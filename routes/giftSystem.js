const express = require("express");
const router = express.Router();
const { User, GiftItem, UserGift, Settings, Room } = require("../models");
const upload = require("../middlewares/uploads");
const { Op } = require("sequelize");
const { connectedUsers } = require("../socket/socketHandler");
const { requireAdmin , authenticateTokenUser} = require("../middlewares/auth");

// إضافة هدية جديدة للمتجر (للمشرفين أو الإدارة)
router.post("/gift-items", requireAdmin, upload.single("image"), async (req, res) => {
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
router.patch("/gift-items/:id/toggle", requireAdmin, async (req, res) => {
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
router.post("/buy-gift/:giftItemId", authenticateTokenUser, upload.none(), async (req, res) => {
  const t = await User.sequelize.transaction();
  try {
    const userId = req.user.id;
    const { giftItemId } = req.params;

    const user = await User.findByPk(userId, { transaction: t, lock: t.LOCK.UPDATE });
    const item = await GiftItem.findByPk(giftItemId, { transaction: t });

    if (!user || !item) {
      await t.rollback();
      return res.status(404).json({ error: "المستخدم أو الهدية غير موجودة" });
    }

    if (!item.isAvailable) {
      await t.rollback();
      return res.status(400).json({ error: "هذه الهدية غير متاحة حالياً" });
    }

    const commissionSetting = await Settings.findOne({
      where: { key: "gift_buy_commission", isActive: true },
      transaction: t,
    });

    const commissionRate = Number(commissionSetting?.value ?? 0); 
    const price = Number(item.points ?? 0);

    const commission = Math.ceil(price * commissionRate);
    const totalCost = price + commission;

    if (Number(user.sawa ?? 0) < totalCost) {
      await t.rollback();
      return res.status(400).json({ error: "رصيد النقاط غير كافي (يشمل عمولة الشراء)" });
    }

    user.sawa = Number(user.sawa ?? 0) - totalCost;
    await user.save({ transaction: t });

    const userGift = await UserGift.create(
      { userId, giftItemId, status: "active" },
      { transaction: t }
    );

    await t.commit();

    return res.json({
      message: "تم شراء الهدية بنجاح",
      userGift,
      price,
      commissionRate,
      commission,
      totalCost,
      newBalance: user.sawa,
    });
  } catch (error) {
    await t.rollback();
    console.error("❌ خطأ أثناء شراء الهدية:", error);
    res.status(500).json({ error: "حدث خطأ أثناء شراء الهدية" });
  }
});

router.post("/send-gift", authenticateTokenUser, upload.none(), async (req, res) => {
  const t = await User.sequelize.transaction();

  try {
    const { receiverId, giftItemId, roomId } = req.body;
    const senderId = req.user.id;

    if (!roomId) {
      await t.rollback();
      return res.status(400).json({ error: "مطلوب لإرسال الهدية داخل غرفة" });
    }

    if (!senderId || !receiverId || !giftItemId) {
      await t.rollback();
      return res
        .status(400)
        .json({ error: "receiverId, giftItemId مطلوبة" });
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

    let roomOwnerId = null;

    if (roomId) {
      const room = await Room.findByPk(roomId, { transaction: t });
      if (!room) {
        await t.rollback();
        return res.status(404).json({ error: "الغرفة غير موجودة" });
      }
      roomOwnerId = room.creatorId;
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

    userGift.roomId = roomId || null;
    userGift.roomOwnerId = roomOwnerId;

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
router.get("/my-gifts/:userId", authenticateTokenUser,async (req, res) => {
  try {
    const userId = req.user.id;
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
router.post("/convert-gift/:userGiftId", authenticateTokenUser, upload.none(), async (req, res) => {
  const t = await User.sequelize.transaction();
  try {
    const { userGiftId } = req.params;
    const userId = req.user.id;

    if (!userId) {
      await t.rollback();
      return res.status(400).json({ error: "userId مطلوب" });
    }

    const userGift = await UserGift.findOne({
      where: { id: userGiftId },
      include: { model: GiftItem, as: "item" },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });

    if (!userGift) {
      await t.rollback();
      return res.status(404).json({ error: "الهدية غير موجودة" });
    }

    if (String(userGift.userId) !== String(userId)) {
      await t.rollback();
      return res.status(403).json({ error: "لا تملك هذه الهدية" });
    }

    const points = Number(userGift.item?.points ?? 0);
    if (!points || points <= 0) {
      await t.rollback();
      return res.status(400).json({ error: "نقاط الهدية غير صالحة" });
    }

    const receiver = await User.findByPk(userId, {
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!receiver) {
      await t.rollback();
      return res.status(404).json({ error: "المستخدم غير موجود" });
    }

    const isReceivedGift = userGift.senderId != null;

    let ownerCutRate = 0;
    let ownerShare = 0;
    let receiverShare = points;

    if (isReceivedGift && userGift.roomId) {
      const room = await Room.findByPk(userGift.roomId, { transaction: t });

      if (room) {
        const cutSetting = await Settings.findOne({
          where: { key: "room_gift_owner_cut", isActive: true },
          transaction: t,
        });

        ownerCutRate = Number(cutSetting?.value ?? 0);
        if (ownerCutRate < 0) ownerCutRate = 0;
        if (ownerCutRate > 1) ownerCutRate = 1;

        const actualRoomOwnerId = room.creatorId; // ✅ هذا المهم

        const roomOwner = await User.findByPk(actualRoomOwnerId, {
          transaction: t,
          lock: t.LOCK.UPDATE,
        });

        if (roomOwner && ownerCutRate > 0 && String(roomOwner.id) !== String(receiver.id)) {
          ownerShare = Math.floor(points * ownerCutRate);
          receiverShare = points - ownerShare;

          if (ownerShare > 0) {
            await roomOwner.increment({ sawa: ownerShare }, { transaction: t });
          }
        }
      }
    }

    await receiver.increment({ sawa: receiverShare }, { transaction: t });
    await userGift.destroy({ transaction: t, force: true });

    await t.commit();
    const updatedReceiver = await User.findByPk(userId);
    const updatedOwner = userGift.roomOwnerId ? await User.findByPk(userGift.roomOwnerId) : null;

    return res.json({
      message: "تم تحويل الهدية إلى نقاط وحذفها ✅",
      originalPoints: points,
      isReceivedGift,
      ownerCutRate,
      ownerShare,
      receiverShare,
      receiverNewBalance: updatedReceiver?.sawa,
      roomOwnerNewBalance: updatedOwner?.sawa,
    });
  } catch (error) {
    await t.rollback();
    console.error("❌ خطأ أثناء تحويل الهدية:", error);
    res.status(500).json({ error: "حدث خطأ أثناء تحويل الهدية" });
  }
});

module.exports = router;
