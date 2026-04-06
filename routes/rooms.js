const express = require("express");
const router = express.Router();
const Room = require("../models/room");
const Message = require("../models/message");
const User = require("../models/user");
const jwt = require("jsonwebtoken");
const Settings = require("../models/settings");
const upload = require("../middlewares/uploads");

const authenticateToken = async (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: "Token Ù…Ø·Ù„ÙˆØ¨" });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const userId = decoded.id || decoded.userId;
        if (!userId) {
            return res.status(401).json({ error: "Token ØºÙŠØ± ØµØ§Ù„Ø­ - Ù„Ø§ ÙŠÙˆØ¬Ø¯ Ù…Ø¹Ø±Ù Ù…Ø³ØªØ®Ø¯Ù…" });
        }
        
        const user = await User.findByPk(userId);
        if (!user) {
            return res.status(401).json({ error: "Ø§Ù„Ù…Ø³ØªØ®Ø¯Ù… ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯" });
        }
        req.user = user;
        next();
    } catch (error) {
        return res.status(403).json({ error: "Token ØºÙŠØ± ØµØ§Ù„Ø­" });
    }
};

// Ø¥Ø¶Ø§ÙØ© Ù†Ù‚Ø§Ø· sawa Ù„Ù„Ù…Ø³ØªØ®Ø¯Ù… Ù„Ù„Ø§Ø®ØªØ¨Ø§Ø±
router.post("/add-sawa", authenticateToken, async (req, res) => {
    try {
        const { amount = 1000 } = req.body;
        
        await req.user.update({
            sawa: req.user.sawa + amount
        });
        
        res.json({
            message: `ØªÙ… Ø¥Ø¶Ø§ÙØ© ${amount} Ù†Ù‚Ø·Ø© sawa`,
            newBalance: req.user.sawa + amount
        });
    } catch (error) {
        res.status(500).json({ error: "Ø®Ø·Ø£ ÙÙŠ Ø¥Ø¶Ø§ÙØ© Ø§Ù„Ù†Ù‚Ø§Ø·" });
    }
});

