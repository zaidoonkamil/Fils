const express = require("express");
const router = express.Router();
const Room = require("../models/room");
const Message = require("../models/message");
const User = require("../models/user");
const jwt = require("jsonwebtoken");
const { AccessToken } = require("livekit-server-sdk");
const Settings = require("../models/settings");
const upload = require("../middlewares/uploads");
const { attachActiveRoomFrames, attachActiveUserFrames } = require("../services/roomLeaderboard");

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

async function normalizeMessagePayload(message) {
    const plainMessage = typeof message.toJSON === "function" ? message.toJSON() : { ...message };
    plainMessage.user = await normalizeUserPayload(plainMessage.user);

    if (plainMessage.replyTo) {
        const replyMessage = typeof plainMessage.replyTo.toJSON === "function"
            ? plainMessage.replyTo.toJSON()
            : { ...plainMessage.replyTo };

        replyMessage.user = await normalizeUserPayload(replyMessage.user);
        plainMessage.replyTo = replyMessage;
    }

    return plainMessage;
}

function canManageRoom(room, user) {
    if (!room || !user) return false;
    if (user.role === "admin") return true;
    return String(room.creatorId) === String(user.id);
}

function normalizeRoomNameInput(value) {
    if (value === undefined || value === null) {
        return "";
    }
    return String(value).trim().replace(/\s+/g, " ");
}

function extractImage(images) {
    if (Array.isArray(images) && images.length > 0) {
        return images[0] ? String(images[0]) : "";
    }
    if (typeof images === "string" && images.trim().length > 0) {
        return images.trim();
    }
    return "";
}

function normalizeVoiceIdArray(value) {
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    const result = [];
    for (const item of value) {
        const id = Number(item);
        if (!Number.isFinite(id) || id <= 0 || seen.has(id)) continue;
        seen.add(id);
        result.push(id);
    }
    return result;
}

function getLiveKitRoomName(roomId) {
    return `room-voice-${roomId}`;
}

async function getRoomVoicePackageSettings() {
    const [mic3PriceSetting, mic3HoursSetting] = await Promise.all([
        Settings.findOne({ where: { key: "room_voice_mic_3_price" } }),
        Settings.findOne({ where: { key: "room_voice_mic_3_hours" } }),
    ]);

    return {
        packages: [
            {
                micCount: 3,
                price: mic3PriceSetting ? parseInt(mic3PriceSetting.value, 10) || 0 : 0,
                hours: mic3HoursSetting ? parseInt(mic3HoursSetting.value, 10) || 0 : 0,
            },
        ],
    };
}

async function normalizeRoomVoiceState(room, { persist = false } = {}) {
    let voiceMicCount = Number(room.voiceMicCount ?? 0);
    let voicePackageExpiresAt = room.voicePackageExpiresAt ? new Date(room.voicePackageExpiresAt) : null;
    let voiceActiveSpeakerIds = normalizeVoiceIdArray(room.voiceActiveSpeakerIds);
    let voicePendingRequestIds = normalizeVoiceIdArray(room.voicePendingRequestIds)
        .filter((id) => !voiceActiveSpeakerIds.includes(id));

    let changed = false;
    const isActive = voiceMicCount > 0 && voicePackageExpiresAt && voicePackageExpiresAt.getTime() > Date.now();

    if (!isActive) {
        if (voiceMicCount !== 0 || voicePackageExpiresAt || voiceActiveSpeakerIds.length > 0 || voicePendingRequestIds.length > 0) {
            voiceMicCount = 0;
            voicePackageExpiresAt = null;
            voiceActiveSpeakerIds = [];
            voicePendingRequestIds = [];
            changed = true;
        }
    } else if (voiceActiveSpeakerIds.length > voiceMicCount) {
        voiceActiveSpeakerIds = voiceActiveSpeakerIds.slice(0, voiceMicCount);
        voicePendingRequestIds = voicePendingRequestIds.filter((id) => !voiceActiveSpeakerIds.includes(id));
        changed = true;
    }

    if (
        changed ||
        JSON.stringify(room.voiceActiveSpeakerIds ?? []) !== JSON.stringify(voiceActiveSpeakerIds) ||
        JSON.stringify(room.voicePendingRequestIds ?? []) !== JSON.stringify(voicePendingRequestIds) ||
        Number(room.voiceMicCount ?? 0) !== voiceMicCount ||
        String(room.voicePackageExpiresAt ?? "") !== String(voicePackageExpiresAt ?? "")
    ) {
        changed = true;
    }

    if (persist && changed) {
        await room.update({
            voiceMicCount,
            voicePackageExpiresAt,
            voiceActiveSpeakerIds,
            voicePendingRequestIds,
        });
    }

    return {
        voiceMicCount,
        voicePackageExpiresAt,
        voiceActiveSpeakerIds,
        voicePendingRequestIds,
        isActive: voiceMicCount > 0 && !!voicePackageExpiresAt,
    };
}

async function hydrateVoiceUsers(userIds) {
    const normalizedIds = normalizeVoiceIdArray(userIds);
    if (normalizedIds.length === 0) return [];

    const users = await User.findAll({
        where: { id: normalizedIds },
        attributes: ["id", "name", "images", "role"],
    });

    const byId = new Map(
        users.map((user) => [
            Number(user.id),
            {
                id: Number(user.id),
                name: user.name || "مستخدم",
                image: extractImage(user.images),
                role: user.role || "user",
            },
        ]),
    );

    return normalizedIds.map((id) => byId.get(id)).filter(Boolean);
}

