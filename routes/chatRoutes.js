const express = require("express");
const jwt = require("jsonwebtoken");
const { Op } = require("sequelize");
const { ChatMessage, User, Settings } = require("../models");
const { authenticateTokenUser, requireAdmin } = require("../middlewares/auth");
const upload = require("../middlewares/uploads");
const {
  sendNotificationToRole,
  sendNotificationToUser,
} = require("../services/notifications.js");

const router = express.Router();

const CHAT_USER_ATTRIBUTES = ["id", "name", "role", "images"];
const LEGACY_IMAGE_PREFIX = "__chat_image__:";
const LEGACY_AUDIO_PREFIX = "__chat_audio__:";
const ADMIN_TOKEN_VALID_AFTER_IAT_KEY = "admin_token_valid_after_iat";
let cachedChatMessageColumns = null;

function extractSocketToken(socket) {
  const authToken = socket.handshake?.auth?.token;
  if (typeof authToken === "string" && authToken.trim()) {
    return authToken.trim();
  }

  const authorizationHeader = socket.handshake?.headers?.authorization;
  if (typeof authorizationHeader === "string" && authorizationHeader.trim()) {
    return authorizationHeader.replace(/^Bearer\s+/i, "").trim();
  }

  const queryToken = socket.handshake?.query?.token;
  if (typeof queryToken === "string" && queryToken.trim()) {
    return queryToken.trim();
  }

  return null;
}

async function getAdminTokenValidAfterIat() {
  const currentUnixSeconds = Math.floor(Date.now() / 1000);

  const [setting] = await Settings.findOrCreate({
    where: { key: ADMIN_TOKEN_VALID_AFTER_IAT_KEY },
    defaults: {
      value: String(currentUnixSeconds),
      description: "Reject admin JWTs issued before this unix timestamp",
      isActive: true,
    },
  });

  const parsedValue = parseInt(String(setting.value || "").trim(), 10);
  if (Number.isNaN(parsedValue) || parsedValue <= 0) {
    setting.value = String(currentUnixSeconds);
    setting.isActive = true;
    await setting.save();
    return currentUnixSeconds;
  }

  return parsedValue;
}

async function verifyChatSocketUser(socket) {
  const token = extractSocketToken(socket);
  if (!token) {
    throw new Error("TOKEN_REQUIRED");
  }

  const decoded = jwt.verify(token, process.env.JWT_SECRET);
  if (!decoded || !decoded.id) {
    throw new Error("INVALID_TOKEN");
  }

  if (decoded.role === "admin") {
    const decodedIat = Number(decoded.iat || 0);
    if (!decodedIat) {
      throw new Error("INVALID_ADMIN_TOKEN");
    }

    const validAfterIat = await getAdminTokenValidAfterIat();
    if (decodedIat < validAfterIat) {
      throw new Error("ADMIN_TOKEN_EXPIRED");
    }
  }

  const user = await User.findByPk(decoded.id, {
    attributes: ["id", "email", "role", "isActive", "isVerified"],
  });

  if (!user || user.isActive === false) {
    throw new Error("USER_NOT_ALLOWED");
  }

  return {
    id: user.id,
    email: user.email,
    role: user.role,
    isActive: user.isActive,
    isVerified: user.isVerified,
  };
}

function normalizeLimit(value, fallback = 20) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(parsed, 100);
}

function buildDirectConversationWhere(firstUserId, secondUserId) {
  return {
    [Op.or]: [
      { senderId: firstUserId, receiverId: secondUserId },
      { senderId: secondUserId, receiverId: firstUserId },
    ],
  };
}

function getMessageIncludes() {
  return [
    { model: User, as: "sender", attributes: CHAT_USER_ATTRIBUTES },
    { model: User, as: "receiver", attributes: CHAT_USER_ATTRIBUTES },
  ];
}

function resolveChatMessagesTableName() {
  const tableName = ChatMessage.getTableName();
  if (typeof tableName === "string") return tableName;
  if (tableName && tableName.tableName) return tableName.tableName;
  return String(tableName);
}

