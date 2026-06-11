const jwt = require("jsonwebtoken");
const { User, Message, Room } = require("../models");
const { maskArabicProfanity } = require("../services/profanityFilter");
const { attachActiveUserFrames } = require("../services/roomLeaderboard");
const roomsRouter = require("../routes/rooms");

const cleanupRoomVoiceParticipant = roomsRouter.cleanupRoomVoiceParticipant;
const syncRoomAudioPlaybackPresence = roomsRouter.syncRoomAudioPlaybackPresence;
const canManageRoom = roomsRouter.canManageRoom;

// roomId -> Set({ id, name, socketId })
const roomUsers = new Map();

// userId -> latest socketId
const connectedUsers = new Map();
const kickedUsers = new Map();

function pruneExpiredKickedUsers(now = Date.now()) {
  for (const [roomId, kickedMap] of kickedUsers.entries()) {
    for (const [userId, expireAt] of kickedMap.entries()) {
      if (!expireAt || expireAt <= now) {
        kickedMap.delete(userId);
      }
    }

    if (kickedMap.size === 0) {
      kickedUsers.delete(roomId);
    }
  }
}

async function normalizeUserPayload(user) {
  if (!user) return null;
  const [plainUser] = await attachActiveUserFrames([user]);
  if (!plainUser) return null;
  if (plainUser.images) {
    plainUser.image = Array.isArray(plainUser.images) && plainUser.images.length > 0
      ? plainUser.images[0]
      : null;
    delete plainUser.images;
  }
  return plainUser;
}

async function normalizeMessagePayload(message, fallbackUser) {
  const plainMessage = typeof message.toJSON === "function" ? message.toJSON() : { ...message };
  plainMessage.user = (await normalizeUserPayload(plainMessage.user)) ?? fallbackUser ?? null;

  if (plainMessage.replyTo) {
    const replyMessage = typeof plainMessage.replyTo.toJSON === "function"
      ? plainMessage.replyTo.toJSON()
      : { ...plainMessage.replyTo };
    replyMessage.user = await normalizeUserPayload(replyMessage.user);
    plainMessage.replyTo = replyMessage;
  }

  return plainMessage;
}

async function refreshConnectedUserFrame(io, userId) {
  if (!io || userId == null) {
    return null;
  }

  const user = await User.findByPk(userId, {
    attributes: ["id", "name", "images", "isActive"],
  });
  const normalizedUser = await normalizeUserPayload(user);
  const activeFrame = normalizedUser?.activeFrame ?? null;
  const image = normalizedUser?.image ?? null;

  const targetSocketId = connectedUsers.get(String(userId));
  const targetSocket = targetSocketId ? io.sockets.sockets.get(targetSocketId) : null;
  if (targetSocket) {
    targetSocket.userImage = image;
    targetSocket.userFrame = activeFrame;
  }

  for (const [roomId, usersSet] of roomUsers.entries()) {
    let updated = false;
    const nextUsers = new Set();

    for (const currentUser of usersSet) {
      if (String(currentUser.id) === String(userId)) {
        nextUsers.add({
          ...currentUser,
          image,
          activeFrame,
        });
        updated = true;
      } else {
        nextUsers.add(currentUser);
      }
    }

    if (!updated) {
      continue;
    }

    roomUsers.set(roomId, nextUsers);
    const currentUsers = Array.from(nextUsers).map((entry) => ({
      id: entry.id,
      name: entry.name,
      image: entry.image,
      activeFrame: entry.activeFrame ?? null,
    }));
    io.to(`room-${roomId}`).emit("room-users", currentUsers);
  }

  return normalizedUser;
}