async function buildRoomVoicePayload(room, currentUserId = null, currentUserRole = null) {
    const normalized = await normalizeRoomVoiceState(room, { persist: true });
    const settings = await getRoomVoicePackageSettings();
    const [speakers, pendingRequests] = await Promise.all([
        hydrateVoiceUsers(normalized.voiceActiveSpeakerIds),
        hydrateVoiceUsers(normalized.voicePendingRequestIds),
    ]);

    const activeSpeakerIds = speakers.map((speaker) => Number(speaker.id));
    const pendingRequestIds = pendingRequests.map((entry) => Number(entry.id));
    const currentId = currentUserId != null ? Number(currentUserId) : null;
    const isOwner = currentId != null && String(room.creatorId) === String(currentId);
    const canManage = isOwner || currentUserRole === "admin";

    return {
        roomId: Number(room.id),
        isActive: normalized.isActive,
        micCount: normalized.voiceMicCount,
        availableSeats: Math.max(0, normalized.voiceMicCount - activeSpeakerIds.length),
        expiresAt: normalized.voicePackageExpiresAt ? normalized.voicePackageExpiresAt.toISOString() : null,
        livekitRoomName: normalized.isActive ? getLiveKitRoomName(room.id) : null,
        activeSpeakerIds,
        pendingRequestIds,
        speakers,
        pendingRequests,
        packageOptions: settings.packages,
        currentUser: {
            isOwner,
            canManage,
            isSpeaker: currentId != null ? activeSpeakerIds.includes(currentId) : false,
            hasPendingRequest: currentId != null ? pendingRequestIds.includes(currentId) : false,
        },
    };
}

async function emitRoomVoiceUpdated(app, room) {
    const roomsIO = app.get("roomsIO");
    if (!roomsIO) return;
    const voiceState = await buildRoomVoicePayload(room);
    roomsIO.to(`room-${room.id}`).emit("room-voice-updated", {
        roomId: Number(room.id),
        voiceState,
    });
}

async function emitRoomVoiceUpdatedToIO(roomsIO, room) {
    if (!roomsIO || !room) return;
    const voiceState = await buildRoomVoicePayload(room);
    roomsIO.to(`room-${room.id}`).emit("room-voice-updated", {
        roomId: Number(room.id),
        voiceState,
    });
}

async function cleanupRoomVoiceParticipant(roomsIO, roomId, userId) {
    const numericRoomId = Number(roomId);
    const numericUserId = Number(userId);

    if (!Number.isFinite(numericRoomId) || numericRoomId <= 0 || !Number.isFinite(numericUserId) || numericUserId <= 0) {
        return false;
    }

    const room = await Room.findByPk(numericRoomId);
    if (!room) return false;

    const normalized = await normalizeRoomVoiceState(room, { persist: true });
    const nextSpeakers = normalized.voiceActiveSpeakerIds.filter((id) => id !== numericUserId);
    const nextPending = normalized.voicePendingRequestIds.filter((id) => id !== numericUserId);

    if (
        nextSpeakers.length === normalized.voiceActiveSpeakerIds.length &&
        nextPending.length === normalized.voicePendingRequestIds.length
    ) {
        return false;
    }

    await room.update({
        voiceActiveSpeakerIds: nextSpeakers,
        voicePendingRequestIds: nextPending,
    });

    await emitRoomVoiceUpdatedToIO(roomsIO, room);
    return true;
}

async function buildPinnedMessage(message) {
    if (!message) return null;
    const msg = typeof message.toJSON === "function" ? message.toJSON() : { ...message };
    msg.user = await normalizeUserPayload(msg.user);
    return {
        id: msg.id,
        content: msg.content ?? "",
        messageType: msg.messageType ?? "text",
        createdAt: msg.createdAt,
        user: msg.user ?? null,
    };
}

const authenticateToken = async (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: "Token مطلوب" });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const userId = decoded.id || decoded.userId;
        if (!userId) {
            return res.status(401).json({ error: "Token غير صالح - لا يوجد معرف مستخدم" });
        }
        
        const user = await User.findByPk(userId);
        if (!user) {
            return res.status(401).json({ error: "المستخدم غير موجود" });
        }
        if (user.isActive === false) {
            return res.status(403).json({ error: "تم حظر حسابك" });
        }
        req.user = user;
        next();
    } catch (error) {
        return res.status(403).json({ error: "Token غير صالح" });
    }
};

// إضافة نقاط sawa للمستخدم للاختبار
router.post("/add-sawa", authenticateToken, async (req, res) => {
    try {
        const { amount = 1000 } = req.body;
        
        await req.user.update({
            sawa: req.user.sawa + amount
        });
        
        res.json({
            message: `تم إضافة ${amount} نقطة sawa`,
            newBalance: req.user.sawa + amount
        });
    } catch (error) {
        res.status(500).json({ error: "خطأ في إضافة النقاط" });
    }
});

// إنشاء مستخدمين متعددين للاختبار
router.post("/create-test-users", async (req, res) => {
    try {
        const users = [];
        
        // إنشاء 5 مستخدمين للاختبار
        for (let i = 1; i <= 5; i++) {
            const userId = 547000 + i;
            
            // التحقق من وجود المستخدم
            let user = await User.findByPk(userId);
            
            if (!user) {
                // إنشاء مستخدم جديد
                user = await User.create({
                    id: userId,
                    name: `مستخدم ${i}`,
                    email: `user${i}@test.com`,
                    phone: `123456789${i}`,
                    location: 'الرياض',
                    password: '123456',
                    role: 'user',
                    Jewel: 1000,
                    sawa: 2000,
                    card: 0,
                    dolar: 0,
                    isVerified: true,
                    isLoggedIn: false
                });
            } else {
                // تحديث النقاط إذا كان المستخدم موجود
                await user.update({
                    sawa: 2000,
                    Jewel: 1000
                });
            }
            
            const token = jwt.sign({ id: userId }, process.env.JWT_SECRET || 'your-secret-key-123456789');
            
            users.push({
                id: userId,
                name: user.name,
                token: token,
                sawa: user.sawa,
                Jewel: user.Jewel
            });
        }
        
        res.json({
            message: "تم إنشاء المستخدمين بنجاح",
            users: users
        });
        
    } catch (error) {
        console.error("خطأ في إنشاء المستخدمين:", error);
        res.status(500).json({ error: "خطأ في إنشاء المستخدمين" });
    }
});

