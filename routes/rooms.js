const express = require("express");
const router = express.Router();
const Room = require("../models/room");
const Message = require("../models/message");
const User = require("../models/user");
const jwt = require("jsonwebtoken");

// Middleware للتحقق من التوكن
const authenticateToken = async (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: "Token مطلوب" });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');
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
            
            const token = jwt.sign({ id: userId }, process.env.JWT_SECRET || 'your-secret-key');
            
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
        const token = jwt.sign({ id: 10001 }, process.env.JWT_SECRET || 'your-secret-key');
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
        const { name, description, cost, maxUsers, category } = req.body;
        
        // التحقق من وجود النقاط الكافية
        if (req.user.sawa < cost) {
            return res.status(400).json({ 
                error: "نقاط غير كافية لإنشاء الغرفة",
                required: cost,
                available: req.user.sawa
            });
        }

        // إنشاء الغرفة
        const room = await Room.create({
            name,
            description,
            creatorId: req.user.id,
            cost,
            maxUsers: maxUsers || 50,
            category: category || 'general'
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
                attributes: ['id', 'name']
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
        res.status(500).json({ error: "خطأ في جلب الغرف" });
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

// الحصول على رسائل غرفة معينة
router.get("/room/:roomId/messages", authenticateToken, async (req, res) => {
    try {
        const { roomId } = req.params;
        const { page = 1, limit = 50 } = req.query;

        const messages = await Message.findAndCountAll({
            where: { 
                roomId,
                isDeleted: false
            },
            include: [{
                model: User,
                attributes: ['id', 'name']
            }],
            order: [['createdAt', 'DESC']],
            limit: parseInt(limit),
            offset: (parseInt(page) - 1) * parseInt(limit)
        });

        res.json({
            messages: messages.rows.reverse(), // عكس الترتيب لعرض الرسائل من الأقدم للأحدث
            total: messages.count,
            currentPage: parseInt(page),
            totalPages: Math.ceil(messages.count / parseInt(limit))
        });

    } catch (error) {
        console.error("خطأ في جلب الرسائل:", error);
        res.status(500).json({ error: "خطأ في جلب الرسائل" });
    }
});

// حذف غرفة (للمنشئ فقط)
router.delete("/room/:roomId", authenticateToken, async (req, res) => {
    try {
        const { roomId } = req.params;
        
        const room = await Room.findByPk(roomId);
        
        if (!room) {
            return res.status(404).json({ error: "الغرفة غير موجودة" });
        }

        if (room.creatorId !== req.user.id) {
            return res.status(403).json({ error: "غير مصرح لك بحذف هذه الغرفة" });
        }

        await room.update({ isActive: false });
        
        res.json({ message: "تم حذف الغرفة بنجاح" });

    } catch (error) {
        console.error("خطأ في حذف الغرفة:", error);
        res.status(500).json({ error: "خطأ في حذف الغرفة" });
    }
});

module.exports = router;