function initializeSocketIO(io) {
  const isBlockedRoomShortcutMessage = (value) => {
    if (typeof value !== "string") return false;
    return /^#\s*\+/.test(value.trim());
  };

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

      const user = await User.findByPk(userId, { attributes: ["id", "name", "images", "isActive"] });
      if (!user) return next(new Error("User not found"));
      if (user.isActive === false) {
        return next(new Error("تم حظر حسابك"));
      }

      const normalizedUser = await normalizeUserPayload(user);

      socket.userId = user.id;
      socket.userName = user.name;
      socket.userImage = normalizedUser?.image ?? null;
      socket.userFrame = normalizedUser?.activeFrame ?? null;

      next();
    } catch (error) {
      next(new Error("Authentication error"));
    }
  });

  io.on("connection", (socket) => {
    console.log(`User ${socket.userName} connected (${socket.id})`);
    socket.data.joinedRoomIds = new Set();

    // âœ… register online user
    connectedUsers.set(String(socket.userId), socket.id);

    socket.on("join-room", async (roomId) => {
      try {
        pruneExpiredKickedUsers();
        const room = await Room.findByPk(roomId);
        if (!room || !room.isActive) {
          socket.emit("error", { message: "الغرفة غير موجودة أو غير نشطة" });
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
        socket.data.joinedRoomIds.add(String(roomId));

        if (!roomUsers.has(roomId)) roomUsers.set(roomId, new Set());
        const usersSet = roomUsers.get(roomId);

        const alreadyJoined = [...usersSet].some((u) => u.id === socket.userId);

        if (!alreadyJoined) {
          usersSet.add({
              id: socket.userId,
              name: socket.userName,
              image: socket.userImage,
              activeFrame: socket.userFrame,
              socketId: socket.id,
            });
            await room.update({ currentUsers: usersSet.size });
            await syncRoomAudioPlaybackPresence(io, roomId, usersSet.size > 0);
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
            activeFrame: socket.userFrame,
          message: `${socket.userName} انضم إلى الغرفة`,
          });
        }

        const currentUsers = Array.from(usersSet).map((u) => ({
          id: u.id,
          name: u.name,
          image: u.image,
          activeFrame: u.activeFrame ?? null,
        }));
        io.to(`room-${roomId}`).emit("room-users", currentUsers);
      } catch (error) {
        console.error("Error joining room:", error);
        socket.emit("error", { message: "خطأ في الانضمام للغرفة" });
      }
    });

    socket.on("send-message", async (data) => {
      try {
        const { roomId, content, messageType = "text", replyToId } = data;
        pruneExpiredKickedUsers();

        if (messageType === "text" && isBlockedRoomShortcutMessage(content)) {
          socket.emit("error", {
            message: "هذا النمط من الرسائل غير مسموح داخل الغرف",
          });
          return;
        }

        const kickedMap = kickedUsers.get(roomId);
        if (kickedMap && kickedMap.has(String(socket.userId))) {
          const expireAt = kickedMap.get(String(socket.userId));
          if (expireAt && Date.now() < expireAt) {
            socket.emit("kicked-block", {
              roomId,
              message: "أنت مطرود من هذه الغرفة",
              secondsLeft: Math.max(0, Math.floor((expireAt - Date.now()) / 1000)),
            });
            return;
          }
          kickedMap.delete(String(socket.userId));
          if (kickedMap.size === 0) kickedUsers.delete(roomId);
        }

        if (!socket.rooms.has(`room-${roomId}`)) {
          socket.emit("error", { message: "أنت لست داخل الغرفة" });
          return;
        }

        const room = await Room.findByPk(roomId);
        if (!room || !room.isActive) {
          socket.emit("error", { message: "الغرفة غير موجودة" });
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

        const filteredContent =
          typeof content === "string" ? maskArabicProfanity(content) : content;

        const message = await Message.create({
          roomId,
          userId: socket.userId,
          content: filteredContent,
          messageType,
          replyToId: replyMessage?.id ?? null,
        });

        const createdMessage = await Message.findByPk(message.id, {
          include: [
            {
              model: User,
              as: "user",
              attributes: ["id", "name", "images"],
            },
            {
              model: Message,
              as: "replyTo",
              required: false,
              where: { isDeleted: false },
              include: [{
                model: User,
                as: "user",
                attributes: ["id", "name", "images"],
              }],
            },
          ],
        });

        const messageData = await normalizeMessagePayload(
          createdMessage || {
            ...message.toJSON(),
            user: {
              id: socket.userId,
              name: socket.userName,
              image: socket.userImage,
              activeFrame: socket.userFrame,
            },
            replyTo: replyMessage,
          },
        );

        io.to(`room-${roomId}`).emit("new-message", messageData);
      } catch (error) {
        console.error("Error sending message:", error);
        socket.emit("error", { message: "خطأ في إرسال الرسالة" });
      }
    });

    socket.on("leave-room", async (roomId) => {
      try {
        socket.leave(`room-${roomId}`);
        socket.data.joinedRoomIds?.delete(String(roomId));
        await cleanupRoomVoiceParticipant(io, roomId, socket.userId);

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
            image: u.image,
            activeFrame: u.activeFrame ?? null,
          }));
            io.to(`room-${roomId}`).emit("room-users", currentUsers);

          await syncRoomAudioPlaybackPresence(io, roomId, usersSet.size > 0);
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
          socket.emit("error", { message: "الغرفة غير موجودة" });
          return;
        }

        if (String(userId) === String(socket.userId)) {
          socket.emit("error", { message: "ما تگدر تطرد نفسك" });
          return;
        }

        const me = await User.findByPk(socket.userId, { attributes: ["id", "role"] });
        const canKick = canManageRoom?.(room, {
          id: socket.userId,
          role: me?.role,
        }) === true;

        if (!canKick) {
          socket.emit("error", { message: "غير مصرح" });
          return;
        }

        const DURATION_SECONDS = 6 * 60 * 60;
        const expireAt = Date.now() + DURATION_SECONDS * 1000;

        pruneExpiredKickedUsers();
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
          targetSocket.data?.joinedRoomIds?.delete(String(roomId));
          targetSocket.emit("kicked", {
            roomId,
            message: "تم طردك من الغرفة لمدة 6 ساعات",
            expireAt,
          });
        }

        await cleanupRoomVoiceParticipant(io, roomId, userId);

        if (usersSet) {
          await room.update({ currentUsers: usersSet.size });
        }

        socket.to(`room-${roomId}`).emit("user-left", {
          userId: String(userId),
          message: "تم طرد المستخدم من الغرفة",
        });

        if (usersSet) {
          const currentUsers = Array.from(usersSet).map((u) => ({
            id: u.id,
            name: u.name,
            image: u.image,
          }));
            io.to(`room-${roomId}`).emit("room-users", currentUsers);

          await syncRoomAudioPlaybackPresence(io, roomId, usersSet.size > 0);
          if (usersSet.size === 0) roomUsers.delete(roomId);
        }
      } catch (e) {
        console.error("kick-user error:", e);
        socket.emit("error", { message: "خطأ بالطرد" });
      }
    });



        socket.on("disconnect", async () => {
          console.log(`User ${socket.userName} disconnected`);

          // âœ… remove from online map
          if (connectedUsers.get(String(socket.userId)) === socket.id) {
            connectedUsers.delete(String(socket.userId));
          }

          // remove from rooms
          const joinedRoomIds = Array.from(socket.data.joinedRoomIds || []);
          for (const roomId of joinedRoomIds) {
            const usersSet = roomUsers.get(roomId);
            if (!usersSet) {
              continue;
            }
            let removed = false;

            for (const u of usersSet) {
              if (u.socketId === socket.id) {
                usersSet.delete(u);
                removed = true;
                break;
              }
            }

            if (removed) {
              await cleanupRoomVoiceParticipant(io, roomId, socket.userId);

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
                image: u.image,
                activeFrame: u.activeFrame ?? null,
              }));
              io.to(`room-${roomId}`).emit("room-users", currentUsers);
              await syncRoomAudioPlaybackPresence(io, roomId, usersSet.size > 0);
              if (usersSet.size === 0) roomUsers.delete(roomId);
            }
          }
        });
      });
    }

module.exports = {
  initializeSocketIO,
  connectedUsers,
  roomUsers,
  refreshConnectedUserFrame,
};