// إنشاء غرفة جديدة
router.post("/create-room", authenticateToken, upload.array("images", 5), async (req, res) => {
    try {
        const { name, description, cost, maxUsers, category } = req.body;

        const existingRoom = await Room.findOne({
            where: { creatorId: req.user.id }
        });

        if (existingRoom) {
            return res.status(400).json({
                error: "لا يمكن إنشاء أكثر من غرفة واحدة لكل مستخدم"
            });
        }
        
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ error: "الرجاء رفع صورة واحدة على الأقل" });
        }
        
        const images = req.files.map(file => file.filename);
        
        if (req.user.sawa < cost) {
            return res.status(400).json({ 
                error: "نقاط غير كافية لإنشاء الغرفة",
                required: cost,
                available: req.user.sawa
            });
        }

        const room = await Room.create({
            name,
            description,
            creatorId: req.user.id,
            cost,
            maxUsers: maxUsers || 50,
            category: category || 'general',
            images: images || []
        });

        // خصم النقاط من المستخدم
        await req.user.update({
            sawa: req.user.sawa - cost
        });

        res.status(201).json({
            message: "تم إنشاء الغرفة بنجاح",
            room,
            remainingSawa: req.user.sawa - cost
        });

    } catch (error) {
        console.error("خطأ في إنشاء الغرفة:", error);
        res.status(500).json({ error: "خطأ في إنشاء الغرفة" });
    }
});

// البحث عن غرفة باستخدام id أو name
router.get("/search-rooms", authenticateToken, async (req, res) => {
    try {
        const { query } = req.query;
        const { Op } = require("sequelize");
        
        if (!query) {
            return res.status(400).json({ error: "الرجاء توفير كلمة البحث" });
        }

        let whereClause = { isActive: true };
        const isNumeric = !isNaN(query) && query.trim() !== "";

        if (isNumeric) {
            whereClause[Op.or] = [
                { id: parseInt(query) },
                { name: { [Op.like]: `%${query}%` } }
            ];
        } else {
            whereClause.name = { [Op.like]: `%${query}%` };
        }

        const rooms = await Room.findAll({
            where: whereClause,
            include: [{
                model: User,
                as: 'creator',
                attributes: ['id', 'name', 'images'],
                required: false
            }],
            order: [['createdAt', 'DESC']]
        });

        const serializedRooms = await attachActiveRoomFrames(rooms);

        res.json({
            rooms: serializedRooms,
            total: rooms.length
        });

    } catch (error) {
        console.error("خطأ في البحث عن الغرف:", error);
        res.status(500).json({ error: "خطأ في البحث عن الغرف" });
    }
});

// عرض الغرف المتوفرة
router.get("/rooms", authenticateToken, async (req, res) => {
    try {
        const { category, page = 1, limit = 20 } = req.query;
        
        let whereClause = { isActive: true };
        if (category) {
            whereClause.category = category;
        }

        const rooms = await Room.findAndCountAll({
            where: whereClause,
            include: [{
                model: User,
                as: 'creator',
                attributes: ['id', 'name', 'images'],
                required: false  // LEFT JOIN بدلاً من INNER JOIN
            }],
            order: [
                ['currentUsers', 'DESC'],
                ['createdAt', 'DESC']
            ],
            limit: parseInt(limit),
            offset: (parseInt(page) - 1) * parseInt(limit)
        });

        const serializedRooms = await attachActiveRoomFrames(rooms.rows);

        res.json({
            rooms: serializedRooms,
            total: rooms.count,
            currentPage: parseInt(page),
            totalPages: Math.ceil(rooms.count / parseInt(limit))
        });

    } catch (error) {
        console.error("خطأ في جلب الغرف:", error);
        console.error("Stack trace:", error.stack);
        res.status(500).json({ 
            error: "خطأ في جلب الغرف"
        });
    }
});

// الحصول على تفاصيل غرفة معينة
router.get("/my-room", authenticateToken, async (req, res) => {
    try {
        const room = await Room.findOne({
            where: { creatorId: req.user.id },
            include: [{
                model: User,
                as: 'creator',
                attributes: ['id', 'name', 'images'],
            }],
            order: [['createdAt', 'DESC']]
        });

        if (!room) {
            return res.status(404).json({ error: "لا توجد غرفة لهذا المستخدم" });
        }

        if (!room.isActive) {
            return res.status(400).json({ error: "آخر غرفة للمستخدم غير نشطة" });
        }

        const [serializedRoom] = await attachActiveRoomFrames([room]);
        res.json({ room: serializedRoom });
    } catch (error) {
        console.error("خطأ في جلب غرفة المستخدم:", error);
        res.status(500).json({ error: "خطأ في جلب غرفة المستخدم" });
    }
});

// الحصول على تفاصيل غرفة معينة
router.get("/room/:roomId", authenticateToken, async (req, res) => {
    try {
        const { roomId } = req.params;
        
        const room = await Room.findByPk(roomId, {
            include: [{
                model: User,
                as: 'creator',
                attributes: ['id', 'name', 'images'],
            }]
        });

        if (!room) {
            return res.status(404).json({ error: "الغرفة غير موجودة" });
        }

        if (!room.isActive) {
            return res.status(400).json({ error: "الغرفة غير نشطة" });
        }

        const [serializedRoom] = await attachActiveRoomFrames([room]);
        res.json({ room: serializedRoom });

    } catch (error) {
        console.error("خطأ في جلب تفاصيل الغرفة:", error);
        res.status(500).json({ error: "خطأ في جلب تفاصيل الغرفة" });
    }
});

