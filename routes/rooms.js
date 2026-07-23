const express = require("express");
const router = express.Router();
const { Op } = require("sequelize");
const jwt = require("jsonwebtoken");
const Room = require("../models/room");
const Message = require("../models/message");
const User = require("../models/user");
const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const { AccessToken, RoomServiceClient } = require("livekit-server-sdk");
const { parseFile } = require("music-metadata");
const Settings = require("../models/settings");
const upload = require("../middlewares/uploads");
const { attachActiveRoomFrames, attachActiveUserFrames } = require("../services/roomLeaderboard");
const { sendNotificationToUser } = require("../services/notifications");
const { RoomJoinSubscription } = require("../models");

const ROOM_AUDIO_ALLOWED_EXTENSIONS = new Set([
    ".aac",
    ".m4a",
    ".mp3",
    ".ogg",
    ".opus",
    ".wav",
    ".webm",
]);

const ROOM_VOICE_PACKAGE_COUNTS = [4, 8];

const ROOM_SUPERVISOR_SLOT_META = {
    gold: {
        key: "gold",
        label: "مشرف سوبر ذهبي",
        shortLabel: "ذهبي",
        color: "#F6C453",
        settingKey: "room_gift_supervisor_gold_cut",
    },
    silver: {
        key: "silver",
        label: "مشرف سوبر فضي",
        shortLabel: "فضي",
        color: "#CBD5E1",
        settingKey: "room_gift_supervisor_silver_cut",
    },
    bronze: {
        key: "bronze",
        label: "مشرف سوبر برونزي",
        shortLabel: "برونزي",
        color: "#D97706",
        settingKey: "room_gift_supervisor_bronze_cut",
    },
    standard: {
        key: "standard",
        label: "مشرف سوبر",
        shortLabel: "سوبر",
        color: "#60A5FA",
        settingKey: "room_gift_supervisor_standard_cut",
    },
};

const ROOM_SUPERVISOR_SLOT_KEYS = Object.keys(ROOM_SUPERVISOR_SLOT_META);
const ROOM_CHALLENGE_WATCH_INTERVAL_MS = 1000;
const roomChallengeWatchIds = new Set();
let roomChallengeWatchBootstrapped = false;
let roomChallengeWatchStarted = false;
let roomChallengeWatchInFlight = false;

router.use((req, res, next) => {
    ensureRoomChallengeWatchWorker(req.app);
    next();
});

function getJwtSecret() {
    const secret = String(process.env.JWT_SECRET || "").trim();
    if (!secret) {
        throw new Error("JWT_SECRET is not configured");
    }
    return secret;
}

async function normalizeUserPayload(user) {
    if (!user) return null;
    const [plainUser] = await attachActiveUserFrames([user]);
    if (!plainUser) return null;
    if (plainUser.images) {
        plainUser.image = Array.isArray(plainUser.images) && plainUser.images.length > 0
            ? plainUser.images[0]
            : null;
        delete plainUser.images;
    }
    return plainUser;
}

async function buildRoomJoinPayload(room, currentUserId = null, currentUserRole = null) {
    const roomId = Number(room.id);
    const joinedCount = await RoomJoinSubscription.count({
        where: { roomId },
    });

    let isJoined = false;
    if (currentUserId != null) {
        const subscription = await RoomJoinSubscription.findOne({
            where: {
                roomId,
                userId: Number(currentUserId),
            },
            attributes: ["id"],
        });
        isJoined = !!subscription;
    }

    return {
        roomId,
        isJoined,
        joinedCount,
        currentUser: {
            canManage: canManageRoom(room, {
                id: currentUserId,
                role: currentUserRole,
            }),
        },
    };
}

async function normalizeMessagePayload(message) {
    const plainMessage = typeof message.toJSON === "function" ? message.toJSON() : { ...message };
    plainMessage.user = await normalizeUserPayload(plainMessage.user);

    if (plainMessage.replyTo) {
        const replyMessage = typeof plainMessage.replyTo.toJSON === "function"
            ? plainMessage.replyTo.toJSON()
            : { ...plainMessage.replyTo };

        replyMessage.user = await normalizeUserPayload(replyMessage.user);
        plainMessage.replyTo = replyMessage;
    }

    return plainMessage;
}

function canManageRoom(room, user) {
    if (!room || !user) return false;
    if (user.role === "admin") return true;
    if (String(room.creatorId) === String(user.id)) return true;

    const slots = normalizeRoomSupervisorSlots(room.supervisorSlots);
    return ROOM_SUPERVISOR_SLOT_KEYS.some(
        (slotKey) => String(slots[slotKey] ?? "") === String(user.id),
    );
}

function canManageRoomSupervisorAssignments(room, user) {
    if (!room || !user) return false;
    if (user.role === "admin") return true;
    return String(room.creatorId) === String(user.id);
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

    for (const slotKey of ROOM_SUPERVISOR_SLOT_KEYS) {
        const parsedId = Number(source[slotKey]);
        base[slotKey] = Number.isFinite(parsedId) && parsedId > 0 ? parsedId : null;
    }

    return base;
}

async function getRoomSupervisorCommissionRates() {
    const keys = ROOM_SUPERVISOR_SLOT_KEYS.map(
        (slotKey) => ROOM_SUPERVISOR_SLOT_META[slotKey].settingKey,
    );
    const settings = await Settings.findAll({
        where: {
            key: keys,
            isActive: true,
        },
    });

    const config = {};
    settings.forEach((setting) => {
        config[setting.key] = Number(setting.value ?? 0);
    });

    const rates = {};
    for (const slotKey of ROOM_SUPERVISOR_SLOT_KEYS) {
        const settingKey = ROOM_SUPERVISOR_SLOT_META[slotKey].settingKey;
        rates[slotKey] = Number.isFinite(config[settingKey]) ? config[settingKey] : 0;
    }
    return rates;
}

async function buildRoomSupervisorsPayload(room, currentUserId = null, currentUserRole = null, app = null) {
    const slots = normalizeRoomSupervisorSlots(room.supervisorSlots);
    const assignedIds = ROOM_SUPERVISOR_SLOT_KEYS
        .map((slotKey) => slots[slotKey])
        .filter(Boolean);

    const users = assignedIds.length > 0
        ? await User.findAll({
            where: { id: assignedIds },
            attributes: ["id", "name", "images", "role", "isActive"],
        })
        : [];

    const usersWithFrames = await attachActiveUserFrames(users);

    const userMap = new Map(
        usersWithFrames.map((user) => [
            String(user.id),
            {
                id: Number(user.id),
                name: user.name || "مستخدم",
                image: extractImage(user.images),
                role: user.role || "user",
                isActive: user.isActive !== false,
                activeFrame: user.activeFrame ?? null,
            },
        ]),
    );

    const rates = await getRoomSupervisorCommissionRates();
    const currentId = currentUserId != null ? Number(currentUserId) : null;
    const normalizedSlots = ROOM_SUPERVISOR_SLOT_KEYS.map((slotKey) => {
        const assignedUserId = slots[slotKey];
        return {
            slotKey,
            title: ROOM_SUPERVISOR_SLOT_META[slotKey].label,
            shortTitle: ROOM_SUPERVISOR_SLOT_META[slotKey].shortLabel,
            color: ROOM_SUPERVISOR_SLOT_META[slotKey].color,
            commissionRate: Number(rates[slotKey] ?? 0),
            userId: assignedUserId,
            isOccupied: assignedUserId != null,
            isPresentInRoom:
                assignedUserId != null
                    ? isUserPresentInRoomSocket(app, room.id, assignedUserId)
                    : false,
            user: assignedUserId != null
                ? userMap.get(String(assignedUserId)) ?? null
                : null,
        };
    });

    const assignedSlot =
        normalizedSlots.find(
            (slot) => slot.userId != null && String(slot.userId) === String(currentId),
        ) ?? {
            slotKey: null,
            title: "",
            shortTitle: "",
            color: "",
            commissionRate: 0,
            userId: null,
            isOccupied: false,
            isPresentInRoom: false,
            user: null,
        };

    return {
        roomId: Number(room.id),
        slots: normalizedSlots,
        currentUser: {
            isOwner: String(room.creatorId) === String(currentUserId),
            canManage: canManageRoom(room, {
                id: currentUserId,
                role: currentUserRole,
            }),
            canManageAssignments: canManageRoomSupervisorAssignments(room, {
                id: currentUserId,
                role: currentUserRole,
            }),
            assignedSlotKey: assignedSlot["slotKey"],
        },
    };
}

function normalizeRoomNameInput(value) {
    if (value === undefined || value === null) {
        return "";
    }
    return String(value).trim().replace(/\s+/g, " ");
}

function extractImage(images) {
    if (Array.isArray(images) && images.length > 0) {
        return images[0] ? String(images[0]) : "";
    }
    if (typeof images === "string" && images.trim().length > 0) {
        const normalized = images.trim();
        if (normalized.startsWith("[")) {
            try {
                const parsed = JSON.parse(normalized);
                if (Array.isArray(parsed) && parsed.length > 0) {
                    return parsed[0] ? String(parsed[0]).trim() : "";
                }
            } catch (_) {
                // ignore invalid JSON and fall through to raw string
            }
        }
        return normalized;
    }
    return "";
}

function normalizeVoiceIdArray(value) {
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    const result = [];
    for (const item of value) {
        const id = Number(item);
        if (!Number.isFinite(id) || id <= 0 || seen.has(id)) continue;
        seen.add(id);
        result.push(id);
    }
    return result;
}

function getLiveKitRoomName(roomId) {
    return `room-voice-${roomId}`;
}

function getLiveKitParticipantIdentity(roomId, userId) {
    return `room-${roomId}-user-${userId}`;
}

let liveKitRoomServiceClient = null;

function getLiveKitRoomServiceClient() {
    if (liveKitRoomServiceClient) {
        return liveKitRoomServiceClient;
    }

    const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = process.env;
    if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
        return null;
    }

    liveKitRoomServiceClient = new RoomServiceClient(
        LIVEKIT_URL,
        LIVEKIT_API_KEY,
        LIVEKIT_API_SECRET,
    );
    return liveKitRoomServiceClient;
}

async function syncLiveKitSpeakerPermission(roomId, userId, canPublish) {
    const client = getLiveKitRoomServiceClient();
    if (!client) {
        return;
    }

    try {
        await client.updateParticipant(
            getLiveKitRoomName(roomId),
            getLiveKitParticipantIdentity(roomId, userId),
            {
                permission: {
                    canPublish: !!canPublish,
                    canPublishData: false,
                    canSubscribe: true,
                },
            },
        );
    } catch (error) {
        const message = String(error?.message || error || "");
        if (
            message.includes("participant does not exist")
            || message.includes("participant not found")
            || message.includes("could not find participant")
            || message.includes("NOT_FOUND")
        ) {
            return;
        }
        console.error("Error syncing LiveKit speaker permission:", error);
    }
}

function getSocketRoomName(roomId) {
    return `room-${roomId}`;
}

function isUserPresentInRoomSocket(app, roomId, userId) {
    const roomsIO = app?.get?.("roomsIO") ?? app;
    if (!roomsIO) return false;

    const socketIds = roomsIO.adapter.rooms.get(getSocketRoomName(roomId));
    if (!socketIds || socketIds.size === 0) {
        return false;
    }

    for (const socketId of socketIds) {
        const socket = roomsIO.sockets.get(socketId);
        if (socket && String(socket.userId) === String(userId)) {
            return true;
        }
    }

    return false;
}

function ensureUserPresentInRoomSocket(req, res, roomId) {
    if (isUserPresentInRoomSocket(req.app, roomId, req.user.id)) {
        return true;
    }

    res.status(403).json({
        error: "يجب أن يكون المستخدم موجودًا داخل الغرفة لاستخدام هذه الميزة",
    });
    return false;
}

async function getRoomVoicePackageSettings() {
    const settingsList = await Promise.all(
        ROOM_VOICE_PACKAGE_COUNTS.flatMap((micCount) => ([
            Settings.findOne({ where: { key: `room_voice_mic_${micCount}_price` } }),
            Settings.findOne({ where: { key: `room_voice_mic_${micCount}_hours` } }),
        ])),
    );

    const packages = ROOM_VOICE_PACKAGE_COUNTS.map((micCount, index) => {
        const priceSetting = settingsList[index * 2];
        const hoursSetting = settingsList[(index * 2) + 1];

        return {
            micCount,
            price: priceSetting ? parseInt(priceSetting.value, 10) || 0 : 0,
            hours: hoursSetting ? parseInt(hoursSetting.value, 10) || 0 : 0,
        };
    });

    return {
        packages,
    };
}

function isSupportedRoomVoiceMicCount(micCount) {
    return ROOM_VOICE_PACKAGE_COUNTS.includes(Number(micCount));
}

async function cleanupUnsupportedRoomVoicePackages() {
    try {
        await Room.update(
            {
                voiceMicCount: 0,
                voicePackageExpiresAt: null,
                voiceActiveSpeakerIds: [],
                voicePendingRequestIds: [],
            },
            {
                where: {
                    voiceMicCount: {
                        [Op.gt]: 0,
                        [Op.notIn]: ROOM_VOICE_PACKAGE_COUNTS,
                    },
                },
            },
        );
    } catch (error) {
        console.error("Error cleaning unsupported room voice packages:", error);
    }
}

async function getRoomSupportAgentSettings() {
    const [priceSetting, hoursSetting] = await Promise.all([
        Settings.findOne({
            where: { key: "room_support_agent_price", isActive: true },
            order: [["updatedAt", "DESC"], ["id", "DESC"]],
        }),
        Settings.findOne({
            where: { key: "room_support_agent_hours", isActive: true },
            order: [["updatedAt", "DESC"], ["id", "DESC"]],
        }),
    ]);

    return {
        price: priceSetting ? parseInt(priceSetting.value, 10) || 0 : 0,
        hours: hoursSetting ? parseInt(hoursSetting.value, 10) || 0 : 0,
    };
}

async function getRoomAudioSettings() {
    const [priceSetting, hoursSetting, maxMinutesSetting] = await Promise.all([
        Settings.findOne({ where: { key: "room_audio_price" } }),
        Settings.findOne({ where: { key: "room_audio_hours" } }),
        Settings.findOne({ where: { key: "room_audio_max_total_minutes" } }),
    ]);

    return {
        price: priceSetting ? parseInt(priceSetting.value, 10) || 0 : 0,
        hours: hoursSetting ? parseInt(hoursSetting.value, 10) || 0 : 0,
        maxTotalMinutes: maxMinutesSetting ? parseInt(maxMinutesSetting.value, 10) || 60 : 60,
    };
}