async function getChatMessageColumns() {
  if (cachedChatMessageColumns) {
    return cachedChatMessageColumns;
  }

  const queryInterface = ChatMessage.sequelize.getQueryInterface();
  const tableName = resolveChatMessagesTableName();
  const columns = await queryInterface.describeTable(tableName);
  cachedChatMessageColumns = columns;
  return columns;
}

async function getChatMessageAttributes() {
  const columns = await getChatMessageColumns();
  const attributes = [
    "id",
    "senderId",
    "receiverId",
    "message",
    "read",
    "createdAt",
    "updatedAt",
  ];

  if (columns.messageType) {
    attributes.push("messageType");
  }

  if (columns.image) {
    attributes.push("image");
  }

  return attributes;
}

async function buildChatMessageCreatePayload({
  senderId,
  receiverId,
  message,
  messageType,
  image,
}) {
  const columns = await getChatMessageColumns();
  const payload = {
    senderId,
    receiverId,
    message,
  };

  if (columns.messageType) {
    payload.messageType = messageType;
  }

  if (columns.image) {
    payload.image = image || null;
  }

  return payload;
}

async function insertChatMessage(payload) {
  const sequelize = ChatMessage.sequelize;
  const queryInterface = sequelize.getQueryInterface();
  const tableName = resolveChatMessagesTableName();
  const now = new Date();

  const insertPayload = {
    ...payload,
    read: false,
    createdAt: now,
    updatedAt: now,
  };

  await queryInterface.bulkInsert(tableName, [insertPayload]);

  const createdMessage = await ChatMessage.findOne({
    attributes: await getChatMessageAttributes(),
    where: {
      senderId: payload.senderId,
      receiverId: payload.receiverId,
      createdAt: now,
    },
    order: [["id", "DESC"]],
    include: getMessageIncludes(),
  });

  return createdMessage;
}

function getImageUrl(fileName) {
  if (!fileName) return null;
  return `/uploads/${fileName}`;
}

function encodeLegacyImagePayload(fileName, caption) {
  return `${LEGACY_IMAGE_PREFIX}${JSON.stringify({
    image: fileName,
    caption: caption || "",
  })}`;
}

function encodeLegacyAudioPayload(fileName, durationInSeconds) {
  return `${LEGACY_AUDIO_PREFIX}${JSON.stringify({
    audio: fileName,
    durationInSeconds: durationInSeconds || 0,
  })}`;
}

function parseLegacyImagePayload(value) {
  if (typeof value !== "string" || !value.startsWith(LEGACY_IMAGE_PREFIX)) {
    return null;
  }

  try {
    return JSON.parse(value.slice(LEGACY_IMAGE_PREFIX.length));
  } catch (_) {
    return null;
  }
}

function parseLegacyAudioPayload(value) {
  if (typeof value !== "string" || !value.startsWith(LEGACY_AUDIO_PREFIX)) {
    return null;
  }

  try {
    return JSON.parse(value.slice(LEGACY_AUDIO_PREFIX.length));
  } catch (_) {
    return null;
  }
}

function normalizeChatMessage(message) {
  const rawMessage =
    typeof message?.toJSON === "function" ? message.toJSON() : { ...message };

  const legacyImagePayload = parseLegacyImagePayload(rawMessage.message);
  if (legacyImagePayload?.image) {
    rawMessage.messageType = "image";
    rawMessage.image = legacyImagePayload.image;
    rawMessage.message = legacyImagePayload.caption || "صورة";
    return rawMessage;
  }

  const legacyAudioPayload = parseLegacyAudioPayload(rawMessage.message);
  if (legacyAudioPayload?.audio) {
    rawMessage.messageType = "audio";
    rawMessage.audio = legacyAudioPayload.audio;
    rawMessage.durationInSeconds = Number(legacyAudioPayload.durationInSeconds || 0);
    rawMessage.message = "بصمة صوتية";
    return rawMessage;
  }

  rawMessage.image = rawMessage.image || null;
  rawMessage.messageType =
    rawMessage.messageType === "image" && rawMessage.image ? "image" : "text";
  return rawMessage;
}

function getResolvedMessageType(message) {
  return normalizeChatMessage(message).messageType;
}

function buildNotificationMessage(message) {
  const normalized = normalizeChatMessage(message);
  if (normalized.messageType === "image") {
    return "تم إرسال صورة";
  }
  return normalized.message || "";
}