// الحصول على رسائل غرفة معينة
router.get("/room/:roomId/messages", authenticateToken, async (req, res) => {
    try {
        const { roomId } = req.params;
        const { page = 1, limit = 10 } = req.query;

        const messages = await Message.findAndCountAll({
            where: { 
                roomId,
                isDeleted: false
            },
            include: [
                {
                    model: User,
                    as: 'user',
                    attributes: ['id', 'name', 'images'],
                },
                {
                    model: Message,
                    as: 'replyTo',
                    required: false,
                    where: { isDeleted: false },
                    include: [{
                        model: User,
                        as: 'user',
                        attributes: ['id', 'name', 'images'],
                    }],
                }
            ],
            order: [['createdAt', 'DESC']],
            limit: parseInt(limit),
            offset: (parseInt(page) - 1) * parseInt(limit)
        });

        const serializedMessages = await Promise.all(
            messages.rows.reverse().map((message) => normalizeMessagePayload(message))
        );

        res.json({
            messages: serializedMessages,
            total: messages.count,
            currentPage: parseInt(page),
            totalPages: Math.ceil(messages.count / parseInt(limit))
        });

    } catch (error) {
        console.error("خطأ في جلب الرسائل:", error);
        res.status(500).json({ error: "خطأ في جلب الرسائل" });
    }
});

// تثبيت رسالة في الغرفة (لصاحب الغرفة أو الأدمن فقط)
router.post("/room/:roomId/pin-message", authenticateToken, async (req, res) => {
    try {
        const { roomId } = req.params;
        const { messageId } = req.body;

        const room = await Room.findByPk(roomId);
        if (!room || !room.isActive) {
            return res.status(404).json({ error: "الغرفة غير موجودة" });
        }

        if (!canManageRoom(room, req.user)) {
            return res.status(403).json({ error: "غير مصرح" });
        }

        if (!messageId) {
            return res.status(400).json({ error: "messageId مطلوب" });
        }

        const message = await Message.findOne({
            where: { id: messageId, roomId, isDeleted: false },
            include: [{
                model: User,
                as: 'user',
                attributes: ['id', 'name', 'images'],
            }],
        });

        if (!message) {
            return res.status(404).json({ error: "الرسالة غير موجودة" });
        }

        const pinnedMessage = await buildPinnedMessage(message);
        await room.update({
            pinnedMessageId: message.id,
            pinnedMessage,
        });

        const roomsIO = req.app.get("roomsIO");
        if (roomsIO) {
            roomsIO.to(`room-${roomId}`).emit("pinned-message", {
                roomId,
                pinnedMessage,
            });
        }

        return res.json({ message: "تم تثبيت الرسالة", pinnedMessage });
    } catch (error) {
        console.error("خطأ في تثبيت الرسالة:", error);
        return res.status(500).json({ error: "خطأ في تثبيت الرسالة" });
    }
});

// إلغاء تثبيت رسالة في الغرفة
router.post("/room/:roomId/unpin-message", authenticateToken, async (req, res) => {
    try {
        const { roomId } = req.params;

        const room = await Room.findByPk(roomId);
        if (!room || !room.isActive) {
            return res.status(404).json({ error: "الغرفة غير موجودة" });
        }

        if (!canManageRoom(room, req.user)) {
            return res.status(403).json({ error: "غير مصرح" });
        }

        await room.update({
            pinnedMessageId: null,
            pinnedMessage: null,
        });

        const roomsIO = req.app.get("roomsIO");
        if (roomsIO) {
            roomsIO.to(`room-${roomId}`).emit("unpinned-message", { roomId });
        }

        return res.json({ message: "تم إلغاء تثبيت الرسالة" });
    } catch (error) {
        console.error("خطأ في إلغاء تثبيت الرسالة:", error);
        return res.status(500).json({ error: "خطأ في إلغاء تثبيت الرسالة" });
    }
});

// جلب الرسالة المثبتة للغرفة
router.get("/room/:roomId/pinned-message", authenticateToken, async (req, res) => {
    try {
        const { roomId } = req.params;

        const room = await Room.findByPk(roomId);
        if (!room || !room.isActive) {
            return res.status(404).json({ error: "الغرفة غير موجودة" });
        }

        return res.json({ pinnedMessage: room.pinnedMessage ?? null });
    } catch (error) {
        console.error("خطأ في جلب الرسالة المثبتة:", error);
        return res.status(500).json({ error: "خطأ في جلب الرسالة المثبتة" });
    }
});

