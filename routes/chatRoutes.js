const { ChatMessage, User } = require("../models");
const { Op } = require("sequelize");
const { sendNotificationToRole, sendNotificationToUser } = require("../services/notifications.js"); 
const jwt = require("jsonwebtoken");

function initChatSocket(io) {
  const userSockets = new Map();

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) return next(new Error("Authentication error"));

      const decoded = jwt.verify(token, process.env.JWT_SECRET || "your-secret-key-123456789");
      const user = await User.findByPk(decoded.id || decoded.userId);
      if (!user) return next(new Error("User not found"));

      socket.userId = user.id;
      socket.userName = user.name;
      socket.userRole = user.role;
      next();
    } catch (err) {
      next(new Error("Authentication error"));
    }
  });

  io.on("connection", (socket) => {
    console.log(`🔌 مستخدم متصل: ${socket.userName} (${socket.userId})`);

    if (!userSockets.has(socket.userId)) userSockets.set(socket.userId, []);
    userSockets.get(socket.userId).push(socket.id);

    socket.on("getMessages", async ({ receiverId = null } = {}) => {
      try {
        let messages;
        if (receiverId) {
          messages = await ChatMessage.findAll({
            where: {
              [Op.or]: [
                { senderId: socket.userId, receiverId },
                { senderId: receiverId, receiverId: socket.userId }
              ]
            },
            order: [["createdAt", "ASC"]],
            include: [
              { model: User, as: "sender", attributes: ["id", "name", "role"] },
              { model: User, as: "receiver", attributes: ["id", "name", "role"] }
            ]
          });
        } else {
          const admins = await User.findAll({ where: { role: "admin" }, attributes: ["id"] });
          const adminIds = admins.map(a => a.id);
          messages = await ChatMessage.findAll({
            where: {
              [Op.or]: [
                { senderId: socket.userId, receiverId: null },
                { senderId: socket.userId, receiverId: { [Op.in]: adminIds } },
                { senderId: { [Op.in]: adminIds }, receiverId: socket.userId }
              ]
            },
            order: [["createdAt", "ASC"]],
            include: [
              { model: User, as: "sender", attributes: ["id", "name", "role"] },
              { model: User, as: "receiver", attributes: ["id", "name", "role"] }
            ]
          });
        }
        socket.emit("messagesLoaded", messages);
      } catch (err) {
        console.error("❌ خطأ في جلب الرسائل:", err);
      }
    });

    socket.on("sendMessage", async ({ receiverId = null, message }) => {
      try {
        if (!message) return;

        const newMessage = await ChatMessage.create({
          senderId: socket.userId,
          receiverId,
          message
        });

        const fullMessage = await ChatMessage.findOne({
          where: { id: newMessage.id },
          include: [
            { model: User, as: "sender", attributes: ["id", "name", "role"] },
            { model: User, as: "receiver", attributes: ["id", "name", "role"] }
          ]
        });

        let recipients = [];
        if (!receiverId) {
          const admins = await User.findAll({ where: { role: "admin" }, attributes: ["id"] });
          recipients = [...admins.map(a => a.id), socket.userId];
          await sendNotificationToRole(
            "admin",
            fullMessage.message,
            `رسالة جديدة من ${fullMessage.sender?.name || "مستخدم"}`
          );
        } else {
          recipients = [socket.userId, receiverId];
          if (fullMessage.sender.role === "admin") {
            await sendNotificationToUser(
              receiverId,
              fullMessage.message,
              `رسالة جديدة من الأدمن ${fullMessage.sender?.name || ""}`
            );
          }
        }

        recipients.forEach(id => {
          const sockets = userSockets.get(id) || [];
          sockets.forEach(sid => io.to(sid).emit("newMessage", fullMessage));
        });

      } catch (err) {
        console.error("❌ خطأ في إرسال الرسالة:", err);
      }
    });

    socket.on("disconnect", () => {
      console.log(`❌ مستخدم قطع الاتصال: ${socket.userName}`);
      const sockets = userSockets.get(socket.userId) || [];
      userSockets.set(socket.userId, sockets.filter(id => id !== socket.id));
    });
  });
}

module.exports = { initChatSocket };