async function isAllowedDirectChat(senderId, receiverId) {
  const [sender, receiver] = await Promise.all([
    User.findByPk(senderId, { attributes: ["id", "role", "isActive"] }),
    User.findByPk(receiverId, { attributes: ["id", "role", "isActive"] }),
  ]);

  if (!sender || !receiver || sender.isActive === false || receiver.isActive === false) {
    return { allowed: false, error: "المستخدم غير موجود" };
  }

  if (sender.id === receiver.id) {
    return { allowed: false, error: "لا يمكن مراسلة نفس الحساب" };
  }

  const allowedRoles = new Set(["admin", "agent"]);
  if (!allowedRoles.has(sender.role) && !allowedRoles.has(receiver.role)) {
    return { allowed: false, error: "المحادثة متاحة فقط مع الوكيل أو الإدارة" };
  }

  const userAgentPair =
    (sender.role === "user" && receiver.role === "agent") ||
    (sender.role === "agent" && receiver.role === "user");

  if (userAgentPair) {
    const agent = sender.role === "agent" ? sender : receiver;
    if (agent.agentPrivateChatEnabled === false) {
      return { allowed: false, error: "الشات الخاص مع هذا الوكيل موقوف من الإدارة" };
    }
  }

  return { allowed: true, sender, receiver };
}

async function canOpenDirectChat(senderId, receiverId) {
  const [sender, receiver] = await Promise.all([
    User.findByPk(senderId, { attributes: ["id", "role", "isActive"] }),
    User.findByPk(receiverId, { attributes: ["id", "role", "isActive"] }),
  ]);

  if (!sender || !receiver || sender.isActive === false || receiver.isActive === false) {
    return { allowed: false, error: "المستخدم غير موجود" };
  }

  if (sender.id === receiver.id) {
    return { allowed: false, error: "لا يمكن مراسلة نفس الحساب" };
  }

  const allowedRoles = new Set(["admin", "agent"]);
  if (!allowedRoles.has(sender.role) && !allowedRoles.has(receiver.role)) {
    return { allowed: false, error: "المحادثة متاحة فقط مع الوكيل أو الإدارة" };
  }

  return { allowed: true, sender, receiver };
}

async function loadDirectMessages({ userId, receiverId, limit }) {
  const [currentUser, peerUser] = await Promise.all([
    User.findByPk(userId, { attributes: ["id", "role"] }),
    User.findByPk(receiverId, { attributes: ["id", "role"] }),
  ]);
  const attributes = await getChatMessageAttributes();
  let whereClause = buildDirectConversationWhere(userId, receiverId);

  if (
    currentUser?.role === "admin" &&
    peerUser &&
    peerUser.role !== "admin"
  ) {
    const admins = await User.findAll({
      where: { role: "admin" },
      attributes: ["id"],
    });
    const adminIds = admins.map((admin) => admin.id);

    whereClause = {
      [Op.or]: [
        { senderId: peerUser.id, receiverId: null },
        { senderId: peerUser.id, receiverId: { [Op.in]: adminIds } },
        { senderId: { [Op.in]: adminIds }, receiverId: peerUser.id },
      ],
    };
  }

  const messages = await ChatMessage.findAll({
    attributes,
    where: whereClause,
    order: [["createdAt", "DESC"]],
    limit,
    include: getMessageIncludes(),
  });

  return messages.reverse().map(normalizeChatMessage);
}

async function markConversationAsRead(viewerId, peerId) {
  if (!viewerId || !peerId) return;

  await ChatMessage.update(
    { read: true },
    {
      where: {
        senderId: peerId,
        receiverId: viewerId,
        read: false,
      },
    }
  );
}

async function loadAdminSupportMessages({ userId, limit }) {
  const attributes = await getChatMessageAttributes();
  const admins = await User.findAll({
    where: { role: "admin" },
    attributes: ["id"],
  });
  const adminIds = admins.map((admin) => admin.id);

  const messages = await ChatMessage.findAll({
    attributes,
    where: {
      [Op.or]: [
        { senderId: userId, receiverId: null },
        { senderId: userId, receiverId: { [Op.in]: adminIds } },
        { senderId: { [Op.in]: adminIds }, receiverId: userId },
      ],
    },
    order: [["createdAt", "DESC"]],
    limit,
    include: getMessageIncludes(),
  });

  return messages.reverse().map(normalizeChatMessage);
}