// Ø¥Ù†Ø´Ø§Ø¡ Ù…Ø³ØªØ®Ø¯Ù…ÙŠÙ† Ù…ØªØ¹Ø¯Ø¯ÙŠÙ† Ù„Ù„Ø§Ø®ØªØ¨Ø§Ø±
router.post("/create-test-users", async (req, res) => {
    try {
        const users = [];
        
        // Ø¥Ù†Ø´Ø§Ø¡ 5 Ù…Ø³ØªØ®Ø¯Ù…ÙŠÙ† Ù„Ù„Ø§Ø®ØªØ¨Ø§Ø±
        for (let i = 1; i <= 5; i++) {
            const userId = 10000 + i;
            
            // Ø§Ù„ØªØ­Ù‚Ù‚ Ù…Ù† ÙˆØ¬ÙˆØ¯ Ø§Ù„Ù…Ø³ØªØ®Ø¯Ù…
            let user = await User.findByPk(userId);
            
            if (!user) {
                // Ø¥Ù†Ø´Ø§Ø¡ Ù…Ø³ØªØ®Ø¯Ù… Ø¬Ø¯ÙŠØ¯
                user = await User.create({
                    id: userId,
                    name: `Ù…Ø³ØªØ®Ø¯Ù… ${i}`,
                    email: `user${i}@test.com`,
                    phone: `123456789${i}`,
                    location: 'Ø§Ù„Ø±ÙŠØ§Ø¶',
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
                // ØªØ­Ø¯ÙŠØ« Ø§Ù„Ù†Ù‚Ø§Ø· Ø¥Ø°Ø§ ÙƒØ§Ù† Ø§Ù„Ù…Ø³ØªØ®Ø¯Ù… Ù…ÙˆØ¬ÙˆØ¯
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
            message: "ØªÙ… Ø¥Ù†Ø´Ø§Ø¡ Ø§Ù„Ù…Ø³ØªØ®Ø¯Ù…ÙŠÙ† Ø¨Ù†Ø¬Ø§Ø­",
            users: users
        });
        
    } catch (error) {
        console.error("Ø®Ø·Ø£ ÙÙŠ Ø¥Ù†Ø´Ø§Ø¡ Ø§Ù„Ù…Ø³ØªØ®Ø¯Ù…ÙŠÙ†:", error);
        res.status(500).json({ error: "Ø®Ø·Ø£ ÙÙŠ Ø¥Ù†Ø´Ø§Ø¡ Ø§Ù„Ù…Ø³ØªØ®Ø¯Ù…ÙŠÙ†" });
    }
});

// Ø¥Ù†Ø´Ø§Ø¡ ØºØ±ÙØ© Ø¬Ø¯ÙŠØ¯Ø©
router.post("/create-room", authenticateToken, upload.array("images", 5), async (req, res) => {
    try {
        const { name, description, cost, maxUsers, category } = req.body;

        const existingRoom = await Room.findOne({
            where: { creatorId: req.user.id }
        });

        if (existingRoom) {
            return res.status(400).json({
                error: "Ù„Ø§ ÙŠÙ…ÙƒÙ† Ø¥Ù†Ø´Ø§Ø¡ Ø£ÙƒØ«Ø± Ù…Ù† ØºØ±ÙØ© ÙˆØ§Ø­Ø¯Ø© Ù„ÙƒÙ„ Ù…Ø³ØªØ®Ø¯Ù…"
            });
        }
        
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ error: "Ø§Ù„Ø±Ø¬Ø§Ø¡ Ø±ÙØ¹ ØµÙˆØ±Ø© ÙˆØ§Ø­Ø¯Ø© Ø¹Ù„Ù‰ Ø§Ù„Ø£Ù‚Ù„" });
        }
        
        const images = req.files.map(file => file.filename);
        
        if (req.user.sawa < cost) {
            return res.status(400).json({ 
                error: "Ù†Ù‚Ø§Ø· ØºÙŠØ± ÙƒØ§ÙÙŠØ© Ù„Ø¥Ù†Ø´Ø§Ø¡ Ø§Ù„ØºØ±ÙØ©",
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

        // Ø®ØµÙ… Ø§Ù„Ù†Ù‚Ø§Ø· Ù…Ù† Ø§Ù„Ù…Ø³ØªØ®Ø¯Ù…
        await req.user.update({
            sawa: req.user.sawa - cost
        });

        res.status(201).json({
            message: "ØªÙ… Ø¥Ù†Ø´Ø§Ø¡ Ø§Ù„ØºØ±ÙØ© Ø¨Ù†Ø¬Ø§Ø­",
            room,
            remainingSawa: req.user.sawa - cost
        });

    } catch (error) {
        console.error("Ø®Ø·Ø£ ÙÙŠ Ø¥Ù†Ø´Ø§Ø¡ Ø§Ù„ØºØ±ÙØ©:", error);
        res.status(500).json({ error: "Ø®Ø·Ø£ ÙÙŠ Ø¥Ù†Ø´Ø§Ø¡ Ø§Ù„ØºØ±ÙØ©" });
    }
});

// Ø§Ù„Ø¨Ø­Ø« Ø¹Ù† ØºØ±ÙØ© Ø¨Ø§Ø³ØªØ®Ø¯Ø§Ù… id Ø£Ùˆ name
router.get("/search-rooms", authenticateToken, async (req, res) => {
    try {
        const { query } = req.query;
        const { Op } = require("sequelize");
        
        if (!query) {
            return res.status(400).json({ error: "Ø§Ù„Ø±Ø¬Ø§Ø¡ ØªÙˆÙÙŠØ± ÙƒÙ„Ù…Ø© Ø§Ù„Ø¨Ø­Ø«" });
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
        console.error("Ø®Ø·Ø£ ÙÙŠ Ø§Ù„Ø¨Ø­Ø« Ø¹Ù† Ø§Ù„ØºØ±Ù:", error);
        res.status(500).json({ error: "Ø®Ø·Ø£ ÙÙŠ Ø§Ù„Ø¨Ø­Ø« Ø¹Ù† Ø§Ù„ØºØ±Ù", details: error.message });
    }
});

// Ø¹Ø±Ø¶ Ø§Ù„ØºØ±Ù Ø§Ù„Ù…ØªÙˆÙØ±Ø©
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
                required: false  // LEFT JOIN Ø¨Ø¯Ù„Ø§Ù‹ Ù…Ù† INNER JOIN
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
        console.error("Ø®Ø·Ø£ ÙÙŠ Ø¬Ù„Ø¨ Ø§Ù„ØºØ±Ù:", error);
        console.error("ØªÙØ§ØµÙŠÙ„ Ø§Ù„Ø®Ø·Ø£:", error.message);
        console.error("Stack trace:", error.stack);
        res.status(500).json({ 
            error: "Ø®Ø·Ø£ ÙÙŠ Ø¬Ù„Ø¨ Ø§Ù„ØºØ±Ù",
            details: error.message 
        });
    }
});

