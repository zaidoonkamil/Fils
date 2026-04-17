const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const router = express.Router();
const { User, GiftItem, UserGift, Settings, Room } = require("../models");
const upload = require("../middlewares/uploads");
const { Op, DataTypes, fn, col, literal } = require("sequelize");
const { connectedUsers, roomUsers } = require("../socket/socketHandler");
const { requireAdmin , authenticateTokenUser} = require("../middlewares/auth");
const { sendNotificationToUser } = require("../services/notifications");

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
    return res.status(400).json({ error: "Ù†Ù‚Ø§Ø· Ø§Ù„Ù‡Ø¯ÙŠØ© ØºÙŠØ± ØµØ§Ù„Ø­Ø©" });
  }

  if (error.message === "RECEIVER_NOT_FOUND") {
    return res.status(404).json({ error: "Ø§Ù„Ù…Ø³ØªØ®Ø¯Ù… ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯" });
  }

  return null;
}

function parsePositiveInteger(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const parsedValue = Number.parseInt(value, 10);
  if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
    return null;
  }

  return parsedValue;
}

function parseStatsDate(value, options = {}) {
  if (!value) {
    return null;
  }

  const parsedDate = new Date(value);
  if (Number.isNaN(parsedDate.getTime())) {
    return null;
  }

  if (options.endOfDay) {
    parsedDate.setHours(23, 59, 59, 999);
  } else {
    parsedDate.setHours(0, 0, 0, 0);
  }

  return parsedDate;
}

function buildSentGiftStatsFilters(query) {
  const where = {
    senderId: { [Op.not]: null },
  };

  const fromDate = parseStatsDate(query.fromDate);
  const toDate = parseStatsDate(query.toDate, { endOfDay: true });

  if ((query.fromDate && !fromDate) || (query.toDate && !toDate)) {
    return { error: "ØµÙŠØºØ© Ø§Ù„ØªØ§Ø±ÙŠØ® ØºÙŠØ± ØµØ­ÙŠØ­Ø©" };
  }

  if (fromDate || toDate) {
    where.createdAt = {};
    if (fromDate) {
      where.createdAt[Op.gte] = fromDate;
    }
    if (toDate) {
      where.createdAt[Op.lte] = toDate;
    }
  }

  const giftItemId = parsePositiveInteger(query.giftItemId);
  if (query.giftItemId && !giftItemId) {
    return { error: "giftItemId ØºÙŠØ± ØµØ§Ù„Ø­" };
  }
  if (giftItemId) {
    where.giftItemId = giftItemId;
  }

  const senderId = parsePositiveInteger(query.senderId);
  if (query.senderId && !senderId) {
    return { error: "senderId ØºÙŠØ± ØµØ§Ù„Ø­" };
  }
  if (senderId) {
    where.senderId = senderId;
  }

  const receiverId = parsePositiveInteger(query.receiverId);
  if (query.receiverId && !receiverId) {
    return { error: "receiverId ØºÙŠØ± ØµØ§Ù„Ø­" };
  }
  if (receiverId) {
    where.userId = receiverId;
  }

  let roomScope = null;
  const deliveryType = query.deliveryType ? String(query.deliveryType).trim().toLowerCase() : null;
  if (deliveryType) {
    if (!["direct", "room"].includes(deliveryType)) {
      return { error: "deliveryType ÙŠØ¬Ø¨ Ø£Ù† ÙŠÙƒÙˆÙ† direct Ø£Ùˆ room" };
    }

    if (deliveryType === "direct") {
      where.roomId = { [Op.is]: null };
      roomScope = "direct";
    } else {
      where.roomId = { [Op.not]: null };
      roomScope = "room";
    }
  }

  const roomId = parsePositiveInteger(query.roomId);
  if (query.roomId && !roomId) {
    return { error: "roomId ØºÙŠØ± ØµØ§Ù„Ø­" };
  }
  if (roomId) {
    where.roomId = roomId;
    roomScope = "room";
  }

  return {
    where,
    roomScope,
    filters: {
      fromDate: fromDate ? fromDate.toISOString() : null,
      toDate: toDate ? toDate.toISOString() : null,
      giftItemId,
      senderId,
      receiverId,
      roomId,
      deliveryType: deliveryType || "all",
    },
  };
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
  payload,
}) {
  if (!roomsIO || !roomId) {
    return;
  }

  roomsIO.to(`room-${roomId}`).emit("gift-received", payload);
}