async function buildConversationListForUser(currentUser) {
  const attributes = await getChatMessageAttributes();
  const whereClause = {
    [Op.or]: [{ senderId: currentUser.id }, { receiverId: currentUser.id }],
  };
  const messages = await ChatMessage.findAll({
    attributes,
    where: whereClause,
    include: getMessageIncludes(),
    order: [["createdAt", "DESC"]],
  });

  const unreadRows = await ChatMessage.findAll({
    attributes: [
      "senderId",
      [
        ChatMessage.sequelize.fn("COUNT", ChatMessage.sequelize.col("id")),
        "count",
      ],
    ],
    where: {
      receiverId: currentUser.id,
      read: false,
    },
    group: ["senderId"],
    raw: true,
  });
  const unreadBySenderId = new Map(
    unreadRows.map((row) => [Number(row.senderId), Number(row.count || 0)]),
  );

  const conversations = new Map();

  for (const message of messages) {
    const normalizedMessage = normalizeChatMessage(message);
    const peer =
      normalizedMessage.senderId === currentUser.id
        ? normalizedMessage.receiver
        : normalizedMessage.sender;
    if (!peer) continue;

    if (currentUser.role === "agent") {
      if (peer.role !== "user") continue;
    } else if (currentUser.role === "user") {
      if (peer.role !== "agent") continue;
    } else if (currentUser.role === "admin") {
      continue;
    }

    if (!conversations.has(peer.id)) {
      conversations.set(peer.id, {
        user: peer,
        lastMessage: normalizedMessage,
        unreadCount: unreadBySenderId.get(Number(peer.id)) ?? 0,
      });
    }
  }

  return Array.from(conversations.values());
}

async function loadAdminSupportConversationBuckets(limit = null) {
  const attributes = await getChatMessageAttributes();
  const admins = await User.findAll({
    where: { role: "admin" },
    attributes: ["id"],
  });
  const adminIds = admins.map((admin) => admin.id);

  const queryOptions = {
    attributes,
    where: {
      [Op.or]: [
        { senderId: { [Op.notIn]: adminIds }, receiverId: { [Op.in]: adminIds } },
        { senderId: { [Op.in]: adminIds }, receiverId: { [Op.notIn]: adminIds } },
        { senderId: { [Op.notIn]: adminIds }, receiverId: null },
      ],
    },
    include: [
      { model: User, as: "sender", attributes: CHAT_USER_ATTRIBUTES },
      { model: User, as: "receiver", attributes: CHAT_USER_ATTRIBUTES },
    ],
    order: [["createdAt", "DESC"]],
  };

  const normalizedLimit = Number(limit);
  if (Number.isFinite(normalizedLimit) && normalizedLimit > 0) {
    queryOptions.limit = normalizedLimit;
  }

  const messages = await ChatMessage.findAll(queryOptions);

  const usersMap = new Map();
  const agentsMap = new Map();

  for (const message of messages) {
    const normalizedMessage = normalizeChatMessage(message);
    const candidates = [];

    if (
      normalizedMessage.sender &&
      !adminIds.includes(normalizedMessage.senderId)
    ) {
      candidates.push(normalizedMessage.sender);
    }

    if (
      normalizedMessage.receiver &&
      normalizedMessage.receiverId &&
      !adminIds.includes(normalizedMessage.receiverId)
    ) {
      candidates.push(normalizedMessage.receiver);
    }

    for (const peer of candidates) {
      const targetMap = peer.role === "agent" ? agentsMap : usersMap;
      if (!targetMap.has(peer.id)) {
        targetMap.set(peer.id, {
          user: peer,
          lastMessage: normalizedMessage,
        });
      }
    }
  }

  return {
    users: Array.from(usersMap.values()),
    agents: Array.from(agentsMap.values()),
  };
}

