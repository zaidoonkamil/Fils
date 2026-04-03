const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const router = express.Router();
const { User, GiftItem, UserGift, Settings, Room } = require("../models");
const upload = require("../middlewares/uploads");
const { Op, DataTypes } = require("sequelize");
const { connectedUsers } = require("../socket/socketHandler");
const { requireAdmin , authenticateTokenUser} = require("../middlewares/auth");

const uploadsDir = path.resolve(process.cwd(), "uploads");

async function deleteGiftMediaFile(filePath) {
  if (!filePath || typeof filePath !== "string") {
    return;
  }

  const normalizedPath = filePath.replace(/\\/g, "/");
  const absolutePath = path.resolve(process.cwd(), normalizedPath);

  if (!absolutePath.startsWith(uploadsDir + path.sep) && absolutePath !== uploadsDir) {
    return;
  }

  try {
    await fs.unlink(absolutePath);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

function buildGiftConversionErrorResponse(error, res) {
  if (error.message === "INVALID_GIFT_POINTS") {
    return res.status(400).json({ error: "نقاط الهدية غير صالحة" });
  }

  if (error.message === "RECEIVER_NOT_FOUND") {
    return res.status(404).json({ error: "المستخدم غير موجود" });
  }

  return null;
}

function serializeGiftItem(item) {
  if (!item) return null;

  return {
    id: item.id,
    name: item.name,
    image: item.image,
    video: item.video,
    points: item.points,
    isAvailable: item.isAvailable,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

function buildGiftSocketPayload({
  userGift,
  sender,
  receiver,
  item,
  conversion,
  message,
  senderBalance,
}) {
  return {
    message,
    autoConvertedToPoints: true,
    senderBalance,
    userGift: {
      id: userGift.id,
      userId: userGift.userId,
      senderId: userGift.senderId,
      giftItemId: userGift.giftItemId,
      roomId: userGift.roomId,
      roomOwnerId: userGift.roomOwnerId,
      status: userGift.status,
      createdAt: userGift.createdAt,
      updatedAt: userGift.updatedAt,
      sender: sender ? { id: sender.id, name: sender.name } : null,
      receiver: receiver ? { id: receiver.id, name: receiver.name } : null,
      item: serializeGiftItem(item),
      conversion,
    },
  };
}

function emitRoomGiftNotification({
  roomsIO,
  roomId,
  senderSocketId,
  payload,
}) {
  if (!roomsIO || !roomId) {
    return;
  }

  const roomTarget = roomsIO.to(`room-${roomId}`);

  if (senderSocketId) {
    roomsIO.except(senderSocketId).to(`room-${roomId}`).emit("gift-received", payload);
    return;
  }

  roomTarget.emit("gift-received", payload);
}

async function convertGiftToPoints({
  userGift,
  receiverId,
  transaction,
}) {
  const points = Number(userGift.item?.points ?? 0);
  if (!points || points <= 0) {
    throw new Error("INVALID_GIFT_POINTS");
  }

  const receiver = await User.findByPk(receiverId, {
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  if (!receiver) {
    throw new Error("RECEIVER_NOT_FOUND");
  }

  const isReceivedGift = userGift.senderId != null;

  let ownerCutRate = 0;
  let ownerShare = 0;
  let receiverShare = points;

  if (isReceivedGift && userGift.roomId) {
    const room = await Room.findByPk(userGift.roomId, { transaction });

    if (room) {
      const cutSetting = await Settings.findOne({
        where: { key: "room_gift_owner_cut", isActive: true },
        transaction,
      });

      ownerCutRate = Number(cutSetting?.value ?? 0);
      if (ownerCutRate < 0) ownerCutRate = 0;
      if (ownerCutRate > 1) ownerCutRate = 1;

      const actualRoomOwnerId = room.creatorId;

      const roomOwner = await User.findByPk(actualRoomOwnerId, {
        transaction,
        lock: transaction.LOCK.UPDATE,
      });

      if (roomOwner && ownerCutRate > 0 && String(roomOwner.id) !== String(receiver.id)) {
        ownerShare = Math.floor(points * ownerCutRate);
        receiverShare = points - ownerShare;

        if (ownerShare > 0) {
          await roomOwner.increment({ sawa: ownerShare }, { transaction });
        }
      }
    }
  }

  await receiver.increment({ sawa: receiverShare }, { transaction });
  userGift.status = "converted";
  await userGift.save({ transaction });

  return {
    points,
    isReceivedGift,
    ownerCutRate,
    ownerShare,
    receiverShare,
  };
}

// إضافة هدية جديدة للمتجر (للمشرفين أو الإدارة)
router.post("/gift-items", requireAdmin, upload.fields([
  { name: "image", maxCount: 1 },
  { name: "video", maxCount: 1 },
]), async (req, res) => {
  try {
    const { name, points } = req.body;
    const image = req.files?.image?.[0]?.path || null;
    const video = req.files?.video?.[0]?.path || null;

    if (!name || !points || !image || !video) {
      return res.status(400).json({ error: "جميع الحقول مطلوبة: الاسم، النقاط، الصورة، والفيديو" });
    }

    const queryInterface = GiftItem.sequelize.getQueryInterface();
    const tableName = GiftItem.getTableName();
    const tableDefinition = await queryInterface.describeTable(tableName);

    const giftItemPayload = {
      name,
      points,
      isAvailable: true,
    };

    if (tableDefinition.video) {
      giftItemPayload.video = video;
    }

    if (tableDefinition.image) {
      giftItemPayload.image = image;
    }

    const newItem = await GiftItem.create(giftItemPayload);

    res.json({ message: "تمت إضافة الهدية للمتجر", item: newItem });
  } catch (error) {
    console.error("❌ خطأ أثناء إضافة الهدية:", error);
    res.status(500).json({ error: "حدث خطأ أثناء إضافة الهدية" });
  }
});

// عرض جميع الهدايا المتاحة في المتجر (اختياري: يمكن تصفية المتاح فقط للمستخدمين)
router.post("/gift-items/ensure-video-column", requireAdmin, async (req, res) => {
  try {
    const queryInterface = GiftItem.sequelize.getQueryInterface();
    const tableName = GiftItem.getTableName();
    const tableDefinition = await queryInterface.describeTable(tableName);

    if (tableDefinition.video) {
      return res.json({
        message: "حقل video موجود بالفعل",
        added: false,
      });
    }

    await queryInterface.addColumn(tableName, "video", {
      type: DataTypes.STRING,
      allowNull: true,
      after: "name",
    });

    return res.json({
      message: "تمت إضافة حقل video بنجاح",
      added: true,
    });
  } catch (error) {
    console.error("❌ خطأ أثناء إضافة حقل video:", error);
    return res.status(500).json({ error: "حدث خطأ أثناء إضافة الحقل video" });
  }
});

router.post("/gift-items/fix-schema", requireAdmin, async (req, res) => {
  try {
    const queryInterface = GiftItem.sequelize.getQueryInterface();
    const tableName = GiftItem.getTableName();
    const tableDefinition = await queryInterface.describeTable(tableName);
    const changes = [];

    if (!tableDefinition.video) {
      await queryInterface.addColumn(tableName, "video", {
        type: DataTypes.STRING,
        allowNull: true,
        after: "name",
      });
      changes.push("added_video");
    }

    if (tableDefinition.image) {
      await queryInterface.changeColumn(tableName, "image", {
        type: DataTypes.STRING,
        allowNull: true,
      });
      changes.push("image_nullable");
    }

    return res.json({
      message: changes.length ? "تم إصلاح بنية جدول الهدايا" : "بنية جدول الهدايا سليمة بالفعل",
      changes,
    });
  } catch (error) {
    console.error("❌ خطأ أثناء إصلاح جدول الهدايا:", error);
    return res.status(500).json({ error: "حدث خطأ أثناء إصلاح جدول الهدايا" });
  }
});

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
router.delete("/gift-items/:id", requireAdmin, async (req, res) => {
  const transaction = await GiftItem.sequelize.transaction();

  try {
    const { id } = req.params;
    const item = await GiftItem.findByPk(id, { transaction });

    if (!item) {
      await transaction.rollback();
      return res.status(404).json({ error: "الهدية غير موجودة" });
    }

    const filesToDelete = [item.image, item.video].filter(Boolean);

    await UserGift.destroy({
      where: { giftItemId: item.id },
      transaction,
    });

    await item.destroy({ transaction });
    await transaction.commit();

    for (const filePath of filesToDelete) {
      await deleteGiftMediaFile(filePath);
    }

    return res.json({
      message: "تم حذف الهدية ومحتواها من السيرفر",
      deletedGiftId: item.id,
    });
  } catch (error) {
    await transaction.rollback();
    console.error("❌ خطأ أثناء حذف الهدية:", error);
    return res.status(500).json({ error: "حدث خطأ أثناء حذف الهدية" });
  }
});

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

router.post("/send-gift-direct", authenticateTokenUser, upload.none(), async (req, res) => {
  const t = await User.sequelize.transaction();

  try {
    const { receiverId, giftItemId, roomId } = req.body;
    const senderId = req.user.id;

    if (!senderId || !receiverId || !giftItemId) {
      await t.rollback();
      return res.status(400).json({ error: "receiverId و giftItemId مطلوبة" });
    }

    if (String(senderId) === String(receiverId)) {
      await t.rollback();
      return res.status(400).json({ error: "لا يمكن إرسال هدية لنفسك" });
    }

    const sender = await User.findByPk(senderId, {
      transaction: t,
      lock: t.LOCK.UPDATE,
      attributes: ["id", "name", "sawa"],
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

    const giftCost = Number(item.points ?? 0);
    if (!giftCost || giftCost <= 0) {
      await t.rollback();
      return res.status(400).json({ error: "سعر الهدية غير صالح" });
    }

    if (Number(sender.sawa ?? 0) < giftCost) {
      await t.rollback();
      return res.status(400).json({
        error: "رصيد النقاط غير كافٍ لإرسال هذه الهدية",
        requiredPoints: giftCost,
        currentBalance: Number(sender.sawa ?? 0),
      });
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

    sender.sawa = Number(sender.sawa ?? 0) - giftCost;
    await sender.save({ transaction: t });

    const userGift = await UserGift.create({
      userId: receiverId,
      senderId,
      giftItemId,
      roomId: roomId || null,
      roomOwnerId,
      status: "active",
    }, { transaction: t });

    userGift.item = item;

    const conversionResult = await convertGiftToPoints({
      userGift,
      receiverId,
      transaction: t,
    });

    await t.commit();

    const updatedReceiver = await User.findByPk(receiverId);
    const updatedOwner = userGift.roomOwnerId
      ? await User.findByPk(userGift.roomOwnerId)
      : null;

    const conversion = {
      originalPoints: conversionResult.points,
      ownerCutRate: conversionResult.ownerCutRate,
      ownerShare: conversionResult.ownerShare,
      receiverShare: conversionResult.receiverShare,
      receiverNewBalance: updatedReceiver?.sawa,
      roomOwnerNewBalance: updatedOwner?.sawa,
    };

    const payload = buildGiftSocketPayload({
      userGift,
      sender,
      receiver,
      item,
      conversion,
      message: "\u0648\u0635\u0644\u062a\u0643 \u0647\u062f\u064a\u0629 \u0648\u062a\u0645 \u062a\u062d\u0648\u064a\u0644\u0647\u0627 \u0645\u0628\u0627\u0634\u0631\u0629 \u0625\u0644\u0649 \u0646\u0642\u0627\u0637 \u{1F381}",
      senderBalance: sender.sawa,
    });

    const roomsIO = req.app.get("roomsIO");
    const senderSocketId = connectedUsers.get(String(senderId));

    if (roomId) {
      emitRoomGiftNotification({
        roomsIO,
        roomId,
        senderSocketId,
        payload,
      });
    } else {
      const receiverSocketId = connectedUsers.get(String(receiverId));
      if (roomsIO && receiverSocketId) {
        roomsIO.to(receiverSocketId).emit("gift-received", payload);
      }
    }

    if (roomsIO && senderSocketId) {
      roomsIO.to(senderSocketId).emit("gift-sent", {
        ...payload,
        message: "\u062a\u0645 \u0625\u0631\u0633\u0627\u0644 \u0627\u0644\u0647\u062f\u064a\u0629 \u0645\u0628\u0627\u0634\u0631\u0629 \u0648\u062e\u0635\u0645 \u0642\u064a\u0645\u062a\u0647\u0627 \u0645\u0646 \u0631\u0635\u064a\u062f\u0643 \u2705",
      });
    }

    return res.json({
      message: "تم إرسال الهدية مباشرة بنجاح",
      deductedPoints: giftCost,
      senderBalance: sender.sawa,
      ...payload,
    });
  } catch (error) {
    const handledResponse = buildGiftConversionErrorResponse(error, res);
    if (handledResponse) {
      await t.rollback();
      return handledResponse;
    }

    await t.rollback();
    console.error("❌ خطأ أثناء الإرسال المباشر للهدية:", error);
    return res.status(500).json({ error: "حدث خطأ أثناء الإرسال المباشر للهدية" });
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
    userGift.item = item;

    const conversionResult = await convertGiftToPoints({
      userGift,
      receiverId,
      transaction: t,
    });

    await t.commit();

    const updatedReceiver = await User.findByPk(receiverId);
    const updatedOwner = userGift.roomOwnerId
      ? await User.findByPk(userGift.roomOwnerId)
      : null;

    const conversion = {
      originalPoints: conversionResult.points,
      ownerCutRate: conversionResult.ownerCutRate,
      ownerShare: conversionResult.ownerShare,
      receiverShare: conversionResult.receiverShare,
      receiverNewBalance: updatedReceiver?.sawa,
      roomOwnerNewBalance: updatedOwner?.sawa,
    };

    const payload = buildGiftSocketPayload({
      userGift,
      sender,
      receiver,
      item,
      conversion,
      message: "\u0648\u0635\u0644\u062a\u0643 \u0647\u062f\u064a\u0629 \u0648\u062a\u0645 \u062a\u062d\u0648\u064a\u0644\u0647\u0627 \u0645\u0628\u0627\u0634\u0631\u0629 \u0625\u0644\u0649 \u0646\u0642\u0627\u0637 \u{1F381}",
    });

    const roomsIO = req.app.get("roomsIO");
    const senderSocketId = connectedUsers.get(String(senderId));

    if (roomId) {
      emitRoomGiftNotification({
        roomsIO,
        roomId,
        senderSocketId,
        payload,
      });
    } else {
      const receiverSocketId = connectedUsers.get(String(receiverId));
      if (roomsIO && receiverSocketId) {
        roomsIO.to(receiverSocketId).emit("gift-received", payload);
      }
    }

    if (roomsIO && senderSocketId) {
      roomsIO.to(senderSocketId).emit("gift-sent", {
        ...payload,
        message: "\u062a\u0645 \u0625\u0631\u0633\u0627\u0644 \u0627\u0644\u0647\u062f\u064a\u0629 \u0648\u062a\u062d\u0648\u064a\u0644\u0647\u0627 \u0645\u0628\u0627\u0634\u0631\u0629 \u0625\u0644\u0649 \u0646\u0642\u0627\u0637 \u2705",
      });
    }

    return res.json({
      message: "تم إرسال الهدية وتحويلها مباشرة إلى نقاط",
      ...payload,
    });
  } catch (error) {
    const handledResponse = buildGiftConversionErrorResponse(error, res);
    if (handledResponse) {
      await t.rollback();
      return handledResponse;
    }

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
      where: { id: userGiftId, status: "active" },
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

    const conversionResult = await convertGiftToPoints({
      userGift,
      receiverId: userId,
      transaction: t,
    });

    await t.commit();
    const updatedReceiver = await User.findByPk(userId);
    const updatedOwner = userGift.roomOwnerId ? await User.findByPk(userGift.roomOwnerId) : null;

    return res.json({
      message: "تم تحويل الهدية إلى نقاط ✅",
      originalPoints: conversionResult.points,
      isReceivedGift: conversionResult.isReceivedGift,
      ownerCutRate: conversionResult.ownerCutRate,
      ownerShare: conversionResult.ownerShare,
      receiverShare: conversionResult.receiverShare,
      receiverNewBalance: updatedReceiver?.sawa,
      roomOwnerNewBalance: updatedOwner?.sawa,
    });
  } catch (error) {
    await t.rollback();

    const handledResponse = buildGiftConversionErrorResponse(error, res);
    if (handledResponse) {
      return handledResponse;
    }

    console.error("❌ خطأ أثناء تحويل الهدية:", error);
    res.status(500).json({ error: "حدث خطأ أثناء تحويل الهدية" });
  }
});

module.exports = router;
