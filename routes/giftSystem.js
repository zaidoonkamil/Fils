const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const router = express.Router();
const { User, GiftItem, UserGift, Settings, Room } = require("../models");
const upload = require("../middlewares/uploads");
const { Op, DataTypes, fn, col, literal } = require("sequelize");
const { connectedUsers, roomUsers } = require("../socket/socketHandler");
const { requireAdmin , authenticateTokenUser} = require("../middlewares/auth");
const { sendNotificationToUser: originalSendNotificationToUser } = require("../services/notifications");
// تم تعطيل إشعارات الهدايا الفردية والجماعية مؤقتًا بطلب الإدارة.
const sendNotificationToUser = async () => null;
const {
  getGlobalSupportLeaderboard,
  getSupportLeaderboardHistory,
  getRoomSupportLeaderboard,
  getRoomsSupportLeaderboard,
  getRoomsLeaderboardHistory,
} = require("../services/roomLeaderboard");
const roomsRouter = require("./rooms");

const uploadsDir = path.resolve(process.cwd(), "uploads");
let userGiftAccountingColumnsReady = false;
let giftItemsTierColumnReady = false;

const GIFT_TIERS = new Set(["normal", "premium", "vip"]);

function normalizeGiftTier(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (GIFT_TIERS.has(normalized)) {
    return normalized;
  }
  return "premium";
}

async function ensureUserGiftAccountingColumns() {
  if (userGiftAccountingColumnsReady) return;

  const queryInterface = UserGift.sequelize.getQueryInterface();
  const tableName = UserGift.getTableName();
  const tableDefinition = await queryInterface.describeTable(tableName);
  const accountingColumns = {
    pointsSnapshot: DataTypes.INTEGER,
    ownerShare: DataTypes.INTEGER,
    receiverShare: DataTypes.INTEGER,
    adminShare: DataTypes.INTEGER,
  };

  for (const [columnName, type] of Object.entries(accountingColumns)) {
    if (!tableDefinition[columnName]) {
      await queryInterface.addColumn(tableName, columnName, {
        type,
        allowNull: true,
      });
    }
  }

  userGiftAccountingColumnsReady = true;
}