function initChatSocket(io) {
  const userSocketsById = new Map();

  io.use(async (socket, next) => {
    try {
      const authUser = await verifyChatSocketUser(socket);
      socket.data.authUser = authUser;
      next();
    } catch (error) {
      const reason =
        error && error.name === "TokenExpiredError"
          ? "Token expired"
          : error?.message || "Unauthorized";
      next(new Error(reason));
    }
  });

  io.on("connection", (socket) => {
    const authUser = socket.data.authUser;
    const userId = String(authUser?.id || "");
    if (!userId) return socket.disconnect(true);

    if (!userSocketsById.has(userId)) {
      userSocketsById.set(userId, []);
    }
    userSocketsById.get(userId).push(socket.id);

    socket.on("getMessages", async (payload = {}) => {
      try {
        const currentUserId = Number(authUser.id);
        if (!currentUserId) {
          return socket.emit("chatError", { message: "ØºÙŠØ± Ù…ØµØ±Ø­ Ø¨Ù‡" });
        }

        const receiverId = payload.receiverId ? Number(payload.receiverId) : null;
        const targetUserId =
          payload.targetUserId != null
            ? Number(payload.targetUserId)
            : payload.userId != null
            ? Number(payload.userId)
            : null;
        const normalizedLimit = Math.max(
          normalizeLimit(payload.limit, 100),
          100
        );

        if (receiverId) {
          const allowed = await canOpenDirectChat(
            currentUserId,
            Number(receiverId)
          );
          if (!allowed.allowed) {
            return socket.emit("chatError", { message: allowed.error });
          }

          await markConversationAsRead(currentUserId, Number(receiverId));

          const messages = await loadDirectMessages({
            userId: currentUserId,
            receiverId: Number(receiverId),
            limit: normalizedLimit,
          });
          return socket.emit("messagesLoaded", messages);
        }

        if (
          authUser.role === "admin" &&
          Number.isFinite(targetUserId) &&
          targetUserId > 0 &&
          targetUserId !== currentUserId
        ) {
          const allowed = await canOpenDirectChat(currentUserId, targetUserId);
          if (!allowed.allowed) {
            return socket.emit("chatError", { message: allowed.error });
          }

          const messages = await loadDirectMessages({
            userId: currentUserId,
            receiverId: targetUserId,
            limit: normalizedLimit,
          });
          return socket.emit("messagesLoaded", messages);
        }

        const messages = await loadAdminSupportMessages({
          userId: currentUserId,
          limit: normalizedLimit,
        });

        socket.emit("messagesLoaded", messages);
      } catch (error) {
        console.error("خطأ في جلب الرسائل:", error);
        socket.emit("chatError", { message: "تعذر جلب الرسائل" });
      }
    });

    socket.on("sendMessage", async (data = {}) => {
      try {
        const normalizedSenderId = Number(authUser.id);
        if (!normalizedSenderId) {
          return socket.emit("chatError", { message: "ØºÙŠØ± Ù…ØµØ±Ø­ Ø¨Ù‡" });
        }

        const { receiverId, message, messageType, image } = data;
        const normalizedReceiverId = receiverId ? Number(receiverId) : null;
        const normalizedType = messageType === "image" ? "image" : "text";
        const trimmedMessage = String(message || "").trim();

        if (normalizedType === "text" && !trimmedMessage) return;
        if (normalizedType === "image" && !image) return;

        if (normalizedReceiverId) {
          const allowed = await isAllowedDirectChat(normalizedSenderId, normalizedReceiverId);
          if (!allowed.allowed) {
            return socket.emit("chatError", { message: allowed.error });
          }
        }

        const createPayload = await buildChatMessageCreatePayload({
          senderId: normalizedSenderId,
          receiverId: normalizedReceiverId,
          message: normalizedType === "image" ? trimmedMessage || "صورة" : trimmedMessage,
          messageType: normalizedType,
          image: image || null,
        });
        const fullMessage = normalizeChatMessage(await insertChatMessage(createPayload));

        let recipients = [];
        if (normalizedReceiverId) {
          recipients = [normalizedSenderId, normalizedReceiverId];
        } else {
          const admins = await User.findAll({
            where: { role: "admin" },
            attributes: ["id"],
          });
          recipients = [normalizedSenderId, ...admins.map((admin) => admin.id)];
        }

        recipients.forEach((id) => {
          const sockets = userSocketsById.get(String(id)) || [];
          sockets.forEach((socketId) => io.to(socketId).emit("newMessage", fullMessage));
        });

        if (!normalizedReceiverId) {
          await sendNotificationToRole(
            "admin",
            buildNotificationMessage(fullMessage),
            `   ${fullMessage.sender?.name || ""}`
          );
        } else if (normalizedSenderId !== normalizedReceiverId) {
          await sendNotificationToUser(
            normalizedReceiverId,
            buildNotificationMessage(fullMessage),
            `   ${fullMessage.sender?.name || ""}`
          );
        }
      } catch (error) {
        console.error("خطأ في إرسال الرسالة:", error);
        socket.emit("chatError", { message: "تعذر إرسال الرسالة" });
      }
    });

    socket.on("disconnect", () => {
      const sockets = userSocketsById.get(userId) || [];
      const nextSockets = sockets.filter((socketId) => socketId !== socket.id);
      if (nextSockets.length === 0) {
        userSocketsById.delete(userId);
        return;
      }

      userSocketsById.set(userId, nextSockets);
    });
  });
}

