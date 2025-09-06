const jwt = require("jsonwebtoken");
const User = require("../models/user");
const Room = require("../models/room");
const Message = require("../models/message");

// تخزين المستخدمين المتصلين في كل غرفة
const roomUsers = new Map();

function initializeSocketIO(io) {
    io.use(async (socket, next) => {
        try {
            const token = socket.handshake.auth.token;
            if (!token) {
                return next(new Error("Authentication error"));
            }
            
            const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key-123456789');
            // التحقق من وجود id أو userId في التوكن
            const userId = decoded.id || decoded.userId;
            if (!userId) {
                return next(new Error("Invalid token - no user ID"));
            }
            
            const user = await User.findByPk(userId);
            if (!user) {
                return next(new Error("User not found"));
            }
            
            socket.userId = user.id;
            socket.userName = user.name;
            next();
        } catch (error) {
            next(new Error("Authentication error"));
        }
    });

    io.on("connection", (socket) => {
        console.log(`User ${socket.userName} connected`);

        // الانضمام إلى غرفة
        socket.on("join-room", async (roomId) => {
            try {
                const room = await Room.findByPk(roomId);
                if (!room || !room.isActive) {
                    socket.emit("error", { message: "الغرفة غير موجودة أو غير نشطة" });
                    return;
                }

                socket.join(`room-${roomId}`);

                if (!roomUsers.has(roomId)) {
                    roomUsers.set(roomId, new Set());
                }
                const usersSet = roomUsers.get(roomId);

                const alreadyJoined = [...usersSet].some(u => u.id === socket.userId);
                if (!alreadyJoined) {
                    usersSet.add({ id: socket.userId, name: socket.userName, socketId: socket.id });
                    await room.update({ currentUsers: usersSet.size });
                }

                socket.emit("joined-room", { 
                    roomId, 
                    message: `مرحباً بك في غرفة ${room.name}` 
                });

                if (!alreadyJoined) {
                    socket.to(`room-${roomId}`).emit("user-joined", {
                        userId: socket.userId,
                        userName: socket.userName,
                        message: `${socket.userName} انضم إلى الغرفة`
                    });
                }

                const currentUsers = Array.from(usersSet).map(user => ({
                    id: user.id,
                    name: user.name
                }));
                io.to(`room-${roomId}`).emit("room-users", currentUsers);

            } catch (error) {
                console.error("Error joining room:", error);
                socket.emit("error", { message: "خطأ في الانضمام للغرفة" });
            }
        });

        // إرسال رسالة
        socket.on("send-message", async (data) => {
            try {
                const { roomId, content, messageType = 'text' } = data;
                
                // التحقق من أن المستخدم في الغرفة
                const room = await Room.findByPk(roomId);
                if (!room || !room.isActive) {
                    socket.emit("error", { message: "الغرفة غير موجودة" });
                    return;
                }

                // حفظ الرسالة في قاعدة البيانات
                const message = await Message.create({
                    roomId,
                    userId: socket.userId,
                    content,
                    messageType
                });

                // جلب معلومات المستخدم
                const user = await User.findByPk(socket.userId, {
                    attributes: ['id', 'name']
                });

                const messageData = {
                    id: message.id,
                    content: message.content,
                    messageType: message.messageType,
                    createdAt: message.createdAt,
                    user: {                
                        id: user.id,
                        name: user.name
                    }
                };

                io.to(`room-${roomId}`).emit("new-message", messageData);

            } catch (error) {
                console.error("Error sending message:", error);
                socket.emit("error", { message: "خطأ في إرسال الرسالة" });
            }
        });

        // مغادرة الغرفة
        socket.on("leave-room", async (roomId) => {
            try {
                socket.leave(`room-${roomId}`);
                
                // إزالة المستخدم من قائمة الغرفة
                if (roomUsers.has(roomId)) {
                    const users = roomUsers.get(roomId);
                    for (let user of users) {
                        if (user.socketId === socket.id) {
                            users.delete(user);
                            break;
                        }
                    }
                    
                    // إذا لم يتبق مستخدمين، حذف الغرفة من الخريطة
                    if (users.size === 0) {
                        roomUsers.delete(roomId);
                    }
                }

                // تحديث عدد المستخدمين في الغرفة
                const room = await Room.findByPk(roomId);
                if (room && room.currentUsers > 0) {
                    await room.update({ currentUsers: room.currentUsers - 1 });
                }

                // إعلام باقي المستخدمين
                socket.to(`room-${roomId}`).emit("user-left", {
                    userId: socket.userId,
                    userName: socket.userName,
                    message: `${socket.userName} غادر الغرفة`
                });

                // إرسال قائمة المستخدمين المحدثة
                if (roomUsers.has(roomId)) {
                    const currentUsers = Array.from(roomUsers.get(roomId)).map(user => ({
                        id: user.id,
                        name: user.name
                    }));
                    io.to(`room-${roomId}`).emit("room-users", currentUsers);
                }

            } catch (error) {
                console.error("Error leaving room:", error);
            }
        });

        // الكتابة
        socket.on("typing", (data) => {
            const { roomId, isTyping } = data;
            socket.to(`room-${roomId}`).emit("user-typing", {
                userId: socket.userId,
                userName: socket.userName,
                isTyping
            });
        });

        socket.on("disconnect", async () => {
            console.log(`User ${socket.userName} disconnected`);
            
            // إزالة المستخدم من جميع الغرف التي كان فيها
            for (let [roomId, users] of roomUsers.entries()) {
                for (let user of users) {
                    if (user.socketId === socket.id) {
                        users.delete(user);
                        
                        // تحديث عدد المستخدمين
                        const room = await Room.findByPk(roomId);
                        if (room && room.currentUsers > 0) {
                            await room.update({ currentUsers: room.currentUsers - 1 });
                        }
                        
                        // إعلام باقي المستخدمين
                        socket.to(`room-${roomId}`).emit("user-left", {
                            userId: socket.userId,
                            userName: socket.userName,
                            message: `${socket.userName} غادر الغرفة`
                        });
                        
                        break;
                    }
                }
                
                // إذا لم يتبق مستخدمين، حذف الغرفة من الخريطة
                if (users.size === 0) {
                    roomUsers.delete(roomId);
                }
            }
        });
    });
}

module.exports = initializeSocketIO;