async function getRoomChallengeSettings() {
    const durationSetting = await Settings.findOne({ where: { key: "room_challenge_duration_seconds" } });
    return {
        durationSeconds: durationSetting ? parseInt(durationSetting.value, 10) || 180 : 180,
    };
}

function normalizeChallengeSupporters(value) {
    if (!Array.isArray(value)) return [];
    return value
        .filter((item) => item && typeof item === "object")
        .map((item) => ({
            userId: Number(item.userId || 0) || 0,
            name: normalizeAudioFileName(item.name || item.userName || "مستخدم") || "مستخدم",
            image: extractImage(item.image || item.images || ""),
            totalPoints: Math.max(0, Number(item.totalPoints || 0) || 0),
        }))
        .filter((item) => item.userId > 0)
        .slice(0, 6);
}

function createChallengeParticipantPayload(user) {
    return {
        userId: Number(user?.id || 0) || 0,
        name: normalizeAudioFileName(user?.name || "مستخدم") || "مستخدم",
        image: extractImage(user?.image || user?.images || ""),
        score: 0,
        receiverShareTotal: 0,
        supportersCount: 0,
        supporters: [],
    };
}

function normalizeRoomChallengeState(value) {
    if (!value || typeof value !== "object") return null;
    const left = value.left && typeof value.left === "object" ? value.left : null;
    const right = value.right && typeof value.right === "object" ? value.right : null;
    const status = String(value.status || "idle");
    const startedAt = value.startedAt ? new Date(value.startedAt) : null;
    const endsAt = value.endsAt ? new Date(value.endsAt) : null;
    if (!left || !right || !left.userId || !right.userId) return null;
    return {
        status,
        startedAt: startedAt instanceof Date && !Number.isNaN(startedAt.getTime()) ? startedAt : null,
        endsAt: endsAt instanceof Date && !Number.isNaN(endsAt.getTime()) ? endsAt : null,
        winnerUserId: Number(value.winnerUserId || 0) || null,
        settledAt: value.settledAt ? new Date(value.settledAt).toISOString() : null,
        resultSummary:
            value.resultSummary && typeof value.resultSummary === "object"
                ? {
                    winnerUserId: Number(value.resultSummary.winnerUserId || 0) || null,
                    loserUserId: Number(value.resultSummary.loserUserId || 0) || null,
                    winnerScore: Math.max(0, Number(value.resultSummary.winnerScore || 0) || 0),
                    loserScore: Math.max(0, Number(value.resultSummary.loserScore || 0) || 0),
                    winnerOwnShare: Math.max(0, Number(value.resultSummary.winnerOwnShare || 0) || 0),
                    loserOwnShare: Math.max(0, Number(value.resultSummary.loserOwnShare || 0) || 0),
                    transferAmount: Math.max(0, Number(value.resultSummary.transferAmount || 0) || 0),
                    totalWinnerGain: Math.max(0, Number(value.resultSummary.totalWinnerGain || 0) || 0),
                    totalLoserLoss: Math.max(0, Number(value.resultSummary.totalLoserLoss || 0) || 0),
                    isDraw: value.resultSummary.isDraw === true,
                }
                : null,
        left: {
            userId: Number(left.userId || 0) || 0,
            name: normalizeAudioFileName(left.name || "مستخدم") || "مستخدم",
            image: extractImage(left.image || ""),
            score: Math.max(0, Number(left.score || 0) || 0),
            receiverShareTotal: Math.max(0, Number(left.receiverShareTotal || 0) || 0),
            supportersCount: Math.max(0, Number(left.supportersCount || 0) || 0),
            supporters: normalizeChallengeSupporters(left.supporters),
        },
        right: {
            userId: Number(right.userId || 0) || 0,
            name: normalizeAudioFileName(right.name || "مستخدم") || "مستخدم",
            image: extractImage(right.image || ""),
            score: Math.max(0, Number(right.score || 0) || 0),
            receiverShareTotal: Math.max(0, Number(right.receiverShareTotal || 0) || 0),
            supportersCount: Math.max(0, Number(right.supportersCount || 0) || 0),
            supporters: normalizeChallengeSupporters(right.supporters),
        },
    };
}

function normalizeAudioFileName(value) {
    if (value === undefined || value === null) {
        return "";
    }

    return String(value)
        .replace(/[^\x20-\x7E\u0600-\u06FF]/g, "")
        .trim();
}

function normalizeRoomAudioFiles(value) {
    if (!Array.isArray(value)) return [];

    const files = [];
    const seen = new Set();

    for (const item of value) {
        if (!item || typeof item !== "object") continue;

        const fileId = String(item.id || "").trim();
        const storedFileName = String(item.storedFileName || item.fileName || "").trim();
        const extension = path.extname(storedFileName).toLowerCase();
        if (!fileId || !storedFileName || !ROOM_AUDIO_ALLOWED_EXTENSIONS.has(extension) || seen.has(fileId)) {
            continue;
        }

        seen.add(fileId);
        files.push({
            id: fileId,
            name: normalizeAudioFileName(item.name || item.originalName || path.parse(storedFileName).name) || "ملف صوتي",
            originalName: normalizeAudioFileName(item.originalName || item.name || path.basename(storedFileName)) || path.basename(storedFileName),
            storedFileName,
            durationSeconds: Math.max(0, Math.round(Number(item.durationSeconds || 0))),
            uploadedById: Number(item.uploadedById || 0) || null,
            uploadedByName: normalizeAudioFileName(item.uploadedByName || "مستخدم") || "مستخدم",
            uploadedAt: item.uploadedAt ? new Date(item.uploadedAt).toISOString() : new Date().toISOString(),
        });
    }

    return files;
}

function sumRoomAudioDurationSeconds(files) {
    return normalizeRoomAudioFiles(files).reduce(
        (total, file) => total + Math.max(0, Number(file.durationSeconds || 0)),
        0,
    );
}

function formatDurationLabel(totalSeconds) {
    const safeSeconds = Math.max(0, Math.round(Number(totalSeconds || 0)));
    const minutes = Math.floor(safeSeconds / 60);
    const seconds = safeSeconds % 60;
    if (minutes <= 0) {
        return `${seconds}?`;
    }
    return `${minutes}? ${seconds}?`;
}

function isAudioUploadFile(file) {
    if (!file) return false;

    const extension = path.extname(file.originalname || file.filename || "").toLowerCase();
    const mimeType = String(file.mimetype || "").toLowerCase();
    return ROOM_AUDIO_ALLOWED_EXTENSIONS.has(extension) && mimeType.startsWith("audio/");
}

function removeUploadedFileSafe(filePath) {
    if (!filePath) return Promise.resolve();

    return fs.promises.unlink(filePath).catch(() => null);
}

async function normalizeRoomVoiceState(room, { persist = false } = {}) {
    let voiceMicCount = Number(room.voiceMicCount ?? 0);
    let voicePackageExpiresAt = room.voicePackageExpiresAt ? new Date(room.voicePackageExpiresAt) : null;
    let voiceActiveSpeakerIds = normalizeVoiceIdArray(room.voiceActiveSpeakerIds);
    let voicePendingRequestIds = normalizeVoiceIdArray(room.voicePendingRequestIds)
        .filter((id) => !voiceActiveSpeakerIds.includes(id));

    let changed = false;
    const hasUnsupportedPackage = voiceMicCount > 0 && !isSupportedRoomVoiceMicCount(voiceMicCount);
    const isActive = voiceMicCount > 0 && voicePackageExpiresAt && voicePackageExpiresAt.getTime() > Date.now();

    if (hasUnsupportedPackage || !isActive) {
        if (voiceMicCount !== 0 || voicePackageExpiresAt || voiceActiveSpeakerIds.length > 0 || voicePendingRequestIds.length > 0) {
            voiceMicCount = 0;
            voicePackageExpiresAt = null;
            voiceActiveSpeakerIds = [];
            voicePendingRequestIds = [];
            changed = true;
        }
    } else if (voiceActiveSpeakerIds.length > voiceMicCount) {
        voiceActiveSpeakerIds = voiceActiveSpeakerIds.slice(0, voiceMicCount);
        voicePendingRequestIds = voicePendingRequestIds.filter((id) => !voiceActiveSpeakerIds.includes(id));
        changed = true;
    }

    if (
        changed ||
        JSON.stringify(room.voiceActiveSpeakerIds ?? []) !== JSON.stringify(voiceActiveSpeakerIds) ||
        JSON.stringify(room.voicePendingRequestIds ?? []) !== JSON.stringify(voicePendingRequestIds) ||
        Number(room.voiceMicCount ?? 0) !== voiceMicCount ||
        String(room.voicePackageExpiresAt ?? "") !== String(voicePackageExpiresAt ?? "")
    ) {
        changed = true;
    }

    if (persist && changed) {
        await room.update({
            voiceMicCount,
            voicePackageExpiresAt,
            voiceActiveSpeakerIds,
            voicePendingRequestIds,
        });
    }

    return {
        voiceMicCount,
        voicePackageExpiresAt,
        voiceActiveSpeakerIds,
        voicePendingRequestIds,
        isActive: voiceMicCount > 0 && !!voicePackageExpiresAt,
    };
}

async function normalizeRoomSupportAgentState(room, { persist = false } = {}) {
    let supportAgentUserId = room.supportAgentUserId ? Number(room.supportAgentUserId) : null;
    let supportAgentExpiresAt = room.supportAgentExpiresAt ? new Date(room.supportAgentExpiresAt) : null;

    const isActive =
        Number.isFinite(supportAgentUserId) &&
        supportAgentUserId > 0 &&
        supportAgentExpiresAt &&
        supportAgentExpiresAt.getTime() > Date.now();

    if (!isActive && (supportAgentUserId || supportAgentExpiresAt)) {
        supportAgentUserId = null;
        supportAgentExpiresAt = null;
        if (persist) {
            await room.update({
                supportAgentUserId: null,
                supportAgentExpiresAt: null,
            });
        }
    }

    return {
        supportAgentUserId,
        supportAgentExpiresAt,
        isActive: Boolean(supportAgentUserId && supportAgentExpiresAt),
    };
}

async function normalizeRoomAudioState(room, { persist = false } = {}) {
    let roomAudioExpiresAt = room.roomAudioExpiresAt ? new Date(room.roomAudioExpiresAt) : null;
    let roomAudioFiles = normalizeRoomAudioFiles(room.roomAudioFiles);
    let roomAudioCurrentTrackId = room.roomAudioCurrentTrackId ? String(room.roomAudioCurrentTrackId) : null;
    let roomAudioPlaybackStartedAt = room.roomAudioPlaybackStartedAt
        ? new Date(room.roomAudioPlaybackStartedAt)
        : null;

    const isPackageActive =
        roomAudioExpiresAt instanceof Date &&
        !Number.isNaN(roomAudioExpiresAt.getTime()) &&
        roomAudioExpiresAt.getTime() > Date.now();

    if (!isPackageActive) {
        roomAudioExpiresAt = null;
        roomAudioCurrentTrackId = null;
        roomAudioPlaybackStartedAt = null;
    }

    const currentTrack = roomAudioCurrentTrackId
        ? roomAudioFiles.find((file) => file.id === roomAudioCurrentTrackId) || null
        : null;

    if (!currentTrack) {
        roomAudioCurrentTrackId = null;
        roomAudioPlaybackStartedAt = null;
    }

    const shouldPersist =
        JSON.stringify(normalizeRoomAudioFiles(room.roomAudioFiles)) !== JSON.stringify(roomAudioFiles) ||
        String(room.roomAudioExpiresAt ?? "") !== String(roomAudioExpiresAt ?? "") ||
        String(room.roomAudioCurrentTrackId ?? "") !== String(roomAudioCurrentTrackId ?? "") ||
        String(room.roomAudioPlaybackStartedAt ?? "") !== String(roomAudioPlaybackStartedAt ?? "");

    if (persist && shouldPersist) {
        await room.update({
            roomAudioExpiresAt,
            roomAudioFiles,
            roomAudioCurrentTrackId,
            roomAudioPlaybackStartedAt,
        });
    }

    return {
        roomAudioExpiresAt,
        roomAudioFiles,
        roomAudioCurrentTrackId,
        roomAudioPlaybackStartedAt,
        currentTrack,
        isPackageActive: Boolean(roomAudioExpiresAt),
    };
}

async function hydrateVoiceUsers(userIds) {
    const normalizedIds = normalizeVoiceIdArray(userIds);
    if (normalizedIds.length === 0) return [];

    const users = await User.findAll({
        where: { id: normalizedIds },
        attributes: ["id", "name", "images", "role"],
    });

    const usersWithFrames = await attachActiveUserFrames(users);

    const byId = new Map(
        usersWithFrames.map((user) => [
            Number(user.id),
            {
                id: Number(user.id),
                name: user.name || "مستخدم",
                image: extractImage(user.images),
                role: user.role || "user",
                activeFrame: user.activeFrame ?? null,
            },
        ]),
    );

    return normalizedIds.map((id) => byId.get(id)).filter(Boolean);
}

async function buildRoomVoicePayload(room, currentUserId = null, currentUserRole = null) {
    const normalized = await normalizeRoomVoiceState(room, { persist: true });
    const settings = await getRoomVoicePackageSettings();
    const [speakers, pendingRequests] = await Promise.all([
        hydrateVoiceUsers(normalized.voiceActiveSpeakerIds),
        hydrateVoiceUsers(normalized.voicePendingRequestIds),
    ]);

    const activeSpeakerIds = speakers.map((speaker) => Number(speaker.id));
    const pendingRequestIds = pendingRequests.map((entry) => Number(entry.id));
    const currentId = currentUserId != null ? Number(currentUserId) : null;
    const isOwner = currentId != null && String(room.creatorId) === String(currentId);
    const canManage = canManageRoom(room, {
        id: currentId,
        role: currentUserRole,
    });

    return {
        roomId: Number(room.id),
        isActive: normalized.isActive,
        micCount: normalized.voiceMicCount,
        availableSeats: Math.max(0, normalized.voiceMicCount - activeSpeakerIds.length),
        expiresAt: normalized.voicePackageExpiresAt ? normalized.voicePackageExpiresAt.toISOString() : null,
        livekitRoomName: normalized.isActive ? getLiveKitRoomName(room.id) : null,
        activeSpeakerIds,
        pendingRequestIds,
        speakers,
        pendingRequests,
        packageOptions: settings.packages,
        currentUser: {
            isOwner,
            canManage,
            isSpeaker: currentId != null ? activeSpeakerIds.includes(currentId) : false,
            hasPendingRequest: currentId != null ? pendingRequestIds.includes(currentId) : false,
        },
    };
}