function getActiveRoomRecipients(roomId, senderId) {
  const parsedRoomId = Number.parseInt(roomId, 10);
  const roomUsersSet =
    roomUsers.get(parsedRoomId) ??
    roomUsers.get(String(roomId)) ??
    roomUsers.get(roomId);

  if (!roomUsersSet || roomUsersSet.size === 0) {
    return [];
  }

  return Array.from(roomUsersSet)
    .filter((user) => String(user.id) !== String(senderId))
    .map((user) => ({
      id: user.id,
      name: user.name,
      socketId: user.socketId,
    }));
}
function isUserActiveInRoom(roomId, userId) {
  const parsedRoomId = Number.parseInt(roomId, 10);
  const roomUsersSet =
    roomUsers.get(parsedRoomId) ??
    roomUsers.get(String(roomId)) ??
    roomUsers.get(roomId);

  if (!roomUsersSet || roomUsersSet.size === 0) {
    return false;
  }

  return Array.from(roomUsersSet).some(
    (user) => String(user.id) === String(userId)
  );
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
  let receiverCutRate = 1.0;
  let adminCutRate = 0;

  let ownerShare = 0;
  let receiverShare = points;
  let adminShare = 0;

  if (isReceivedGift && userGift.roomId) {
    const room = await Room.findByPk(userGift.roomId, { transaction });

    if (room) {
      const settings = await Settings.findAll({
        where: {
          key: ["room_gift_owner_cut", "room_gift_receiver_cut", "room_gift_admin_cut"],
          isActive: true,
        },
        transaction,
      });

      const config = {};
      settings.forEach((s) => (config[s.key] = Number(s.value)));

      ownerCutRate = config.room_gift_owner_cut ?? 0.1;
      receiverCutRate = config.room_gift_receiver_cut ?? 0.5;
      adminCutRate = config.room_gift_admin_cut ?? 0.4;

      const actualRoomOwnerId = room.creatorId;
      const isRoomOwnerActive = isUserActiveInRoom(
        userGift.roomId,
        actualRoomOwnerId
      );

      const roomOwner = isRoomOwnerActive
        ? await User.findByPk(actualRoomOwnerId, {
            transaction,
            lock: transaction.LOCK.UPDATE,
          })
        : null;

      if (roomOwner && String(roomOwner.id) !== String(receiver.id)) {
        ownerShare = Math.floor(points * ownerCutRate);
        receiverShare = Math.floor(points * receiverCutRate);
        adminShare = points - ownerShare - receiverShare;

        if (ownerShare > 0) {
          await roomOwner.increment({ sawa: ownerShare }, { transaction });
        }
      } else if (
        String(actualRoomOwnerId) === String(receiver.id) &&
        isRoomOwnerActive
      ) {
        receiverShare = Math.floor(points * (receiverCutRate + ownerCutRate));
        adminShare = points - receiverShare;
        ownerShare = 0;
      } else {
        receiverShare = Math.floor(points * receiverCutRate);
        ownerShare = 0;
        adminShare = points - receiverShare;
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
    receiverCutRate,
    adminCutRate,
    ownerShare,
    receiverShare,
    adminShare,
  };
}

// Ø¥Ø¶Ø§ÙØ© Ù‡Ø¯ÙŠØ© Ø¬Ø¯ÙŠØ¯Ø© Ù„Ù„Ù…ØªØ¬Ø± (Ù„Ù„Ù…Ø´Ø±ÙÙŠÙ† Ø£Ùˆ Ø§Ù„Ø¥Ø¯Ø§Ø±Ø©)
router.post("/gift-items", requireAdmin, upload.fields([
  { name: "image", maxCount: 1 },
  { name: "video", maxCount: 1 },
]), async (req, res) => {
  try {
    const { name, points } = req.body;
    const image = req.files?.image?.[0]?.path || null;
    const video = req.files?.video?.[0]?.path || null;

    if (!name || !points || !image || !video) {
      return res.status(400).json({ error: "Ø¬Ù…ÙŠØ¹ Ø§Ù„Ø­Ù‚ÙˆÙ„ Ù…Ø·Ù„ÙˆØ¨Ø©: Ø§Ù„Ø§Ø³Ù…ØŒ Ø§Ù„Ù†Ù‚Ø§Ø·ØŒ Ø§Ù„ØµÙˆØ±Ø©ØŒ ÙˆØ§Ù„ÙÙŠØ¯ÙŠÙˆ" });
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

    res.json({ message: "ØªÙ…Øª Ø¥Ø¶Ø§ÙØ© Ø§Ù„Ù‡Ø¯ÙŠØ© Ù„Ù„Ù…ØªØ¬Ø±", item: newItem });
  } catch (error) {
    console.error("âŒ Ø®Ø·Ø£ Ø£Ø«Ù†Ø§Ø¡ Ø¥Ø¶Ø§ÙØ© Ø§Ù„Ù‡Ø¯ÙŠØ©:", error);
    res.status(500).json({ error: "Ø­Ø¯Ø« Ø®Ø·Ø£ Ø£Ø«Ù†Ø§Ø¡ Ø¥Ø¶Ø§ÙØ© Ø§Ù„Ù‡Ø¯ÙŠØ©" });
  }
});

// Ø¹Ø±Ø¶ Ø¬Ù…ÙŠØ¹ Ø§Ù„Ù‡Ø¯Ø§ÙŠØ§ Ø§Ù„Ù…ØªØ§Ø­Ø© ÙÙŠ Ø§Ù„Ù…ØªØ¬Ø± (Ø§Ø®ØªÙŠØ§Ø±ÙŠ: ÙŠÙ…ÙƒÙ† ØªØµÙÙŠØ© Ø§Ù„Ù…ØªØ§Ø­ ÙÙ‚Ø· Ù„Ù„Ù…Ø³ØªØ®Ø¯Ù…ÙŠÙ†)
router.post("/gift-items/ensure-video-column", requireAdmin, async (req, res) => {
  try {
    const queryInterface = GiftItem.sequelize.getQueryInterface();
    const tableName = GiftItem.getTableName();
    const tableDefinition = await queryInterface.describeTable(tableName);

    if (tableDefinition.video) {
      return res.json({
        message: "Ø­Ù‚Ù„ video Ù…ÙˆØ¬ÙˆØ¯ Ø¨Ø§Ù„ÙØ¹Ù„",
        added: false,
      });
    }

    await queryInterface.addColumn(tableName, "video", {
      type: DataTypes.STRING,
      allowNull: true,
      after: "name",
    });

    return res.json({
      message: "ØªÙ…Øª Ø¥Ø¶Ø§ÙØ© Ø­Ù‚Ù„ video Ø¨Ù†Ø¬Ø§Ø­",
      added: true,
    });
  } catch (error) {
    console.error("âŒ Ø®Ø·Ø£ Ø£Ø«Ù†Ø§Ø¡ Ø¥Ø¶Ø§ÙØ© Ø­Ù‚Ù„ video:", error);
    return res.status(500).json({ error: "Ø­Ø¯Ø« Ø®Ø·Ø£ Ø£Ø«Ù†Ø§Ø¡ Ø¥Ø¶Ø§ÙØ© Ø§Ù„Ø­Ù‚Ù„ video" });
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
      message: changes.length ? "ØªÙ… Ø¥ØµÙ„Ø§Ø­ Ø¨Ù†ÙŠØ© Ø¬Ø¯ÙˆÙ„ Ø§Ù„Ù‡Ø¯Ø§ÙŠØ§" : "Ø¨Ù†ÙŠØ© Ø¬Ø¯ÙˆÙ„ Ø§Ù„Ù‡Ø¯Ø§ÙŠØ§ Ø³Ù„ÙŠÙ…Ø© Ø¨Ø§Ù„ÙØ¹Ù„",
      changes,
    });
  } catch (error) {
    console.error("âŒ Ø®Ø·Ø£ Ø£Ø«Ù†Ø§Ø¡ Ø¥ØµÙ„Ø§Ø­ Ø¬Ø¯ÙˆÙ„ Ø§Ù„Ù‡Ø¯Ø§ÙŠØ§:", error);
    return res.status(500).json({ error: "Ø­Ø¯Ø« Ø®Ø·Ø£ Ø£Ø«Ù†Ø§Ø¡ Ø¥ØµÙ„Ø§Ø­ Ø¬Ø¯ÙˆÙ„ Ø§Ù„Ù‡Ø¯Ø§ÙŠØ§" });
  }
});

router.get("/gift-items", async (req, res) => {
    try {
        const { includeUnavailable } = req.query; // Ù„Ù„Ø³Ù…Ø§Ø­ Ù„Ù„Ø£Ø¯Ù…Ù† Ø¨Ø±Ø¤ÙŠØ© Ø§Ù„ÙƒÙ„

        const whereClause = {};
        if (includeUnavailable !== "true") {
            whereClause.isAvailable = true;
        }

        const items = await GiftItem.findAll({ where: whereClause });
        res.json(items);
    } catch (error) {
        console.error("âŒ Ø®Ø·Ø£ Ø£Ø«Ù†Ø§Ø¡ Ø¬Ù„Ø¨ Ø§Ù„Ù‡Ø¯Ø§ÙŠØ§:", error);
        res.status(500).json({ error: "Ø­Ø¯Ø« Ø®Ø·Ø£ Ø£Ø«Ù†Ø§Ø¡ Ø¬Ù„Ø¨ Ø§Ù„Ù‡Ø¯Ø§ÙŠØ§" });
    }
});


router.get("/gift-items/sent-statistics", requireAdmin, async (req, res) => {
  try {
    const recentLimit = Math.min(parsePositiveInteger(req.query.limit) || 10, 50);
    const { where, roomScope, filters, error } = buildSentGiftStatsFilters(req.query);

    if (error) {
      return res.status(400).json({ error });
    }

    const totalSentGifts = await UserGift.count({ where });
    const totalUniqueSenders = await UserGift.count({
      where,
      distinct: true,
      col: "senderId",
    });
    const totalUniqueReceivers = await UserGift.count({
      where,
      distinct: true,
      col: "userId",
    });

    let sentInsideRooms = 0;
    let sentDirectly = 0;

    if (roomScope === "direct") {
      sentDirectly = totalSentGifts;
    } else if (roomScope === "room") {
      sentInsideRooms = totalSentGifts;
    } else {
      sentInsideRooms = await UserGift.count({
        where: {
          ...where,
          roomId: { [Op.not]: null },
        },
      });
      sentDirectly = totalSentGifts - sentInsideRooms;
    }

    const totalPointsRow = await UserGift.findOne({
      where,
      attributes: [
        [fn("COALESCE", fn("SUM", col("item.points")), 0), "totalPoints"],
      ],
      include: [
        { model: GiftItem, as: "item", attributes: [], required: true },
      ],
      raw: true,
    });

    const topGiftItems = await UserGift.findAll({
      where,
      attributes: [
        "giftItemId",
        [fn("COUNT", col("UserGift.id")), "sentCount"],
        [fn("COALESCE", fn("SUM", col("item.points")), 0), "totalPoints"],
      ],
      include: [
        {
          model: GiftItem,
          as: "item",
          attributes: ["id", "name", "image", "video", "points"],
          required: true,
        },
      ],
      group: ["giftItemId", "item.id", "item.name", "item.image", "item.video", "item.points"],
      order: [literal("sentCount DESC")],
      limit: 5,
      subQuery: false,
    });

    const topSenders = await UserGift.findAll({
      where,
      attributes: [
        "senderId",
        [fn("COUNT", col("UserGift.id")), "sentCount"],
        [fn("COALESCE", fn("SUM", col("item.points")), 0), "totalPoints"],
      ],
      include: [
        {
          model: User,
          as: "sender",
          attributes: ["id", "name"],
          required: true,
        },
        {
          model: GiftItem,
          as: "item",
          attributes: [],
          required: true,
        },
      ],
      group: ["senderId", "sender.id", "sender.name"],
      order: [literal("sentCount DESC")],
      limit: 5,
      subQuery: false,
    });

    const recentSentGifts = await UserGift.findAll({
      where,
      include: [
        {
          model: GiftItem,
          as: "item",
          attributes: ["id", "name", "image", "video", "points"],
        },
        {
          model: User,
          as: "sender",
          attributes: ["id", "name"],
        },
        {
          model: User,
          as: "user",
          attributes: ["id", "name"],
        },
        {
          model: Room,
          as: "room",
          attributes: ["id", "name"],
        },
      ],
      order: [["createdAt", "DESC"]],
      limit: recentLimit,
    });

    const totalPoints = Number(totalPointsRow?.totalPoints ?? 0);

    return res.json({
      success: true,
      filters: {
        ...filters,
        limit: recentLimit,
      },
      summary: {
        totalSentGifts,
        totalPoints,
        totalUniqueSenders,
        totalUniqueReceivers,
        sentInsideRooms,
        sentDirectly,
        averagePointsPerGift: totalSentGifts ? Number((totalPoints / totalSentGifts).toFixed(2)) : 0,
      },
      topGiftItems: topGiftItems.map((entry) => ({
        giftItem: serializeGiftItem(entry.item),
        sentCount: Number(entry.get("sentCount") ?? 0),
        totalPoints: Number(entry.get("totalPoints") ?? 0),
      })),
      topSenders: topSenders.map((entry) => ({
        sender: entry.sender ? { id: entry.sender.id, name: entry.sender.name } : null,
        sentCount: Number(entry.get("sentCount") ?? 0),
        totalPoints: Number(entry.get("totalPoints") ?? 0),
      })),
      recentSentGifts: recentSentGifts.map((gift) => ({
        id: gift.id,
        status: gift.status,
        createdAt: gift.createdAt,
        sender: gift.sender ? { id: gift.sender.id, name: gift.sender.name } : null,
        receiver: gift.user ? { id: gift.user.id, name: gift.user.name } : null,
        room: gift.room ? { id: gift.room.id, name: gift.room.name } : null,
        giftItem: serializeGiftItem(gift.item),
      })),
    });
  } catch (error) {
    console.error("âŒ Ø®Ø·Ø£ Ø£Ø«Ù†Ø§Ø¡ Ø¬Ù„Ø¨ Ø¥Ø­ØµØ§Ø¦ÙŠØ§Øª Ø§Ù„Ù‡Ø¯Ø§ÙŠØ§ Ø§Ù„Ù…Ø±Ø³Ù„Ø©:", error);
    return res.status(500).json({ error: "Ø­Ø¯Ø« Ø®Ø·Ø£ Ø£Ø«Ù†Ø§Ø¡ Ø¬Ù„Ø¨ Ø¥Ø­ØµØ§Ø¦ÙŠØ§Øª Ø§Ù„Ù‡Ø¯Ø§ÙŠØ§ Ø§Ù„Ù…Ø±Ø³Ù„Ø©" });
  }
});

// ØªØ¹Ø¯ÙŠÙ„ Ø­Ø§Ù„Ø© Ø§Ù„Ù‡Ø¯ÙŠØ© (Ø¥ÙŠÙ‚Ø§Ù/ØªÙØ¹ÙŠÙ„) - Ø¨Ø¯Ù„Ø§Ù‹ Ù…Ù† Ø§Ù„ØªØ¹Ù„ÙŠÙ‚
router.patch("/gift-items/:id/toggle", requireAdmin, async (req, res) => {
    try {
        const giftItemId = req.params.id;
        const item = await GiftItem.findByPk(giftItemId);

        if (!item) {
            return res.status(404).json({ error: "Ø§Ù„Ù‡Ø¯ÙŠØ© ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯Ø©" });
        }

        // Ø¹ÙƒØ³ Ø§Ù„Ø­Ø§Ù„Ø© Ø§Ù„Ø­Ø§Ù„ÙŠØ©
        item.isAvailable = !item.isAvailable;
        await item.save();

        res.json({
            message: item.isAvailable ? "ØªÙ… ØªÙØ¹ÙŠÙ„ Ø§Ù„Ù‡Ø¯ÙŠØ©" : "ØªÙ… Ø¥ÙŠÙ‚Ø§Ù Ø¹Ø±Ø¶ Ø§Ù„Ù‡Ø¯ÙŠØ©",
            item
        });

    } catch (error) {
        console.error("âŒ Ø®Ø·Ø£ Ø£Ø«Ù†Ø§Ø¡ ØªØ¹Ø¯ÙŠÙ„ Ø­Ø§Ù„Ø© Ø§Ù„Ù‡Ø¯ÙŠØ©:", error);
        res.status(500).json({ error: "Ø­Ø¯Ø« Ø®Ø·Ø£ Ø£Ø«Ù†Ø§Ø¡ Ø§Ù„ØªØ¹Ø¯ÙŠÙ„" });
    }
});



// ØªØ¹Ø¯ÙŠÙ„ Ø¨ÙŠØ§Ù†Ø§Øª Ø§Ù„Ù‡Ø¯ÙŠØ© (Ø§Ù„Ø§Ø³Ù…ØŒ Ø§Ù„Ù†Ù‚Ø§Ø·)
router.patch("/gift-items/:id", requireAdmin, upload.none(), async (req, res) => {
  try {
    const giftItemId = req.params.id;
    const { name, points } = req.body;
    const item = await GiftItem.findByPk(giftItemId);

    if (!item) {
      return res.status(404).json({ error: "Ø§Ù„Ù‡Ø¯ÙŠØ© ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯Ø©" });
    }

    // ØªØ­Ø¯ÙŠØ« Ø§Ù„Ø§Ø³Ù… ÙˆØ§Ù„Ù†Ù‚Ø§Ø· Ø¥Ø°Ø§ ØªÙ… ØªÙ‚Ø¯ÙŠÙ…Ù‡Ø§
    if (name) item.name = name;
    if (points !== undefined) item.points = points;

    await item.save();

    res.json({
      message: "ØªÙ… ØªØ­Ø¯ÙŠØ« Ø¨ÙŠØ§Ù†Ø§Øª Ø§Ù„Ù‡Ø¯ÙŠØ© Ø¨Ù†Ø¬Ø§Ø­",
      item
    });

  } catch (error) {
    console.error("âŒ Ø®Ø·Ø£ Ø£Ø«Ù†Ø§Ø¡ ØªØ¹Ø¯ÙŠÙ„ Ø¨ÙŠØ§Ù†Ø§Øª Ø§Ù„Ù‡Ø¯ÙŠØ©:", error);
    res.status(500).json({ error: "Ø­Ø¯Ø« Ø®Ø·Ø£ Ø£Ø«Ù†Ø§Ø¡ Ø§Ù„ØªØ¹Ø¯ÙŠÙ„" });
  }
});


// Ø­Ø°Ù Ø§Ù„Ù‡Ø¯ÙŠØ© Ù…Ù† Ø§Ù„Ù…ØªØ¬Ø±
router.delete("/gift-items/:id", requireAdmin, async (req, res) => {
  const transaction = await GiftItem.sequelize.transaction();

  try {
    const { id } = req.params;
    const item = await GiftItem.findByPk(id, { transaction });

    if (!item) {
      await transaction.rollback();
      return res.status(404).json({ error: "Ø§Ù„Ù‡Ø¯ÙŠØ© ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯Ø©" });
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
      message: "ØªÙ… Ø­Ø°Ù Ø§Ù„Ù‡Ø¯ÙŠØ© ÙˆÙ…Ø­ØªÙˆØ§Ù‡Ø§ Ù…Ù† Ø§Ù„Ø³ÙŠØ±ÙØ±",
      deletedGiftId: item.id,
    });
  } catch (error) {
    await transaction.rollback();
    console.error("âŒ Ø®Ø·Ø£ Ø£Ø«Ù†Ø§Ø¡ Ø­Ø°Ù Ø§Ù„Ù‡Ø¯ÙŠØ©:", error);
    return res.status(500).json({ error: "Ø­Ø¯Ø« Ø®Ø·Ø£ Ø£Ø«Ù†Ø§Ø¡ Ø­Ø°Ù Ø§Ù„Ù‡Ø¯ÙŠØ©" });
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
      return res.status(404).json({ error: "Ø§Ù„Ù…Ø³ØªØ®Ø¯Ù… Ø£Ùˆ Ø§Ù„Ù‡Ø¯ÙŠØ© ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯Ø©" });
    }

    if (!item.isAvailable) {
      await t.rollback();
      return res.status(400).json({ error: "Ù‡Ø°Ù‡ Ø§Ù„Ù‡Ø¯ÙŠØ© ØºÙŠØ± Ù…ØªØ§Ø­Ø© Ø­Ø§Ù„ÙŠØ§Ù‹" });
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
      return res.status(400).json({ error: "Ø±ØµÙŠØ¯ Ø§Ù„Ù†Ù‚Ø§Ø· ØºÙŠØ± ÙƒØ§ÙÙŠ (ÙŠØ´Ù…Ù„ Ø¹Ù…ÙˆÙ„Ø© Ø§Ù„Ø´Ø±Ø§Ø¡)" });
    }

    user.sawa = Number(user.sawa ?? 0) - totalCost;
    await user.save({ transaction: t });

    const userGift = await UserGift.create(
      { userId, giftItemId, status: "active" },
      { transaction: t }
    );

    await t.commit();

    return res.json({
      message: "ØªÙ… Ø´Ø±Ø§Ø¡ Ø§Ù„Ù‡Ø¯ÙŠØ© Ø¨Ù†Ø¬Ø§Ø­",
      userGift,
      price,
      commissionRate,
      commission,
      totalCost,
      newBalance: user.sawa,
    });
  } catch (error) {
    await t.rollback();
    console.error("âŒ Ø®Ø·Ø£ Ø£Ø«Ù†Ø§Ø¡ Ø´Ø±Ø§Ø¡ Ø§Ù„Ù‡Ø¯ÙŠØ©:", error);
    res.status(500).json({ error: "Ø­Ø¯Ø« Ø®Ø·Ø£ Ø£Ø«Ù†Ø§Ø¡ Ø´Ø±Ø§Ø¡ Ø§Ù„Ù‡Ø¯ÙŠØ©" });
  }
});

