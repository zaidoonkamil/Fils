const { Op, fn, col, literal } = require("sequelize");
const { UserGift, GiftItem, User, Room, Settings } = require("../models");

const LEADERBOARD_DURATION_HOURS = 72;
const LEADERBOARD_DURATION_MS = LEADERBOARD_DURATION_HOURS * 60 * 60 * 1000;
const CYCLE_ANCHOR_KEY = "room_support_leaderboard_cycle_anchor";
const CYCLE_DURATION_KEY = "room_support_leaderboard_cycle_duration_hours";
const CYCLE_DATA_START_KEY = "room_support_leaderboard_cycle_data_start";

const USER_FRAME_PRESETS = {
  1: {
    rank: 1,
    key: "supporter_gold",
    label: "المركز الأول",
    colors: ["#F6C453", "#FF8A00"],
  },
  2: {
    rank: 2,
    key: "supporter_silver",
    label: "المركز الثاني",
    colors: ["#D9E2EC", "#8FA3B8"],
  },
  3: {
    rank: 3,
    key: "supporter_bronze",
    label: "المركز الثالث",
    colors: ["#D9A066", "#8C4F24"],
  },
};

const ROOM_FRAME_PRESETS = {
  1: {
    rank: 1,
    key: "room_gold",
    label: "أفضل روم",
    colors: ["#F6C453", "#FF8A00"],
  },
  2: {
    rank: 2,
    key: "room_silver",
    label: "ثاني أفضل روم",
    colors: ["#D9E2EC", "#8FA3B8"],
  },
  3: {
    rank: 3,
    key: "room_bronze",
    label: "ثالث أفضل روم",
    colors: ["#D9A066", "#8C4F24"],
  },
};

function normalizeImage(images) {
  if (!images) return "";
  if (Array.isArray(images) && images.length > 0) {
    return String(images[0] ?? "").trim();
  }
  return "";
}

function normalizeNumber(value) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function buildCycleRange(start, end) {
  if (!start || !end) {
    return null;
  }

  return {
    startsAt: start.toISOString(),
    endsAt: end.toISOString(),
  };
}

async function ensureCycleAnchor() {
  const [setting] = await Settings.findOrCreate({
    where: { key: CYCLE_ANCHOR_KEY },
    defaults: {
      value: new Date().toISOString(),
      description: "Anchor timestamp for 72-hour room support leaderboard cycles",
      isActive: true,
    },
  });

  const [durationSetting] = await Settings.findOrCreate({
    where: { key: CYCLE_DURATION_KEY },
    defaults: {
      value: String(LEADERBOARD_DURATION_HOURS),
      description: "Stored duration for room support leaderboard cycles in hours",
      isActive: true,
    },
  });

  const [dataStartSetting] = await Settings.findOrCreate({
    where: { key: CYCLE_DATA_START_KEY },
    defaults: {
      value: "",
      description: "Carry-over start timestamp for the first room support leaderboard cycle after duration changes",
      isActive: true,
    },
  });

  const parsedAnchor = new Date(setting.value);
  const storedDuration = Number.parseInt(String(durationSetting.value ?? ""), 10);
  if (storedDuration !== LEADERBOARD_DURATION_HOURS) {
    const now = new Date();
    const oldDurationMs =
      Number.isInteger(storedDuration) && storedDuration > 0
        ? storedDuration * 60 * 60 * 1000
        : LEADERBOARD_DURATION_MS;
    const safeOldAnchor = !Number.isNaN(parsedAnchor.getTime()) ? parsedAnchor : now;
    const elapsedMs = Math.max(0, now.getTime() - safeOldAnchor.getTime());
    const oldCycleIndex = Math.floor(elapsedMs / oldDurationMs);
    const oldCurrentCycleStart = new Date(
      safeOldAnchor.getTime() + oldCycleIndex * oldDurationMs
    );

    setting.value = now.toISOString();
    durationSetting.value = String(LEADERBOARD_DURATION_HOURS);
    dataStartSetting.value = oldCurrentCycleStart.toISOString();
    await Promise.all([setting.save(), durationSetting.save(), dataStartSetting.save()]);
    return {
      anchorAt: now,
      carryoverStartAt: oldCurrentCycleStart,
    };
  }

  const parsedDataStart = new Date(dataStartSetting.value);

  if (!Number.isNaN(parsedAnchor.getTime())) {
    return {
      anchorAt: parsedAnchor,
      carryoverStartAt: !Number.isNaN(parsedDataStart.getTime()) ? parsedDataStart : null,
    };
  }

  const now = new Date();
  setting.value = now.toISOString();
  durationSetting.value = String(LEADERBOARD_DURATION_HOURS);
  dataStartSetting.value = "";
  await Promise.all([setting.save(), durationSetting.save(), dataStartSetting.save()]);
  return {
    anchorAt: now,
    carryoverStartAt: null,
  };
}