async function buildRoomSupportAgentPayload(room, currentUserId = null, currentUserRole = null) {
    const normalized = await normalizeRoomSupportAgentState(room, { persist: true });
    const packageConfig = await getRoomSupportAgentSettings();
    const currentId = currentUserId != null ? Number(currentUserId) : null;
    const canManage = canManageRoom(room, {
        id: currentId,
        role: currentUserRole,
    });

    let selectedAgent = null;
    if (normalized.isActive && normalized.supportAgentUserId) {
        const agent = await User.findOne({
            where: {
                id: normalized.supportAgentUserId,
                role: "agent",
            },
            attributes: [
                "id",
                "name",
                "images",
                "phone",
                "location",
                "agentPrivateChatEnabled",
                "isActive",
            ],
        });

        if (agent) {
            selectedAgent = {
                id: Number(agent.id),
                name: agent.name || "وكيل",
                image: extractImage(agent.images),
                phone: agent.phone || "",
                location: agent.location || "",
                agentPrivateChatEnabled: agent.agentPrivateChatEnabled !== false,
                isActive: agent.isActive !== false,
            };
        }
    }

    return {
        roomId: Number(room.id),
        isActive: normalized.isActive && selectedAgent != null,
        expiresAt: normalized.supportAgentExpiresAt
            ? normalized.supportAgentExpiresAt.toISOString()
            : null,
        selectedAgent,
        packageOption: {
            price: packageConfig.price,
            hours: packageConfig.hours,
        },
        currentUser: {
            canManage,
        },
    };
}

async function buildRoomAudioPayload(room, currentUserId = null, currentUserRole = null) {
    const normalized = await normalizeRoomAudioState(room, { persist: true });
    const packageOption = await getRoomAudioSettings();
    const currentId = currentUserId != null ? Number(currentUserId) : null;
    const canManage = canManageRoom(room, {
        id: currentId,
        role: currentUserRole,
    });

    const currentTrack = normalized.currentTrack
        ? {
            ...normalized.currentTrack,
            durationLabel: formatDurationLabel(normalized.currentTrack.durationSeconds),
        }
        : null;

    return {
        roomId: Number(room.id),
        isActive: normalized.isPackageActive,
        expiresAt: normalized.roomAudioExpiresAt
            ? normalized.roomAudioExpiresAt.toISOString()
            : null,
        files: normalized.roomAudioFiles.map((file) => ({
            ...file,
            durationLabel: formatDurationLabel(file.durationSeconds),
            isCurrent: currentTrack != null && currentTrack.id === file.id,
        })),
        currentTrackId: normalized.roomAudioCurrentTrackId,
        currentTrack,
        isPlaying: currentTrack != null && normalized.roomAudioPlaybackStartedAt != null,
        playbackStartedAt: normalized.roomAudioPlaybackStartedAt
            ? normalized.roomAudioPlaybackStartedAt.toISOString()
            : null,
        totalDurationSeconds: sumRoomAudioDurationSeconds(normalized.roomAudioFiles),
        packageOption,
        currentUser: {
            canManage,
        },
    };
}

async function settleRoomChallengeIfNeeded(room) {
    const normalized = normalizeRoomChallengeState(room.roomChallengeState);
    if (!normalized || normalized.status !== "active" || !normalized.endsAt || normalized.endsAt.getTime() > Date.now()) {
        return normalizeRoomChallengeState(room.roomChallengeState);
    }

    const leftShare = Math.max(0, Number(normalized.left.receiverShareTotal || 0));
    const rightShare = Math.max(0, Number(normalized.right.receiverShareTotal || 0));
    const isDraw = normalized.left.score === normalized.right.score;
    const hasAnyChallengePoints =
        Math.max(0, Number(normalized.left.score || 0)) > 0 ||
        Math.max(0, Number(normalized.right.score || 0)) > 0;

    if (isDraw && hasAnyChallengePoints) {
        const overtimeEndsAt = new Date(Date.now() + (30 * 1000));
        const nextState = {
            ...normalized,
            status: "active",
            winnerUserId: null,
            settledAt: null,
            resultSummary: null,
            endsAt: overtimeEndsAt.toISOString(),
        };
        await room.update({ roomChallengeState: nextState });
        return normalizeRoomChallengeState(nextState);
    }

    let winnerUserId = null;
    let loserUserId = null;
    let transferAmount = 0;
    let winnerOwnShare = 0;
    let loserOwnShare = 0;
    let winnerScore = 0;
    let loserScore = 0;

    if (!isDraw) {
        winnerUserId = normalized.left.score > normalized.right.score
            ? normalized.left.userId
            : normalized.right.userId;
        loserUserId = winnerUserId === normalized.left.userId ? normalized.right.userId : normalized.left.userId;
        transferAmount = winnerUserId === normalized.left.userId ? rightShare : leftShare;
        winnerOwnShare = winnerUserId === normalized.left.userId ? leftShare : rightShare;
        loserOwnShare = winnerUserId === normalized.left.userId ? rightShare : leftShare;
        winnerScore = winnerUserId === normalized.left.userId ? normalized.left.score : normalized.right.score;
        loserScore = winnerUserId === normalized.left.userId ? normalized.right.score : normalized.left.score;

        if (transferAmount > 0) {
            const [winner, loser] = await Promise.all([
                User.findByPk(winnerUserId),
                User.findByPk(loserUserId),
            ]);

            if (winner && loser) {
                await loser.update({ sawa: Number(loser.sawa || 0) - transferAmount });
                await winner.update({ sawa: Number(winner.sawa || 0) + transferAmount });
            }
        }
    }

    const nextState = {
        ...normalized,
        status: isDraw ? "draw" : "finished",
        winnerUserId,
        settledAt: new Date().toISOString(),
        resultSummary: {
            winnerUserId,
            loserUserId,
            winnerScore,
            loserScore,
            winnerOwnShare,
            loserOwnShare,
            transferAmount,
            totalWinnerGain: winnerOwnShare + transferAmount,
            totalLoserLoss: transferAmount,
            isDraw,
        },
    };
    await room.update({ roomChallengeState: nextState });
    return normalizeRoomChallengeState(nextState);
}

async function buildRoomChallengePayload(room, currentUserId = null, currentUserRole = null) {
    const settled = await settleRoomChallengeIfNeeded(room);
    if (!settled) {
        return {
            roomId: Number(room.id),
            isActive: false,
            challenge: null,
            currentUser: {
                isOwner: String(room.creatorId) === String(currentUserId),
                canManage: currentUserRole === "admin" || String(room.creatorId) === String(currentUserId),
            },
        };
    }

    const now = Date.now();
    const remainingSeconds = settled.endsAt ? Math.max(0, Math.floor((settled.endsAt.getTime() - now) / 1000)) : 0;
    return {
        roomId: Number(room.id),
        isActive: settled.status === "active" && remainingSeconds > 0,
        challenge: {
            status: settled.status,
            startedAt: settled.startedAt ? settled.startedAt.toISOString() : null,
            endsAt: settled.endsAt ? settled.endsAt.toISOString() : null,
            remainingSeconds,
            winnerUserId: settled.winnerUserId,
            settledAt: settled.settledAt,
            resultSummary: settled.resultSummary || null,
            left: settled.left,
            right: settled.right,
        },
        currentUser: {
            isOwner: String(room.creatorId) === String(currentUserId),
            canManage: currentUserRole === "admin" || String(room.creatorId) === String(currentUserId),
        },
    };
}

async function emitRoomChallengeUpdatedToIO(roomsIO, room, currentUserId = null, currentUserRole = null) {
    if (!roomsIO || !room) return;
    const challengeState = await buildRoomChallengePayload(room, currentUserId, currentUserRole);
    roomsIO.to(`room-${room.id}`).emit("room-challenge-updated", {
        roomId: Number(room.id),
        challengeState,
    });
}

function emitGlobalRoomChallengeStarted(roomsIO, room, challengeState) {
    if (!roomsIO || !room || !challengeState?.challenge) return;
    roomsIO.emit("global-room-challenge-started", {
        roomId: Number(room.id),
        roomName: normalizeRoomNameInput(room.name) || "غرفة",
        left: challengeState.challenge.left || null,
        right: challengeState.challenge.right || null,
        startedAt: challengeState.challenge.startedAt || null,
        endsAt: challengeState.challenge.endsAt || null,
    });
}

async function emitRoomSupervisorsUpdatedToIO(roomsIO, room, currentUserId = null, currentUserRole = null) {
    if (!roomsIO || !room) return;
    const supervisorState = await buildRoomSupervisorsPayload(
        room,
        currentUserId,
        currentUserRole,
        roomsIO.app,
    );
    roomsIO.to(`room-${room.id}`).emit("room-supervisors-updated", {
        roomId: Number(room.id),
        supervisorState,
    });
}

async function processRoomChallengeGift({
    app,
    roomId,
    receiver,
    sender,
    points,
    receiverShare,
}) {
    const room = await Room.findByPk(roomId);
    if (!room) return null;

    const settled = await settleRoomChallengeIfNeeded(room);
    if (!settled || settled.status !== "active" || !settled.endsAt || settled.endsAt.getTime() <= Date.now()) {
        await emitRoomChallengeUpdatedToIO(app?.get?.("roomsIO"), room);
        return null;
    }

    let changed = false;
    const challenge = JSON.parse(JSON.stringify(settled));

    for (const sideKey of ["left", "right"]) {
        const side = challenge[sideKey];
        if (String(side.userId) !== String(receiver.id)) continue;

        side.score = Math.max(0, Number(side.score || 0) + Number(points || 0));
        side.receiverShareTotal = Math.max(0, Number(side.receiverShareTotal || 0) + Number(receiverShare || 0));
        const supporters = Array.isArray(side.supporters) ? side.supporters : [];
        const existingIndex = supporters.findIndex((entry) => String(entry.userId) === String(sender.id));
        if (existingIndex >= 0) {
            supporters[existingIndex].totalPoints = Math.max(0, Number(supporters[existingIndex].totalPoints || 0) + Number(points || 0));
        } else {
            supporters.unshift({
                userId: Number(sender.id),
                name: normalizeAudioFileName(sender.name || "مستخدم") || "مستخدم",
                image: extractImage(sender.images || sender.image || ""),
                totalPoints: Math.max(0, Number(points || 0)),
            });
        }
        supporters.sort((a, b) => Number(b.totalPoints || 0) - Number(a.totalPoints || 0));
        side.supporters = supporters.slice(0, 6);
        side.supportersCount = supporters.length;
        changed = true;
        break;
    }

    if (!changed) return null;

    await room.update({ roomChallengeState: challenge });
    await emitRoomChallengeUpdatedToIO(app?.get?.("roomsIO"), room);
    return buildRoomChallengePayload(room);
}

function watchRoomChallenge(roomId) {
    const numericRoomId = Number(roomId);
    if (Number.isFinite(numericRoomId) && numericRoomId > 0) {
        roomChallengeWatchIds.add(numericRoomId);
    }
}

function unwatchRoomChallenge(roomId) {
    const numericRoomId = Number(roomId);
    if (Number.isFinite(numericRoomId) && numericRoomId > 0) {
        roomChallengeWatchIds.delete(numericRoomId);
    }
}

async function bootstrapWatchedRoomChallenges() {
    if (roomChallengeWatchBootstrapped) return;
    const rooms = await Room.findAll({
        where: { isActive: true },
        attributes: ["id", "roomChallengeState"],
    });

    for (const room of rooms) {
        const challenge = normalizeRoomChallengeState(room.roomChallengeState);
        if (challenge && challenge.status === "active") {
            watchRoomChallenge(room.id);
        }
    }

    roomChallengeWatchBootstrapped = true;
}

async function flushWatchedRoomChallenges(app) {
    if (roomChallengeWatchInFlight) return;
    roomChallengeWatchInFlight = true;

    try {
        await bootstrapWatchedRoomChallenges();
        if (roomChallengeWatchIds.size === 0) return;

        const watchedIds = Array.from(roomChallengeWatchIds);
        const rooms = await Room.findAll({
            where: {
                id: watchedIds,
                isActive: true,
            },
            attributes: ["id", "creatorId", "isActive", "roomChallengeState"],
        });

        const foundIds = new Set(rooms.map((room) => Number(room.id)));
        for (const watchedId of watchedIds) {
            if (!foundIds.has(watchedId)) {
                roomChallengeWatchIds.delete(watchedId);
            }
        }

        const roomsIO = app?.get?.("roomsIO");
        for (const room of rooms) {
            const before = normalizeRoomChallengeState(room.roomChallengeState);
            if (!before) {
                unwatchRoomChallenge(room.id);
                continue;
            }

            if (before.status !== "active") {
                unwatchRoomChallenge(room.id);
                continue;
            }

            if (!before.endsAt || before.endsAt.getTime() > Date.now()) {
                continue;
            }

            const beforeStatus = before.status;
            const beforeEndsAt = before.endsAt?.getTime() || 0;
            const beforeSettledAt = before.settledAt?.getTime?.() || 0;
            const beforeWinnerUserId = Number(before.winnerUserId || 0) || 0;

            const after = await settleRoomChallengeIfNeeded(room);
            if (!after) {
                unwatchRoomChallenge(room.id);
                continue;
            }

            if (after.status === "active") {
                watchRoomChallenge(room.id);
            } else {
                unwatchRoomChallenge(room.id);
            }

            const afterStatus = after.status;
            const afterEndsAt = after.endsAt?.getTime() || 0;
            const afterSettledAt = after.settledAt?.getTime?.() || 0;
            const afterWinnerUserId = Number(after.winnerUserId || 0) || 0;
            const changed =
                afterStatus !== beforeStatus ||
                afterEndsAt !== beforeEndsAt ||
                afterSettledAt !== beforeSettledAt ||
                afterWinnerUserId !== beforeWinnerUserId;

            if (changed && roomsIO) {
                await emitRoomChallengeUpdatedToIO(roomsIO, room);
            }
        }
    } catch (error) {
        console.error("Error while flushing watched room challenges:", error);
    } finally {
        roomChallengeWatchInFlight = false;
    }
}

function ensureRoomChallengeWatchWorker(app) {
    if (roomChallengeWatchStarted) return;
    roomChallengeWatchStarted = true;

    const timer = setInterval(() => {
        flushWatchedRoomChallenges(app);
    }, ROOM_CHALLENGE_WATCH_INTERVAL_MS);

    if (typeof timer.unref === "function") {
        timer.unref();
    }
}

