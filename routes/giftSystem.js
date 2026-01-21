const express = require("express");
const router = express.Router();
const { User, GiftItem, UserGift } = require("../models");
const upload = require("../middlewares/uploads");
const { Op } = require("sequelize");
const { connectedUsers } = require("../socket/socketHandler");

// إضافة هدية جديدة للمتجر (للمشرفين أو الإدارة)
router.post("/gift-items", upload.single("image"), async (req, res) => {
    try {
        const { name, points } = req.body;
        let image = req.file ? req.file.path : null;

        if (!name || !points || !image) {
            return res.status(400).json({ error: "جميع الحقول مطلوبة: الاسم، النقاط، والصورة" });
        }

        const newItem = await GiftItem.create({
            name,
            points,
            image
        });

        res.json({ message: "تمت إضافة الهدية للمتجر", item: newItem });

    } catch (error) {
        console.error("❌ خطأ أثناء إضافة الهدية:", error);
        res.status(500).json({ error: "حدث خطأ أثناء إضافة الهدية" });
    }
});

// عرض جميع الهدايا المتاحة في المتجر (اختياري: يمكن تصفية المتاح فقط للمستخدمين)
router.get("/gift-items", async (req, res) => {
    try {
        const { includeUnavailable } = req.query; // للسماح للأدمن برؤية الكل

        const whereClause = {};
        if (includeUnavailable !== "true") {
            whereClause.isAvailable = true;
        }

        const items = await GiftItem.findAll({ where: whereClause });
        res.json(items);
    } catch (error) {
        console.error("❌ خطأ أثناء جلب الهدايا:", error);
        res.status(500).json({ error: "حدث خطأ أثناء جلب الهدايا" });
    }
});

// تعديل حالة الهدية (إيقاف/تفعيل) - بدلاً من التعليق
router.patch("/gift-items/:id/toggle", async (req, res) => {
    try {
        const giftItemId = req.params.id;
        const item = await GiftItem.findByPk(giftItemId);

        if (!item) {
            return res.status(404).json({ error: "الهدية غير موجودة" });
        }

        // عكس الحالة الحالية
        item.isAvailable = !item.isAvailable;
        await item.save();

        res.json({
            message: item.isAvailable ? "تم تفعيل الهدية" : "تم إيقاف عرض الهدية",
            item
        });

    } catch (error) {
        console.error("❌ خطأ أثناء تعديل حالة الهدية:", error);
        res.status(500).json({ error: "حدث خطأ أثناء التعديل" });
    }
});


// شراء هدية (تضاف لمخزون المستخدم)
router.post("/buy-gift/:giftItemId", upload.none(), async (req, res) => {
  try {
    const { userId } = req.body;
    const { giftItemId } = req.params;

    const user = await User.findByPk(userId);
    const item = await GiftItem.findByPk(giftItemId);

    if (!user || !item) {
      return res.status(404).json({ error: "المستخدم أو الهدية غير موجودة" });
    }

    if (user.sawa < item.points) {
      return res.status(400).json({ error: "رصيد النقاط غير كافي" });
    }

    if (!item.isAvailable) {
      return res.status(400).json({ error: "هذه الهدية غير متاحة حالياً" });
    }

    user.sawa -= item.points;
    await user.save();

    const userGift = await UserGift.create({
      userId,
      giftItemId,
      status: "active",
    });

    res.json({
      message: "تم شراء الهدية بنجاح",
      userGift,
      newBalance: user.sawa,
    });
  } catch (error) {
    console.error("❌ خطأ أثناء شراء الهدية:", error);
    res.status(500).json({ error: "حدث خطأ أثناء شراء الهدية" });
  }
});