router.post("/send-gift-direct", authenticateTokenUser, upload.none(), async (req, res) => {
  const t = await User.sequelize.transaction();

  try {
    const { receiverId, giftItemId, roomId } = req.body;
    const senderId = req.user.id;

    if (!senderId || !receiverId || !giftItemId) {
      await t.rollback();
      return res.status(400).json({ error: "receiverId Ùˆ giftItemId Ù…Ø·Ù„ÙˆØ¨Ø©" });
    }

    if (String(senderId) === String(receiverId)) {
      await t.rollback();
      return res.status(400).json({ error: "Ù„Ø§ ÙŠÙ…ÙƒÙ† Ø¥Ø±Ø³Ø§Ù„ Ù‡Ø¯ÙŠØ© Ù„Ù†ÙØ³Ùƒ" });
    }

    const sender = await User.findByPk(senderId, {
      transaction: t,
      lock: t.LOCK.UPDATE,
      attributes: ["id", "name", "sawa"],
    });
    if (!sender) {
      await t.rollback();
      return res.status(404).json({ error: "Ø§Ù„Ù…Ø±Ø³Ù„ ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯" });
    }

    const receiver = await User.findByPk(receiverId, {
      transaction: t,
      attributes: ["id", "name"],
    });
    if (!receiver) {
      await t.rollback();
      return res.status(404).json({ error: "Ø§Ù„Ù…Ø³ØªÙ„Ù… ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯" });
    }

    const item = await GiftItem.findByPk(giftItemId, { transaction: t });
    if (!item) {
      await t.rollback();
      return res.status(404).json({ error: "Ø§Ù„Ù‡Ø¯ÙŠØ© ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯Ø©" });
    }

    if (!item.isAvailable) {
      await t.rollback();
      return res.status(400).json({ error: "Ù‡Ø°Ù‡ Ø§Ù„Ù‡Ø¯ÙŠØ© ØºÙŠØ± Ù…ØªØ§Ø­Ø© Ø­Ø§Ù„ÙŠØ§Ù‹" });
    }

    const giftCost = Number(item.points ?? 0);
    if (!giftCost || giftCost <= 0) {
      await t.rollback();
      return res.status(400).json({ error: "Ø³Ø¹Ø± Ø§Ù„Ù‡Ø¯ÙŠØ© ØºÙŠØ± ØµØ§Ù„Ø­" });
    }

    if (Number(sender.sawa ?? 0) < giftCost) {
      await t.rollback();
      return res.status(400).json({
        error: "Ø±ØµÙŠØ¯ Ø§Ù„Ù†Ù‚Ø§Ø· ØºÙŠØ± ÙƒØ§ÙÙ Ù„Ø¥Ø±Ø³Ø§Ù„ Ù‡Ø°Ù‡ Ø§Ù„Ù‡Ø¯ÙŠØ©",
        requiredPoints: giftCost,
        currentBalance: Number(sender.sawa ?? 0),
      });
    }

    let roomOwnerId = null;
    if (roomId) {
      const room = await Room.findByPk(roomId, { transaction: t });
      if (!room) {
        await t.rollback();
        return res.status(404).json({ error: "Ø§Ù„ØºØ±ÙØ© ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯Ø©" });
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
      receiverCutRate: conversionResult.receiverCutRate,
      adminCutRate: conversionResult.adminCutRate,
      ownerShare: conversionResult.ownerShare,
      receiverShare: conversionResult.receiverShare,
      adminShare: conversionResult.adminShare,
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

    try {
      await sendNotificationToUser(
        receiverId,
        `${sender.name} Ø§Ø±Ø³Ù„ Ø§Ù„ÙŠÙƒ Ù‡Ø¯ÙŠØ©`,
        "Ù‡Ø¯ÙŠØ© Ø¬Ø¯ÙŠØ¯Ø©"
      );
    } catch (notifyError) {
      console.warn("âš ï¸ ÙØ´Ù„ Ø¥Ø±Ø³Ø§Ù„ Ø¥Ø´Ø¹Ø§Ø± Ø§Ù„Ù‡Ø¯ÙŠØ©:", notifyError.message);
    }

    return res.json({
      message: "ØªÙ… Ø¥Ø±Ø³Ø§Ù„ Ø§Ù„Ù‡Ø¯ÙŠØ© Ù…Ø¨Ø§Ø´Ø±Ø© Ø¨Ù†Ø¬Ø§Ø­",
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
    console.error("âŒ Ø®Ø·Ø£ Ø£Ø«Ù†Ø§Ø¡ Ø§Ù„Ø¥Ø±Ø³Ø§Ù„ Ø§Ù„Ù…Ø¨Ø§Ø´Ø± Ù„Ù„Ù‡Ø¯ÙŠØ©:", error);
    return res.status(500).json({ error: "Ø­Ø¯Ø« Ø®Ø·Ø£ Ø£Ø«Ù†Ø§Ø¡ Ø§Ù„Ø¥Ø±Ø³Ø§Ù„ Ø§Ù„Ù…Ø¨Ø§Ø´Ø± Ù„Ù„Ù‡Ø¯ÙŠØ©" });
  }
});

router.post("/send-gift-room-all", authenticateTokenUser, upload.none(), async (req, res) => {
  const t = await User.sequelize.transaction();

  try {
    const { giftItemId, roomId } = req.body;
    const senderId = req.user.id;

    if (!senderId || !giftItemId || !roomId) {
      await t.rollback();
      return res.status(400).json({ error: "giftItemId Ùˆ roomId Ù…Ø·Ù„ÙˆØ¨Ø©" });
    }

    const room = await Room.findByPk(roomId, { transaction: t });
    if (!room) {
      await t.rollback();
      return res.status(404).json({ error: "Ø§Ù„ØºØ±ÙØ© ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯Ø©" });
    }

    const recipients = getActiveRoomRecipients(roomId, senderId);
    if (recipients.length === 0) {
      await t.rollback();
      return res.status(400).json({ error: "Ù„Ø§ ÙŠÙˆØ¬Ø¯ Ù…Ø³ØªÙ„Ù…ÙˆÙ† Ø¯Ø§Ø®Ù„ Ø§Ù„ØºØ±ÙØ© Ø­Ø§Ù„ÙŠØ§Ù‹" });
    }

    const sender = await User.findByPk(senderId, {
      transaction: t,
      lock: t.LOCK.UPDATE,
      attributes: ["id", "name", "sawa"],
    });
    if (!sender) {
      await t.rollback();
      return res.status(404).json({ error: "Ø§Ù„Ù…Ø±Ø³Ù„ ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯" });
    }

    const item = await GiftItem.findByPk(giftItemId, { transaction: t });
    if (!item) {
      await t.rollback();
      return res.status(404).json({ error: "Ø§Ù„Ù‡Ø¯ÙŠØ© ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯Ø©" });
    }

    if (!item.isAvailable) {
      await t.rollback();
      return res.status(400).json({ error: "Ù‡Ø°Ù‡ Ø§Ù„Ù‡Ø¯ÙŠØ© ØºÙŠØ± Ù…ØªØ§Ø­Ø© Ø­Ø§Ù„ÙŠØ§Ù‹" });
    }

    const giftCost = Number(item.points ?? 0);
    if (!giftCost || giftCost <= 0) {
      await t.rollback();
      return res.status(400).json({ error: "Ø³Ø¹Ø± Ø§Ù„Ù‡Ø¯ÙŠØ© ØºÙŠØ± ØµØ§Ù„Ø­" });
    }

    const totalCost = giftCost * recipients.length;
    if (Number(sender.sawa ?? 0) < totalCost) {
      await t.rollback();
      return res.status(400).json({
        error: "Ø±ØµÙŠØ¯ Ø§Ù„Ù†Ù‚Ø§Ø· ØºÙŠØ± ÙƒØ§ÙÙ Ù„Ø¥Ø±Ø³Ø§Ù„ Ø§Ù„Ù‡Ø¯ÙŠØ© Ù„Ù„Ø¬Ù…ÙŠØ¹",
        requiredPoints: totalCost,
        currentBalance: Number(sender.sawa ?? 0),
        recipientsCount: recipients.length,
      });
    }

    sender.sawa = Number(sender.sawa ?? 0) - totalCost;
    await sender.save({ transaction: t });

    const payloads = [];

    for (const recipientInfo of recipients) {
      const receiver = await User.findByPk(recipientInfo.id, {
        transaction: t,
        attributes: ["id", "name"],
      });

      if (!receiver) {
        continue;
      }

      const userGift = await UserGift.create({
        userId: receiver.id,
        senderId,
        giftItemId,
        roomId,
        roomOwnerId: room.creatorId,
        status: "active",
      }, { transaction: t });

      userGift.item = item;

      const conversionResult = await convertGiftToPoints({
        userGift,
        receiverId: receiver.id,
        transaction: t,
      });

      payloads.push(
        buildGiftSocketPayload({
          userGift,
          sender,
          receiver,
          item,
          conversion: {
            originalPoints: conversionResult.points,
            ownerCutRate: conversionResult.ownerCutRate,
            receiverCutRate: conversionResult.receiverCutRate,
            adminCutRate: conversionResult.adminCutRate,
            ownerShare: conversionResult.ownerShare,
            receiverShare: conversionResult.receiverShare,
            adminShare: conversionResult.adminShare,
          },
          message: "ÙˆØµÙ„ØªÙƒ Ù‡Ø¯ÙŠØ© ÙˆØªÙ… ØªØ­ÙˆÙŠÙ„Ù‡Ø§ Ù…Ø¨Ø§Ø´Ø±Ø© Ø¥Ù„Ù‰ Ù†Ù‚Ø§Ø· ðŸŽ",
          senderBalance: sender.sawa,
        })
      );
    }

    if (payloads.length === 0) {
      await t.rollback();
      return res.status(400).json({ error: "ØªØ¹Ø°Ø± ØªØ­Ø¯ÙŠØ¯ Ù…Ø³ØªÙ„Ù…ÙŠÙ† ØµØ§Ù„Ø­ÙŠÙ† Ø¯Ø§Ø®Ù„ Ø§Ù„ØºØ±ÙØ©" });
    }

    await t.commit();

    const roomsIO = req.app.get("roomsIO");
    const senderSocketId = connectedUsers.get(String(senderId));
    const broadcastPayload = {
      message: "ÙˆØµÙ„Øª Ù‡Ø¯ÙŠØ© Ù„Ù„Ø¬Ù…ÙŠØ¹ ÙˆØªÙ… ØªØ­ÙˆÙŠÙ„Ù‡Ø§ Ù…Ø¨Ø§Ø´Ø±Ø© Ø¥Ù„Ù‰ Ù†Ù‚Ø§Ø· ðŸŽ",
      senderBalance: sender.sawa,
      roomId,
      createdAt: new Date().toISOString(),
      recipientsCount: payloads.length,
      isRoomBroadcastAll: true,
      sender: {
        id: sender.id,
        name: sender.name,
      },
      receiver: {
        id: null,
        name: "Ø§Ù„Ø¬Ù…ÙŠØ¹",
      },
      item: serializeGiftItem(item),
    };

    emitRoomGiftNotification({
      roomsIO,
      roomId,
      payload: broadcastPayload,
    });

      if (roomsIO && senderSocketId) {
        roomsIO.to(senderSocketId).emit("gift-sent", {
          message: "ØªÙ… Ø¥Ø±Ø³Ø§Ù„ Ø§Ù„Ù‡Ø¯ÙŠØ© Ù„Ù„Ø¬Ù…ÙŠØ¹ Ø¨Ù†Ø¬Ø§Ø­ âœ…",
          senderBalance: sender.sawa,
          roomId,
          giftItem: serializeGiftItem(item),
          recipientsCount: payloads.length,
          isRoomBroadcastAll: true,
        });
      }

    for (const payload of payloads) {
      try {
        if (payload.userGift?.receiver?.id) {
          await sendNotificationToUser(
            payload.userGift.receiver.id,
            `${sender.name} Ø§Ø±Ø³Ù„ Ø§Ù„ÙŠÙƒ Ù‡Ø¯ÙŠØ©`,
            "Ù‡Ø¯ÙŠØ© Ø¬Ø¯ÙŠØ¯Ø©"
          );
        }
      } catch (notifyError) {
        console.warn("âš ï¸ ÙØ´Ù„ Ø¥Ø±Ø³Ø§Ù„ Ø¥Ø´Ø¹Ø§Ø± Ù‡Ø¯ÙŠØ© Ù„Ù„Ø¬Ù…ÙŠØ¹:", notifyError.message);
      }
    }

      return res.json({
        message: "ØªÙ… Ø¥Ø±Ø³Ø§Ù„ Ø§Ù„Ù‡Ø¯ÙŠØ© Ù„Ù„Ø¬Ù…ÙŠØ¹ Ø¨Ù†Ø¬Ø§Ø­",
        deductedPoints: totalCost,
        senderBalance: sender.sawa,
        recipientsCount: payloads.length,
        giftItem: serializeGiftItem(item),
        isRoomBroadcastAll: true,
      });
  } catch (error) {
    const handledResponse = buildGiftConversionErrorResponse(error, res);
    if (handledResponse) {
      await t.rollback();
      return handledResponse;
    }

    await t.rollback();
    console.error("âŒ Ø®Ø·Ø£ Ø£Ø«Ù†Ø§Ø¡ Ø¥Ø±Ø³Ø§Ù„ Ø§Ù„Ù‡Ø¯ÙŠØ© Ù„Ù„Ø¬Ù…ÙŠØ¹:", error);
    return res.status(500).json({ error: "Ø­Ø¯Ø« Ø®Ø·Ø£ Ø£Ø«Ù†Ø§Ø¡ Ø¥Ø±Ø³Ø§Ù„ Ø§Ù„Ù‡Ø¯ÙŠØ© Ù„Ù„Ø¬Ù…ÙŠØ¹" });
  }
});

router.post("/send-gift", authenticateTokenUser, upload.none(), async (req, res) => {
  const t = await User.sequelize.transaction();

  try {
    const { receiverId, giftItemId, roomId } = req.body;
    const senderId = req.user.id;

    if (!roomId) {
      await t.rollback();
      return res.status(400).json({ error: "Ù…Ø·Ù„ÙˆØ¨ Ù„Ø¥Ø±Ø³Ø§Ù„ Ø§Ù„Ù‡Ø¯ÙŠØ© Ø¯Ø§Ø®Ù„ ØºØ±ÙØ©" });
    }

    if (!senderId || !receiverId || !giftItemId) {
      await t.rollback();
      return res
        .status(400)
        .json({ error: "receiverId, giftItemId Ù…Ø·Ù„ÙˆØ¨Ø©" });
    }

    if (String(senderId) === String(receiverId)) {
      await t.rollback();
      return res.status(400).json({ error: "Ù„Ø§ ÙŠÙ…ÙƒÙ† Ø¥Ø±Ø³Ø§Ù„ Ù‡Ø¯ÙŠØ© Ù„Ù†ÙØ³Ùƒ" });
    }

    const sender = await User.findByPk(senderId, {
      transaction: t,
      attributes: ["id", "name"],
    });
    if (!sender) {
      await t.rollback();
      return res.status(404).json({ error: "Ø§Ù„Ù…Ø±Ø³Ù„ ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯" });
    }

    const receiver = await User.findByPk(receiverId, {
      transaction: t,
      attributes: ["id", "name"],
    });
    if (!receiver) {
      await t.rollback();
      return res.status(404).json({ error: "Ø§Ù„Ù…Ø³ØªÙ„Ù… ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯" });
    }

    const item = await GiftItem.findByPk(giftItemId, { transaction: t });
    if (!item) {
      await t.rollback();
      return res.status(404).json({ error: "Ø§Ù„Ù‡Ø¯ÙŠØ© ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯Ø©" });
    }

    if (!item.isAvailable) {
      await t.rollback();
      return res.status(400).json({ error: "Ù‡Ø°Ù‡ Ø§Ù„Ù‡Ø¯ÙŠØ© ØºÙŠØ± Ù…ØªØ§Ø­Ø© Ø­Ø§Ù„ÙŠØ§Ù‹" });
    }

    let roomOwnerId = null;

    if (roomId) {
      const room = await Room.findByPk(roomId, { transaction: t });
      if (!room) {
        await t.rollback();
        return res.status(404).json({ error: "Ø§Ù„ØºØ±ÙØ© ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯Ø©" });
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
      return res.status(400).json({ error: "Ù„Ø§ ØªÙ…Ù„Ùƒ Ù‡Ø°Ù‡ Ø§Ù„Ù‡Ø¯ÙŠØ© ÙÙŠ Ù…Ø®Ø²ÙˆÙ†Ùƒ" });
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
      receiverCutRate: conversionResult.receiverCutRate,
      adminCutRate: conversionResult.adminCutRate,
      ownerShare: conversionResult.ownerShare,
      receiverShare: conversionResult.receiverShare,
      adminShare: conversionResult.adminShare,
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

    try {
      await sendNotificationToUser(
        receiverId,
        `${sender.name} Ø§Ø±Ø³Ù„ Ø§Ù„ÙŠÙƒ Ù‡Ø¯ÙŠØ©`,
        "Ù‡Ø¯ÙŠØ© Ø¬Ø¯ÙŠØ¯Ø©"
      );
    } catch (notifyError) {
      console.warn("âš ï¸ ÙØ´Ù„ Ø¥Ø±Ø³Ø§Ù„ Ø¥Ø´Ø¹Ø§Ø± Ø§Ù„Ù‡Ø¯ÙŠØ©:", notifyError.message);
    }

    return res.json({
      message: "ØªÙ… Ø¥Ø±Ø³Ø§Ù„ Ø§Ù„Ù‡Ø¯ÙŠØ© ÙˆØªØ­ÙˆÙŠÙ„Ù‡Ø§ Ù…Ø¨Ø§Ø´Ø±Ø© Ø¥Ù„Ù‰ Ù†Ù‚Ø§Ø·",
      ...payload,
    });
  } catch (error) {
    const handledResponse = buildGiftConversionErrorResponse(error, res);
    if (handledResponse) {
      await t.rollback();
      return handledResponse;
    }

    console.error("âŒ Ø®Ø·Ø£ Ø£Ø«Ù†Ø§Ø¡ Ø¥Ø±Ø³Ø§Ù„ Ø§Ù„Ù‡Ø¯ÙŠØ©:", error);
    await t.rollback();
    res.status(500).json({ error: "Ø­Ø¯Ø« Ø®Ø·Ø£ Ø£Ø«Ù†Ø§Ø¡ Ø¥Ø±Ø³Ø§Ù„ Ø§Ù„Ù‡Ø¯ÙŠØ©" });
  }
});

// Ø¹Ø±Ø¶ Ø§Ù„Ù‡Ø¯Ø§ÙŠØ§ Ø§Ù„ØªÙŠ ÙŠÙ…Ù„ÙƒÙ‡Ø§ Ø§Ù„Ù…Ø³ØªØ®Ø¯Ù…
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
    console.error("âŒ Ø®Ø·Ø£ Ø£Ø«Ù†Ø§Ø¡ Ø¬Ù„Ø¨ Ø§Ù„Ù‡Ø¯Ø§ÙŠØ§:", error);
    res.status(500).json({ error: "Ø­Ø¯Ø« Ø®Ø·Ø£ Ø£Ø«Ù†Ø§Ø¡ Ø¬Ù„Ø¨ Ø§Ù„Ù‡Ø¯Ø§ÙŠØ§" });
  }
});

// ØªØ­ÙˆÙŠÙ„ Ù‡Ø¯ÙŠØ© ÙŠÙ…Ù„ÙƒÙ‡Ø§ Ø§Ù„Ù…Ø³ØªØ®Ø¯Ù… Ø¥Ù„Ù‰ Ù†Ù‚Ø§Ø·
router.post("/convert-gift/:userGiftId", authenticateTokenUser, upload.none(), async (req, res) => {
  const t = await User.sequelize.transaction();
  try {
    const { userGiftId } = req.params;
    const userId = req.user.id;

    if (!userId) {
      await t.rollback();
      return res.status(400).json({ error: "userId Ù…Ø·Ù„ÙˆØ¨" });
    }

    const userGift = await UserGift.findOne({
      where: { id: userGiftId, status: "active" },
      include: { model: GiftItem, as: "item" },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });

    if (!userGift) {
      await t.rollback();
      return res.status(404).json({ error: "Ø§Ù„Ù‡Ø¯ÙŠØ© ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯Ø©" });
    }

    if (String(userGift.userId) !== String(userId)) {
      await t.rollback();
      return res.status(403).json({ error: "Ù„Ø§ ØªÙ…Ù„Ùƒ Ù‡Ø°Ù‡ Ø§Ù„Ù‡Ø¯ÙŠØ©" });
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
      message: "ØªÙ… ØªØ­ÙˆÙŠÙ„ Ø§Ù„Ù‡Ø¯ÙŠØ© Ø¥Ù„Ù‰ Ù†Ù‚Ø§Ø· âœ…",
      originalPoints: conversionResult.points,
      isReceivedGift: conversionResult.isReceivedGift,
      ownerCutRate: conversionResult.ownerCutRate,
      receiverCutRate: conversionResult.receiverCutRate,
      adminCutRate: conversionResult.adminCutRate,
      ownerShare: conversionResult.ownerShare,
      receiverShare: conversionResult.receiverShare,
      adminShare: conversionResult.adminShare,
      receiverNewBalance: updatedReceiver?.sawa,
      roomOwnerNewBalance: updatedOwner?.sawa,

    });
  } catch (error) {
    await t.rollback();

    const handledResponse = buildGiftConversionErrorResponse(error, res);
    if (handledResponse) {
      return handledResponse;
    }

    console.error("âŒ Ø®Ø·Ø£ Ø£Ø«Ù†Ø§Ø¡ ØªØ­ÙˆÙŠÙ„ Ø§Ù„Ù‡Ø¯ÙŠØ©:", error);
    res.status(500).json({ error: "Ø­Ø¯Ø« Ø®Ø·Ø£ Ø£Ø«Ù†Ø§Ø¡ ØªØ­ÙˆÙŠÙ„ Ø§Ù„Ù‡Ø¯ÙŠØ©" });
  }
});

module.exports = router;


