require("dotenv").config();
const express = require("express");
const router = express.Router();
const multer = require("multer");
const upload = multer();
const { Op } = require("sequelize");
const {
  sendNotification,
  sendNotificationToUser,
  sendNotificationToRole,
} = require("../services/notifications");
const {
  User,
  UserDevice,
  NotificationLog,
  NotificationRead,
  DeviceFingerprint,
  DeviceFingerprintUser,
} = require("../models");
const { requireAdmin, authenticateTokenUser } = require("../middlewares/auth");

function normalizeCategory(value) {
  const category = String(value || "").trim().toLowerCase();
  return category || null;
}

function buildNotificationsWhereCondition({ userId, role, category }) {
  const whereCondition = {
    [Op.or]: [
      { target_type: "all" },
      { target_type: "user", target_value: userId.toString() },
    ],
  };

  if (role) {
    whereCondition[Op.or].push({
      target_type: "role",
      target_value: role,
    });
  }

  if (category) {
    whereCondition.category = category;
  }

  return whereCondition;
}

async function fetchRelevantNotificationIds({ userId, role, category }) {
  const logs = await NotificationLog.findAll({
    where: buildNotificationsWhereCondition({ userId, role, category }),
    attributes: ["id"],
    raw: true,
  });

  return logs
    .map((item) => Number(item.id))
    .filter((value) => Number.isFinite(value) && value > 0);
}

async function countUnreadNotifications({ userId, role, category }) {
  const notificationIds = await fetchRelevantNotificationIds({ userId, role, category });
  if (notificationIds.length == 0) {
    return 0;
  }

  const reads = await NotificationRead.findAll({
    where: {
      userId,
      notificationId: {
        [Op.in]: notificationIds,
      },
    },
    attributes: ["notificationId"],
    raw: true,
  });

  const readIds = new Set(reads.map((item) => Number(item.notificationId)));
  return notificationIds.filter((id) => !readIds.has(id)).length;
}

async function markAllNotificationsAsRead({ userId, role, category }) {
  const notificationIds = await fetchRelevantNotificationIds({ userId, role, category });
  if (notificationIds.length === 0) {
    return 0;
  }

  const existingReads = await NotificationRead.findAll({
    where: {
      userId,
      notificationId: {
        [Op.in]: notificationIds,
      },
    },
    attributes: ["notificationId"],
    raw: true,
  });

  const readIds = new Set(existingReads.map((item) => Number(item.notificationId)));
  const missingRows = notificationIds
    .filter((notificationId) => !readIds.has(notificationId))
    .map((notificationId) => ({
      notificationId,
      userId,
      readAt: new Date(),
    }));

  if (missingRows.length > 0) {
    await NotificationRead.bulkCreate(missingRows, {
      ignoreDuplicates: true,
    });
  }

  return missingRows.length;
}

router.post("/register-device", async (req, res) => {
  const { user_id, player_id } = req.body;

  if (!user_id || !player_id) {
    return res.status(400).json({ error: "user_id و player_id مطلوبان" });
  }

  try {
    const user = await User.findByPk(user_id);
    if (!user) {
      return res.status(404).json({ error: "المستخدم غير موجود" });
    }

    let device = await UserDevice.findOne({ where: { player_id } });

    if (device) {
      device.user_id = user_id;
      await device.save();
    } else {
      await UserDevice.create({ user_id, player_id });
    }

    const installId = `onesignal:${player_id}`;
    let fingerprint = await DeviceFingerprint.findOne({
      where: { install_id: installId },
    });

    if (!fingerprint) {
      fingerprint = await DeviceFingerprint.create({
        install_id: installId,
        last_seen_at: new Date(),
      });
    } else {
      fingerprint.last_seen_at = new Date();
      await fingerprint.save();
    }

    let link = await DeviceFingerprintUser.findOne({
      where: { device_id: fingerprint.id, user_id },
    });

    if (!link) {
      await DeviceFingerprintUser.create({
        device_id: fingerprint.id,
        user_id,
        last_seen_at: new Date(),
      });
    } else {
      link.last_seen_at = new Date();
      await link.save();
    }

    if (fingerprint.is_banned) {
      user.isActive = false;
      await user.save();
      return res.status(403).json({ error: "هذا الجهاز محظور" });
    }

    res.json({ success: true, message: "تم تسجيل الجهاز بنجاح" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "حدث خطأ أثناء تسجيل الجهاز" });
  }
});

router.post("/send-notification", requireAdmin, upload.none(), async (req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const { title, message, category, subcategory } = body;

  if (!message) {
    return res.status(400).json({ error: "message مطلوب" });
  }

  await sendNotification(message, title, { category, subcategory });
  res.json({ success: true, message: "تم إرسال الإشعار للجميع" });
});

router.post("/send-notification-to-role", requireAdmin, upload.none(), async (req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const { title, message, role, category, subcategory } = body;

  if (!message) {
    return res.status(400).json({ error: "message مطلوب" });
  }

  if (!role) {
    return res.status(400).json({ error: "role مطلوب" });
  }

  try {
    const result = await sendNotificationToRole(
      role,
      message,
      title || "Notification",
      { category, subcategory },
    );

    if (!result?.success) {
      return res.status(404).json({
        error: result?.message || `لا توجد أجهزة للمستخدمين بالرول ${role}`,
      });
    }

    return res.json({
      success: true,
      message: `تم إرسال الإشعار لجميع المستخدمين بالرول ${role}`,
    });
  } catch (error) {
    console.error(`Error sending notification to role ${role}:`, error);
    return res.status(500).json({ error: "حدث خطأ أثناء إرسال الإشعار" });
  }
});