router.post("/send-gift", upload.none(), async (req, res) => {
  const t = await User.sequelize.transaction();

  try {
    const { senderId, receiverId, giftItemId } = req.body;

    if (!senderId || !receiverId || !giftItemId) {
      await t.rollback();
      return res
        .status(400)
        .json({ error: "senderId, receiverId, giftItemId مطلوبة" });
    }

    if (String(senderId) === String(receiverId)) {
      await t.rollback();
      return res.status(400).json({ error: "لا يمكن إرسال هدية لنفسك" });
    }

    const sender = await User.findByPk(senderId, {
      transaction: t,
      attributes: ["id", "name"],
    });
    if (!sender) {
      await t.rollback();
      return res.status(404).json({ error: "المرسل غير موجود" });
    }

    const receiver = await User.findByPk(receiverId, {
      transaction: t,
      attributes: ["id", "name"],
    });
    if (!receiver) {
      await t.rollback();
      return res.status(404).json({ error: "المستلم غير موجود" });
    }

    const item = await GiftItem.findByPk(giftItemId, { transaction: t });
    if (!item) {
      await t.rollback();
      return res.status(404).json({ error: "الهدية غير موجودة" });
    }

    if (!item.isAvailable) {
      await t.rollback();
      return res.status(400).json({ error: "هذه الهدية غير متاحة حالياً" });
    }

    const userGift = await UserGift.findOne({
      where: {
        userId: senderId,
        giftItemId,
        status: "active",
        senderId: { [Op.is]: null },
      },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });

    if (!userGift) {
      await t.rollback();
      return res.status(400).json({ error: "لا تملك هذه الهدية في مخزونك" });
    }

    userGift.userId = receiverId;
    userGift.senderId = senderId;
    await userGift.save({ transaction: t });

    await t.commit();

    const payload = {
      message: "وصلتك هدية جديدة 🎁",
      userGift: {
        id: userGift.id,
        status: userGift.status,
        createdAt: userGift.createdAt,
        sender: {
          id: sender.id,
          name: sender.name,
        },
        item: {
          id: item.id,
          name: item.name,
          points: item.points,
          image: item.image,
        },
      },
    };

    const roomsIO = req.app.get("roomsIO");
    const receiverSocketId = connectedUsers.get(String(receiverId));

    if (roomsIO && receiverSocketId) {
      roomsIO.to(receiverSocketId).emit("gift-received", payload);
    }

    const senderSocketId = connectedUsers.get(String(senderId));
    if (roomsIO && senderSocketId) {
      roomsIO.to(senderSocketId).emit("gift-sent", {
        message: "تم إرسال الهدية بنجاح ✅",
        receiver: { id: receiver.id, name: receiver.name },
        item: payload.userGift.item,
      });
    }

    return res.json({
      message: "تم إرسال الهدية بنجاح",
      ...payload,
    });
  } catch (error) {
    console.error("❌ خطأ أثناء إرسال الهدية:", error);
    await t.rollback();
    res.status(500).json({ error: "حدث خطأ أثناء إرسال الهدية" });
  }
});

// عرض الهدايا التي يملكها المستخدم
router.get("/my-gifts/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const { type } = req.query;

    const where = { userId, status: "active" };

    if (type === "purchased") {
      where.senderId = { [Op.is]: null };
    } else if (type === "received") {
      where.senderId = { [Op.not]: null };
    }

    const include = [{ model: GiftItem, as: "item" }];
    if (type === "received") {
      include.push({ model: User, as: "sender", attributes: ["id", "name"] });
    }

    const gifts = await UserGift.findAll({
      where,
      include,
      order: [["createdAt", "DESC"]],
    });

    res.json(gifts);
  } catch (error) {
    console.error("❌ خطأ أثناء جلب الهدايا:", error);
    res.status(500).json({ error: "حدث خطأ أثناء جلب الهدايا" });
  }
});

// تحويل هدية يملكها المستخدم إلى نقاط
router.post("/convert-gift/:userGiftId", upload.none(), async (req, res) => {
    try {
        const { userGiftId } = req.params;
        const { userId } = req.body; // للتأكد من المالك

        const userGift = await UserGift.findOne({
            where: { id: userGiftId },
            include: { model: GiftItem, as: "item" }
        });

        if (!userGift) {
            return res.status(404).json({ error: "الهدية غير موجودة" });
        }

        if (userGift.userId != userId) {
            return res.status(403).json({ error: "لا تملك هذه الهدية" });
        }

        if (userGift.status !== "active") {
            return res.status(400).json({ error: "الهدية مستخدمة بالفعل" });
        }

        const pointsToAdd = userGift.item.points;

        // إضافة النقاط للمالك
        const user = await User.findByPk(userId);
        user.Jewel += pointsToAdd;
        await user.save();

        // تحديث الحالة
        userGift.status = "converted";
        await userGift.save();

        res.json({ message: "تم تحويل الهدية لنقاط", addedPoints: pointsToAdd, newBalance: user.Jewel });

    } catch (error) {
        console.error("❌ خطأ أثناء تحويل الهدية:", error);
        res.status(500).json({ error: "حدث خطأ أثناء تحويل الهدية" });
    }
});

module.exports = router;
