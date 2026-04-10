const express = require("express");
const router = express.Router();
const Room = require("../models/room");
const Message = require("../models/message");
const User = require("../models/user");
const jwt = require("jsonwebtoken");
const Settings = require("../models/settings");
const upload = require("../middlewares/uploads");

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

function normalizeMessagePayload(message) {
    const plainMessage = typeof message.toJSON === "function" ? message.toJSON() : { ...message };
    plainMessage.user = normalizeUserPayload(plainMessage.user);

    if (plainMessage.replyTo) {
        const replyMessage = typeof plainMessage.replyTo.toJSON === "function"
            ? plainMessage.replyTo.toJSON()
            : { ...plainMessage.replyTo };

        replyMessage.user = normalizeUserPayload(replyMessage.user);
        plainMessage.replyTo = replyMessage;
    }

    return plainMessage;
}

function canManageRoom(room, user) {
    if (!room || !user) return false;
    if (user.role === "admin") return true;
    return String(room.creatorId) === String(user.id);
}

function buildPinnedMessage(message) {
    if (!message) return null;
    const msg = typeof message.toJSON === "function" ? message.toJSON() : { ...message };
    msg.user = normalizeUserPayload(msg.user);
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
            const userId = 10000 + i;
            
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

        res.json({
            rooms: rooms,
            total: rooms.length
        });

    } catch (error) {
        console.error("خطأ في البحث عن الغرف:", error);
        res.status(500).json({ error: "خطأ في البحث عن الغرف", details: error.message });
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

        res.json({
            rooms: rooms.rows,
            total: rooms.count,
            currentPage: parseInt(page),
            totalPages: Math.ceil(rooms.count / parseInt(limit))
        });

    } catch (error) {
        console.error("خطأ في جلب الغرف:", error);
        console.error("تفاصيل الخطأ:", error.message);
        console.error("Stack trace:", error.stack);
        res.status(500).json({ 
            error: "خطأ في جلب الغرف",
            details: error.message 
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

        res.json({ room });
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

        res.json({ room });

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

        res.json({
            messages: messages.rows.reverse().map(normalizeMessagePayload),
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

        const pinnedMessage = buildPinnedMessage(message);
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

        return res.json({
            message: "Room background updated successfully",
            deductedPoints: backgroundCost,
            remainingSawa,
            room: refreshedRoom,
        });
    } catch (error) {
        console.error("Error updating room background:", error);
        return res.status(500).json({ error: "An error occurred while updating room background" });
    }
});
router.delete("/room/:roomId", async (req, res) => {
    try {
        const { roomId } = req.params;
        
        const room = await Room.findByPk(roomId);
        
        if (!room) {
            return res.status(404).json({ error: "الغرفة غير موجودة" });
        }

        await room.update({ isActive: false });
        
        res.json({ message: "تم حذف الغرفة بنجاح" });

    } catch (error) {
        console.error("خطأ في حذف الغرفة:", error);
        res.status(500).json({ error: "خطأ في حذف الغرفة" });
    }
});

router.get("/room-settings", async (req, res) => {
  try {
    const costSetting = await Settings.findOne({ where: { key: "room_creation_cost" } });
    const maxUsersSetting = await Settings.findOne({ where: { key: "room_max_users" } });
    const roomBackgroundChangeCostSetting = await Settings.findOne({ where: { key: "room_background_change_cost" } });

    res.json({
      room_creation_cost: costSetting ? parseInt(costSetting.value) : 0,
      room_max_users: maxUsersSetting ? parseInt(maxUsersSetting.value) : 50,
      room_background_change_cost: roomBackgroundChangeCostSetting ? parseInt(roomBackgroundChangeCostSetting.value) : 0,
    });
  } catch (err) {
    console.error("Error fetching room settings:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// راوت لتحديث جدول الغرف وإضافة عامود الصور
router.get("/migrate-rooms-images", async (req, res) => {
    try {
        await require("../models/room").sync({ alter: true });
        res.json({ message: "تم تحديث جدول الغرف وإضافة عامود الصور بنجاح" });
    } catch (error) {
        console.error("خطأ في تحديث قاعدة البيانات:", error);
        res.status(500).json({ error: "خطأ في تحديث قاعدة البيانات", details: error.message });
    }
});

module.exports = router;