router.get("/chat/conversations", authenticateTokenUser, async (req, res) => {
  try {
    const currentUser = await User.findByPk(req.user.id, {
      attributes: ["id", "role"],
    });
    if (!currentUser) {
      return res.status(404).json({ error: "المستخدم غير موجود" });
    }

    const conversations = await buildConversationListForUser(currentUser);
    return res.json(conversations);
  } catch (error) {
    console.error("خطأ في جلب سجل المحادثات:", error);
    return res.status(500).json({ error: "حدث خطأ أثناء جلب سجل المحادثات" });
  }
});

router.get("/admin/agents/:agentId/conversations", requireAdmin, async (req, res) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({ error: "Admins only" });
    }

    const agentId = Number(req.params.agentId);
    const agent = await User.findByPk(agentId, {
      attributes: ["id", "role", "name", "phone", "agentPrivateChatEnabled"],
    });

    if (!agent || agent.role !== "agent") {
      return res.status(404).json({ error: "الوكيل غير موجود" });
    }

    
    const conversations = await buildConversationListForUser(agent);
    return res.status(200).json({
      agent: {
        id: agent.id,
        name: agent.name,
        phone: agent.phone,
        agentPrivateChatEnabled: agent.agentPrivateChatEnabled,
      },
      conversations,
    });
  } catch (error) {
    console.error("خطأ في جلب محادثات الوكيل:", error);
    return res.status(500).json({ error: "تعذر جلب محادثات الوكيل" });
  }
});

router.get("/admin/agents/:agentId/conversations/:userId/messages", requireAdmin, async (req, res) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({ error: "Admins only" });
    }

    const agentId = Number(req.params.agentId);
    const targetUserId = Number(req.params.userId);
    const limit = normalizeLimit(req.query.limit, 100);

    const [agent, targetUser] = await Promise.all([
      User.findByPk(agentId, { attributes: ["id", "role", "name", "phone", "images"] }),
      User.findByPk(targetUserId, { attributes: ["id", "role", "name", "phone", "images"] }),
    ]);

    if (!agent || agent.role !== "agent") {
      return res.status(404).json({ error: "الوكيل غير موجود" });
    }

    if (!targetUser || targetUser.role !== "user") {
      return res.status(404).json({ error: "المستخدم غير موجود" });
    }

    const messages = await loadDirectMessages({
      userId: agentId,
      receiverId: targetUserId,
      limit,
    });

    return res.status(200).json({
      agent,
      user: targetUser,
      messages,
    });
  } catch (error) {
    console.error("خطأ في جلب رسائل الوكيل:", error);
    return res.status(500).json({ error: "تعذر جلب الرسائل" });
  }
});

router.get("/admin/support/conversations", requireAdmin, async (req, res) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({ error: "Admins only" });
    }

    const requestedLimit = req.query.limit ? normalizeLimit(req.query.limit, 100) : null;
    const { users, agents } = await loadAdminSupportConversationBuckets(requestedLimit);

    return res.status(200).json({
      users,
      agents,
    });
  } catch (error) {
    console.error("خطأ في جلب محادثات الدعم للإدارة:", error);
    return res.status(500).json({ error: "تعذر جلب محادثات الدعم" });
  }
});

