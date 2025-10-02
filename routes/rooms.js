const express = require("express");
const router = express.Router();
const Room = require("../models/room");
const Message = require("../models/message");
const User = require("../models/user");
const Settings = require("../models/settings");
const jwt = require("jsonwebtoken");

// Middleware للتحقق من التوكن
const authenticateToken = async (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: "Token مطلوب" });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key-123456789');
        // التحقق من وجود id أو userId في التوكن
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

// إنشاء Token تجريبي للاختبار
router.post("/test-token", async (req, res) => {
    try {
        const token = jwt.sign({ id: 10001 }, process.env.JWT_SECRET || 'your-secret-key-123456789');
        res.json({ 
            token,
            message: "Token تم إنشاؤه بنجاح",
            userId: 10001
        });
    } catch (error) {
        res.status(500).json({ error: "خطأ في إنشاء Token" });
    }
});

// إنشاء غرفة جديدة
router.post("/create-room", authenticateToken, async (req, res) => {
    try {
        const { name, description } = req.body;
        
        // الحصول على إعدادات الادمن للغرف
        const roomSettings = await Promise.all([
            Settings.findOne({ where: { key: 'room_creation_cost', isActive: true } }),
            Settings.findOne({ where: { key: 'room_max_users', isActive: true } })
        ]);
        
        const roomCost = roomSettings[0] ? parseInt(roomSettings[0].value) : 10;
        const maxUsers = roomSettings[1] ? parseInt(roomSettings[1].value) : 50;
        
        // التحقق من وجود النقاط الكافية
        if (req.user.sawa < roomCost) {
            return res.status(400).json({ 
                error: "نقاط غير كافية لإنشاء الغرفة",
                required: roomCost,
                available: req.user.sawa
            });
        }

        // إنشاء الغرفة مع الإعدادات المتاحة فقط للادمن
        const room = await Room.create({
            name,
            description,
            creatorId: req.user.id,
            cost: roomCost, // دائماً الفئة
            maxUsers: maxUsers, // من إعدادات الادمن
            category: 'general' // دائماً عام
        });

        // خصم النقاط من المستخدم
        await req.user.update({
            sawa: req.user.sawa - roomCost
        });

        res.status(201).json({
            message: "تم إنشاء الغرفة بنجاح",
            room,
            remainingSawa: req.user.sawa - roomCost
        });

    } catch (error) {
        console.error("خطأ في إنشاء الغرفة:", error);
        res.status(500).json({ error: "خطأ في إنشاء الغرفة" });
    }
});

// عرض الغرف المتوفرة
router.get("/rooms", authenticateToken, async (req, res) => {
    try {
        const { category, page = 1, limit = 10 } = req.query;
        
        let whereClause = { isActive: true };
        if (category) {
            whereClause.category = category;
        }

        const rooms = await Room.findAndCountAll({
            where: whereClause,
            include: [{
                model: User,
                as: 'creator',
                attributes: ['id', 'name'],
                required: false  // LEFT JOIN بدلاً من INNER JOIN
            }],
            order: [['createdAt', 'DESC']],
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
router.get("/room/:roomId", authenticateToken, async (req, res) => {
    try {
        const { roomId } = req.params;
        
        const room = await Room.findByPk(roomId, {
            include: [{
                model: User,
                as: 'creator',
                attributes: ['id', 'name']
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

// الحصول على رسائل غرفة معينة - آخر 30 رسالة فقط
router.get("/room/:roomId/messages", async (req, res) => {
    try {
        const { roomId } = req.params;

        // جلب آخر 30 رسالة فقط مع معلومات إجمالية
        const [messages, totalCount] = await Promise.all([
            Message.findAll({
                where: { 
                    roomId,
                    isDeleted: false
                },
                include: [{
                    model: User,
                    as: 'user',
                    attributes: ['id', 'name']
                }],
                order: [['createdAt', 'DESC']],
                limit: 30
            }),
            Message.count({
                where: { 
                    roomId,
                    isDeleted: false
                }
            })
        ]);

        res.json({
            messages: messages.reverse(), // عكس الترتيب لعرض الرسائل من الأقدم للأحدث
            total: totalCount,
            displayedCount: messages.length,
            message: "عرض آخر 30 رسالة فقط، باقي الرسائل محفوظة في قاعدة البيانات"
        });

    } catch (error) {
        console.error("خطأ في جلب الرسائل:", error);
        res.status(500).json({ error: "خطأ في جلب الرسائل" });
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

module.exports = router;