// حذف غرفة (للمنشئ فقط)
router.patch("/room/:roomId/name", authenticateToken, async (req, res) => {
    try {
        const { roomId } = req.params;
        const nextName = normalizeRoomNameInput(req.body?.name);

        if (!nextName) {
            return res.status(400).json({ error: "اسم الروم مطلوب" });
        }

        if (nextName.length > 100) {
            return res.status(400).json({ error: "اسم الروم طويل جدًا" });
        }

        const room = await Room.findByPk(roomId, {
            include: [{
                model: User,
                as: 'creator',
                attributes: ['id', 'name', 'images'],
            }]
        });

        if (!room || !room.isActive) {
            return res.status(404).json({ error: "الغرفة غير موجودة" });
        }

        if (!canManageRoom(room, req.user)) {
            return res.status(403).json({ error: "غير مصرح" });
        }

        const roomNameChangeCostSetting = await Settings.findOne({
            where: { key: "room_name_change_cost" }
        });
        const roomNameChangeCost = roomNameChangeCostSetting
            ? parseInt(roomNameChangeCostSetting.value, 10) || 0
            : 0;

        const currentBalance = Number(req.user.sawa ?? 0);
        if (currentBalance < roomNameChangeCost) {
            return res.status(400).json({
                error: "Ù†Ù‚Ø§Ø· ØºÙŠØ± ÙƒØ§ÙÙŠØ© Ù„ØªØºÙŠÙŠØ± Ø§Ø³Ù… Ø§Ù„Ø±ÙˆÙ…",
                requiredPoints: roomNameChangeCost,
                availablePoints: currentBalance,
            });
        }

        const remainingSawa = currentBalance - roomNameChangeCost;
        if (roomNameChangeCost > 0) {
            await req.user.update({ sawa: remainingSawa });
        }

        await room.update({ name: nextName });

        const refreshedRoom = await Room.findByPk(roomId, {
            include: [{
                model: User,
                as: 'creator',
                attributes: ['id', 'name', 'images'],
            }]
        });

        const [serializedRoom] = await attachActiveRoomFrames([refreshedRoom]);
        const roomsIO = req.app.get("roomsIO");
        if (roomsIO) {
            roomsIO.to(`room-${roomId}`).emit("room-updated", {
                roomId: Number(roomId),
                room: serializedRoom,
            });
        }

        return res.json({
            message: "تم تحديث اسم الروم بنجاح",
            deductedPoints: roomNameChangeCost,
            remainingSawa,
            room: serializedRoom,
        });
    } catch (error) {
        console.error("خطأ في تحديث اسم الروم:", error);
        return res.status(500).json({ error: "خطأ في تحديث اسم الروم" });
    }
});

router.patch("/admin/rooms/:roomId/name", authenticateToken, async (req, res) => {
    try {
        if (req.user?.role !== "admin") {
            return res.status(403).json({ error: "Admins only" });
        }

        const { roomId } = req.params;
        const nextName = normalizeRoomNameInput(req.body?.name);

        if (!nextName) {
            return res.status(400).json({ error: "اسم الروم مطلوب" });
        }

        if (nextName.length > 100) {
            return res.status(400).json({ error: "اسم الروم طويل جدًا" });
        }

        const room = await Room.findByPk(roomId, {
            include: [{
                model: User,
                as: 'creator',
                attributes: ['id', 'name', 'images'],
            }]
        });

        if (!room) {
            return res.status(404).json({ error: "الغرفة غير موجودة" });
        }

        await room.update({ name: nextName });

        const refreshedRoom = await Room.findByPk(roomId, {
            include: [{
                model: User,
                as: 'creator',
                attributes: ['id', 'name', 'images'],
            }]
        });

        const [serializedRoom] = await attachActiveRoomFrames([refreshedRoom]);
        const roomsIO = req.app.get("roomsIO");
        if (roomsIO) {
            roomsIO.to(`room-${roomId}`).emit("room-updated", {
                roomId: Number(roomId),
                room: serializedRoom,
            });
        }

        return res.json({
            message: "تم تحديث اسم الروم من قبل الأدمن بنجاح",
            room: serializedRoom,
        });
    } catch (error) {
        console.error("خطأ في تحديث اسم الروم من قبل الأدمن:", error);
        return res.status(500).json({ error: "خطأ في تحديث اسم الروم" });
    }
});

router.post("/room/:roomId/background", authenticateToken, upload.single("background"), async (req, res) => {
    try {
        const { roomId } = req.params;

        const room = await Room.findByPk(roomId, {
            include: [{
                model: User,
                as: 'creator',
                attributes: ['id', 'name', 'images'],
            }]
        });

        if (!room) {
            return res.status(404).json({ error: "Room not found" });
        }

        if (String(room.creatorId) !== String(req.user.id)) {
            return res.status(403).json({ error: "Only the room owner can change the room background" });
        }

        if (!req.file) {
            return res.status(400).json({ error: "Background image is required" });
        }

        const backgroundCostSetting = await Settings.findOne({
            where: { key: "room_background_change_cost" }
        });
        const backgroundCost = backgroundCostSetting
            ? parseInt(backgroundCostSetting.value, 10) || 0
            : 0;

        const currentBalance = Number(req.user.sawa ?? 0);
        if (currentBalance < backgroundCost) {
            return res.status(400).json({
                error: "Insufficient points to change room background",
                requiredPoints: backgroundCost,
                availablePoints: currentBalance,
            });
        }

        const remainingSawa = currentBalance - backgroundCost;
        if (backgroundCost > 0) {
            await req.user.update({ sawa: remainingSawa });
        }

        await room.update({ backgroundImage: req.file.filename });

        const refreshedRoom = await Room.findByPk(roomId, {
            include: [{
                model: User,
                as: 'creator',
                attributes: ['id', 'name', 'images'],
            }]
        });

        const [serializedRoom] = await attachActiveRoomFrames([refreshedRoom]);

        return res.json({
            message: "Room background updated successfully",
            deductedPoints: backgroundCost,
            remainingSawa,
            room: serializedRoom,
        });
    } catch (error) {
        console.error("Error updating room background:", error);
        return res.status(500).json({ error: "An error occurred while updating room background" });
    }
});