function buildCycleMeta(anchorAt, now = new Date()) {
  const safeAnchor = anchorAt instanceof Date ? anchorAt : new Date(anchorAt);
  const safeNow = now instanceof Date ? now : new Date(now);
  const elapsedMs = Math.max(0, safeNow.getTime() - safeAnchor.getTime());
  const cycleIndex = Math.floor(elapsedMs / LEADERBOARD_DURATION_MS);
  const currentCycleStart = new Date(safeAnchor.getTime() + cycleIndex * LEADERBOARD_DURATION_MS);
  const currentCycleEnd = new Date(currentCycleStart.getTime() + LEADERBOARD_DURATION_MS);
  const previousCycleStart =
    cycleIndex > 0 ? new Date(currentCycleStart.getTime() - LEADERBOARD_DURATION_MS) : null;
  const previousCycleEnd = cycleIndex > 0 ? new Date(currentCycleStart.getTime()) : null;

  return {
    anchorAt: safeAnchor.toISOString(),
    durationHours: LEADERBOARD_DURATION_HOURS,
    cycleIndex,
    currentCycle: buildCycleRange(currentCycleStart, currentCycleEnd),
    previousCycle: buildCycleRange(previousCycleStart, previousCycleEnd),
    secondsUntilCurrentCycleEnds: Math.max(
      0,
      Math.floor((currentCycleEnd.getTime() - safeNow.getTime()) / 1000)
    ),
  };
}

function resolveEffectiveCycleBounds(cycle, carryoverStartAt) {
  const currentStart = new Date(cycle.currentCycle.startsAt);
  const currentEnd = new Date(cycle.currentCycle.endsAt);

  let effectiveCurrentStart = currentStart;
  let effectivePreviousStart = cycle.previousCycle ? new Date(cycle.previousCycle.startsAt) : null;
  const effectivePreviousEnd = cycle.previousCycle ? new Date(cycle.previousCycle.endsAt) : null;

  if (carryoverStartAt instanceof Date && !Number.isNaN(carryoverStartAt.getTime())) {
    if (cycle.cycleIndex === 0 && carryoverStartAt.getTime() < currentStart.getTime()) {
      effectiveCurrentStart = carryoverStartAt;
    }

    if (
      cycle.cycleIndex === 1 &&
      effectivePreviousStart &&
      carryoverStartAt.getTime() < effectivePreviousStart.getTime()
    ) {
      effectivePreviousStart = carryoverStartAt;
    }
  }

  return {
    currentStart: effectiveCurrentStart,
    currentEnd,
    previousStart: effectivePreviousStart,
    previousEnd: effectivePreviousEnd,
  };
}

function shouldPromoteCarryoverLeaders(cycle, carryoverStartAt) {
  return (
    cycle?.cycleIndex === 0 &&
    carryoverStartAt instanceof Date &&
    !Number.isNaN(carryoverStartAt.getTime())
  );
}

function buildDateWhere(start, end) {
  return {
    [Op.gte]: start,
    [Op.lt]: end,
  };
}

async function queryTopSupporters({ roomId, start, end, limit = 10 }) {
  const where = {
    senderId: { [Op.not]: null },
    createdAt: buildDateWhere(start, end),
  };

  if (Number.isInteger(roomId) && roomId > 0) {
    where.roomId = roomId;
  } else {
    where.roomId = { [Op.not]: null };
  }

  const entries = await UserGift.findAll({
    where,
    attributes: [
      "senderId",
      [fn("COUNT", col("UserGift.id")), "giftsCount"],
      [fn("COALESCE", fn("SUM", col("item.points")), 0), "totalPoints"],
    ],
    include: [
      {
        model: GiftItem,
        as: "item",
        attributes: [],
        required: true,
      },
      {
        model: User,
        as: "sender",
        attributes: ["id", "name", "images"],
        required: true,
      },
    ],
    group: ["senderId", "sender.id", "sender.name", "sender.images"],
    order: [
      [literal("totalPoints"), "DESC"],
      [literal("giftsCount"), "DESC"],
      ["senderId", "ASC"],
    ],
    subQuery: false,
    limit,
  });

  return entries.map((entry) => {
    const plain = entry.toJSON();
    const sender = plain.sender || {};
    return {
      userId: Number(plain.senderId),
      name: sender.name || "مستخدم",
      image: normalizeImage(sender.images),
      referralCode: String(sender.id ?? plain.senderId ?? ""),
      totalPoints: normalizeNumber(plain.totalPoints),
      giftsCount: normalizeNumber(plain.giftsCount),
    };
  });
}