// Ø§Ù„Ø­ØµÙˆÙ„ Ø¹Ù„Ù‰ ØªÙØ§ØµÙŠÙ„ ØºØ±ÙØ© Ù…Ø¹ÙŠÙ†Ø©
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
            return res.status(404).json({ error: "Ù„Ø§ ØªÙˆØ¬Ø¯ ØºØ±ÙØ© Ù„Ù‡Ø°Ø§ Ø§Ù„Ù…Ø³ØªØ®Ø¯Ù…" });
        }

        if (!room.isActive) {
            return res.status(400).json({ error: "Ø¢Ø®Ø± ØºØ±ÙØ© Ù„Ù„Ù…Ø³ØªØ®Ø¯Ù… ØºÙŠØ± Ù†Ø´Ø·Ø©" });
        }

        res.json({ room });
    } catch (error) {
        console.error("Ø®Ø·Ø£ ÙÙŠ Ø¬Ù„Ø¨ ØºØ±ÙØ© Ø§Ù„Ù…Ø³ØªØ®Ø¯Ù…:", error);
        res.status(500).json({ error: "Ø®Ø·Ø£ ÙÙŠ Ø¬Ù„Ø¨ ØºØ±ÙØ© Ø§Ù„Ù…Ø³ØªØ®Ø¯Ù…" });
    }
});

// Ø§Ù„Ø­ØµÙˆÙ„ Ø¹Ù„Ù‰ ØªÙØ§ØµÙŠÙ„ ØºØ±ÙØ© Ù…Ø¹ÙŠÙ†Ø©
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
            return res.status(404).json({ error: "Ø§Ù„ØºØ±ÙØ© ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯Ø©" });
        }

        if (!room.isActive) {
            return res.status(400).json({ error: "Ø§Ù„ØºØ±ÙØ© ØºÙŠØ± Ù†Ø´Ø·Ø©" });
        }

        res.json({ room });

    } catch (error) {
        console.error("Ø®Ø·Ø£ ÙÙŠ Ø¬Ù„Ø¨ ØªÙØ§ØµÙŠÙ„ Ø§Ù„ØºØ±ÙØ©:", error);
        res.status(500).json({ error: "Ø®Ø·Ø£ ÙÙŠ Ø¬Ù„Ø¨ ØªÙØ§ØµÙŠÙ„ Ø§Ù„ØºØ±ÙØ©" });
    }
});

// Ø§Ù„Ø­ØµÙˆÙ„ Ø¹Ù„Ù‰ Ø±Ø³Ø§Ø¦Ù„ ØºØ±ÙØ© Ù…Ø¹ÙŠÙ†Ø©
router.get("/room/:roomId/messages", authenticateToken, async (req, res) => {
    try {
        const { roomId } = req.params;
        const { page = 1, limit = 10 } = req.query;

        const messages = await Message.findAndCountAll({
            where: { 
                roomId,
                isDeleted: false
            },
            include: [{
                model: User,
                as: 'user',
                attributes: ['id', 'name', 'images'],
            }],
            order: [['createdAt', 'DESC']],
            limit: parseInt(limit),
            offset: (parseInt(page) - 1) * parseInt(limit)
        });

        res.json({
            messages: messages.rows.reverse().map(msg => {
                const m = msg.toJSON();
                if (m.user && m.user.images) {
                    m.user.image = m.user.images.length > 0 ? m.user.images[0] : null;
                    delete m.user.images;
                }
                return m;
            }),
            total: messages.count,
            currentPage: parseInt(page),
            totalPages: Math.ceil(messages.count / parseInt(limit))
        });

    } catch (error) {
        console.error("Ø®Ø·Ø£ ÙÙŠ Ø¬Ù„Ø¨ Ø§Ù„Ø±Ø³Ø§Ø¦Ù„:", error);
        res.status(500).json({ error: "Ø®Ø·Ø£ ÙÙŠ Ø¬Ù„Ø¨ Ø§Ù„Ø±Ø³Ø§Ø¦Ù„" });
    }
});

