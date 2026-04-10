const jwt = require("jsonwebtoken");
const { User, Message, Room } = require("../models");

// roomId -> Set({ id, name, socketId })
const roomUsers = new Map();

// userId -> socketId
const connectedUsers = new Map();
const kickedUsers = new Map();

function normalizeUserPayload(user) {
  if (!user) return null;
  const plainUser = typeof user.toJSON === "function" ? user.toJSON() : { ...user };
  if (plainUser.images) {
    plainUser.image = Array.isArray(plainUser.images) && plainUser.images.length > 0
      ? plainUser.images[0]
      : null;
    delete plainUser.images;
  }
  return plainUser;
}

function normalizeMessagePayload(message, fallbackUser) {
  const plainMessage = typeof message.toJSON === "function" ? message.toJSON() : { ...message };
  plainMessage.user = normalizeUserPayload(plainMessage.user) ?? fallbackUser ?? null;

  if (plainMessage.replyTo) {
    const replyMessage = typeof plainMessage.replyTo.toJSON === "function"
      ? plainMessage.replyTo.toJSON()
      : { ...plainMessage.replyTo };
    replyMessage.user = normalizeUserPayload(replyMessage.user);
    plainMessage.replyTo = replyMessage;
  }

  return plainMessage;
}

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

      const user = await User.findByPk(userId, { attributes: ["id", "name", "images"] });
      if (!user) return next(new Error("User not found"));

      socket.userId = user.id;
      socket.userName = user.name;
      socket.userImage = (user.images && user.images.length > 0) ? user.images[0] : null;

      next();
    } catch (error) {
      next(new Error("Authentication error"));
    }
  });

  io.on("connection", (socket) => {
    console.log(`User ${socket.userName} connected (${socket.id})`);

    // âœ… register online user
    connectedUsers.set(String(socket.userId), socket.id);

    socket.on("join-room", async (roomId) => {
      try {
        const room = await Room.findByPk(roomId);
        if (!room || !room.isActive) {
          socket.emit("error", { message: "Ø§Ù„ØºØ±ÙØ© ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯Ø© Ø£Ùˆ ØºÙŠØ± Ù†Ø´Ø·Ø©" });
          return;
        }

        const kickedMap = kickedUsers.get(roomId);
        if (kickedMap && kickedMap.has(String(socket.userId))) {
          const expireAt = kickedMap.get(String(socket.userId));

          if (Date.now() < expireAt) {
            const secondsLeft = Math.ceil((expireAt - Date.now()) / 1000);

            socket.emit("kicked-block", {
              roomId,
              message: `Ø§Ù†Øª Ù…Ø·Ø±ÙˆØ¯ Ù…Ù† Ù‡Ø°Ù‡ Ø§Ù„ØºØ±ÙØ©`,
              secondsLeft,
              expireAt,
            });
            return; 
          } else {
            kickedMap.delete(String(socket.userId));
            if (kickedMap.size === 0) kickedUsers.delete(roomId);
          }
        }

        socket.join(`room-${roomId}`);

        if (!roomUsers.has(roomId)) roomUsers.set(roomId, new Set());
        const usersSet = roomUsers.get(roomId);

        const alreadyJoined = [...usersSet].some((u) => u.id === socket.userId);

        if (!alreadyJoined) {
          usersSet.add({
            id: socket.userId,
            name: socket.userName,
            image: socket.userImage,
            socketId: socket.id,
          });
          await room.update({ currentUsers: usersSet.size });
        }

        socket.emit("joined-room", {
          roomId,
          message: `Ù…Ø±Ø­Ø¨Ø§Ù‹ Ø¨Ùƒ ÙÙŠ ØºØ±ÙØ© ${room.name}`,
        });

        if (!alreadyJoined) {
          socket.to(`room-${roomId}`).emit("user-joined", {
            userId: socket.userId,
            userName: socket.userName,
            userImage: socket.userImage,
            message: `${socket.userName} Ø§Ù†Ø¶Ù… Ø¥Ù„Ù‰ Ø§Ù„ØºØ±ÙØ©`,
          });
        }

        const currentUsers = Array.from(usersSet).map((u) => ({
          id: u.id,
          name: u.name,
          image: u.image,
        }));
        io.to(`room-${roomId}`).emit("room-users", currentUsers);
      } catch (error) {
        console.error("Error joining room:", error);
        socket.emit("error", { message: "Ø®Ø·Ø£ ÙÙŠ Ø§Ù„Ø§Ù†Ø¶Ù…Ø§Ù… Ù„Ù„ØºØ±ÙØ©" });
      }
    });

    socket.on("send-message", async (data) => {
      try {
        const { roomId, content, messageType = "text", replyToId } = data;

        const room = await Room.findByPk(roomId);
        if (!room || !room.isActive) {
          socket.emit("error", { message: "Ø§Ù„ØºØ±ÙØ© ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯Ø©" });
          return;
        }

        let replyMessage = null;
        if (replyToId != null) {
          replyMessage = await Message.findOne({
            where: {
              id: replyToId,
              roomId,
              isDeleted: false,
            },
            include: [{
              model: User,
              as: "user",
              attributes: ["id", "name", "images"],
            }],
          });

          if (!replyMessage) {
            socket.emit("error", { message: "الرسالة المراد الرد عليها غير موجودة" });
            return;
          }
        }

        const message = await Message.create({
          roomId,
          userId: socket.userId,
          content,
          messageType,
          replyToId: replyMessage?.id ?? null,
        });

        const messageData = normalizeMessagePayload({
          ...message.toJSON(),
          user: {
            id: socket.userId,
            name: socket.userName,
            image: socket.userImage,
          },
          replyTo: replyMessage,
        });

        io.to(`room-${roomId}`).emit("new-message", messageData);
      } catch (error) {
        console.error("Error sending message:", error);
        socket.emit("error", { message: "Ø®Ø·Ø£ ÙÙŠ Ø¥Ø±Ø³Ø§Ù„ Ø§Ù„Ø±Ø³Ø§Ù„Ø©" });
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
            message: `${socket.userName} ØºØ§Ø¯Ø± Ø§Ù„ØºØ±ÙØ©`,
          });

          const currentUsers = Array.from(usersSet).map((u) => ({
            id: u.id,
            name: u.name,
            image: u.image,
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

    socket.on("kick-user", async ({ roomId, userId }) => {
      try {
        const room = await Room.findByPk(roomId);
        if (!room || !room.isActive) {
          socket.emit("error", { message: "Ø§Ù„ØºØ±ÙØ© ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯Ø©" });
          return;
        }

        if (String(userId) === String(socket.userId)) {
          socket.emit("error", { message: "Ù…Ø§ ØªÚ¯Ø¯Ø± ØªØ·Ø±Ø¯ Ù†ÙØ³Ùƒ" });
          return;
        }

        const me = await User.findByPk(socket.userId, { attributes: ["id", "role"] });
        const isAdmin = me?.role === "admin";
        const isCreator = String(room.creatorId) === String(socket.userId);

        if (!isAdmin && !isCreator) {
          socket.emit("error", { message: "ØºÙŠØ± Ù…ØµØ±Ø­" });
          return;
        }

        const DURATION_SECONDS = 6 * 60 * 60; // 21600
        const expireAt = Date.now() + DURATION_SECONDS * 1000;

        // âœ… Ø®Ø²Ù‘Ù† Ø§Ù„Ø­Ø¸Ø±
        if (!kickedUsers.has(roomId)) kickedUsers.set(roomId, new Map());
        kickedUsers.get(roomId).set(String(userId), expireAt);

        const usersSet = roomUsers.get(roomId);
        let target = null;
        if (usersSet) {
          target = [...usersSet].find((u) => String(u.id) === String(userId));
          if (target) usersSet.delete(target);
        }

        const targetSocketId = target?.socketId || connectedUsers.get(String(userId));
        const targetSocket = targetSocketId
          ? io.sockets.sockets.get(targetSocketId)
          : null;

        if (targetSocket) {
          targetSocket.leave(`room-${roomId}`);
          targetSocket.emit("kicked", {
            roomId,
            message: "ØªÙ… Ø·Ø±Ø¯Ùƒ Ù…Ù† Ø§Ù„ØºØ±ÙØ© Ù„Ù…Ø¯Ø© 6 Ø³Ø§Ø¹Ø§Øª",
            expireAt,
          });
        }

        if (usersSet) {
          await room.update({ currentUsers: usersSet.size });
        }

        socket.to(`room-${roomId}`).emit("user-left", {
          userId: String(userId),
          message: "ØªÙ… Ø·Ø±Ø¯ Ø§Ù„Ù…Ø³ØªØ®Ø¯Ù… Ù…Ù† Ø§Ù„ØºØ±ÙØ©",
        });

        if (usersSet) {
          const currentUsers = Array.from(usersSet).map((u) => ({
            id: u.id,
            name: u.name,
            image: u.image,
          }));
          io.to(`room-${roomId}`).emit("room-users", currentUsers);

          if (usersSet.size === 0) roomUsers.delete(roomId);
        }
      } catch (e) {
        console.error("kick-user error:", e);
        socket.emit("error", { message: "Ø®Ø·Ø£ Ø¨Ø§Ù„Ø·Ø±Ø¯" });
      }
    });



        socket.on("disconnect", async () => {
          console.log(`User ${socket.userName} disconnected`);

          // âœ… remove from online map
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
                message: `${socket.userName} ØºØ§Ø¯Ø± Ø§Ù„ØºØ±ÙØ©`,
              });

              const currentUsers = Array.from(usersSet).map((u) => ({
                id: u.id,
                name: u.name,
                image: u.image,
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
  roomUsers,
};