async function emitRoomVoiceUpdated(app, room) {
    const roomsIO = app.get("roomsIO");
    if (!roomsIO) return;
    const socketIds = roomsIO.adapter.rooms.get(`room-${room.id}`);
    if (!socketIds || socketIds.size === 0) return;

    for (const socketId of socketIds) {
        const socket = roomsIO.sockets.get(socketId);
        if (!socket) continue;

        const voiceState = await buildRoomVoicePayload(
            room,
            socket.userId ?? null,
            socket.userRole ?? null,
        );
        roomsIO.to(socketId).emit("room-voice-updated", {
            roomId: Number(room.id),
            voiceState,
        });
    }
}

async function emitRoomAudioUpdated(app, room) {
    const roomsIO = app.get("roomsIO");
    if (!roomsIO) return;
    const audioState = await buildRoomAudioPayload(room);
    roomsIO.to(`room-${room.id}`).emit("room-audio-updated", {
        roomId: Number(room.id),
        audioState,
    });
}

async function emitRoomAudioUpdatedToIO(roomsIO, room) {
    if (!roomsIO || !room) return;
    const audioState = await buildRoomAudioPayload(room);
    roomsIO.to(`room-${room.id}`).emit("room-audio-updated", {
        roomId: Number(room.id),
        audioState,
    });
}

async function syncRoomAudioPlaybackPresence(roomsIO, roomId, shouldPlay) {
    const numericRoomId = Number(roomId);
    if (!Number.isFinite(numericRoomId) || numericRoomId <= 0) {
        return false;
    }

    const room = await Room.findByPk(numericRoomId);
    if (!room || !room.isActive) {
        return false;
    }

    const normalized = await normalizeRoomAudioState(room, { persist: true });
    if (!normalized.isPackageActive || !normalized.roomAudioCurrentTrackId) {
        return false;
    }

    const isCurrentlyPlaying = normalized.roomAudioPlaybackStartedAt != null;
    if (shouldPlay && !isCurrentlyPlaying) {
        await room.update({
            roomAudioPlaybackStartedAt: new Date(),
        });
        await emitRoomAudioUpdatedToIO(roomsIO, room);
        return true;
    }

    if (!shouldPlay && isCurrentlyPlaying) {
        await room.update({
            roomAudioPlaybackStartedAt: null,
        });
        await emitRoomAudioUpdatedToIO(roomsIO, room);
        return true;
    }

    return false;
}

async function emitRoomVoiceUpdatedToIO(roomsIO, room) {
    if (!roomsIO || !room) return;
    const socketIds = roomsIO.adapter.rooms.get(`room-${room.id}`);
    if (!socketIds || socketIds.size === 0) return;

    for (const socketId of socketIds) {
        const socket = roomsIO.sockets.get(socketId);
        if (!socket) continue;

        const voiceState = await buildRoomVoicePayload(
            room,
            socket.userId ?? null,
            socket.userRole ?? null,
        );
        roomsIO.to(socketId).emit("room-voice-updated", {
            roomId: Number(room.id),
            voiceState,
        });
    }
}

async function emitSerializedRoomUpdated(app, roomId) {
    const roomsIO = app.get("roomsIO");
    if (!roomsIO) return;

    const refreshedRoom = await Room.findByPk(roomId);
    if (!refreshedRoom) return;

    const [serializedRoom] = await attachActiveRoomFrames([refreshedRoom]);
    roomsIO.to(`room-${roomId}`).emit("room-updated", {
        roomId: Number(roomId),
        room: serializedRoom,
    });
}

async function cleanupRoomVoiceParticipant(roomsIO, roomId, userId) {
    const numericRoomId = Number(roomId);
    const numericUserId = Number(userId);

    if (!Number.isFinite(numericRoomId) || numericRoomId <= 0 || !Number.isFinite(numericUserId) || numericUserId <= 0) {
        return false;
    }

    const room = await Room.findByPk(numericRoomId);
    if (!room) return false;

    const normalized = await normalizeRoomVoiceState(room, { persist: true });
    const nextSpeakers = normalized.voiceActiveSpeakerIds.filter((id) => id !== numericUserId);
    const nextPending = normalized.voicePendingRequestIds.filter((id) => id !== numericUserId);

    if (
        nextSpeakers.length === normalized.voiceActiveSpeakerIds.length &&
        nextPending.length === normalized.voicePendingRequestIds.length
    ) {
        return false;
    }

    await room.update({
        voiceActiveSpeakerIds: nextSpeakers,
        voicePendingRequestIds: nextPending,
    });

    await emitRoomVoiceUpdatedToIO(roomsIO, room);
    return true;
}

async function buildPinnedMessage(message) {
    if (!message) return null;
    const msg = typeof message.toJSON === "function" ? message.toJSON() : { ...message };
    msg.user = await normalizeUserPayload(msg.user);
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
        return res.status(401).json({ error: "Token مفقود" });
    }

    try {
        const decoded = jwt.verify(token, getJwtSecret());
        const userId = decoded.id || decoded.userId;
        if (!userId) {
            return res.status(401).json({ error: "Token غير صالح - لا يحتوي على معرف المستخدم" });
        }
        
        const user = await User.findByPk(userId);
        if (!user) {
            return res.status(401).json({ error: "المستخدم غير موجود" });
        }
        if (user.isActive === false) {
            return res.status(403).json({ error: "تم حظر الحساب" });
        }
        req.user = user;
        next();
    } catch (error) {
        return res.status(403).json({ error: "Token غير صالح" });
    }
};

// ????? ???? sawa ???????? ????????
router.post("/add-sawa", authenticateToken, async (req, res) => {
    try {
        if (req.user?.role !== "admin") {
            return res.status(403).json({ error: "Admins only" });
        }
        const { amount = 1000 } = req.body;
        
        await req.user.update({
            sawa: req.user.sawa + amount
        });
        
        res.json({
            message: `تمت إضافة ${amount} نقطة sawa`,
            newBalance: req.user.sawa + amount
        });
    } catch (error) {
        res.status(500).json({ error: "حدث خطأ أثناء الإضافة" });
    }
});

router.post("/create-room", authenticateToken, upload.array("images", 5), async (req, res) => {
    try {
        const { name, description, cost, maxUsers, category } = req.body;

        const existingRoom = await Room.findOne({
            where: { creatorId: req.user.id }
        });

        if (existingRoom) {
            return res.status(400).json({
                error: "لا يمكنك إنشاء أكثر من غرفة في نفس الوقت"
            });
        }
        
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ error: "يرجى رفع صورة واحدة على الأقل" });
        }
        
        const images = req.files.map(file => file.filename);
        
        if (req.user.sawa < cost) {
            return res.status(400).json({ 
                error: "رصيدك الحالي غير كافٍ",
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

        // ??? ?????? ?? ????????
        await req.user.update({
            sawa: req.user.sawa - cost
        });

        res.status(201).json({
            message: "تم إنشاء الغرفة بنجاح",
            room,
            remainingSawa: req.user.sawa - cost
        });

    } catch (error) {
        console.error("??? ?? ????? ??????:", error);
        res.status(500).json({ error: "حدث خطأ أثناء إنشاء الغرفة" });
    }
});

// ????? ?? ???? ???????? id ?? name
router.get("/search-rooms", authenticateToken, async (req, res) => {
    try {
        const { query } = req.query;
        const { Op } = require("sequelize");
        
        if (!query) {
            return res.status(400).json({ error: "يرجى إدخال كلمة البحث" });
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

        const serializedRooms = await attachActiveRoomFrames(rooms);

        res.json({
            rooms: serializedRooms,
            total: rooms.length
        });

    } catch (error) {
        console.error("??? ?? ????? ?? ?????:", error);
        res.status(500).json({ error: "حدث خطأ أثناء البحث" });
    }
});

// ??? ????? ????????
router.get("/rooms", authenticateToken, async (req, res) => {
    try {
        const { category, page = 1, limit = 50 } = req.query;
        
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
                required: false  // LEFT JOIN ????? ?? INNER JOIN
            }],
            order: [
                ['currentUsers', 'DESC'],
                ['createdAt', 'DESC']
            ],
            limit: parseInt(limit),
            offset: (parseInt(page) - 1) * parseInt(limit)
        });

        const serializedRooms = await attachActiveRoomFrames(rooms.rows);

        res.json({
            rooms: serializedRooms,
            total: rooms.count,
            currentPage: parseInt(page),
            totalPages: Math.ceil(rooms.count / parseInt(limit))
        });

    } catch (error) {
        console.error("خطأ في جلب الغرف:", error);
        console.error("Stack trace:", error.stack);
        res.status(500).json({ 
            error: "حدث خطأ أثناء جلب الغرف"
        });
    }
});

// ?????? ??? ?????? ???? ?????
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
            return res.status(404).json({ error: "لا توجد غرفة مملوكة لهذا المستخدم" });
        }

        if (!room.isActive) {
            return res.status(400).json({ error: "هذه الغرفة غير نشطة حالياً" });
        }

        const [serializedRoom] = await attachActiveRoomFrames([room]);
        res.json({ room: serializedRoom });
    } catch (error) {
        console.error("خطأ في جلب غرفة المستخدم:", error);
        res.status(500).json({ error: "حدث خطأ أثناء جلب غرفة المستخدم" });
    }
});

// ?????? ??? ?????? ???? ?????
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

        const [serializedRoom] = await attachActiveRoomFrames([room]);
        res.json({ room: serializedRoom });

    } catch (error) {
        console.error("خطأ في جلب تفاصيل الغرفة:", error);
        res.status(500).json({ error: "حدث خطأ أثناء جلب تفاصيل الغرفة" });
    }
});

// ?????? ??? ????? ???? ?????
router.get("/room/:roomId/creator", authenticateToken, async (req, res) => {
    try {
        const roomId = Number(req.params.roomId);

        if (!Number.isInteger(roomId) || roomId <= 0) {
            return res.status(400).json({ error: "معرف الغرفة غير صالح" });
        }

        const room = await Room.findByPk(roomId, {
            include: [{
                model: User,
                as: 'creator',
                attributes: ['id', 'name', 'images', 'phone', 'role'],
            }]
        });

        if (!room) {
            return res.status(404).json({ error: "الغرفة غير موجودة" });
        }

        res.json({
            roomId: room.id,
            roomName: room.name,
            creatorId: room.creatorId,
            creator: room.creator ? {
                id: room.creator.id,
                name: room.creator.name,
                images: room.creator.images,
                phone: room.creator.phone,
                role: room.creator.role,
            } : null,
        });
    } catch (error) {
        console.error("خطأ في جلب مالك الغرفة:", error);
        res.status(500).json({ error: "حدث خطأ أثناء جلب مالك الغرفة" });
    }
});

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

        const serializedMessages = await Promise.all(
            messages.rows.reverse().map((message) => normalizeMessagePayload(message))
        );

        res.json({
            messages: serializedMessages,
            total: messages.count,
            currentPage: parseInt(page),
            totalPages: Math.ceil(messages.count / parseInt(limit))
        });

    } catch (error) {
        console.error("خطأ في جلب رسائل الغرفة:", error);
        res.status(500).json({ error: "حدث خطأ أثناء جلب رسائل الغرفة" });
    }
});

// ????? ????? ?? ?????? (????? ?????? ?? ?????? ???)
router.post("/room/:roomId/pin-message", authenticateToken, async (req, res) => {
    try {
        const { roomId } = req.params;
        const { messageId } = req.body;

        const room = await Room.findByPk(roomId);
        if (!room || !room.isActive) {
            return res.status(404).json({ error: "الغرفة غير موجودة" });
        }

        if (!canManageRoom(room, req.user)) {
            return res.status(403).json({ error: "غير مسموح لك" });
        }

        if (!messageId) {
            return res.status(400).json({ error: "معرف الرسالة مطلوب" });
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

        const pinnedMessage = await buildPinnedMessage(message);
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
        return res.status(500).json({ error: "حدث خطأ أثناء تثبيت الرسالة" });
    }
});

// ????? ????? ????? ?? ??????
router.post("/room/:roomId/unpin-message", authenticateToken, async (req, res) => {
    try {
        const { roomId } = req.params;

        const room = await Room.findByPk(roomId);
        if (!room || !room.isActive) {
            return res.status(404).json({ error: "الغرفة غير موجودة" });
        }

        if (!canManageRoom(room, req.user)) {
            return res.status(403).json({ error: "غير مسموح لك" });
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
        return res.status(500).json({ error: "حدث خطأ أثناء إلغاء تثبيت الرسالة" });
    }
});

// ??? ??????? ??????? ??????
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
        return res.status(500).json({ error: "حدث خطأ أثناء جلب الرسالة المثبتة" });
    }
});

// ??? ???? (?????? ???)
router.patch("/room/:roomId/name", authenticateToken, async (req, res) => {
    try {
        const { roomId } = req.params;
        const nextName = normalizeRoomNameInput(req.body?.name);

        if (!nextName) {
            return res.status(400).json({ error: "اسم الغرفة مطلوب" });
        }

        if (nextName.length > 100) {
            return res.status(400).json({ error: "اسم الغرفة طويل جدا" });
        }

        const room = await Room.findByPk(roomId, {
            include: [{
                model: User,
                as: 'creator',
                attributes: ['id', 'name', 'images'],
            }]
        });

        if (!room || !room.isActive) {
            return res.status(404).json({ error: "الغرفة غير موجودة" });
        }

        if (!canManageRoom(room, req.user)) {
            return res.status(403).json({ error: "غير مسموح لك" });
        }

        const actorUser = await User.findByPk(req.user.id);
        if (!actorUser) {
            return res.status(404).json({ error: "المستخدم غير موجود" });
        }

        const roomNameChangeCostSetting = await Settings.findOne({
            where: { key: "room_name_change_cost", isActive: true },
            order: [["updatedAt", "DESC"], ["id", "DESC"]],
        });
        const roomNameChangeCost = roomNameChangeCostSetting
            ? parseInt(roomNameChangeCostSetting.value, 10) || 0
            : 0;

        const currentBalance = Number(actorUser.sawa ?? 0);
        if (currentBalance < roomNameChangeCost) {
            return res.status(400).json({
                error: "رصيدك الحالي غير كافٍ",
                requiredPoints: roomNameChangeCost,
                availablePoints: currentBalance,
            });
        }

        const remainingSawa = currentBalance - roomNameChangeCost;
        if (roomNameChangeCost > 0) {
            await actorUser.update({ sawa: remainingSawa });
        }

        await room.update({ name: nextName });

        const refreshedRoom = await Room.findByPk(roomId, {
            include: [{
                model: User,
                as: 'creator',
                attributes: ['id', 'name', 'images'],
            }]
        });

        const [serializedRoom] = await attachActiveRoomFrames([refreshedRoom]);
        const roomsIO = req.app.get("roomsIO");
        if (roomsIO) {
            roomsIO.to(`room-${roomId}`).emit("room-updated", {
                roomId: Number(roomId),
                room: serializedRoom,
            });
        }

        return res.json({
            message: "تم تحديث اسم الغرفة",
            deductedPoints: roomNameChangeCost,
            remainingSawa,
            room: serializedRoom,
        });
    } catch (error) {
        console.error("خطأ في تحديث اسم الغرفة:", error);
        return res.status(500).json({ error: "حدث خطأ أثناء تحديث اسم الغرفة" });
    }
});