async function queryTopRooms({ start, end, limit = 10 }) {
  const entries = await UserGift.findAll({
    where: {
      roomId: { [Op.not]: null },
      senderId: { [Op.not]: null },
      createdAt: buildDateWhere(start, end),
    },
    attributes: [
      "roomId",
      [fn("COUNT", col("UserGift.id")), "giftsCount"],
      [fn("COUNT", fn("DISTINCT", col("senderId"))), "supportersCount"],
      [fn("COALESCE", fn("SUM", col("item.points")), 0), "totalPoints"],
    ],
    include: [
      {
        model: GiftItem,
        as: "item",
        attributes: [],
        required: true,
      },
      {
        model: Room,
        as: "room",
        attributes: ["id", "name", "images", "currentUsers", "category", "isActive"],
        required: true,
      },
    ],
    group: [
      "roomId",
      "room.id",
      "room.name",
      "room.images",
      "room.currentUsers",
      "room.category",
      "room.isActive",
    ],
    order: [
      [literal("totalPoints"), "DESC"],
      [literal("supportersCount"), "DESC"],
      ["roomId", "ASC"],
    ],
    subQuery: false,
    limit,
  });

  return entries.map((entry) => {
    const plain = entry.toJSON();
    const room = plain.room || {};
    return {
      roomId: Number(plain.roomId),
      name: room.name || "روم",
      image: normalizeImage(room.images),
      totalPoints: normalizeNumber(plain.totalPoints),
      giftsCount: normalizeNumber(plain.giftsCount),
      supportersCount: normalizeNumber(plain.supportersCount),
      currentUsers: normalizeNumber(room.currentUsers),
      category: room.category || "",
      isActive: room.isActive !== false,
    };
  });
}

function decorateEntriesWithFrames(entries, framePresets, entityKey) {
  const frameMap = new Map();

  entries.slice(0, 3).forEach((entry, index) => {
    const rank = index + 1;
    const frame = framePresets[rank];
    if (!frame) return;
    frameMap.set(String(entry[entityKey]), frame);
  });

  return frameMap;
}

function applyEntryRanks(entries, frameMap, entityKey) {
  return entries.map((entry, index) => ({
    ...entry,
    rank: index + 1,
    activeFrame: frameMap.get(String(entry[entityKey])) ?? null,
  }));
}

async function getRoomSupportLeaderboard(roomId, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const { anchorAt, carryoverStartAt } = await ensureCycleAnchor();
  const cycle = buildCycleMeta(anchorAt, now);
  const { currentStart, currentEnd, previousStart, previousEnd } = resolveEffectiveCycleBounds(
    cycle,
    carryoverStartAt
  );

  const currentTopSupporters = await queryTopSupporters({
    roomId,
    start: currentStart,
    end: currentEnd,
    limit: options.limit ?? 10,
  });

  const previousTopSupporters = cycle.previousCycle
    ? await queryTopSupporters({
        roomId,
        start: previousStart,
        end: previousEnd,
        limit: 3,
      })
    : [];

  const effectivePreviousTopSupporters =
    previousTopSupporters.length > 0
      ? previousTopSupporters
      : shouldPromoteCarryoverLeaders(cycle, carryoverStartAt)
        ? currentTopSupporters.slice(0, 3)
        : [];

  const frameMap = decorateEntriesWithFrames(
    effectivePreviousTopSupporters,
    USER_FRAME_PRESETS,
    "userId"
  );

  return {
    cycle,
    topSupporters: applyEntryRanks(currentTopSupporters, frameMap, "userId"),
    activeFrameWinners: applyEntryRanks(effectivePreviousTopSupporters, frameMap, "userId"),
  };
}