router.get("/chat/support/target", authenticateTokenUser, async (req, res) => {
  try {
    const currentUserId = Number(req.user.id);

    const admin = await User.findOne({
      where: {
        role: "admin",
        isActive: { [Op.not]: false },
        id: { [Op.ne]: currentUserId },
      },
      attributes: ["id", "name", "role", "images"],
      order: [["id", "ASC"]],
    });

    if (!admin) {
      return res.status(404).json({ error: "لا يوجد أدمن متاح حالياً" });
    }

    return res.status(200).json({
      supportTarget: admin,
    });
  } catch (error) {
    console.error("خطأ في جلب جهة الدعم:", error);
    return res.status(500).json({ error: "تعذر جلب جهة الدعم" });
  }
});

router.post("/chat/conversations/:peerId/read", authenticateTokenUser, async (req, res) => {
  try {
    const viewerId = Number(req.user.id);
    const peerId = Number(req.params.peerId);

    if (!peerId) {
      return res.status(400).json({ error: "معرف الطرف الآخر مطلوب" });
    }

    const allowed = await canOpenDirectChat(viewerId, peerId);
    if (!allowed.allowed) {
      return res.status(403).json({ error: allowed.error });
    }

    await markConversationAsRead(viewerId, peerId);

    return res.status(200).json({
      success: true,
      peerId,
      message: "تم تعليم الرسائل كمقروءة",
    });
  } catch (error) {
    console.error("خطأ في تعليم المحادثة كمقروءة:", error);
    return res.status(500).json({ error: "تعذر تحديث حالة القراءة" });
  }
});

router.post(
  "/chat/messages/image",
  authenticateTokenUser,
  upload.single("image"),
  async (req, res) => {
    try {
      const senderId = Number(req.user.id);
      const receiverId = req.body.receiverId ? Number(req.body.receiverId) : null;
      const caption = String(req.body.message || "").trim();

      if (!req.file) {
        return res.status(400).json({ error: "الصورة مطلوبة" });
      }

      if (receiverId) {
        const allowed = await isAllowedDirectChat(senderId, receiverId);
        if (!allowed.allowed) {
          return res.status(403).json({ error: allowed.error });
        }
      }

      const availableColumns = await getChatMessageColumns();
      const canStoreStructuredImage = Boolean(
        availableColumns.image && availableColumns.messageType
      );

      const createPayload = await buildChatMessageCreatePayload({
        senderId,
        receiverId,
        message: canStoreStructuredImage
          ? caption || "صورة"
          : encodeLegacyImagePayload(req.file.filename, caption),
        messageType: "image",
        image: canStoreStructuredImage ? req.file.filename : null,
      });
      const fullMessage = normalizeChatMessage(await insertChatMessage(createPayload));

      const chatNamespace = req.app.get("chatNamespace");
      if (chatNamespace) {
        const adminIds = receiverId
          ? []
          : (
              await User.findAll({
                where: { role: "admin" },
                attributes: ["id"],
              })
            ).map((admin) => admin.id);
        const participantIds = receiverId
          ? [senderId, receiverId]
          : [senderId, ...adminIds];

        participantIds.forEach((participantId) => {
          chatNamespace
            .fetchSockets()
            .then((sockets) => {
              sockets
                .filter(
                  (socket) => String(socket.handshake?.query?.userId || "") === String(participantId)
                )
                .forEach((socket) => socket.emit("newMessage", fullMessage));
            })
            .catch(() => {});
        });
      }

      if (receiverId) {
        await sendNotificationToUser(
          receiverId,
          "تم إرسال صورة",
          `   ${fullMessage.sender?.name || ""}`
        );
      } else {
        await sendNotificationToRole(
          "admin",
          "تم إرسال صورة",
          `   ${fullMessage.sender?.name || ""}`
        );
      }

      return res.status(201).json({
        success: true,
        message: fullMessage,
        imageUrl: getImageUrl(req.file.filename),
      });
    } catch (error) {
      console.error("خطأ في رفع صورة المحادثة:", error);
      return res.status(500).json({ error: "تعذر رفع الصورة" });
    }
  }
);