router.patch("/admin/rooms/:roomId/name", authenticateToken, async (req, res) => {
    try {
        if (req.user?.role !== "admin") {
            return res.status(403).json({ error: "Admins only" });
        }

        const { roomId } = req.params;
        const nextName = normalizeRoomNameInput(req.body?.name);

        if (!nextName) {
            return res.status(400).json({ error: "اسم الغرفة مطلوب" });
        }

        if (nextName.length > 100) {
            return res.status(400).json({ error: "اسم الغرفة طويل جدا" });
        }

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

        await room.update({ name: nextName });

        const refreshedRoom = await Room.findByPk(roomId, {
            include: [{
                model: User,
                as: 'creator',
                attributes: ['id', 'name', 'images'],
            }]
        });

        const [serializedRoom] = await attachActiveRoomFrames([refreshedRoom]);
        const roomsIO = req.app.get("roomsIO");
        if (roomsIO) {
            roomsIO.to(`room-${roomId}`).emit("room-updated", {
                roomId: Number(roomId),
                room: serializedRoom,
            });
        }

        return res.json({
            message: "تم تحديث اسم الغرفة بواسطة الإدارة",
            room: serializedRoom,
        });
    } catch (error) {
        console.error("خطأ في تحديث اسم الغرفة من الإدارة:", error);
        return res.status(500).json({ error: "حدث خطأ أثناء تحديث اسم الغرفة" });
    }
});

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

        if (!canManageRoom(room, req.user)) {
            return res.status(403).json({ error: "غير مسموح لك بتعديل خلفية الغرفة" });
        }

        if (!req.file) {
            return res.status(400).json({ error: "Background image is required" });
        }

        const actorUser = await User.findByPk(req.user.id);
        if (!actorUser) {
            return res.status(404).json({ error: "User not found" });
        }

        const backgroundCostSetting = await Settings.findOne({
            where: { key: "room_background_change_cost", isActive: true },
            order: [["updatedAt", "DESC"], ["id", "DESC"]],
        });
        const backgroundCost = backgroundCostSetting
            ? parseInt(backgroundCostSetting.value, 10) || 0
            : 0;

        const currentBalance = Number(actorUser.sawa ?? 0);
        if (currentBalance < backgroundCost) {
            return res.status(400).json({
                error: "Insufficient points to change room background",
                requiredPoints: backgroundCost,
                availablePoints: currentBalance,
            });
        }

        const remainingSawa = currentBalance - backgroundCost;
        if (backgroundCost > 0) {
            await actorUser.update({ sawa: remainingSawa });
        }

        await room.update({ backgroundImage: req.file.filename });

        const refreshedRoom = await Room.findByPk(roomId, {
            include: [{
                model: User,
                as: 'creator',
                attributes: ['id', 'name', 'images'],
            }]
        });

        const [serializedRoom] = await attachActiveRoomFrames([refreshedRoom]);

        return res.json({
            message: "Room background updated successfully",
            deductedPoints: backgroundCost,
            remainingSawa,
            room: serializedRoom,
        });
    } catch (error) {
        console.error("Error updating room background:", error);
        return res.status(500).json({ error: "An error occurred while updating room background" });
    }
});

// ????? ?????? ???????? ?????? (????? ?????? ?? ??????)
router.post("/room/:roomId/image", authenticateToken, upload.single("image"), async (req, res) => {
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

        if (!canManageRoom(room, req.user)) {
            return res.status(403).json({ error: "??? ????" });
        }

        if (!req.file) {
            return res.status(400).json({ error: "الصورة مطلوبة" });
        }

        const existingImages = Array.isArray(room.images) ? [...room.images] : [];
        if (existingImages.length === 0) {
            existingImages.push(req.file.filename);
        } else {
            existingImages[0] = req.file.filename;
        }

        await room.update({ images: existingImages });

        const refreshedRoom = await Room.findByPk(roomId, {
            include: [{
                model: User,
                as: 'creator',
                attributes: ['id', 'name', 'images'],
            }]
        });

        const [serializedRoom] = await attachActiveRoomFrames([refreshedRoom]);

        return res.json({
            message: "تم تحديث صورة الغرفة",
            room: serializedRoom,
        });
    } catch (error) {
        console.error("خطأ في تحديث صورة الغرفة:", error);
        return res.status(500).json({ error: "حدث خطأ أثناء تحديث صورة الغرفة" });
    }
});
router.delete("/room/:roomId", authenticateToken, async (req, res) => {
    try {
        const { roomId } = req.params;
        
        const room = await Room.findByPk(roomId);
        
        if (!room) {
            return res.status(404).json({ error: "الغرفة غير موجودة" });
        }

        if (!canManageRoom(room, req.user)) {
            return res.status(403).json({ error: "Only the room owner or an admin can delete this room" });
        }

        await room.update({ isActive: false });
        
        res.json({ message: "تم حذف الغرفة" });

    } catch (error) {
        console.error("خطأ في حذف الغرفة:", error);
        res.status(500).json({ error: "حدث خطأ أثناء حذف الغرفة" });
    }
});

router.get("/room/:roomId/voice-state", authenticateToken, async (req, res) => {
    try {
        if (!ensureUserPresentInRoomSocket(req, res, req.params.roomId)) {
            return;
        }
        const room = await Room.findByPk(req.params.roomId);
        if (!room || !room.isActive) {
            return res.status(404).json({ error: "الغرفة غير موجودة" });
        }

        const voiceState = await buildRoomVoicePayload(room, req.user.id, req.user.role);
        return res.json(voiceState);
    } catch (error) {
        console.error("Error fetching room voice state:", error);
        return res.status(500).json({ error: "حدث خطأ أثناء جلب حالة المايكات" });
    }
});

router.get("/room/:roomId/support-agent-state", authenticateToken, async (req, res) => {
    try {
        if (!ensureUserPresentInRoomSocket(req, res, req.params.roomId)) {
            return;
        }
        const room = await Room.findByPk(req.params.roomId);
        if (!room || !room.isActive) {
            return res.status(404).json({ error: "الغرفة غير موجودة" });
        }

        const supportAgentState = await buildRoomSupportAgentPayload(
            room,
            req.user.id,
            req.user.role,
        );
        return res.json(supportAgentState);
    } catch (error) {
        console.error("Error fetching room support agent state:", error);
        return res.status(500).json({ error: "حدث خطأ أثناء جلب حالة دعم الوكيل" });
    }
});

router.get("/room/:roomId/audio-state", authenticateToken, async (req, res) => {
    try {
        if (!ensureUserPresentInRoomSocket(req, res, req.params.roomId)) {
            return;
        }
        const room = await Room.findByPk(req.params.roomId);
        if (!room || !room.isActive) {
            return res.status(404).json({ error: "الغرفة غير موجودة" });
        }

        const audioState = await buildRoomAudioPayload(room, req.user.id, req.user.role);
        return res.json(audioState);
    } catch (error) {
        console.error("Error fetching room audio state:", error);
        return res.status(500).json({ error: "حدث خطأ أثناء جلب حالة الصوتيات" });
    }
});

router.get("/room/:roomId/challenge-state", authenticateToken, async (req, res) => {
    try {
        if (!ensureUserPresentInRoomSocket(req, res, req.params.roomId)) {
            return;
        }
        const room = await Room.findByPk(req.params.roomId);
        if (!room || !room.isActive) {
            return res.status(404).json({ error: "الغرفة غير موجودة" });
        }

        const challengeState = await buildRoomChallengePayload(room, req.user.id, req.user.role);
        return res.json(challengeState);
    } catch (error) {
        console.error("Error fetching room challenge state:", error);
        return res.status(500).json({ error: "حدث خطأ أثناء جلب حالة التحدي" });
    }
});

router.post("/room/:roomId/challenge/start", authenticateToken, async (req, res) => {
    try {
        const room = await Room.findByPk(req.params.roomId);
        if (!room || !room.isActive) {
            return res.status(404).json({ error: "الغرفة غير موجودة" });
        }
        if (!canManageRoom(room, req.user)) {
            return res.status(403).json({ error: "غير مسموح لك بإدارة التحدي" });
        }

        const leftUserId = Number(req.body?.leftUserId || 0);
        const rightUserId = Number(req.body?.rightUserId || 0);
        if (!leftUserId || !rightUserId || leftUserId === rightUserId) {
            return res.status(400).json({ error: "يجب اختيار مستخدمين مختلفين لبدء التحدي" });
        }

        const [leftUser, rightUser] = await Promise.all([
            User.findByPk(leftUserId, { attributes: ["id", "name", "images"] }),
            User.findByPk(rightUserId, { attributes: ["id", "name", "images"] }),
        ]);
        if (!leftUser || !rightUser) {
            return res.status(404).json({ error: "أحد المتنافسين غير موجود" });
        }

        const settings = await getRoomChallengeSettings();
        const now = new Date();
        const nextState = {
            status: "active",
            startedAt: now.toISOString(),
            endsAt: new Date(now.getTime() + (settings.durationSeconds * 1000)).toISOString(),
            winnerUserId: null,
            settledAt: null,
            left: createChallengeParticipantPayload(leftUser),
            right: createChallengeParticipantPayload(rightUser),
        };

        await room.update({ roomChallengeState: nextState });
        watchRoomChallenge(room.id);
        const roomsIO = req.app.get("roomsIO");
        const challengeState = await buildRoomChallengePayload(room, req.user.id, req.user.role);
        await emitRoomChallengeUpdatedToIO(roomsIO, room, req.user.id, req.user.role);
        emitGlobalRoomChallengeStarted(roomsIO, room, challengeState);

        return res.json({
            message: "تم بدء التحدي بنجاح",
            challengeState,
        });
    } catch (error) {
        console.error("Error starting room challenge:", error);
        return res.status(500).json({ error: "حدث خطأ أثناء بدء التحدي" });
    }
});

router.post("/room/:roomId/challenge/cancel", authenticateToken, async (req, res) => {
    try {
        const room = await Room.findByPk(req.params.roomId);
        if (!room || !room.isActive) {
            return res.status(404).json({ error: "الغرفة غير موجودة" });
        }
        if (!canManageRoom(room, req.user)) {
            return res.status(403).json({ error: "غير مسموح لك بإدارة التحدي" });
        }

        await room.update({ roomChallengeState: null });
        unwatchRoomChallenge(room.id);
        await emitRoomChallengeUpdatedToIO(req.app.get("roomsIO"), room, req.user.id, req.user.role);

        return res.json({
            message: "تم إلغاء التحدي",
            challengeState: await buildRoomChallengePayload(room, req.user.id, req.user.role),
        });
    } catch (error) {
        console.error("Error cancelling room challenge:", error);
        return res.status(500).json({ error: "حدث خطأ أثناء إلغاء التحدي" });
    }
});

router.get("/room/:roomId/challenge-state", authenticateToken, async (req, res) => {
    try {
        if (!ensureUserPresentInRoomSocket(req, res, req.params.roomId)) {
            return;
        }
        const room = await Room.findByPk(req.params.roomId);
        if (!room || !room.isActive) {
            return res.status(404).json({ error: "الغرفة غير موجودة" });
        }

        const challengeState = await buildRoomChallengePayload(room, req.user.id, req.user.role);
        return res.json(challengeState);
    } catch (error) {
        console.error("Error fetching room challenge state:", error);
        return res.status(500).json({ error: "حدث خطأ أثناء جلب حالة التحدي" });
    }
});

router.get("/room/:roomId/supervisors-state", authenticateToken, async (req, res) => {
    try {
        const room = await Room.findByPk(req.params.roomId);
        if (!room || !room.isActive) {
            return res.status(404).json({ error: "الغرفة غير موجودة" });
        }

        const supervisorState = await buildRoomSupervisorsPayload(
            room,
            req.user.id,
            req.user.role,
            req.app,
        );
        return res.json(supervisorState);
    } catch (error) {
        console.error("Error fetching room supervisors state:", error);
        return res.status(500).json({ error: "حدث خطأ أثناء جلب حالة السوبر مشرفين" });
    }
});

router.get("/room/:roomId/join-state", authenticateToken, async (req, res) => {
    try {
        const room = await Room.findByPk(req.params.roomId);
        if (!room || !room.isActive) {
            return res.status(404).json({ error: "الغرفة غير موجودة" });
        }

        const joinState = await buildRoomJoinPayload(room, req.user.id, req.user.role);
        return res.json(joinState);
    } catch (error) {
        console.error("Error fetching room join state:", error);
        return res.status(500).json({ error: "حدث خطأ أثناء جلب حالة الانضمام" });
    }
});

router.post("/room/:roomId/join/toggle", authenticateToken, async (req, res) => {
    try {
        const room = await Room.findByPk(req.params.roomId);
        if (!room || !room.isActive) {
            return res.status(404).json({ error: "الغرفة غير موجودة" });
        }

        const roomId = Number(room.id);
        const userId = Number(req.user.id);
        const existing = await RoomJoinSubscription.findOne({
            where: { roomId, userId },
        });

        let message = "تم الانضمام إلى الغرفة";
        if (existing) {
            await existing.destroy();
            message = "تم إلغاء الانضمام إلى الغرفة";
        } else {
            await RoomJoinSubscription.create({ roomId, userId });
        }

        return res.json({
            message,
            joinState: await buildRoomJoinPayload(room, req.user.id, req.user.role),
        });
    } catch (error) {
        console.error("Error toggling room join subscription:", error);
        return res.status(500).json({ error: "حدث خطأ أثناء تحديث حالة الانضمام" });
    }
});