async function getGlobalSupportLeaderboard(options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const { anchorAt, carryoverStartAt } = await ensureCycleAnchor();
  const cycle = buildCycleMeta(anchorAt, now);
  const { currentStart, currentEnd, previousStart, previousEnd } = resolveEffectiveCycleBounds(
    cycle,
    carryoverStartAt
  );

  const currentTopSupporters = await queryTopSupporters({
    start: currentStart,
    end: currentEnd,
    limit: options.limit ?? 10,
  });

  const previousTopSupporters = cycle.previousCycle
    ? await queryTopSupporters({
        start: previousStart,
        end: previousEnd,
        limit: 3,
      })
    : [];

  const effectivePreviousTopSupporters =
    previousTopSupporters.length > 0
      ? previousTopSupporters
      : shouldPromoteCarryoverLeaders(cycle, carryoverStartAt)
        ? currentTopSupporters.slice(0, 3)
        : [];

  const frameMap = decorateEntriesWithFrames(
    effectivePreviousTopSupporters,
    USER_FRAME_PRESETS,
    "userId"
  );

  return {
    cycle,
    topSupporters: applyEntryRanks(currentTopSupporters, frameMap, "userId"),
    activeFrameWinners: applyEntryRanks(effectivePreviousTopSupporters, frameMap, "userId"),
  };
}

async function getActiveSupporterFrameMap(options = {}) {
  const leaderboard = await getGlobalSupportLeaderboard({
    now: options.now,
    limit: 10,
  });

  return new Map(
    leaderboard.activeFrameWinners
      .filter((entry) => entry.activeFrame)
      .map((entry) => [String(entry.userId), entry.activeFrame])
  );
}

async function attachActiveUserFrames(users, options = {}) {
  if (!Array.isArray(users) || users.length === 0) {
    return [];
  }

  const frameMap = await getActiveSupporterFrameMap(options);

  return users.map((user) => {
    const plainUser = typeof user?.toJSON === "function" ? user.toJSON() : { ...(user || {}) };
    return {
      ...plainUser,
      activeFrame: frameMap.get(String(plainUser.id)) ?? null,
    };
  });
}

async function getRoomsSupportLeaderboard(options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const { anchorAt, carryoverStartAt } = await ensureCycleAnchor();
  const cycle = buildCycleMeta(anchorAt, now);
  const { currentStart, currentEnd, previousStart, previousEnd } = resolveEffectiveCycleBounds(
    cycle,
    carryoverStartAt
  );

  const currentTopRooms = await queryTopRooms({
    start: currentStart,
    end: currentEnd,
    limit: options.limit ?? 10,
  });

  const previousTopRooms = cycle.previousCycle
    ? await queryTopRooms({
        start: previousStart,
        end: previousEnd,
        limit: 3,
      })
    : [];

  const effectivePreviousTopRooms =
    previousTopRooms.length > 0
      ? previousTopRooms
      : shouldPromoteCarryoverLeaders(cycle, carryoverStartAt)
        ? currentTopRooms.slice(0, 3)
        : [];

  const frameMap = decorateEntriesWithFrames(
    effectivePreviousTopRooms,
    ROOM_FRAME_PRESETS,
    "roomId"
  );

  return {
    cycle,
    topRooms: applyEntryRanks(currentTopRooms, frameMap, "roomId"),
    activeFrameWinners: applyEntryRanks(effectivePreviousTopRooms, frameMap, "roomId"),
  };
}

async function attachActiveRoomFrames(rooms, options = {}) {
  if (!Array.isArray(rooms) || rooms.length === 0) {
    return [];
  }

  const leaderboard = await getRoomsSupportLeaderboard({ now: options.now, limit: 10 });
  const frameMap = new Map(
    leaderboard.activeFrameWinners.map((entry) => [String(entry.roomId), entry.activeFrame])
  );

  return rooms.map((room) => {
    const plainRoom = typeof room.toJSON === "function" ? room.toJSON() : { ...room };
    return {
      ...plainRoom,
      topSupportFrame: frameMap.get(String(plainRoom.id)) ?? null,
    };
  });
}

module.exports = {
  LEADERBOARD_DURATION_HOURS,
  attachActiveUserFrames,
  getActiveSupporterFrameMap,
  getGlobalSupportLeaderboard,
  getRoomSupportLeaderboard,
  getRoomsSupportLeaderboard,
  attachActiveRoomFrames,
};