router.post(
  "/chat/messages/audio",
  authenticateTokenUser,
  upload.single("audio"),
  async (req, res) => {
    try {
      const senderId = Number(req.user.id);
      const receiverId = req.body.receiverId ? Number(req.body.receiverId) : null;
      const durationInSeconds = Number(req.body.durationInSeconds || 0);

      if (!req.file) {
        return res.status(400).json({ error: "الملف الصوتي مطلوب" });
      }

      if (receiverId) {
        const allowed = await isAllowedDirectChat(senderId, receiverId);
        if (!allowed.allowed) {
          return res.status(403).json({ error: allowed.error });
        }
      }

      const createPayload = await buildChatMessageCreatePayload({
        senderId,
        receiverId,
        message: encodeLegacyAudioPayload(req.file.filename, durationInSeconds),
        messageType: "text",
        image: null,
      });

      const fullMessage = normalizeChatMessage(await insertChatMessage(createPayload));

      const chatNamespace = req.app.get("chatNamespace");
      if (chatNamespace) {
        const adminIds = receiverId
          ? []
          : (
              await User.findAll({
                where: { role: "admin" },
                attributes: ["id"],
              })
            ).map((admin) => admin.id);
        const participantIds = receiverId
          ? [senderId, receiverId]
          : [senderId, ...adminIds];

        participantIds.forEach((participantId) => {
          chatNamespace
            .fetchSockets()
            .then((sockets) => {
              sockets
                .filter(
                  (socket) => String(socket.handshake?.query?.userId || "") === String(participantId)
                )
                .forEach((socket) => socket.emit("newMessage", fullMessage));
            })
            .catch(() => {});
        });
      }

      if (receiverId) {
        await sendNotificationToUser(
          receiverId,
          "تم إرسال بصمة صوتية",
          `   ${fullMessage.sender?.name || ""}`
        );
      } else {
        await sendNotificationToRole(
          "admin",
          "تم إرسال بصمة صوتية",
          `   ${fullMessage.sender?.name || ""}`
        );
      }

      return res.status(201).json({
        success: true,
        message: fullMessage,
        audioUrl: getImageUrl(req.file.filename),
      });
    } catch (error) {
      console.error("خطأ في رفع البصمة الصوتية:", error);
      return res.status(500).json({ error: "تعذر رفع البصمة الصوتية" });
    }
  }
);

router.get("/usersWithLastMessage", requireAdmin, async (req, res) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({ error: "Admins only" });
    }

    const attributes = await getChatMessageAttributes();
    const admins = await User.findAll({
      where: { role: "admin" },
      attributes: ["id"],
    });
    const adminIds = admins.map((admin) => admin.id);

    const messages = await ChatMessage.findAll({
      attributes,
      where: {
        [Op.or]: [
          { senderId: { [Op.notIn]: adminIds }, receiverId: { [Op.in]: adminIds } },
          { senderId: { [Op.in]: adminIds }, receiverId: { [Op.notIn]: adminIds } },
          { senderId: { [Op.notIn]: adminIds }, receiverId: null },
        ],
      },
      include: [
        { model: User, as: "sender", attributes: ["id", "name", "images"] },
        { model: User, as: "receiver", attributes: ["id", "name", "images"] },
      ],
      order: [["createdAt", "DESC"]],
      limit: 50,
    });

    const usersMap = new Map();

    messages.forEach((message) => {
      if (!adminIds.includes(message.senderId) && message.sender) {
        if (!usersMap.has(message.senderId)) {
          usersMap.set(message.senderId, { user: message.sender, lastMessage: message });
        }
      }

      if (message.receiverId && !adminIds.includes(message.receiverId) && message.receiver) {
        if (!usersMap.has(message.receiverId)) {
          usersMap.set(message.receiverId, {
            user: message.receiver,
            lastMessage: message,
          });
        }
      }
    });

    res.json(Array.from(usersMap.values()));
  } catch (error) {
    console.error("خطأ في جلب المستخدمين مع آخر رسالة:", error);
    res.status(500).json({ error: "حدث خطأ أثناء جلب المستخدمين" });
  }
});

module.exports = { router, initChatSocket };