router.get("/room/:roomId/join-members", authenticateToken, async (req, res) => {
    try {
        const room = await Room.findByPk(req.params.roomId);
        if (!room || !room.isActive) {
            return res.status(404).json({ error: "الغرفة غير موجودة" });
        }

        if (!canManageRoom(room, req.user)) {
            return res.status(403).json({ error: "غير مسموح لك بعرض المنضمين إلى هذه الغرفة" });
        }

        const subscriptions = await RoomJoinSubscription.findAll({
            where: { roomId: Number(room.id) },
            include: [{
                model: User,
                as: "user",
                attributes: ["id", "name", "images"],
                required: true,
            }],
            order: [["createdAt", "DESC"]],
        });

        const members = await Promise.all(
            subscriptions.map(async (subscription) => {
                const user = await normalizeUserPayload(subscription.user);
                return {
                    subscriptionId: subscription.id,
                    joinedAt: subscription.createdAt,
                    user: user ? {
                        id: user.id,
                        name: user.name,
                        image: user.image ?? "",
                        activeFrame: user.activeFrame ?? null,
                    } : null,
                };
            }),
        );

        return res.json({
            roomId: Number(room.id),
            total: members.length,
            members: members.filter((member) => member.user != null),
        });
    } catch (error) {
        console.error("Error fetching joined room members:", error);
        return res.status(500).json({ error: "حدث خطأ أثناء جلب المنضمين إلى الغرفة" });
    }
});

router.post("/room/:roomId/join-members/notify", authenticateToken, async (req, res) => {
    try {
        const room = await Room.findByPk(req.params.roomId);
        if (!room || !room.isActive) {
            return res.status(404).json({ error: "الغرفة غير موجودة" });
        }

        if (!canManageRoom(room, req.user)) {
            return res.status(403).json({ error: "غير مسموح لك بإرسال إشعار للمنضمين إلى هذه الغرفة" });
        }

        const message = String(req.body?.message ?? "").trim();
        if (!message) {
            return res.status(400).json({ error: "نص الإشعار مطلوب" });
        }

        const title = String(req.body?.title ?? "").trim() || `إشعار من غرفة ${room.name}`;
        const subscriptions = await RoomJoinSubscription.findAll({
            where: { roomId: Number(room.id) },
            attributes: ["userId"],
        });

        const userIds = [...new Set(
            subscriptions
                .map((subscription) => Number(subscription.userId))
                .filter((userId) => Number.isFinite(userId) && userId > 0),
        )];

        if (userIds.length === 0) {
            return res.status(400).json({ error: "لا يوجد أعضاء منضمون لإرسال الإشعار إليهم" });
        }

        const results = await Promise.allSettled(
            userIds.map((userId) => sendNotificationToUser(userId, message, title)),
        );
        const sentCount = results.filter((result) => result.status === "fulfilled").length;

        return res.json({
            message: "تم إرسال الإشعار إلى المنضمين بنجاح",
            sentCount,
            totalRecipients: userIds.length,
        });
    } catch (error) {
        console.error("Error notifying joined room members:", error);
        return res.status(500).json({ error: "حدث خطأ أثناء إرسال الإشعار للمنضمين" });
    }
});

router.post("/room/:roomId/supervisors/assign", authenticateToken, async (req, res) => {
    try {
        const room = await Room.findByPk(req.params.roomId);
        if (!room || !room.isActive) {
            return res.status(404).json({ error: "الغرفة غير موجودة" });
        }

        if (!canManageRoomSupervisorAssignments(room, req.user)) {
            return res.status(403).json({ error: "غير مسموح لك بتعيين مشرفي الغرفة" });
        }

        const slotKey = String(req.body?.slotKey ?? "").trim().toLowerCase();
        const userId = Number(req.body?.userId);

        if (!ROOM_SUPERVISOR_SLOT_KEYS.includes(slotKey)) {
            return res.status(400).json({ error: "نوع رتبة المشرف غير صالح" });
        }

        if (!Number.isFinite(userId) || userId <= 0) {
            return res.status(400).json({ error: "معرف المستخدم غير صالح" });
        }

        if (!isUserPresentInRoomSocket(req.app, room.id, userId)) {
            return res.status(400).json({ error: "يجب أن يكون المستخدم موجودًا داخل الغرفة" });
        }

        if (String(room.creatorId) === String(userId)) {
            return res.status(400).json({ error: "لا يمكن تعيين مالك الغرفة كمشرف سوبر" });
        }

        const targetUser = await User.findByPk(userId, {
            attributes: ["id", "name", "isActive"],
        });
        if (!targetUser || targetUser.isActive === false) {
            return res.status(404).json({ error: "المستخدم المطلوب غير موجود أو غير نشط" });
        }

        const slots = normalizeRoomSupervisorSlots(room.supervisorSlots);
        for (const currentSlotKey of ROOM_SUPERVISOR_SLOT_KEYS) {
            if (currentSlotKey !== slotKey && String(slots[currentSlotKey] ?? "") === String(userId)) {
                return res.status(400).json({ error: "هذا المستخدم معين بالفعل في رتبة مشرف أخرى" });
            }
        }

        slots[slotKey] = userId;
        await room.update({ supervisorSlots: slots });

        const roomsIO = req.app.get("roomsIO");
        await emitRoomSupervisorsUpdatedToIO(roomsIO, room, req.user.id, req.user.role);

        return res.json({
            message: `تم تعيين ${targetUser.name || "المستخدم"} في ${ROOM_SUPERVISOR_SLOT_META[slotKey].label}`,
            supervisorState: await buildRoomSupervisorsPayload(room, req.user.id, req.user.role, req.app),
        });
    } catch (error) {
        console.error("Error assigning room supervisor:", error);
        return res.status(500).json({ error: "حدث خطأ أثناء تعيين المشرف" });
    }
});

router.post("/room/:roomId/supervisors/remove", authenticateToken, async (req, res) => {
    try {
        const room = await Room.findByPk(req.params.roomId);
        if (!room || !room.isActive) {
            return res.status(404).json({ error: "الغرفة غير موجودة" });
        }

        if (!canManageRoomSupervisorAssignments(room, req.user)) {
            return res.status(403).json({ error: "غير مسموح لك بإزالة مشرفي الغرفة" });
        }

        const slotKey = String(req.body?.slotKey ?? "").trim().toLowerCase();
        if (!ROOM_SUPERVISOR_SLOT_KEYS.includes(slotKey)) {
            return res.status(400).json({ error: "نوع رتبة المشرف غير صالح" });
        }

        const slots = normalizeRoomSupervisorSlots(room.supervisorSlots);
        slots[slotKey] = null;
        await room.update({ supervisorSlots: slots });

        const roomsIO = req.app.get("roomsIO");
        await emitRoomSupervisorsUpdatedToIO(roomsIO, room, req.user.id, req.user.role);

        return res.json({
            message: `تمت إزالة ${ROOM_SUPERVISOR_SLOT_META[slotKey].label}`,
            supervisorState: await buildRoomSupervisorsPayload(room, req.user.id, req.user.role, req.app),
        });
    } catch (error) {
        console.error("Error removing room supervisor:", error);
        return res.status(500).json({ error: "حدث خطأ أثناء إزالة المشرف" });
    }
});

router.post("/room/:roomId/challenge/start", authenticateToken, async (req, res) => {
    try {
        const room = await Room.findByPk(req.params.roomId);
        if (!room || !room.isActive) {
            return res.status(404).json({ error: "الغرفة غير موجودة" });
        }
        if (!canManageRoom(room, req.user)) {
            return res.status(403).json({ error: "غير مسموح لك بإدارة التحدي" });
        }

        const leftUserId = Number(req.body?.leftUserId || 0);
        const rightUserId = Number(req.body?.rightUserId || 0);
        if (!leftUserId || !rightUserId || leftUserId === rightUserId) {
            return res.status(400).json({ error: "يجب اختيار مستخدمين مختلفين لبدء التحدي" });
        }

        const [leftUser, rightUser] = await Promise.all([
            User.findByPk(leftUserId, { attributes: ["id", "name", "images"] }),
            User.findByPk(rightUserId, { attributes: ["id", "name", "images"] }),
        ]);
        if (!leftUser || !rightUser) {
            return res.status(404).json({ error: "أحد المتنافسين غير موجود" });
        }

        const settings = await getRoomChallengeSettings();
        const now = new Date();
        const nextState = {
            status: "active",
            startedAt: now.toISOString(),
            endsAt: new Date(now.getTime() + (settings.durationSeconds * 1000)).toISOString(),
            winnerUserId: null,
            settledAt: null,
            left: createChallengeParticipantPayload(leftUser),
            right: createChallengeParticipantPayload(rightUser),
        };

        await room.update({ roomChallengeState: nextState });
        const roomsIO = req.app.get("roomsIO");
        const challengeState = await buildRoomChallengePayload(room, req.user.id, req.user.role);
        await emitRoomChallengeUpdatedToIO(roomsIO, room, req.user.id, req.user.role);
        emitGlobalRoomChallengeStarted(roomsIO, room, challengeState);

        return res.json({
            message: "?? ??? ?????? ?????",
            challengeState,
        });
    } catch (error) {
        console.error("Error starting room challenge:", error);
        return res.status(500).json({ error: "??? ?? ??? ??????" });
    }
});

router.post("/room/:roomId/challenge/cancel", authenticateToken, async (req, res) => {
    try {
        const room = await Room.findByPk(req.params.roomId);
        if (!room || !room.isActive) {
            return res.status(404).json({ error: "?????? ??? ??????" });
        }
        if (!canManageRoom(room, req.user)) {
            return res.status(403).json({ error: "غير مسموح لك بإدارة دعم الوكيل" });
        }

        await room.update({ roomChallengeState: null });
        await emitRoomChallengeUpdatedToIO(req.app.get("roomsIO"), room, req.user.id, req.user.role);

        return res.json({
            message: "?? ????? ??????",
            challengeState: await buildRoomChallengePayload(room, req.user.id, req.user.role),
        });
    } catch (error) {
        console.error("Error cancelling room challenge:", error);
        return res.status(500).json({ error: "??? ?? ????? ??????" });
    }
});

router.post("/room/:roomId/voice/purchase", authenticateToken, async (req, res) => {
    try {
        const room = await Room.findByPk(req.params.roomId);
        if (!room || !room.isActive) {
            return res.status(404).json({ error: "?????? ??? ??????" });
        }

        if (!canManageRoom(room, req.user)) {
            return res.status(403).json({ error: "??? ?????? ????? ?????? ???" });
        }

        const micCount = Number(req.body?.micCount ?? 4);
        if (!isSupportedRoomVoiceMicCount(micCount)) {
            return res.status(400).json({ error: "???? ???????? ???????? ??? ??????" });
        }

        const settings = await getRoomVoicePackageSettings();
        const packageConfig = settings.packages.find((entry) => entry.micCount === micCount);
        if (!packageConfig || packageConfig.hours <= 0) {
            return res.status(400).json({ error: "??????? ???? ???????? ??? ????? ?? ???????" });
        }

        const currentBalance = Number(req.user.sawa ?? 0);
        if (currentBalance < packageConfig.price) {
            return res.status(400).json({
                error: "????? ??? ????? ????? ???? ????????",
                requiredPoints: packageConfig.price,
                availablePoints: currentBalance,
            });
        }

        const normalized = await normalizeRoomVoiceState(room, { persist: true });
        const isReplacingPackage = normalized.isActive && normalized.voiceMicCount !== micCount;
        const nextActiveSpeakerIds = isReplacingPackage
            ? normalized.voiceActiveSpeakerIds.slice(0, micCount)
            : normalized.voiceActiveSpeakerIds;
        const nextPendingRequestIds = isReplacingPackage
            ? normalized.voicePendingRequestIds.filter((userId) => !nextActiveSpeakerIds.includes(userId))
            : normalized.voicePendingRequestIds;
        const baseDate = normalized.isActive && normalized.voicePackageExpiresAt && !isReplacingPackage
            ? normalized.voicePackageExpiresAt
            : new Date();
        const nextExpiry = new Date(baseDate.getTime() + (packageConfig.hours * 60 * 60 * 1000));

        await room.update({
            voiceMicCount: micCount,
            voicePackageExpiresAt: nextExpiry,
            voiceActiveSpeakerIds: nextActiveSpeakerIds,
            voicePendingRequestIds: nextPendingRequestIds,
        });
        await req.user.update({ sawa: currentBalance - packageConfig.price });

        await emitRoomVoiceUpdated(req.app, room);

        return res.json({
            message: "?? ????? ???? ???????? ?????",
            deductedPoints: packageConfig.price,
            remainingSawa: currentBalance - packageConfig.price,
            voiceState: await buildRoomVoicePayload(room, req.user.id, req.user.role),
        });
    } catch (error) {
        console.error("Error purchasing room voice package:", error);
        return res.status(500).json({ error: "??? ?? ???? ???? ????????" });
    }
});

router.post("/room/:roomId/audio/purchase", authenticateToken, async (req, res) => {
    try {
        const room = await Room.findByPk(req.params.roomId);
        if (!room || !room.isActive) {
            return res.status(404).json({ error: "?????? ??? ??????" });
        }

        if (!canManageRoom(room, req.user)) {
            return res.status(403).json({ error: "??? ?????? ????? ?????? ???" });
        }

        if (false && !voiceState.isActive) {
            return res.status(400).json({ error: "???? ???????? ????? ??? ????? ?? ????? ????????" });
        }

        const packageConfig = await getRoomAudioSettings();
        if (packageConfig.hours <= 0) {
            return res.status(400).json({ error: "??????? ??? ???????? ??? ????? ?? ???????" });
        }

        const currentBalance = Number(req.user.sawa ?? 0);
        if (currentBalance < packageConfig.price) {
            return res.status(400).json({
                error: "????? ??? ????? ?????? ????????",
                requiredPoints: packageConfig.price,
                availablePoints: currentBalance,
            });
        }

        const normalized = await normalizeRoomAudioState(room, { persist: true });
        const baseDate = normalized.isPackageActive && normalized.roomAudioExpiresAt
            ? normalized.roomAudioExpiresAt
            : new Date();
        const nextExpiry = new Date(baseDate.getTime() + (packageConfig.hours * 60 * 60 * 1000));

        await room.update({
            roomAudioExpiresAt: nextExpiry,
        });
        await req.user.update({ sawa: currentBalance - packageConfig.price });

        await emitRoomAudioUpdated(req.app, room);
        await emitSerializedRoomUpdated(req.app, room.id);

        return res.json({
            message: "?? ????? ???????? ?????",
            deductedPoints: packageConfig.price,
            remainingSawa: currentBalance - packageConfig.price,
            audioState: await buildRoomAudioPayload(room, req.user.id, req.user.role),
        });
    } catch (error) {
        console.error("Error purchasing room audio package:", error);
        return res.status(500).json({ error: "??? ?? ???? ??? ????????" });
    }
});