router.post("/send-notification-to-referral", requireAdmin, upload.none(), async (req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const { title, message, referralCode, category, subcategory } = body;

  if (!message) {
    return res.status(400).json({
      error: "message مطلوب",
      hint: "أرسل الطلب بصيغة JSON أو form-data مع Content-Type صحيح",
    });
  }

  if (!referralCode) {
    return res.status(400).json({
      error: "referralCode مطلوب",
      hint: "أرسل referralCode داخل body",
    });
  }

  try {
    const normalizedReferralCode = String(referralCode).trim();
    const user = await User.findByPk(normalizedReferralCode);

    if (!user) {
      return res.status(404).json({ error: "المستخدم غير موجود بهذا الرمز" });
    }

    const result = await sendNotificationToUser(
      user.id,
      message,
      title || "Notification",
      { category, subcategory },
    );

    if (!result?.success) {
      return res.status(404).json({
        error: result?.message || "تعذر إرسال الإشعار لهذا المستخدم",
        referralCode: normalizedReferralCode,
        userId: user.id,
      });
    }

    return res.json({
      success: true,
      message: "تم إرسال الإشعار بنجاح",
      user: {
        id: user.id,
        name: user.name,
        referralCode: String(user.id),
      },
    });
  } catch (error) {
    console.error("Error sending notification by referral code:", error);
    return res.status(500).json({ error: "حدث خطأ أثناء إرسال الإشعار" });
  }
});

router.get("/notifications-log", authenticateTokenUser, async (req, res) => {
  const page = Number.parseInt(String(req.query.page || "1"), 10) || 1;
  const limit = Number.parseInt(String(req.query.limit || "30"), 10) || 30;
  const userId = req.user.id;
  const role = String(req.user.role || "").trim();
  const category = normalizeCategory(req.query.category);

  try {
    const whereCondition = buildNotificationsWhereCondition({
      userId,
      role,
      category,
    });

    const offset = (page - 1) * limit;

    const { count, rows } = await NotificationLog.findAndCountAll({
      where: whereCondition,
      distinct: true,
      include: [
        {
          model: NotificationRead,
          as: "reads",
          where: { userId },
          required: false,
          attributes: ["id", "readAt"],
        },
      ],
      order: [["createdAt", "DESC"]],
      limit,
      offset,
    });

    const logs = rows.map((log) => {
      const plain = typeof log.toJSON === "function" ? log.toJSON() : log;
      const readEntry = Array.isArray(plain.reads) && plain.reads.length > 0
        ? plain.reads[0]
        : null;
      return {
        ...plain,
        isRead: !!readEntry,
        readAt: readEntry?.readAt || null,
      };
    });

    res.json({
      total: count,
      page,
      totalPages: Math.ceil(count / limit),
      logs,
    });
  } catch (err) {
    console.error("Error fetching notification logs:", err);
    res.status(500).json({ error: "خطأ أثناء جلب السجل" });
  }
});

router.post("/notifications/read-all", authenticateTokenUser, async (req, res) => {
  const userId = Number(req.user.id);
  const role = String(req.user.role || "").trim();
  const category = normalizeCategory(req.body?.category);

  try {
    const markedCount = await markAllNotificationsAsRead({
      userId,
      role,
      category,
    });

    return res.json({
      success: true,
      markedCount,
    });
  } catch (error) {
    console.error("Error marking notifications as read:", error);
    return res.status(500).json({ error: "تعذر تحديث حالة القراءة" });
  }
});

router.get("/notifications/unread-count", authenticateTokenUser, async (req, res) => {
  const userId = Number(req.user.id);
  const role = String(req.user.role || "").trim();
  const category = normalizeCategory(req.query.category);

  try {
    const unreadCount = await countUnreadNotifications({
      userId,
      role,
      category,
    });

    return res.json({
      unreadCount,
    });
  } catch (error) {
    console.error("Error fetching unread notification count:", error);
    return res.status(500).json({ error: "تعذر جلب عدد الإشعارات غير المقروءة" });
  }
});

router.get("/notifications-log-admin/:userId", requireAdmin, async (req, res) => {
  const { userId } = req.params;
  const page = Number.parseInt(String(req.query.page || "1"), 10) || 1;
  const limit = Number.parseInt(String(req.query.limit || "50"), 10) || 50;
  const category = normalizeCategory(req.query.category);

  try {
    const user = await User.findByPk(userId);
    if (!user) {
      return res.status(404).json({ error: "المستخدم غير موجود" });
    }

    const whereCondition = buildNotificationsWhereCondition({
      userId,
      role: String(user.role || "").trim(),
      category,
    });

    const offset = (page - 1) * limit;

    const { count, rows } = await NotificationLog.findAndCountAll({
      where: whereCondition,
      distinct: true,
      include: [
        {
          model: NotificationRead,
          as: "reads",
          where: { userId: Number(userId) },
          required: false,
          attributes: ["id", "readAt"],
        },
      ],
      order: [["createdAt", "DESC"]],
      limit,
      offset,
    });

    const logs = rows.map((log) => {
      const plain = typeof log.toJSON === "function" ? log.toJSON() : log;
      const readEntry = Array.isArray(plain.reads) && plain.reads.length > 0 ? plain.reads[0] : null;
      return {
        ...plain,
        isRead: !!readEntry,
        readAt: readEntry?.readAt || null,
      };
    });

    res.json({
      userId,
      userName: user.name,
      total: count,
      page,
      totalPages: Math.ceil(count / limit),
      logs,
    });
  } catch (err) {
    console.error("Error fetching admin notification logs:", err);
    res.status(500).json({ error: "خطأ أثناء جلب السجل" });
  }
});

module.exports = router;