// تغيير الصورة الرئيسية للغرفة (لصاحب الغرفة أو الأدمن)
router.post("/room/:roomId/image", authenticateToken, upload.single("image"), async (req, res) => {
    try {
        const { roomId } = req.params;

        const room = await Room.findByPk(roomId, {
            include: [{
                model: User,
                as: 'creator',
                attributes: ['id', 'name', 'images'],
            }]
        });

        if (!room) {
            return res.status(404).json({ error: "الغرفة غير موجودة" });
        }

        if (!canManageRoom(room, req.user)) {
            return res.status(403).json({ error: "غير مصرح" });
        }

        if (!req.file) {
            return res.status(400).json({ error: "الصورة مطلوبة" });
        }

        const existingImages = Array.isArray(room.images) ? [...room.images] : [];
        if (existingImages.length === 0) {
            existingImages.push(req.file.filename);
        } else {
            existingImages[0] = req.file.filename;
        }

        await room.update({ images: existingImages });

        const refreshedRoom = await Room.findByPk(roomId, {
            include: [{
                model: User,
                as: 'creator',
                attributes: ['id', 'name', 'images'],
            }]
        });

        const [serializedRoom] = await attachActiveRoomFrames([refreshedRoom]);

        return res.json({
            message: "تم تحديث صورة الغرفة بنجاح",
            room: serializedRoom,
        });
    } catch (error) {
        console.error("خطأ في تحديث صورة الغرفة:", error);
        return res.status(500).json({ error: "خطأ في تحديث صورة الغرفة" });
    }
});
router.delete("/room/:roomId", authenticateToken, async (req, res) => {
    try {
        const { roomId } = req.params;
        
        const room = await Room.findByPk(roomId);
        
        if (!room) {
            return res.status(404).json({ error: "الغرفة غير موجودة" });
        }

        if (!canManageRoom(room, req.user)) {
            return res.status(403).json({ error: "Only the room owner or an admin can delete this room" });
        }

        await room.update({ isActive: false });
        
        res.json({ message: "تم حذف الغرفة بنجاح" });

    } catch (error) {
        console.error("خطأ في حذف الغرفة:", error);
        res.status(500).json({ error: "خطأ في حذف الغرفة" });
    }
});

router.get("/room/:roomId/voice-state", authenticateToken, async (req, res) => {
    try {
        const room = await Room.findByPk(req.params.roomId);
        if (!room || !room.isActive) {
            return res.status(404).json({ error: "الغرفة غير موجودة" });
        }

        const voiceState = await buildRoomVoicePayload(room, req.user.id, req.user.role);
        return res.json(voiceState);
    } catch (error) {
        console.error("Error fetching room voice state:", error);
        return res.status(500).json({ error: "خطأ في جلب حالة المايكات" });
    }
});

router.post("/room/:roomId/voice/purchase", authenticateToken, async (req, res) => {
    try {
        const room = await Room.findByPk(req.params.roomId);
        if (!room || !room.isActive) {
            return res.status(404).json({ error: "الغرفة غير موجودة" });
        }

        if (!canManageRoom(room, req.user)) {
            return res.status(403).json({ error: "هذه الميزة لصاحب الغرفة فقط" });
        }

        const micCount = Number(req.body?.micCount ?? 3);
        if (micCount !== 3) {
            return res.status(400).json({ error: "حالياً المتاح فقط باقة 3 مايكات" });
        }

        const settings = await getRoomVoicePackageSettings();
        const packageConfig = settings.packages.find((entry) => entry.micCount === micCount);
        if (!packageConfig || packageConfig.hours <= 0) {
            return res.status(400).json({ error: "إعدادات باقة المايكات غير مفعلة من الإدارة" });
        }

        const currentBalance = Number(req.user.sawa ?? 0);
        if (currentBalance < packageConfig.price) {
            return res.status(400).json({
                error: "نقاطك غير كافية لشراء باقة المايكات",
                requiredPoints: packageConfig.price,
                availablePoints: currentBalance,
            });
        }

        const normalized = await normalizeRoomVoiceState(room, { persist: true });
        const baseDate = normalized.isActive && normalized.voicePackageExpiresAt
            ? normalized.voicePackageExpiresAt
            : new Date();
        const nextExpiry = new Date(baseDate.getTime() + (packageConfig.hours * 60 * 60 * 1000));

        await room.update({
            voiceMicCount: micCount,
            voicePackageExpiresAt: nextExpiry,
        });
        await req.user.update({ sawa: currentBalance - packageConfig.price });

        await emitRoomVoiceUpdated(req.app, room);
        const voiceState = await buildRoomVoicePayload(room, req.user.id, req.user.role);

        return res.json({
            message: "تم تفعيل باقة المايكات بنجاح",
            deductedPoints: packageConfig.price,
            remainingSawa: currentBalance - packageConfig.price,
            voiceState,
        });
    } catch (error) {
        console.error("Error purchasing room voice package:", error);
        return res.status(500).json({ error: "خطأ في شراء باقة المايكات" });
    }
});

router.post("/room/:roomId/voice/request", authenticateToken, async (req, res) => {
    try {
        const room = await Room.findByPk(req.params.roomId);
        if (!room || !room.isActive) {
            return res.status(404).json({ error: "الغرفة غير موجودة" });
        }

        const normalized = await normalizeRoomVoiceState(room, { persist: true });
        if (!normalized.isActive) {
            return res.status(400).json({ error: "باقة المايكات غير مفعلة في هذه الغرفة" });
        }

        const userId = Number(req.user.id);
        if (normalized.voiceActiveSpeakerIds.includes(userId)) {
            return res.status(400).json({ error: "أنت موجود بالفعل على المايك" });
        }

        if (String(room.creatorId) === String(userId)) {
            return res.status(400).json({ error: "صاحب الغرفة يصعد مباشرة من زر الإدارة" });
        }

        if (!normalized.voicePendingRequestIds.includes(userId)) {
            normalized.voicePendingRequestIds.push(userId);
            await room.update({ voicePendingRequestIds: normalized.voicePendingRequestIds });
        }

        await emitRoomVoiceUpdated(req.app, room);
        return res.json({
            message: "تم إرسال طلب الصعود للمايك",
            voiceState: await buildRoomVoicePayload(room, req.user.id, req.user.role),
        });
    } catch (error) {
        console.error("Error requesting room voice seat:", error);
        return res.status(500).json({ error: "خطأ في إرسال طلب المايك" });
    }
});