router.post("/admin/rooms/reset-voice-audio-packages", authenticateToken, async (req, res) => {
    try {
        if (req.user?.role !== "admin") {
            return res.status(403).json({ error: "??? ???? ?? ???? ???????" });
        }

        const affectedRooms = await Room.findAll({
            where: {
                [Op.or]: [
                    { voiceMicCount: { [Op.gt]: 0 } },
                    { voicePackageExpiresAt: { [Op.ne]: null } },
                    { roomAudioExpiresAt: { [Op.ne]: null } },
                    { roomAudioCurrentTrackId: { [Op.ne]: null } },
                    { roomAudioPlaybackStartedAt: { [Op.ne]: null } },
                ],
            },
        });

        if (affectedRooms.length == 0) {
            return res.status(200).json({
                message: "?? ???? ????? ?????? ?? ?????? ????? ??????",
                affectedRoomsCount: 0,
                affectedRoomIds: [],
            });
        }

        const roomIds = affectedRooms
            .map((room) => Number(room.id))
            .filter((roomId) => Number.isFinite(roomId));

        await Room.update(
            {
                voiceMicCount: 0,
                voicePackageExpiresAt: null,
                voiceActiveSpeakerIds: [],
                voicePendingRequestIds: [],
                roomAudioExpiresAt: null,
                roomAudioCurrentTrackId: null,
                roomAudioPlaybackStartedAt: null,
            },
            {
                where: {
                    id: {
                        [Op.in]: roomIds,
                    },
                },
            },
        );

        const refreshedRooms = await Room.findAll({
            where: {
                id: {
                    [Op.in]: roomIds,
                },
            },
        });

        for (const room of refreshedRooms) {
            await emitRoomVoiceUpdated(req.app, room);
            await emitRoomAudioUpdated(req.app, room);
            await emitSerializedRoomUpdated(req.app, room.id);
        }

        return res.status(200).json({
            message: "تم تصفير اشتراكات المايكات والصوتيات في جميع الغرف المحددة",
            affectedRoomsCount: refreshedRooms.length,
            affectedRoomIds: roomIds,
        });
    } catch (error) {
        console.error("Error resetting room voice/audio packages:", error);
        return res.status(500).json({ error: "حدث خطأ أثناء تصفير اشتراكات المايكات والصوتيات" });
    }
});

router.post("/room/:roomId/audio/upload", authenticateToken, upload.single("audio"), async (req, res) => {
    try {
        const room = await Room.findByPk(req.params.roomId);
        if (!room || !room.isActive) {
            await removeUploadedFileSafe(req.file?.path);
            return res.status(404).json({ error: "الغرفة غير موجودة" });
        }

        if (!canManageRoom(room, req.user)) {
            await removeUploadedFileSafe(req.file?.path);
            return res.status(403).json({ error: "غير مسموح لك بإدارة الصوتيات" });
        }

        if (!req.file || !isAudioUploadFile(req.file)) {
            await removeUploadedFileSafe(req.file?.path);
            return res.status(400).json({ error: "يجب رفع ملف صوتي صالح" });
        }

        const audioState = await buildRoomAudioPayload(room, req.user.id, req.user.role);
        if (!audioState.isActive) {
            await removeUploadedFileSafe(req.file.path);
            return res.status(400).json({ error: "ميزة الصوتيات غير مفعلة في هذه الغرفة" });
        }

        const packageConfig = await getRoomAudioSettings();
        const parsed = await parseFile(req.file.path);
        const durationSeconds = Math.max(0, Math.round(Number(parsed.format.duration || 0)));
        if (durationSeconds <= 0) {
            await removeUploadedFileSafe(req.file.path);
            return res.status(400).json({ error: "تعذر تحديد مدة الملف الصوتي" });
        }

        const normalized = await normalizeRoomAudioState(room, { persist: true });
        const nextTotalDurationSeconds = sumRoomAudioDurationSeconds(normalized.roomAudioFiles) + durationSeconds;
        const maxTotalSeconds = Math.max(1, Number(packageConfig.maxTotalMinutes || 60)) * 60;
        if (nextTotalDurationSeconds > maxTotalSeconds) {
            await removeUploadedFileSafe(req.file.path);
            return res.status(400).json({
                error: `إجمالي مدة الملفات الصوتية تجاوز الحد المسموح ${packageConfig.maxTotalMinutes} دقيقة`,
            });
        }

        const entry = {
            id: randomUUID(),
            name: normalizeAudioFileName(path.parse(req.file.originalname).name) || "ملف صوتي",
            originalName: normalizeAudioFileName(req.file.originalname) || req.file.filename,
            storedFileName: req.file.filename,
            durationSeconds,
            uploadedById: Number(req.user.id),
            uploadedByName: normalizeAudioFileName(req.user.name || "مستخدم") || "مستخدم",
            uploadedAt: new Date().toISOString(),
        };

        await room.update({
            roomAudioFiles: [...normalized.roomAudioFiles, entry],
        });

        await emitRoomAudioUpdated(req.app, room);
        return res.json({
            message: "تم رفع الملف الصوتي بنجاح",
            audioState: await buildRoomAudioPayload(room, req.user.id, req.user.role),
        });
    } catch (error) {
        await removeUploadedFileSafe(req.file?.path);
        console.error("Error uploading room audio:", error);
        return res.status(500).json({ error: "حدث خطأ أثناء رفع الملف الصوتي" });
    }
});

router.post("/room/:roomId/audio/play", authenticateToken, async (req, res) => {
    try {
        const room = await Room.findByPk(req.params.roomId);
        if (!room || !room.isActive) {
            return res.status(404).json({ error: "الغرفة غير موجودة" });
        }

        if (!canManageRoom(room, req.user)) {
            return res.status(403).json({ error: "غير مسموح لك بتشغيل الصوتيات" });
        }

        const normalized = await normalizeRoomAudioState(room, { persist: true });
        if (!normalized.isPackageActive) {
            return res.status(400).json({ error: "ميزة الصوتيات غير مفعلة أو انتهت صلاحيتها" });
        }

        const fileId = String(req.body?.fileId || "").trim();
        const track = normalized.roomAudioFiles.find((entry) => entry.id === fileId);
        if (!track) {
            return res.status(404).json({ error: "الملف الصوتي غير موجود" });
        }

        await room.update({
            roomAudioCurrentTrackId: track.id,
            roomAudioPlaybackStartedAt: new Date(),
        });

        await emitRoomAudioUpdated(req.app, room);
        return res.json({
            message: "تم تشغيل الملف الصوتي",
            audioState: await buildRoomAudioPayload(room, req.user.id, req.user.role),
        });
    } catch (error) {
        console.error("Error playing room audio:", error);
        return res.status(500).json({ error: "حدث خطأ أثناء تشغيل الملف الصوتي" });
    }
});

router.post("/room/:roomId/audio/stop", authenticateToken, async (req, res) => {
    try {
        const room = await Room.findByPk(req.params.roomId);
        if (!room || !room.isActive) {
            return res.status(404).json({ error: "الغرفة غير موجودة" });
        }

        if (!canManageRoom(room, req.user)) {
            return res.status(403).json({ error: "غير مسموح لك بإيقاف الصوتيات" });
        }

        await room.update({
            roomAudioCurrentTrackId: null,
            roomAudioPlaybackStartedAt: null,
        });

        await emitRoomAudioUpdated(req.app, room);
        return res.json({
            message: "تم إيقاف الصوتيات",
            audioState: await buildRoomAudioPayload(room, req.user.id, req.user.role),
        });
    } catch (error) {
        console.error("Error stopping room audio:", error);
        return res.status(500).json({ error: "حدث خطأ أثناء إيقاف الصوتيات" });
    }
});

router.delete("/room/:roomId/audio/file/:fileId", authenticateToken, async (req, res) => {
    try {
        const room = await Room.findByPk(req.params.roomId);
        if (!room || !room.isActive) {
            return res.status(404).json({ error: "الغرفة غير موجودة" });
        }

        if (!canManageRoom(room, req.user)) {
            return res.status(403).json({ error: "غير مسموح لك بحذف الملفات الصوتية" });
        }

        const normalized = await normalizeRoomAudioState(room, { persist: true });
        const fileId = String(req.params.fileId || "").trim();
        const targetFile = normalized.roomAudioFiles.find((entry) => entry.id === fileId);
        if (!targetFile) {
            return res.status(404).json({ error: "الملف الصوتي غير موجود" });
        }

        const nextFiles = normalized.roomAudioFiles.filter((entry) => entry.id !== fileId);
        const shouldStopCurrent = normalized.roomAudioCurrentTrackId === fileId;

        await room.update({
            roomAudioFiles: nextFiles,
            roomAudioCurrentTrackId: shouldStopCurrent ? null : normalized.roomAudioCurrentTrackId,
            roomAudioPlaybackStartedAt: shouldStopCurrent ? null : normalized.roomAudioPlaybackStartedAt,
        });

        await removeUploadedFileSafe(path.join(process.cwd(), "uploads", targetFile.storedFileName));
        await emitRoomAudioUpdated(req.app, room);

        return res.json({
            message: "تم حذف الملف الصوتي",
            audioState: await buildRoomAudioPayload(room, req.user.id, req.user.role),
        });
    } catch (error) {
        console.error("Error deleting room audio:", error);
        return res.status(500).json({ error: "حدث خطأ أثناء حذف الملف الصوتي" });
    }
});

router.post("/room/:roomId/support-agent/activate", authenticateToken, async (req, res) => {
    try {
        const room = await Room.findByPk(req.params.roomId);
        if (!room || !room.isActive) {
            return res.status(404).json({ error: "?????? ??? ??????" });
        }

        if (!canManageRoom(room, req.user)) {
            return res.status(403).json({ error: "??? ?????? ????? ?????? ???" });
        }

        const agentId = Number(req.body?.agentId);
        if (!Number.isFinite(agentId) || agentId <= 0) {
            return res.status(400).json({ error: "معرف الوكيل غير صالح" });
        }

        const agent = await User.findOne({
            where: {
                id: agentId,
                role: "agent",
                isActive: true,
            },
        });

        if (!agent) {
            return res.status(404).json({ error: "الوكيل المحدد غير موجود" });
        }

        const packageConfig = await getRoomSupportAgentSettings();
        if (packageConfig.hours <= 0) {
            return res.status(400).json({ error: "ميزة دعم الوكيل غير متاحة حاليا" });
        }

        const currentBalance = Number(req.user.sawa ?? 0);
        if (currentBalance < packageConfig.price) {
            return res.status(400).json({
                error: "رصيدك الحالي غير كافٍ لتفعيل دعم الوكيل",
                requiredPoints: packageConfig.price,
                availablePoints: currentBalance,
            });
        }

        const normalized = await normalizeRoomSupportAgentState(room, { persist: true });
        const baseDate = normalized.isActive && normalized.supportAgentExpiresAt
            ? normalized.supportAgentExpiresAt
            : new Date();
        const nextExpiry = new Date(baseDate.getTime() + (packageConfig.hours * 60 * 60 * 1000));

        await room.update({
            supportAgentUserId: agentId,
            supportAgentExpiresAt: nextExpiry,
        });
        await req.user.update({ sawa: currentBalance - packageConfig.price });

        await emitSerializedRoomUpdated(req.app, room.id);

        return res.json({
            message: "تم تفعيل دعم الوكيل بنجاح",
            deductedPoints: packageConfig.price,
            remainingSawa: currentBalance - packageConfig.price,
            supportAgentState: await buildRoomSupportAgentPayload(room, req.user.id, req.user.role),
        });
    } catch (error) {
        console.error("Error activating room support agent:", error);
        return res.status(500).json({ error: "حدث خطأ أثناء تفعيل دعم الوكيل" });
    }
});

router.post("/room/:roomId/support-agent/select", authenticateToken, async (req, res) => {
    try {
        const room = await Room.findByPk(req.params.roomId);
        if (!room || !room.isActive) {
            return res.status(404).json({ error: "الغرفة غير موجودة" });
        }

        if (!canManageRoom(room, req.user)) {
            return res.status(403).json({ error: "غير مسموح لك بإدارة المايكات" });
        }

        const normalized = await normalizeRoomSupportAgentState(room, { persist: true });
        if (!normalized.isActive) {
            return res.status(400).json({ error: "ميزة دعم الوكيل غير مفعلة أو منتهية" });
        }

        const agentId = Number(req.body?.agentId);
        if (!Number.isFinite(agentId) || agentId <= 0) {
            return res.status(400).json({ error: "معرف الوكيل غير صالح" });
        }

        const agent = await User.findOne({
            where: {
                id: agentId,
                role: "agent",
                isActive: true,
            },
        });

        if (!agent) {
            return res.status(404).json({ error: "الوكيل المحدد غير موجود" });
        }

        await room.update({ supportAgentUserId: agentId });
        await emitSerializedRoomUpdated(req.app, room.id);

        return res.json({
            message: "تم اختيار وكيل الدعم",
            supportAgentState: await buildRoomSupportAgentPayload(room, req.user.id, req.user.role),
        });
    } catch (error) {
        console.error("Error selecting room support agent:", error);
        return res.status(500).json({ error: "حدث خطأ أثناء اختيار وكيل الدعم" });
    }
});

router.post("/room/:roomId/support-agent/clear", authenticateToken, async (req, res) => {
    try {
        const room = await Room.findByPk(req.params.roomId);
        if (!room || !room.isActive) {
            return res.status(404).json({ error: "الغرفة غير موجودة" });
        }

        if (!canManageRoom(room, req.user)) {
            return res.status(403).json({ error: "غير مسموح لك بإدارة المايكات" });
        }

        const normalized = await normalizeRoomSupportAgentState(room, { persist: true });
        if (!normalized.isActive) {
            return res.status(400).json({ error: "ميزة دعم الوكيل غير مفعلة أو منتهية" });
        }

        await room.update({ supportAgentUserId: null });
        await emitSerializedRoomUpdated(req.app, room.id);

        return res.json({
            message: "تم إلغاء وكيل الدعم الحالي",
            supportAgentState: await buildRoomSupportAgentPayload(room, req.user.id, req.user.role),
        });
    } catch (error) {
        console.error("Error clearing room support agent:", error);
        return res.status(500).json({ error: "حدث خطأ أثناء إلغاء وكيل الدعم" });
    }
});