// Ø­Ø°Ù ØºØ±ÙØ© (Ù„Ù„Ù…Ù†Ø´Ø¦ ÙÙ‚Ø·)
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
            return res.status(404).json({ error: "الغرفة غير موجودة" });
        }

        if (String(room.creatorId) !== String(req.user.id)) {
            return res.status(403).json({ error: "غير مصرح لك بتغيير خلفية هذه الغرفة" });
        }

        if (!req.file) {
            return res.status(400).json({ error: "الرجاء اختيار صورة للخلفية" });
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
                error: "نقاطك غير كافية لتغيير خلفية الغرفة",
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
            message: "تم تحديث خلفية الغرفة بنجاح",
            deductedPoints: backgroundCost,
            remainingSawa,
            room: refreshedRoom,
        });
    } catch (error) {
        console.error("خطأ في تحديث خلفية الغرفة:", error);
        return res.status(500).json({ error: "حدث خطأ أثناء تحديث خلفية الغرفة" });
    }
});
router.delete("/room/:roomId", async (req, res) => {
    try {
        const { roomId } = req.params;
        
        const room = await Room.findByPk(roomId);
        
        if (!room) {
            return res.status(404).json({ error: "Ø§Ù„ØºØ±ÙØ© ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯Ø©" });
        }

        await room.update({ isActive: false });
        
        res.json({ message: "ØªÙ… Ø­Ø°Ù Ø§Ù„ØºØ±ÙØ© Ø¨Ù†Ø¬Ø§Ø­" });

    } catch (error) {
        console.error("Ø®Ø·Ø£ ÙÙŠ Ø­Ø°Ù Ø§Ù„ØºØ±ÙØ©:", error);
        res.status(500).json({ error: "Ø®Ø·Ø£ ÙÙŠ Ø­Ø°Ù Ø§Ù„ØºØ±ÙØ©" });
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
    console.error("âŒ Error fetching room settings:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Ø±Ø§ÙˆØª Ù„ØªØ­Ø¯ÙŠØ« Ø¬Ø¯ÙˆÙ„ Ø§Ù„ØºØ±Ù ÙˆØ¥Ø¶Ø§ÙØ© Ø¹Ø§Ù…ÙˆØ¯ Ø§Ù„ØµÙˆØ±
router.get("/migrate-rooms-images", async (req, res) => {
    try {
        await require("../models/room").sync({ alter: true });
        res.json({ message: "ØªÙ… ØªØ­Ø¯ÙŠØ« Ø¬Ø¯ÙˆÙ„ Ø§Ù„ØºØ±Ù ÙˆØ¥Ø¶Ø§ÙØ© Ø¹Ø§Ù…ÙˆØ¯ Ø§Ù„ØµÙˆØ± Ø¨Ù†Ø¬Ø§Ø­" });
    } catch (error) {
        console.error("Ø®Ø·Ø£ ÙÙŠ ØªØ­Ø¯ÙŠØ« Ù‚Ø§Ø¹Ø¯Ø© Ø§Ù„Ø¨ÙŠØ§Ù†Ø§Øª:", error);
        res.status(500).json({ error: "Ø®Ø·Ø£ ÙÙŠ ØªØ­Ø¯ÙŠØ« Ù‚Ø§Ø¹Ø¯Ø© Ø§Ù„Ø¨ÙŠØ§Ù†Ø§Øª", details: error.message });
    }
});

module.exports = router;
