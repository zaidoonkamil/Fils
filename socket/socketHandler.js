const jwt = require("jsonwebtoken");
const { User, Message, Room } = require("../models");

// roomId -> Set({ id, name, socketId })
const roomUsers = new Map();

// userId -> socketId
const connectedUsers = new Map();

function initializeSocketIO(io) {
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) return next(new Error("Authentication error"));

      const decoded = jwt.verify(
        token,
        process.env.JWT_SECRET || "your-secret-key-123456789"
      );

      const userId = decoded.id || decoded.userId;
      if (!userId) return next(new Error("Invalid token - no user ID"));

      const user = await User.findByPk(userId, { attributes: ["id", "name"] });
      if (!user) return next(new Error("User not found"));

      socket.userId = user.id;
      socket.userName = user.name;

      next();
    } catch (error) {
      next(new Error("Authentication error"));
    }
  });

  io.on("connection", (socket) => {
    console.log(`User ${socket.userName} connected (${socket.id})`);

    // ✅ register online user
    connectedUsers.set(String(socket.userId), socket.id);

    socket.on("join-room", async (roomId) => {
      try {
        const room = await Room.findByPk(roomId);
        if (!room || !room.isActive) {
          socket.emit("error", { message: "الغرفة غير موجودة أو غير نشطة" });
          return;
        }

        socket.join(`room-${roomId}`);

        if (!roomUsers.has(roomId)) roomUsers.set(roomId, new Set());
        const usersSet = roomUsers.get(roomId);

        const alreadyJoined = [...usersSet].some((u) => u.id === socket.userId);

        if (!alreadyJoined) {
          usersSet.add({
            id: socket.userId,
            name: socket.userName,
            socketId: socket.id,
          });
          await room.update({ currentUsers: usersSet.size });
        }

        socket.emit("joined-room", {
          roomId,
          message: `مرحباً بك في غرفة ${room.name}`,
        });

        if (!alreadyJoined) {
          socket.to(`room-${roomId}`).emit("user-joined", {
            userId: socket.userId,
            userName: socket.userName,
            message: `${socket.userName} انضم إلى الغرفة`,
          });
        }

        const currentUsers = Array.from(usersSet).map((u) => ({
          id: u.id,
          name: u.name,
        }));
        io.to(`room-${roomId}`).emit("room-users", currentUsers);
      } catch (error) {
        console.error("Error joining room:", error);
        socket.emit("error", { message: "خطأ في الانضمام للغرفة" });
      }
    });

    socket.on("send-message", async (data) => {
      try {
        const { roomId, content, messageType = "text" } = data;

        const room = await Room.findByPk(roomId);
        if (!room || !room.isActive) {
          socket.emit("error", { message: "الغرفة غير موجودة" });
          return;
        }

        const message = await Message.create({
          roomId,
          userId: socket.userId,
          content,
          messageType,
        });

        const messageData = {
          id: message.id,
          content: message.content,
          messageType: message.messageType,
          createdAt: message.createdAt,
          user: {
            id: socket.userId,
            name: socket.userName,
          },
        };

        io.to(`room-${roomId}`).emit("new-message", messageData);
      } catch (error) {
        console.error("Error sending message:", error);
        socket.emit("error", { message: "خطأ في إرسال الرسالة" });
      }
    });

    socket.on("leave-room", async (roomId) => {
      try {
        socket.leave(`room-${roomId}`);

        if (roomUsers.has(roomId)) {
          const usersSet = roomUsers.get(roomId);

          for (const u of usersSet) {
            if (u.socketId === socket.id) {
              usersSet.delete(u);
              break;
            }
          }

          const room = await Room.findByPk(roomId);
          if (room) await room.update({ currentUsers: usersSet.size });

          socket.to(`room-${roomId}`).emit("user-left", {
            userId: socket.userId,
            userName: socket.userName,
            message: `${socket.userName} غادر الغرفة`,
          });

          const currentUsers = Array.from(usersSet).map((u) => ({
            id: u.id,
            name: u.name,
          }));
          io.to(`room-${roomId}`).emit("room-users", currentUsers);

          if (usersSet.size === 0) roomUsers.delete(roomId);
        }
      } catch (error) {
        console.error("Error leaving room:", error);
      }
    });

    socket.on("typing", (data) => {
      const { roomId, isTyping } = data;
      socket.to(`room-${roomId}`).emit("user-typing", {
        userId: socket.userId,
        userName: socket.userName,
        isTyping,
      });
    });

    socket.on("disconnect", async () => {
      console.log(`User ${socket.userName} disconnected`);

      // ✅ remove from online map
      connectedUsers.delete(String(socket.userId));

      // remove from rooms
      for (const [roomId, usersSet] of roomUsers.entries()) {
        let removed = false;

        for (const u of usersSet) {
          if (u.socketId === socket.id) {
            usersSet.delete(u);
            removed = true;
            break;
          }
        }

        if (removed) {
          const room = await Room.findByPk(roomId);
          if (room) await room.update({ currentUsers: usersSet.size });

          socket.to(`room-${roomId}`).emit("user-left", {
            userId: socket.userId,
            userName: socket.userName,
            message: `${socket.userName} غادر الغرفة`,
          });

          const currentUsers = Array.from(usersSet).map((u) => ({
            id: u.id,
            name: u.name,
          }));
          io.to(`room-${roomId}`).emit("room-users", currentUsers);
        }

        if (usersSet.size === 0) roomUsers.delete(roomId);
      }
    });
  });
}

module.exports = {
  initializeSocketIO,
  connectedUsers,
};