router.post("/room/:roomId/voice/cancel-request", authenticateToken, async (req, res) => {
    try {
        const room = await Room.findByPk(req.params.roomId);
        if (!room || !room.isActive) {
            return res.status(404).json({ error: "الغرفة غير موجودة" });
        }

        const normalized = await normalizeRoomVoiceState(room, { persist: true });
        const userId = Number(req.user.id);
        const nextPending = normalized.voicePendingRequestIds.filter((id) => id !== userId);
        await room.update({ voicePendingRequestIds: nextPending });

        await emitRoomVoiceUpdated(req.app, room);
        return res.json({
            message: "تم إلغاء طلب المايك",
            voiceState: await buildRoomVoicePayload(room, req.user.id, req.user.role),
        });
    } catch (error) {
        console.error("Error canceling room voice request:", error);
        return res.status(500).json({ error: "خطأ في إلغاء طلب المايك" });
    }
});

router.post("/room/:roomId/voice/toggle-owner-speaker", authenticateToken, async (req, res) => {
    try {
        const room = await Room.findByPk(req.params.roomId);
        if (!room || !room.isActive) {
            return res.status(404).json({ error: "الغرفة غير موجودة" });
        }

        if (!canManageRoom(room, req.user)) {
            return res.status(403).json({ error: "هذا الإجراء لصاحب الغرفة فقط" });
        }

        const normalized = await normalizeRoomVoiceState(room, { persist: true });
        if (!normalized.isActive) {
            return res.status(400).json({ error: "باقة المايكات غير مفعلة في هذه الغرفة" });
        }

        const ownerId = Number(req.user.id);
        let nextSpeakers = [...normalized.voiceActiveSpeakerIds];
        if (nextSpeakers.includes(ownerId)) {
            nextSpeakers = nextSpeakers.filter((id) => id !== ownerId);
        } else {
            if (nextSpeakers.length >= normalized.voiceMicCount) {
                return res.status(400).json({ error: "لا يوجد مكان فارغ على المايك" });
            }
            nextSpeakers.push(ownerId);
        }

        await room.update({
            voiceActiveSpeakerIds: nextSpeakers,
            voicePendingRequestIds: normalized.voicePendingRequestIds.filter((id) => id !== ownerId),
        });

        await emitRoomVoiceUpdated(req.app, room);
        return res.json({
            message: nextSpeakers.includes(ownerId) ? "تم صعود المشرف للمايك" : "تم نزول المشرف من المايك",
            voiceState: await buildRoomVoicePayload(room, req.user.id, req.user.role),
        });
    } catch (error) {
        console.error("Error toggling owner speaker seat:", error);
        return res.status(500).json({ error: "خطأ في تحديث حالة المايك" });
    }
});

router.post("/room/:roomId/voice/approve", authenticateToken, async (req, res) => {
    try {
        const room = await Room.findByPk(req.params.roomId);
        if (!room || !room.isActive) {
            return res.status(404).json({ error: "الغرفة غير موجودة" });
        }

        if (!canManageRoom(room, req.user)) {
            return res.status(403).json({ error: "هذا الإجراء لصاحب الغرفة فقط" });
        }

        const normalized = await normalizeRoomVoiceState(room, { persist: true });
        if (!normalized.isActive) {
            return res.status(400).json({ error: "باقة المايكات غير مفعلة في هذه الغرفة" });
        }

        if (normalized.voiceActiveSpeakerIds.length >= normalized.voiceMicCount) {
            return res.status(400).json({ error: "لا يوجد مكان فارغ على المايك" });
        }

        const userId = Number(req.body?.userId);
        if (!normalized.voicePendingRequestIds.includes(userId)) {
            return res.status(400).json({ error: "هذا الطلب غير موجود" });
        }

        await room.update({
            voiceActiveSpeakerIds: [...normalized.voiceActiveSpeakerIds, userId],
            voicePendingRequestIds: normalized.voicePendingRequestIds.filter((id) => id !== userId),
        });

        await emitRoomVoiceUpdated(req.app, room);
        return res.json({
            message: "تم قبول الطلب وصعود المستخدم للمايك",
            voiceState: await buildRoomVoicePayload(room, req.user.id, req.user.role),
        });
    } catch (error) {
        console.error("Error approving room voice request:", error);
        return res.status(500).json({ error: "خطأ في قبول طلب المايك" });
    }
});

router.post("/room/:roomId/voice/reject", authenticateToken, async (req, res) => {
    try {
        const room = await Room.findByPk(req.params.roomId);
        if (!room || !room.isActive) {
            return res.status(404).json({ error: "الغرفة غير موجودة" });
        }

        if (!canManageRoom(room, req.user)) {
            return res.status(403).json({ error: "هذا الإجراء لصاحب الغرفة فقط" });
        }

        const normalized = await normalizeRoomVoiceState(room, { persist: true });
        const userId = Number(req.body?.userId);
        await room.update({
            voicePendingRequestIds: normalized.voicePendingRequestIds.filter((id) => id !== userId),
        });

        await emitRoomVoiceUpdated(req.app, room);
        return res.json({
            message: "تم رفض طلب المايك",
            voiceState: await buildRoomVoicePayload(room, req.user.id, req.user.role),
        });
    } catch (error) {
        console.error("Error rejecting room voice request:", error);
        return res.status(500).json({ error: "خطأ في رفض طلب المايك" });
    }
});

