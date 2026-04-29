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

function getImageUrl(fileName) {
  if (!fileName) return null;
  return `/uploads/${fileName}`;
}

function buildNotificationMessage(message) {
  if (message.messageType === "image") {
    return "تم إرسال صورة";
  }
  return message.message || "";
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
  const messages = await ChatMessage.findAll({
    where: buildDirectConversationWhere(userId, receiverId),
    order: [["createdAt", "DESC"]],
    limit,
    include: getMessageIncludes(),
  });

  return messages.reverse();
}

async function loadAdminSupportMessages({ userId, limit }) {
  const admins = await User.findAll({
    where: { role: "admin" },
    attributes: ["id"],
  });
  const adminIds = admins.map((admin) => admin.id);

  const messages = await ChatMessage.findAll({
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

  return messages.reverse();
}

async function buildConversationListForUser(currentUser) {
  const messages = await ChatMessage.findAll({
    where: {
      [Op.or]: [{ senderId: currentUser.id }, { receiverId: currentUser.id }],
    },
    include: getMessageIncludes(),
    order: [["createdAt", "DESC"]],
    limit: 300,
  });

  const conversations = new Map();

  for (const message of messages) {
    const peer = message.senderId === currentUser.id ? message.receiver : message.sender;
    if (!peer) continue;

    if (currentUser.role === "agent") {
      if (peer.role === "agent" || peer.role === "admin") continue;
    } else if (currentUser.role === "user") {
      if (!["agent", "admin"].includes(peer.role)) continue;
    }

    if (!conversations.has(peer.id)) {
      conversations.set(peer.id, {
        user: peer,
        lastMessage: message,
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

        const createdMessage = await ChatMessage.create({
          senderId: normalizedSenderId,
          receiverId: normalizedReceiverId,
          message: normalizedType === "image" ? trimmedMessage || "صورة" : trimmedMessage,
          messageType: normalizedType,
          image: image || null,
        });

        const fullMessage = await ChatMessage.findOne({
          where: { id: createdMessage.id },
          include: getMessageIncludes(),
        });

        let recipients = [];
        if (normalizedReceiverId) {
          recipients = [normalizedSenderId, normalizedReceiverId];
        } else {
          const admins = await User.findAll({
            where: { role: "admin" },
            attributes: ["id"],
          });
          recipients = [
            normalizedSenderId,
            ...admins.map((admin) => admin.id),
          ];
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

      const createdMessage = await ChatMessage.create({
        senderId,
        receiverId,
        message: caption || "صورة",
        messageType: "image",
        image: req.file.filename,
      });

      const fullMessage = await ChatMessage.findOne({
        where: { id: createdMessage.id },
        include: getMessageIncludes(),
      });

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

router.get("/usersWithLastMessage", async (req, res) => {
  try {
    const admins = await User.findAll({
      where: { role: "admin" },
      attributes: ["id"],
    });
    const adminIds = admins.map((admin) => admin.id);

    const messages = await ChatMessage.findAll({
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