async function ensureGiftItemTierColumn() {
  if (giftItemsTierColumnReady) return;

  const queryInterface = GiftItem.sequelize.getQueryInterface();
  const tableName = GiftItem.getTableName();
  const tableDefinition = await queryInterface.describeTable(tableName);

  if (!tableDefinition.tier) {
    await queryInterface.addColumn(tableName, "tier", {
      type: DataTypes.ENUM("normal", "premium", "vip"),
      allowNull: false,
      defaultValue: "premium",
      after: "points",
    });
  }

  await GiftItem.update(
    { tier: "premium" },
    { where: { [Op.or]: [{ tier: null }, { tier: "" }] } },
  );

  giftItemsTierColumnReady = true;
}

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
    return { error: "صيغة التاريخ غير صحيحة" };
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
    return { error: "giftItemId غير صالح" };
  }
  if (giftItemId) {
    where.giftItemId = giftItemId;
  }

  const senderId = parsePositiveInteger(query.senderId);
  if (query.senderId && !senderId) {
    return { error: "senderId غير صالح" };
  }
  if (senderId) {
    where.senderId = senderId;
  }

  const receiverId = parsePositiveInteger(query.receiverId);
  if (query.receiverId && !receiverId) {
    return { error: "receiverId غير صالح" };
  }
  if (receiverId) {
    where.userId = receiverId;
  }

  let roomScope = null;
  const deliveryType = query.deliveryType ? String(query.deliveryType).trim().toLowerCase() : null;
  if (deliveryType) {
    if (!["direct", "room"].includes(deliveryType)) {
      return { error: "deliveryType يجب أن يكون direct أو room" };
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
    return { error: "roomId غير صالح" };
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
    tier: normalizeGiftTier(item.tier),
    isAvailable: item.isAvailable,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

async function getRoomGiftCutRates() {
  const settings = await Settings.findAll({
    where: {
      key: [
        "room_gift_owner_cut",
        "room_gift_receiver_cut",
        "room_gift_admin_cut",
        "room_gift_supervisor_gold_cut",
        "room_gift_supervisor_silver_cut",
        "room_gift_supervisor_bronze_cut",
        "room_gift_supervisor_standard_cut",
      ],
      isActive: true,
    },
  });

  const config = {};
  settings.forEach((s) => (config[s.key] = Number(s.value)));

  return {
    ownerCutRate: config.room_gift_owner_cut ?? 0.1,
    receiverCutRate: config.room_gift_receiver_cut ?? 0.5,
    adminCutRate: config.room_gift_admin_cut ?? 0.4,
    supervisorRates: {
      gold: config.room_gift_supervisor_gold_cut ?? 0,
      silver: config.room_gift_supervisor_silver_cut ?? 0,
      bronze: config.room_gift_supervisor_bronze_cut ?? 0,
      standard: config.room_gift_supervisor_standard_cut ?? 0,
    },
  };
}

function estimateRoomGiftAdminShare(userGift, rates) {
  if (!userGift?.roomId) return 0;

  const points = Number(userGift.item?.points ?? userGift.pointsSnapshot ?? 0);
  if (!points || points <= 0) return 0;

  const ownerId = userGift.roomOwnerId;
  const receiverId = userGift.userId;
  let ownerShare = 0;
  let receiverShare = Math.floor(points * rates.receiverCutRate);

  if (ownerId && String(ownerId) !== String(receiverId)) {
    ownerShare = Math.floor(points * rates.ownerCutRate);
  } else if (ownerId && String(ownerId) === String(receiverId)) {
    receiverShare = Math.floor(points * (rates.receiverCutRate + rates.ownerCutRate));
  }

  return Math.max(points - ownerShare - receiverShare, 0);
}

function normalizeRoomSupervisorSlots(value) {
  const base = {
    gold: null,
    silver: null,
    bronze: null,
    standard: null,
  };

  const source =
    value && typeof value === "object" && !Array.isArray(value)
      ? value
      : {};

  for (const key of Object.keys(base)) {
    const parsedId = Number(source[key]);
    base[key] = Number.isFinite(parsedId) && parsedId > 0 ? parsedId : null;
  }

  return base;
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
  roomsIO.emit("gift-ticker", payload);
}

async function emitRoomLeaderboardUpdate({
  roomsIO,
  roomId,
}) {
  if (!roomsIO || !roomId) {
    return;
  }

  try {
    const [roomLeaderboard, roomsLeaderboard] = await Promise.all([
      getGlobalSupportLeaderboard({ limit: 10 }),
      getRoomsSupportLeaderboard({ limit: 10 }),
    ]);

    roomsIO.emit("room-top-supporters-updated", {
      roomId: Number(roomId),
      leaderboard: roomLeaderboard,
      roomsLeaderboard,
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.warn("Failed to emit room leaderboard update:", error.message);
  }
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
  let supervisorShares = {
    gold: 0,
    silver: 0,
    bronze: 0,
    standard: 0,
  };

  if (isReceivedGift && userGift.roomId) {
    const room = await Room.findByPk(userGift.roomId, { transaction });

    if (room) {
      const rates = await getRoomGiftCutRates();
      ownerCutRate = rates.ownerCutRate;
      receiverCutRate = rates.receiverCutRate;
      adminCutRate = rates.adminCutRate;
      const supervisorRates = rates.supervisorRates || {};

      const actualRoomOwnerId = room.creatorId;
      const isRoomOwnerActive = isUserActiveInRoom(
        userGift.roomId,
        actualRoomOwnerId
      );

      const supervisorSlots = normalizeRoomSupervisorSlots(room.supervisorSlots);
      const activeSupervisorEntries = Object.entries(supervisorSlots)
        .filter(([, userId]) => userId != null)
        .map(([slotKey, userId]) => ({
          slotKey,
          userId: Number(userId),
          isActive: isUserActiveInRoom(userGift.roomId, Number(userId)),
          rate: Number(supervisorRates[slotKey] ?? 0),
        }));

      const roomOwner = isRoomOwnerActive
        ? await User.findByPk(actualRoomOwnerId, {
            transaction,
            lock: transaction.LOCK.UPDATE,
          })
        : null;

      if (roomOwner && String(roomOwner.id) !== String(receiver.id)) {
        ownerShare = Math.floor(points * ownerCutRate);
        receiverShare = Math.floor(points * receiverCutRate);

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
      }

      for (const entry of activeSupervisorEntries) {
        const share = Math.max(0, Math.floor(points * entry.rate));
        if (share <= 0) continue;

        if (entry.isActive) {
          const supervisorUser = await User.findByPk(entry.userId, {
            transaction,
            lock: transaction.LOCK.UPDATE,
          });

          if (supervisorUser) {
            await supervisorUser.increment({ sawa: share }, { transaction });
            supervisorShares[entry.slotKey] = share;
            continue;
          }
        }

        adminShare += share;
      }

      adminShare += Math.max(
        points - ownerShare - receiverShare - Object.values(supervisorShares).reduce((sum, value) => sum + value, 0),
        0,
      );
    }
  }

  await receiver.increment({ sawa: receiverShare }, { transaction });
  userGift.pointsSnapshot = points;
  userGift.ownerShare = ownerShare;
  userGift.receiverShare = receiverShare;
  userGift.adminShare = adminShare;
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
    supervisorShares,
  };
}

// إضافة هدية جديدة للمتجر (للمشرفين أو الإدارة)
router.post("/gift-items", requireAdmin, upload.fields([
  { name: "image", maxCount: 1 },
  { name: "video", maxCount: 1 },
]), async (req, res) => {
  try {
    await ensureGiftItemTierColumn();
    const { name, points, tier } = req.body;
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
      tier: normalizeGiftTier(tier),
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

    if (!tableDefinition.tier) {
      await queryInterface.addColumn(tableName, "tier", {
        type: DataTypes.ENUM("normal", "premium", "vip"),
        allowNull: false,
        defaultValue: "premium",
        after: "points",
      });
      changes.push("added_tier");
    }

    await GiftItem.update(
      { tier: "premium" },
      { where: { [Op.or]: [{ tier: null }, { tier: "" }] } },
    );

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
        await ensureGiftItemTierColumn();
        const { includeUnavailable } = req.query; // للسماح للأدمن برؤية الكل

        const whereClause = {};
        if (includeUnavailable !== "true") {
            whereClause.isAvailable = true;
        }

        const items = await GiftItem.findAll({ where: whereClause });
        res.json(items.map((item) => serializeGiftItem(item)));
    } catch (error) {
        console.error("❌ خطأ أثناء جلب الهدايا:", error);
        res.status(500).json({ error: "حدث خطأ أثناء جلب الهدايا" });
    }
});


router.get("/gift-items/sent-statistics", requireAdmin, async (req, res) => {
  try {
    await ensureUserGiftAccountingColumns();

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
    const storedAdminGiftPoints = Number(await UserGift.sum("adminShare", {
      where: {
        ...where,
        adminShare: { [Op.not]: null },
      },
    }) || 0);

    let estimatedAdminGiftPoints = 0;
    if (roomScope !== "direct") {
      const untrackedAdminShareWhere = {
        ...where,
        adminShare: { [Op.is]: null },
      };

      if (roomScope !== "room" && !untrackedAdminShareWhere.roomId) {
        untrackedAdminShareWhere.roomId = { [Op.not]: null };
      }

      const rates = await getRoomGiftCutRates();
      const untrackedRoomGifts = await UserGift.findAll({
        where: untrackedAdminShareWhere,
        attributes: ["id", "userId", "roomId", "roomOwnerId", "pointsSnapshot"],
        include: [
          {
            model: GiftItem,
            as: "item",
            attributes: ["points"],
            required: true,
          },
        ],
      });

      estimatedAdminGiftPoints = untrackedRoomGifts.reduce(
        (sum, gift) => sum + estimateRoomGiftAdminShare(gift, rates),
        0
      );
    }

    const totalAdminGiftPoints = storedAdminGiftPoints + estimatedAdminGiftPoints;

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
        totalAdminGiftPoints,
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
    console.error("❌ خطأ أثناء جلب إحصائيات الهدايا المرسلة:", error);
    return res.status(500).json({ error: "حدث خطأ أثناء جلب إحصائيات الهدايا المرسلة" });
  }
});

// تعديل حالة الهدية (إيقاف/تفعيل) - بدلاً من التعليق
router.get("/room/:roomId/top-supporters", authenticateTokenUser, async (req, res) => {
  try {
    const roomId = Number.parseInt(req.params.roomId, 10);
    if (!Number.isInteger(roomId) || roomId <= 0) {
      return res.status(400).json({ error: "roomId غير صالح" });
    }

    const room = await Room.findByPk(roomId, {
      attributes: ["id", "name", "images", "currentUsers", "category", "isActive"],
    });

    if (!room || room.isActive === false) {
      return res.status(404).json({ error: "الغرفة غير موجودة" });
    }

    const leaderboard = await getGlobalSupportLeaderboard({ limit: 10 });

    return res.json({
      success: true,
      room: {
        id: room.id,
        name: room.name,
        image: Array.isArray(room.images) && room.images.length > 0 ? room.images[0] : "",
        currentUsers: Number(room.currentUsers ?? 0),
        category: room.category ?? "",
      },
      ...leaderboard,
    });
  } catch (error) {
    console.error("Error fetching room supporters leaderboard:", error);
    return res.status(500).json({ error: "حدث خطأ أثناء جلب توب الداعمين" });
  }
});

router.get("/rooms/top-supporters", authenticateTokenUser, async (req, res) => {
  try {
    const leaderboard = await getRoomsSupportLeaderboard({ limit: 10 });
    return res.json({
      success: true,
      ...leaderboard,
    });
  } catch (error) {
    console.error("Error fetching rooms leaderboard:", error);
    return res.status(500).json({ error: "حدث خطأ أثناء جلب توب الرومات" });
  }
});

router.get("/leaderboards/supporters/history", authenticateTokenUser, async (req, res) => {
  try {
    const limit = parsePositiveInteger(req.query.limit) || 10;
    const history = await getSupportLeaderboardHistory({ limit });
    return res.json({
      success: true,
      totalCycles: history.length,
      history,
    });
  } catch (error) {
    console.error("Error fetching supporters leaderboard history:", error);
    return res.status(500).json({ error: "حدث خطأ أثناء جلب سجل توب الداعمين" });
  }
});

router.get("/leaderboards/rooms/history", authenticateTokenUser, async (req, res) => {
  try {
    const limit = parsePositiveInteger(req.query.limit) || 10;
    const history = await getRoomsLeaderboardHistory({ limit });
    return res.json({
      success: true,
      totalCycles: history.length,
      history,
    });
  } catch (error) {
    console.error("Error fetching rooms leaderboard history:", error);
    return res.status(500).json({ error: "حدث خطأ أثناء جلب سجل توب الرومات" });
  }
});

router.patch("/gift-items/:id/toggle", requireAdmin, async (req, res) => {
    try {
        await ensureGiftItemTierColumn();
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



// تعديل بيانات الهدية (الاسم، النقاط)
router.patch("/gift-items/:id", requireAdmin, upload.none(), async (req, res) => {
  try {
    await ensureGiftItemTierColumn();
    const giftItemId = req.params.id;
    const { name, points, tier } = req.body;
    const item = await GiftItem.findByPk(giftItemId);

    if (!item) {
      return res.status(404).json({ error: "الهدية غير موجودة" });
    }

    // تحديث الاسم والنقاط إذا تم تقديمها
    if (name) item.name = name;
    if (points !== undefined) item.points = points;
    if (tier !== undefined) item.tier = normalizeGiftTier(tier);

    await item.save();

    res.json({
      message: "تم تحديث بيانات الهدية بنجاح",
      item
    });

  } catch (error) {
    console.error("❌ خطأ أثناء تعديل بيانات الهدية:", error);
    res.status(500).json({ error: "حدث خطأ أثناء التعديل" });
  }
});


// حذف الهدية من المتجر
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
  await ensureUserGiftAccountingColumns();

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
      receiverCutRate: conversionResult.receiverCutRate,
      adminCutRate: conversionResult.adminCutRate,
      ownerShare: conversionResult.ownerShare,
      receiverShare: conversionResult.receiverShare,
      adminShare: conversionResult.adminShare,
      supervisorShares: conversionResult.supervisorShares,
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
      if (typeof roomsRouter.processRoomChallengeGift === "function") {
        await roomsRouter.processRoomChallengeGift({
          app: req.app,
          roomId,
          receiver,
          sender,
          points: conversionResult.points,
          receiverShare: conversionResult.receiverShare,
        });
      }
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
        `${sender.name} ارسل اليك هدية`,
        "هدية جديدة"
      );
    } catch (notifyError) {
      console.warn("⚠️ فشل إرسال إشعار الهدية:", notifyError.message);
    }

    return res.json({
      message: "تم إرسال الهدية مباشرة بنجاح",
      ...(roomId
        ? (await emitRoomLeaderboardUpdate({
            roomsIO,
            roomId,
          }),
          {})
        : {}),
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

router.post("/send-gift-room-all", authenticateTokenUser, upload.none(), async (req, res) => {
  await ensureUserGiftAccountingColumns();

  const t = await User.sequelize.transaction();

  try {
    const { giftItemId, roomId } = req.body;
    const senderId = req.user.id;

    if (!senderId || !giftItemId || !roomId) {
      await t.rollback();
      return res.status(400).json({ error: "giftItemId و roomId مطلوبة" });
    }

    const room = await Room.findByPk(roomId, { transaction: t });
    if (!room) {
      await t.rollback();
      return res.status(404).json({ error: "الغرفة غير موجودة" });
    }

    const recipients = getActiveRoomRecipients(roomId, senderId);
    if (recipients.length === 0) {
      await t.rollback();
      return res.status(400).json({ error: "لا يوجد مستلمون داخل الغرفة حالياً" });
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

    const totalCost = giftCost * recipients.length;
    if (Number(sender.sawa ?? 0) < totalCost) {
      await t.rollback();
      return res.status(400).json({
        error: "رصيد النقاط غير كافٍ لإرسال الهدية للجميع",
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
            supervisorShares: conversionResult.supervisorShares,
          },
          message: "وصلتك هدية وتم تحويلها مباشرة إلى نقاط 🎁",
          senderBalance: sender.sawa,
        })
      );
    }

    if (payloads.length === 0) {
      await t.rollback();
      return res.status(400).json({ error: "تعذر تحديد مستلمين صالحين داخل الغرفة" });
    }

    await t.commit();

    const roomsIO = req.app.get("roomsIO");
    const senderSocketId = connectedUsers.get(String(senderId));
    const broadcastPayload = {
      message: "وصلت هدية للجميع وتم تحويلها مباشرة إلى نقاط 🎁",
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
        name: "الجميع",
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
          message: "تم إرسال الهدية للجميع بنجاح ✅",
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
            `${sender.name} ارسل اليك هدية`,
            "هدية جديدة"
          );
        }
      } catch (notifyError) {
        console.warn("⚠️ فشل إرسال إشعار هدية للجميع:", notifyError.message);
      }
    }

      return res.json({
        message: "تم إرسال الهدية للجميع بنجاح",
        ...(await emitRoomLeaderboardUpdate({
          roomsIO,
          roomId,
        }),
        {}),
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
    console.error("❌ خطأ أثناء إرسال الهدية للجميع:", error);
    return res.status(500).json({ error: "حدث خطأ أثناء إرسال الهدية للجميع" });
  }
});

router.post("/send-gift", authenticateTokenUser, upload.none(), async (req, res) => {
  await ensureUserGiftAccountingColumns();

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
      receiverCutRate: conversionResult.receiverCutRate,
      adminCutRate: conversionResult.adminCutRate,
      ownerShare: conversionResult.ownerShare,
      receiverShare: conversionResult.receiverShare,
      adminShare: conversionResult.adminShare,
      supervisorShares: conversionResult.supervisorShares,
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
      if (typeof roomsRouter.processRoomChallengeGift === "function") {
        await roomsRouter.processRoomChallengeGift({
          app: req.app,
          roomId,
          receiver,
          sender,
          points: conversionResult.points,
          receiverShare: conversionResult.receiverShare,
        });
      }
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
        `${sender.name} ارسل اليك هدية`,
        "هدية جديدة"
      );
    } catch (notifyError) {
      console.warn("⚠️ فشل إرسال إشعار الهدية:", notifyError.message);
    }

    return res.json({
      message: "تم إرسال الهدية وتحويلها مباشرة إلى نقاط",
      ...(roomId
        ? (await emitRoomLeaderboardUpdate({
            roomsIO,
            roomId,
          }),
          {})
        : {}),
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
  await ensureUserGiftAccountingColumns();

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
      receiverCutRate: conversionResult.receiverCutRate,
      adminCutRate: conversionResult.adminCutRate,
      ownerShare: conversionResult.ownerShare,
      receiverShare: conversionResult.receiverShare,
      adminShare: conversionResult.adminShare,
      supervisorShares: conversionResult.supervisorShares,
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