router.post("/room/:roomId/voice/remove-speaker", authenticateToken, async (req, res) => {
    try {
        const room = await Room.findByPk(req.params.roomId);
        if (!room || !room.isActive) {
            return res.status(404).json({ error: "الغرفة غير موجودة" });
        }

        if (!canManageRoom(room, req.user)) {
            return res.status(403).json({ error: "هذا الإجراء لصاحب الغرفة فقط" });
        }

        const normalized = await normalizeRoomVoiceState(room, { persist: true });
        const userId = Number(req.body?.userId);
        await room.update({
            voiceActiveSpeakerIds: normalized.voiceActiveSpeakerIds.filter((id) => id !== userId),
        });

        await emitRoomVoiceUpdated(req.app, room);
        return res.json({
            message: "تم تنزيل المستخدم من المايك",
            voiceState: await buildRoomVoicePayload(room, req.user.id, req.user.role),
        });
    } catch (error) {
        console.error("Error removing room speaker:", error);
        return res.status(500).json({ error: "خطأ في تنزيل المستخدم من المايك" });
    }
});

router.post("/room/:roomId/voice/leave-speaker", authenticateToken, async (req, res) => {
    try {
        const room = await Room.findByPk(req.params.roomId);
        if (!room || !room.isActive) {
            return res.status(404).json({ error: "الغرفة غير موجودة" });
        }

        const normalized = await normalizeRoomVoiceState(room, { persist: true });
        const userId = Number(req.user.id);
        await room.update({
            voiceActiveSpeakerIds: normalized.voiceActiveSpeakerIds.filter((id) => id !== userId),
        });

        await emitRoomVoiceUpdated(req.app, room);
        return res.json({
            message: "تم مغادرة المايك",
            voiceState: await buildRoomVoicePayload(room, req.user.id, req.user.role),
        });
    } catch (error) {
        console.error("Error leaving room speaker seat:", error);
        return res.status(500).json({ error: "خطأ في مغادرة المايك" });
    }
});

router.post("/room/:roomId/voice/token", authenticateToken, async (req, res) => {
    try {
        const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = process.env;
        if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
            return res.status(500).json({ error: "إعدادات LiveKit غير مكتملة على السيرفر" });
        }

        const room = await Room.findByPk(req.params.roomId);
        if (!room || !room.isActive) {
            return res.status(404).json({ error: "الغرفة غير موجودة" });
        }

        const voiceState = await buildRoomVoicePayload(room, req.user.id, req.user.role);
        if (!voiceState.isActive) {
            return res.status(400).json({ error: "الميكات غير مفعلة في هذه الغرفة" });
        }

        const canPublish = voiceState.currentUser.isSpeaker === true;
        const token = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
            identity: `room-${room.id}-user-${req.user.id}`,
            name: req.user.name || `user-${req.user.id}`,
            ttl: "2h",
            metadata: JSON.stringify({
                roomId: Number(room.id),
                userId: Number(req.user.id),
                role: canPublish ? "speaker" : "listener",
            }),
        });

        token.addGrant({
            roomJoin: true,
            room: getLiveKitRoomName(room.id),
            canPublish,
            canPublishData: false,
            canSubscribe: true,
        });

        return res.json({
            url: LIVEKIT_URL,
            roomName: getLiveKitRoomName(room.id),
            token: await token.toJwt(),
            canPublish,
        });
    } catch (error) {
        console.error("Error creating LiveKit token:", error);
        return res.status(500).json({ error: "خطأ في إنشاء توكن الصوت" });
    }
});

router.get("/room-settings", async (req, res) => {
  try {
    const costSetting = await Settings.findOne({ where: { key: "room_creation_cost" } });
    const maxUsersSetting = await Settings.findOne({ where: { key: "room_max_users" } });
    const roomBackgroundChangeCostSetting = await Settings.findOne({ where: { key: "room_background_change_cost" } });
    const roomNameChangeCostSetting = await Settings.findOne({ where: { key: "room_name_change_cost" } });
    const roomVoiceMic3PriceSetting = await Settings.findOne({ where: { key: "room_voice_mic_3_price" } });
    const roomVoiceMic3HoursSetting = await Settings.findOne({ where: { key: "room_voice_mic_3_hours" } });

    res.json({
      room_creation_cost: costSetting ? parseInt(costSetting.value) : 0,
      room_max_users: maxUsersSetting ? parseInt(maxUsersSetting.value) : 50,
      room_background_change_cost: roomBackgroundChangeCostSetting ? parseInt(roomBackgroundChangeCostSetting.value) : 0,
      room_name_change_cost: roomNameChangeCostSetting ? parseInt(roomNameChangeCostSetting.value) : 0,
      room_voice_mic_3_price: roomVoiceMic3PriceSetting ? parseInt(roomVoiceMic3PriceSetting.value, 10) || 0 : 0,
      room_voice_mic_3_hours: roomVoiceMic3HoursSetting ? parseInt(roomVoiceMic3HoursSetting.value, 10) || 0 : 0,
    });
  } catch (err) {
    console.error("Error fetching room settings:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// راوت لتحديث جدول الغرف وإضافة عامود الصور
router.get("/migrate-rooms-images", authenticateToken, async (req, res) => {
    try {
        if (req.user?.role !== "admin") {
            return res.status(403).json({ error: "Admins only" });
        }

        await require("../models/room").sync({ alter: true });
        res.json({ message: "تم تحديث جدول الغرف وإضافة عامود الصور بنجاح" });
    } catch (error) {
        console.error("خطأ في تحديث قاعدة البيانات:", error);
        res.status(500).json({ error: "خطأ في تحديث قاعدة البيانات" });
    }
});

router.cleanupRoomVoiceParticipant = cleanupRoomVoiceParticipant;
module.exports = router;