router.post("/room/:roomId/voice/request", authenticateToken, async (req, res) => {
    try {
        const room = await Room.findByPk(req.params.roomId);
        if (!room || !room.isActive) {
            return res.status(404).json({ error: "الغرفة غير موجودة" });
        }

        const normalized = await normalizeRoomVoiceState(room, { persist: true });
        if (!normalized.isActive) {
            return res.status(400).json({ error: "ميزة المايكات غير مفعلة في هذه الغرفة" });
        }

        const userId = Number(req.user.id);
        if (normalized.voiceActiveSpeakerIds.includes(userId)) {
            return res.status(400).json({ error: "لديك طلب مايك نشط بالفعل" });
        }

        if (String(room.creatorId) === String(userId)) {
            return res.status(400).json({ error: "مالك الغرفة لا يحتاج إلى طلب مايك" });
        }

        if (!normalized.voicePendingRequestIds.includes(userId)) {
            normalized.voicePendingRequestIds.push(userId);
            await room.update({ voicePendingRequestIds: normalized.voicePendingRequestIds });
        }

        await emitRoomVoiceUpdated(req.app, room);
        return res.json({
            message: "تم إرسال طلب المايك",
            voiceState: await buildRoomVoicePayload(room, req.user.id, req.user.role),
        });
    } catch (error) {
        console.error("Error requesting room voice seat:", error);
        return res.status(500).json({ error: "حدث خطأ أثناء إرسال طلب المايك" });
    }
});

router.post("/room/:roomId/voice/cancel-request", authenticateToken, async (req, res) => {
    try {
        const room = await Room.findByPk(req.params.roomId);
        if (!room || !room.isActive) {
            return res.status(404).json({ error: "الغرفة غير موجودة" });
        }

        const normalized = await normalizeRoomVoiceState(room, { persist: true });
        const userId = Number(req.user.id);
        const nextPending = normalized.voicePendingRequestIds.filter((id) => id !== userId);
        await room.update({ voicePendingRequestIds: nextPending });

        await emitRoomVoiceUpdated(req.app, room);
        return res.json({
            message: "تم إلغاء طلب المايك",
            voiceState: await buildRoomVoicePayload(room, req.user.id, req.user.role),
        });
    } catch (error) {
        console.error("Error canceling room voice request:", error);
        return res.status(500).json({ error: "حدث خطأ أثناء إلغاء طلب المايك" });
    }
});

router.post("/room/:roomId/voice/toggle-owner-speaker", authenticateToken, async (req, res) => {
    try {
        const room = await Room.findByPk(req.params.roomId);
        if (!room || !room.isActive) {
            return res.status(404).json({ error: "?????? ??? ??????" });
        }

        if (!canManageRoom(room, req.user)) {
            return res.status(403).json({ error: "غير مسموح لك بإدارة المايكات" });
        }

        const normalized = await normalizeRoomVoiceState(room, { persist: true });
        if (!normalized.isActive) {
            return res.status(400).json({ error: "ميزة المايكات غير مفعلة في هذه الغرفة" });
        }

        const ownerId = Number(req.user.id);
        let nextSpeakers = [...normalized.voiceActiveSpeakerIds];
        if (nextSpeakers.includes(ownerId)) {
            nextSpeakers = nextSpeakers.filter((id) => id !== ownerId);
        } else {
            if (nextSpeakers.length >= normalized.voiceMicCount) {
                return res.status(400).json({ error: "لا توجد مقاعد مايك شاغرة" });
            }
            nextSpeakers.push(ownerId);
        }

        await room.update({
            voiceActiveSpeakerIds: nextSpeakers,
            voicePendingRequestIds: normalized.voicePendingRequestIds.filter((id) => id !== ownerId),
        });
        await syncLiveKitSpeakerPermission(room.id, ownerId, nextSpeakers.includes(ownerId));

        await emitRoomVoiceUpdated(req.app, room);
        return res.json({
            message: nextSpeakers.includes(ownerId) ? "تم تفعيل المايك" : "تم إيقاف المايك",
            voiceState: await buildRoomVoicePayload(room, req.user.id, req.user.role),
        });
    } catch (error) {
        console.error("Error toggling owner speaker seat:", error);
        return res.status(500).json({ error: "حدث خطأ أثناء تحديث حالة المايك" });
    }
});

router.post("/room/:roomId/voice/approve", authenticateToken, async (req, res) => {
    try {
        const room = await Room.findByPk(req.params.roomId);
        if (!room || !room.isActive) {
            return res.status(404).json({ error: "الغرفة غير موجودة" });
        }

        if (!canManageRoom(room, req.user)) {
            return res.status(403).json({ error: "غير مسموح لك بإدارة المايكات" });
        }

        const normalized = await normalizeRoomVoiceState(room, { persist: true });
        if (!normalized.isActive) {
            return res.status(400).json({ error: "ميزة المايكات غير مفعلة في هذه الغرفة" });
        }

        if (normalized.voiceActiveSpeakerIds.length >= normalized.voiceMicCount) {
            return res.status(400).json({ error: "لا توجد مقاعد مايك شاغرة" });
        }

        const userId = Number(req.body?.userId);
        if (!normalized.voicePendingRequestIds.includes(userId)) {
            return res.status(400).json({ error: "هذا المستخدم لا يملك طلب مايك" });
        }

        await room.update({
            voiceActiveSpeakerIds: [...normalized.voiceActiveSpeakerIds, userId],
            voicePendingRequestIds: normalized.voicePendingRequestIds.filter((id) => id !== userId),
        });
        await syncLiveKitSpeakerPermission(room.id, userId, true);

        await emitRoomVoiceUpdated(req.app, room);
        return res.json({
            message: "تمت الموافقة على طلب المايك",
            voiceState: await buildRoomVoicePayload(room, req.user.id, req.user.role),
        });
    } catch (error) {
        console.error("Error approving room voice request:", error);
        return res.status(500).json({ error: "حدث خطأ أثناء الموافقة على طلب المايك" });
    }
});

router.post("/room/:roomId/voice/reject", authenticateToken, async (req, res) => {
    try {
        const room = await Room.findByPk(req.params.roomId);
        if (!room || !room.isActive) {
            return res.status(404).json({ error: "الغرفة غير موجودة" });
        }

        if (!canManageRoom(room, req.user)) {
            return res.status(403).json({ error: "غير مسموح لك بإدارة المايكات" });
        }

        const normalized = await normalizeRoomVoiceState(room, { persist: true });
        const userId = Number(req.body?.userId);
        await room.update({
            voicePendingRequestIds: normalized.voicePendingRequestIds.filter((id) => id !== userId),
        });

        await emitRoomVoiceUpdated(req.app, room);
        return res.json({
            message: "تم رفض طلب المايك",
            voiceState: await buildRoomVoicePayload(room, req.user.id, req.user.role),
        });
    } catch (error) {
        console.error("Error rejecting room voice request:", error);
        return res.status(500).json({ error: "حدث خطأ أثناء رفض طلب المايك" });
    }
});

router.post("/room/:roomId/voice/remove-speaker", authenticateToken, async (req, res) => {
    try {
        const room = await Room.findByPk(req.params.roomId);
        if (!room || !room.isActive) {
            return res.status(404).json({ error: "الغرفة غير موجودة" });
        }

        if (!canManageRoom(room, req.user)) {
            return res.status(403).json({ error: "غير مسموح لك بإدارة المايكات" });
        }

        const normalized = await normalizeRoomVoiceState(room, { persist: true });
        const userId = Number(req.body?.userId);
        await room.update({
            voiceActiveSpeakerIds: normalized.voiceActiveSpeakerIds.filter((id) => id !== userId),
        });
        await syncLiveKitSpeakerPermission(room.id, userId, false);

        await emitRoomVoiceUpdated(req.app, room);
        return res.json({
            message: "تم تنزيل المستخدم من المايك",
            voiceState: await buildRoomVoicePayload(room, req.user.id, req.user.role),
        });
    } catch (error) {
        console.error("Error removing room speaker:", error);
        return res.status(500).json({ error: "حدث خطأ أثناء تنزيل المستخدم من المايك" });
    }
});

router.post("/room/:roomId/voice/leave-speaker", authenticateToken, async (req, res) => {
    try {
        const room = await Room.findByPk(req.params.roomId);
        if (!room || !room.isActive) {
            return res.status(404).json({ error: "الغرفة غير موجودة" });
        }

        const normalized = await normalizeRoomVoiceState(room, { persist: true });
        const userId = Number(req.user.id);
        await room.update({
            voiceActiveSpeakerIds: normalized.voiceActiveSpeakerIds.filter((id) => id !== userId),
        });
        await syncLiveKitSpeakerPermission(room.id, userId, false);

        await emitRoomVoiceUpdated(req.app, room);
        return res.json({
            message: "تمت مغادرة المايك",
            voiceState: await buildRoomVoicePayload(room, req.user.id, req.user.role),
        });
    } catch (error) {
        console.error("Error leaving room speaker seat:", error);
        return res.status(500).json({ error: "حدث خطأ أثناء مغادرة المايك" });
    }
});

router.post("/room/:roomId/voice/token", authenticateToken, async (req, res) => {
    try {
        if (!ensureUserPresentInRoomSocket(req, res, req.params.roomId)) {
            return;
        }
        const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = process.env;
        if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
            return res.status(500).json({ error: "إعدادات LiveKit غير مكتملة على السيرفر" });
        }

        const room = await Room.findByPk(req.params.roomId);
        if (!room || !room.isActive) {
            return res.status(404).json({ error: "الغرفة غير موجودة" });
        }

        const voiceState = await buildRoomVoicePayload(room, req.user.id, req.user.role);
        if (!voiceState.isActive) {
            return res.status(400).json({ error: "ميزة المايكات غير مفعلة في هذه الغرفة" });
        }

        const canPublish = voiceState.currentUser.isSpeaker === true;
        await syncLiveKitSpeakerPermission(room.id, req.user.id, canPublish);
        const token = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
            identity: getLiveKitParticipantIdentity(room.id, req.user.id),
            name: req.user.name || `user-${req.user.id}`,
            ttl: "2h",
            metadata: JSON.stringify({
                roomId: Number(room.id),
                userId: Number(req.user.id),
                role: canPublish ? "speaker" : "listener",
            }),
        });

        token.addGrant({
            roomJoin: true,
            room: getLiveKitRoomName(room.id),
            canPublish,
            canPublishData: false,
            canSubscribe: true,
        });

        return res.json({
            url: LIVEKIT_URL,
            roomName: getLiveKitRoomName(room.id),
            token: await token.toJwt(),
            canPublish,
        });
    } catch (error) {
        console.error("Error creating LiveKit token:", error);
        return res.status(500).json({ error: "حدث خطأ أثناء إنشاء توكن المايك" });
    }
});

router.get("/room-settings", async (req, res) => {
  try {
    const latestActiveSetting = (key) => Settings.findOne({
      where: { key, isActive: true },
      order: [["updatedAt", "DESC"], ["id", "DESC"]],
    });
    const costSetting = await latestActiveSetting("room_creation_cost");
    const maxUsersSetting = await latestActiveSetting("room_max_users");
    const roomBackgroundChangeCostSetting = await latestActiveSetting("room_background_change_cost");
    const roomNameChangeCostSetting = await latestActiveSetting("room_name_change_cost");
    const roomVoiceMic4PriceSetting = await latestActiveSetting("room_voice_mic_4_price");
    const roomVoiceMic4HoursSetting = await latestActiveSetting("room_voice_mic_4_hours");
    const roomVoiceMic8PriceSetting = await latestActiveSetting("room_voice_mic_8_price");
    const roomVoiceMic8HoursSetting = await latestActiveSetting("room_voice_mic_8_hours");
    const roomAudioPriceSetting = await latestActiveSetting("room_audio_price");
    const roomAudioHoursSetting = await latestActiveSetting("room_audio_hours");
    const roomAudioMaxTotalMinutesSetting = await latestActiveSetting("room_audio_max_total_minutes");
    const roomSupportAgentPriceSetting = await latestActiveSetting("room_support_agent_price");
    const roomSupportAgentHoursSetting = await latestActiveSetting("room_support_agent_hours");
    const roomChallengeDurationSetting = await latestActiveSetting("room_challenge_duration_seconds");

    res.json({
      room_creation_cost: costSetting ? parseInt(costSetting.value) : 0,
      room_max_users: maxUsersSetting ? parseInt(maxUsersSetting.value) : 50,
      room_background_change_cost: roomBackgroundChangeCostSetting ? parseInt(roomBackgroundChangeCostSetting.value) : 0,
      room_name_change_cost: roomNameChangeCostSetting ? parseInt(roomNameChangeCostSetting.value) : 0,
      room_voice_mic_4_price: roomVoiceMic4PriceSetting ? parseInt(roomVoiceMic4PriceSetting.value, 10) || 0 : 0,
      room_voice_mic_4_hours: roomVoiceMic4HoursSetting ? parseInt(roomVoiceMic4HoursSetting.value, 10) || 0 : 0,
      room_voice_mic_8_price: roomVoiceMic8PriceSetting ? parseInt(roomVoiceMic8PriceSetting.value, 10) || 0 : 0,
      room_voice_mic_8_hours: roomVoiceMic8HoursSetting ? parseInt(roomVoiceMic8HoursSetting.value, 10) || 0 : 0,
      room_audio_price: roomAudioPriceSetting ? parseInt(roomAudioPriceSetting.value, 10) || 0 : 0,
      room_audio_hours: roomAudioHoursSetting ? parseInt(roomAudioHoursSetting.value, 10) || 0 : 0,
      room_audio_max_total_minutes: roomAudioMaxTotalMinutesSetting ? parseInt(roomAudioMaxTotalMinutesSetting.value, 10) || 60 : 60,
      room_support_agent_price: roomSupportAgentPriceSetting ? parseInt(roomSupportAgentPriceSetting.value, 10) || 0 : 0,
      room_support_agent_hours: roomSupportAgentHoursSetting ? parseInt(roomSupportAgentHoursSetting.value, 10) || 0 : 0,
      room_challenge_duration_seconds: roomChallengeDurationSetting ? parseInt(roomChallengeDurationSetting.value, 10) || 180 : 180,
    });
  } catch (err) {
    console.error("Error fetching room settings:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ???? ?????? ???? ????? ?????? ????? ?????
router.get("/migrate-rooms-images", authenticateToken, async (req, res) => {
    try {
        if (req.user?.role !== "admin") {
            return res.status(403).json({ error: "Admins only" });
        }

        await require("../models/room").sync({ alter: true });
        res.json({ message: "?? ????? ???? ????? ?????? ????? ????? ?????" });
    } catch (error) {
        console.error("??? ?? ????? ????? ????????:", error);
        res.status(500).json({ error: "??? ?? ????? ????? ????????" });
    }
});

router.cleanupRoomVoiceParticipant = cleanupRoomVoiceParticipant;
router.syncRoomAudioPlaybackPresence = syncRoomAudioPlaybackPresence;
router.processRoomChallengeGift = processRoomChallengeGift;
router.buildRoomChallengePayload = buildRoomChallengePayload;
router.canManageRoom = canManageRoom;
cleanupUnsupportedRoomVoicePackages();
module.exports = router;
