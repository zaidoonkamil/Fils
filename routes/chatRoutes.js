const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");
const { ChatMessage, User } = require("../models");
const { Op } = require("sequelize");
const { sendNotificationToRole, sendNotificationToUser } = require("../services/notifications.js");

function initChatSocket(io) {
  const userSockets = new Map();

  // Middleware للتحقق من JWT قبل السماح بالاتصال
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error("Authentication error"));

    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
      if (err) return next(new Error("Authentication error"));
      socket.userId = user.id;
      socket.userName = user.name;
      next();
    });
  });

  io.on("connection", (socket) => {
    console.log(`🔌 مستخدم متصل: ${socket.userName} (${socket.userId})`);

    // تخزين معرف الـ socket لكل مستخدم
    if (!userSockets.has(socket.userId)) userSockets.set(socket.userId, []);
    userSockets.get(socket.userId).push(socket.id);

    // جلب الرسائل
    socket.on("getMessages", async (payload = {}) => {
      try {
        const userId = socket.userId;
        const receiverId = payload.receiverId;

        if (receiverId) {
          const messages = await ChatMessage.findAll({
            where: {
              [Op.or]: [
                { senderId: userId, receiverId },
                { senderId: receiverId, receiverId: userId },
              ],
            },
            order: [["createdAt", "ASC"]],
            include: [
              { model: User, as: "sender", attributes: ["id", "name", "role"] },
              { model: User, as: "receiver", attributes: ["id", "name", "role"] },
            ],
          });
          return socket.emit("messagesLoaded", messages);
        }

        // جلب الرسائل مع الأدمن إذا receiverId غير محدد
        const admins = await User.findAll({ where: { role: "admin" }, attributes: ["id"] });
        const adminIds = admins.map(a => a.id);

        const messages = await ChatMessage.findAll({
          where: {
            [Op.or]: [
              { senderId: userId, receiverId: null },
              { senderId: userId, receiverId: { [Op.in]: adminIds } },
              { senderId: { [Op.in]: adminIds }, receiverId: userId },
            ],
          },
          order: [["createdAt", "ASC"]],
          include: [
            { model: User, as: "sender", attributes: ["id", "name", "role"] },
            { model: User, as: "receiver", attributes: ["id", "name", "role"] },
          ],
        });

        socket.emit("messagesLoaded", messages);
      } catch (err) {
        console.error("❌ خطأ في جلب الرسائل:", err);
      }
    });

    // إرسال رسالة
    socket.on("sendMessage", async (data) => {
      try {
        const { receiverId, message } = data;
        const senderId = socket.userId;
        if (!senderId || !message) return;

        const newMessage = await ChatMessage.create({
          senderId,
          receiverId: receiverId || null,
          message,
        });

        const fullMessage = await ChatMessage.findOne({
          where: { id: newMessage.id },
          include: [
            { model: User, as: "sender", attributes: ["id", "name", "role"] },
            { model: User, as: "receiver", attributes: ["id", "name", "role"] },
          ],
        });

        let recipients = [];
        if (!receiverId) {
          const admins = await User.findAll({ where: { role: "admin" }, attributes: ["id"] });
          recipients = [...admins.map(a => a.id), senderId];
          await sendNotificationToRole(
            "admin",
            fullMessage.message,
            `رسالة جديدة من ${fullMessage.sender?.name || "مستخدم"}`
          );
        } else {
          recipients = [senderId, receiverId];
          if (fullMessage.sender.role === "admin") {
            await sendNotificationToUser(
              receiverId,
              fullMessage.message,
              `رسالة جديدة من الأدمن ${fullMessage.sender?.name || ""}`
            );
          }
        }

        // إرسال الرسالة لكل sockets المرتبطة بالمستلمين
        recipients.forEach(id => {
          const sockets = userSockets.get(id.toString()) || [];
          sockets.forEach(sid => io.to(sid).emit("newMessage", fullMessage));
        });

      } catch (err) {
        console.error("❌ خطأ في إرسال الرسالة:", err);
      }
    });

    // قطع الاتصال
    socket.on("disconnect", () => {
      console.log(`❌ مستخدم قطع الاتصال: ${socket.userId}`);
      const sockets = userSockets.get(socket.userId) || [];
      userSockets.set(socket.userId, sockets.filter(id => id !== socket.id));
    });
  });
}

// Route لجلب المستخدمين مع آخر رسالة
router.get("/usersWithLastMessage", async (req, res) => {
  try {
    const admins = await User.findAll({ where: { role: "admin" }, attributes: ["id"] });
    const adminIds = admins.map(a => a.id);

    const messages = await ChatMessage.findAll({
      where: {
        [Op.or]: [
          { senderId: { [Op.notIn]: adminIds }, receiverId: { [Op.in]: adminIds } },
          { senderId: { [Op.in]: adminIds }, receiverId: { [Op.notIn]: adminIds } },
          { senderId: { [Op.notIn]: adminIds }, receiverId: null },
        ],
      },
      include: [
        { model: User, as: "sender", attributes: ["id", "name"] },
        { model: User, as: "receiver", attributes: ["id", "name"] },
      ],
      order: [["createdAt", "DESC"]],
      limit: 50,
    });

    const usersMap = new Map();

    messages.forEach(msg => {
      if (!adminIds.includes(msg.senderId) && msg.sender) {
        if (!usersMap.has(msg.senderId)) {
          usersMap.set(msg.senderId, { user: msg.sender, lastMessage: msg });
        }
      }

      if (msg.receiverId && !adminIds.includes(msg.receiverId) && msg.receiver) {
        if (!usersMap.has(msg.receiverId)) {
          usersMap.set(msg.receiverId, { user: msg.receiver, lastMessage: msg });
        }
      }
    });

    res.json(Array.from(usersMap.values()));
  } catch (err) {
    console.error("❌ خطأ في جلب المستخدمين مع آخر رسالة:", err);
    res.status(500).json({ error: "حدث خطأ أثناء جلب المستخدمين" });
  }
});

module.exports = { router, initChatSocket };
