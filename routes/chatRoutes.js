const express = require("express");
const { Op } = require("sequelize");
const { ChatMessage, User } = require("../models");
const { authenticateTokenUser } = require("../middlewares/auth");
const upload = require("../middlewares/uploads");
const {
  sendNotificationToRole,
  sendNotificationToUser,
} = require("../services/notifications.js");

const router = express.Router();

const CHAT_USER_ATTRIBUTES = ["id", "name", "role", "images"];
const LEGACY_IMAGE_PREFIX = "__chat_image__:";
const LEGACY_AUDIO_PREFIX = "__chat_audio__:";
let cachedChatMessageColumns = null;

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

  return { allowed: true, sender, receiver };
}

async function loadDirectMessages({ userId, receiverId, limit }) {
  const attributes = await getChatMessageAttributes();
  const messages = await ChatMessage.findAll({
    attributes,
    where: buildDirectConversationWhere(userId, receiverId),
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
  const messages = await ChatMessage.findAll({
    attributes,
    where: {
      [Op.or]: [{ senderId: currentUser.id }, { receiverId: currentUser.id }],
    },
    include: getMessageIncludes(),
    order: [["createdAt", "DESC"]],
    limit: 300,
  });

  const conversations = new Map();

  for (const message of messages) {
    const normalizedMessage = normalizeChatMessage(message);
    const peer =
      normalizedMessage.senderId === currentUser.id
        ? normalizedMessage.receiver
        : normalizedMessage.sender;
    if (!peer) continue;

    if (currentUser.role === "agent") {
      if (peer.role === "agent" || peer.role === "admin") continue;
    } else if (currentUser.role === "user") {
      if (!["agent", "admin"].includes(peer.role)) continue;
    }

    if (!conversations.has(peer.id)) {
      const unreadCount = await ChatMessage.count({
        where: {
          senderId: peer.id,
          receiverId: currentUser.id,
          read: false,
        },
      });

      conversations.set(peer.id, {
        user: peer,
        lastMessage: normalizedMessage,
        unreadCount,
      });
    }
  }

  return Array.from(conversations.values());
}

function initChatSocket(io) {
  const userSocketsById = new Map();

  io.on("connection", (socket) => {
    const { userId } = socket.handshake.query;
    if (!userId) return socket.disconnect(true);

    if (!userSocketsById.has(userId)) {
      userSocketsById.set(userId, []);
    }
    userSocketsById.get(userId).push(socket.id);

    socket.on("getMessages", async (payload = {}) => {
      try {
        const { userId: payloadUserId, receiverId, limit } = payload;
        if (!payloadUserId) return;

        if (receiverId) {
          const allowed = await isAllowedDirectChat(Number(payloadUserId), Number(receiverId));
          if (!allowed.allowed) {
            return socket.emit("chatError", { message: allowed.error });
          }

          await markConversationAsRead(Number(payloadUserId), Number(receiverId));

          const messages = await loadDirectMessages({
            userId: Number(payloadUserId),
            receiverId: Number(receiverId),
            limit: normalizeLimit(limit, 20),
          });
          return socket.emit("messagesLoaded", messages);
        }

        const messages = await loadAdminSupportMessages({
          userId: Number(payloadUserId),
          limit: normalizeLimit(limit, 20),
        });

        socket.emit("messagesLoaded", messages);
      } catch (error) {
        console.error("خطأ في جلب الرسائل:", error);
        socket.emit("chatError", { message: "تعذر جلب الرسائل" });
      }
    });

    socket.on("sendMessage", async (data = {}) => {
      try {
        const { senderId, receiverId, message, messageType, image } = data;
        const normalizedSenderId = Number(senderId);
        const normalizedReceiverId = receiverId ? Number(receiverId) : null;
        const normalizedType = messageType === "image" ? "image" : "text";
        const trimmedMessage = String(message || "").trim();

        if (!normalizedSenderId) return;
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
            `رسالة جديدة من ${fullMessage.sender?.name || "مستخدم"}`
          );
        } else if (normalizedSenderId !== normalizedReceiverId) {
          await sendNotificationToUser(
            normalizedReceiverId,
            buildNotificationMessage(fullMessage),
            `رسالة جديدة من ${fullMessage.sender?.name || "مستخدم"}`
          );
        }
      } catch (error) {
        console.error("خطأ في إرسال الرسالة:", error);
        socket.emit("chatError", { message: "تعذر إرسال الرسالة" });
      }
    });

    socket.on("disconnect", () => {
      const sockets = userSocketsById.get(userId) || [];
      userSocketsById.set(
        userId,
        sockets.filter((socketId) => socketId !== socket.id)
      );
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

router.post("/chat/conversations/:peerId/read", authenticateTokenUser, async (req, res) => {
  try {
    const viewerId = Number(req.user.id);
    const peerId = Number(req.params.peerId);

    if (!peerId) {
      return res.status(400).json({ error: "معرف الطرف الآخر مطلوب" });
    }

    const allowed = await isAllowedDirectChat(viewerId, peerId);
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
      const receiverId = Number(req.body.receiverId);
      const caption = String(req.body.message || "").trim();

      if (!req.file) {
        return res.status(400).json({ error: "الصورة مطلوبة" });
      }

      if (!receiverId) {
        return res.status(400).json({ error: "معرف المستقبل مطلوب" });
      }

      const allowed = await isAllowedDirectChat(senderId, receiverId);
      if (!allowed.allowed) {
        return res.status(403).json({ error: allowed.error });
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
        [senderId, receiverId].forEach((participantId) => {
          chatNamespace
            .fetchSockets()
            .then((sockets) => {
              sockets
                .filter(
                  (socket) => String(socket.handshake.query.userId) === String(participantId)
                )
                .forEach((socket) => socket.emit("newMessage", fullMessage));
            })
            .catch(() => {});
        });
      }

      await sendNotificationToUser(
        receiverId,
        "تم إرسال صورة",
        `رسالة جديدة من ${fullMessage.sender?.name || "مستخدم"}`
      );

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
      const receiverId = Number(req.body.receiverId);
      const durationInSeconds = Number(req.body.durationInSeconds || 0);

      if (!req.file) {
        return res.status(400).json({ error: "الملف الصوتي مطلوب" });
      }

      if (!receiverId) {
        return res.status(400).json({ error: "معرف المستقبل مطلوب" });
      }

      const allowed = await isAllowedDirectChat(senderId, receiverId);
      if (!allowed.allowed) {
        return res.status(403).json({ error: allowed.error });
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
        [senderId, receiverId].forEach((participantId) => {
          chatNamespace
            .fetchSockets()
            .then((sockets) => {
              sockets
                .filter(
                  (socket) => String(socket.handshake.query.userId) === String(participantId)
                )
                .forEach((socket) => socket.emit("newMessage", fullMessage));
            })
            .catch(() => {});
        });
      }

      await sendNotificationToUser(
        receiverId,
        "تم إرسال بصمة صوتية",
        `رسالة جديدة من ${fullMessage.sender?.name || "مستخدم"}`
      );

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

router.get("/usersWithLastMessage", async (req, res) => {
  try {
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
