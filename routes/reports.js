const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const upload = require("../middlewares/uploads");
const { authenticateTokenUser, requireAdmin } = require("../middlewares/auth");
const { User, UserReport, CommunityPost, Room, Message } = require("../models");

const router = express.Router();
const uploadsDir = path.resolve(process.cwd(), "uploads");
const ALLOWED_STATUSES = new Set(["pending", "reviewed", "resolved", "rejected"]);

function sanitizeText(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function parseOptionalInt(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizeStoredPath(filePath) {
  return String(filePath || "").replace(/\\/g, "/");
}

async function deleteUploadedFile(filePath) {
  if (!filePath) return;
  const normalizedPath = normalizeStoredPath(filePath);
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

function extractImage(images) {
  if (Array.isArray(images) && images.length > 0) {
    return String(images[0] || "").trim();
  }

  if (typeof images === "string" && images.trim().length > 0) {
    const normalized = images.trim();
    if (normalized.startsWith("[")) {
      try {
        const parsed = JSON.parse(normalized);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return String(parsed[0] || "").trim();
        }
      } catch (_) {}
    }
    return normalized;
  }

  return "";
}

function resolveSection(contextScope) {
  const scope = sanitizeText(contextScope).toLowerCase();
  if (scope.startsWith("community_")) return "community";
  if (scope.startsWith("room_")) return "rooms";
  return "general";
}

function serializeUser(user) {
  if (!user) return null;
  return {
    id: Number(user.id),
    name: user.name || "مستخدم",
    role: user.role || "user",
    image: extractImage(user.images),
  };
}

function serializeReport(report) {
  const plain = typeof report.toJSON === "function" ? report.toJSON() : report;
  return {
    id: Number(plain.id),
    section: plain.section || "general",
    contextScope: plain.contextScope || "general_profile",
    targetType: plain.targetType || "user",
    targetId: plain.targetId != null ? Number(plain.targetId) : null,
    roomId: plain.roomId != null ? Number(plain.roomId) : null,
    postId: plain.postId != null ? Number(plain.postId) : null,
    messageId: plain.messageId != null ? Number(plain.messageId) : null,
    reason: plain.reason || "",
    evidenceImage: plain.evidenceImage || "",
    status: plain.status || "pending",
    adminNote: plain.adminNote || "",
    createdAt: plain.createdAt,
    updatedAt: plain.updatedAt,
    reporter: serializeUser(plain.reporter),
    reportedUser: serializeUser(plain.reportedUser),
  };
}

async function buildReportIncludes() {
  return [
    {
      model: User,
      as: "reporter",
      attributes: ["id", "name", "images", "role"],
    },
    {
      model: User,
      as: "reportedUser",
      attributes: ["id", "name", "images", "role"],
      required: false,
    },
  ];
}

router.post(
  "/reports",
  authenticateTokenUser,
  upload.fields([{ name: "evidence", maxCount: 1 }]),
  async (req, res) => {
    const evidenceFile = req.files?.evidence?.[0] || null;

    try {
      if (evidenceFile && !String(evidenceFile.mimetype || "").startsWith("image/")) {
        await deleteUploadedFile(evidenceFile.path);
        return res.status(400).json({ error: "صورة المخالفة يجب أن تكون صورة فقط" });
      }

      const reason = sanitizeText(req.body.reason);
      if (reason.length < 5) {
        if (evidenceFile) await deleteUploadedFile(evidenceFile.path);
        return res.status(400).json({ error: "يرجى كتابة سبب واضح للإبلاغ" });
      }

      const reportedUserId = parseOptionalInt(req.body.reportedUserId);
      const targetId = parseOptionalInt(req.body.targetId);
      const roomId = parseOptionalInt(req.body.roomId);
      const postId = parseOptionalInt(req.body.postId);
      const messageId = parseOptionalInt(req.body.messageId);
      const contextScope = sanitizeText(req.body.contextScope) || "general_profile";
      const targetType = sanitizeText(req.body.targetType) || "user";

      if (reportedUserId != null && reportedUserId === Number(req.user.id)) {
        if (evidenceFile) await deleteUploadedFile(evidenceFile.path);
        return res.status(400).json({ error: "لا يمكنك الإبلاغ عن نفسك" });
      }

      if (reportedUserId != null) {
        const reportedUser = await User.findByPk(reportedUserId, {
          attributes: ["id"],
        });
        if (!reportedUser) {
          if (evidenceFile) await deleteUploadedFile(evidenceFile.path);
          return res.status(404).json({ error: "المستخدم المبلغ عليه غير موجود" });
        }
      }

      if (postId != null) {
        const post = await CommunityPost.findByPk(postId, { attributes: ["id"] });
        if (!post) {
          if (evidenceFile) await deleteUploadedFile(evidenceFile.path);
          return res.status(404).json({ error: "المنشور المطلوب غير موجود" });
        }
      }

      if (roomId != null) {
        const room = await Room.findByPk(roomId, { attributes: ["id"] });
        if (!room) {
          if (evidenceFile) await deleteUploadedFile(evidenceFile.path);
          return res.status(404).json({ error: "الغرفة المطلوبة غير موجودة" });
        }
      }

      if (messageId != null) {
        const message = await Message.findByPk(messageId, { attributes: ["id"] });
        if (!message) {
          if (evidenceFile) await deleteUploadedFile(evidenceFile.path);
          return res.status(404).json({ error: "الرسالة المطلوبة غير موجودة" });
        }
      }

      const createdReport = await UserReport.create({
        reporterId: Number(req.user.id),
        reportedUserId,
        section: resolveSection(contextScope),
        contextScope,
        targetType,
        targetId,
        roomId,
        postId,
        messageId,
        reason,
        evidenceImage: evidenceFile ? normalizeStoredPath(evidenceFile.path) : null,
      });

      const report = await UserReport.findByPk(createdReport.id, {
        include: await buildReportIncludes(),
      });

      return res.status(201).json({
        message: "تم إرسال البلاغ بنجاح",
        report: serializeReport(report),
      });
    } catch (error) {
      if (evidenceFile) {
        await deleteUploadedFile(evidenceFile.path).catch(() => {});
      }
      console.error("Error creating report:", error);
      return res.status(500).json({ error: "حدث خطأ أثناء إرسال البلاغ" });
    }
  }
);

router.get("/admin/reports", requireAdmin, async (req, res) => {
  try {
    const page = Math.max(parseOptionalInt(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(parseOptionalInt(req.query.limit) || 20, 1), 100);
    const offset = (page - 1) * limit;
    const section = sanitizeText(req.query.section).toLowerCase();
    const status = sanitizeText(req.query.status).toLowerCase();

    const where = {};
    if (["general", "community", "rooms"].includes(section)) {
      where.section = section;
    }
    if (ALLOWED_STATUSES.has(status)) {
      where.status = status;
    }

    const { count, rows } = await UserReport.findAndCountAll({
      where,
      include: await buildReportIncludes(),
      order: [["createdAt", "DESC"]],
      limit,
      offset,
    });

    const [generalCount, communityCount, roomsCount, pendingCount] = await Promise.all([
      UserReport.count({ where: { section: "general" } }),
      UserReport.count({ where: { section: "community" } }),
      UserReport.count({ where: { section: "rooms" } }),
      UserReport.count({ where: { status: "pending" } }),
    ]);

    return res.json({
      reports: rows.map(serializeReport),
      pagination: {
        page,
        limit,
        total: count,
        totalPages: Math.max(Math.ceil(count / limit), 1),
      },
      counts: {
        all: generalCount + communityCount + roomsCount,
        general: generalCount,
        community: communityCount,
        rooms: roomsCount,
        pending: pendingCount,
      },
    });
  } catch (error) {
    console.error("Error fetching admin reports:", error);
    return res.status(500).json({ error: "تعذر جلب البلاغات" });
  }
});

router.patch("/admin/reports/:reportId/status", requireAdmin, async (req, res) => {
  try {
    const reportId = parseOptionalInt(req.params.reportId);
    if (reportId == null) {
      return res.status(400).json({ error: "معرف البلاغ غير صالح" });
    }

    const status = sanitizeText(req.body.status).toLowerCase();
    const adminNote = sanitizeText(req.body.adminNote);

    if (!ALLOWED_STATUSES.has(status)) {
      return res.status(400).json({ error: "حالة البلاغ غير صالحة" });
    }

    const report = await UserReport.findByPk(reportId);
    if (!report) {
      return res.status(404).json({ error: "البلاغ غير موجود" });
    }

    report.status = status;
    report.adminNote = adminNote || null;
    await report.save();

    const refreshedReport = await UserReport.findByPk(report.id, {
      include: await buildReportIncludes(),
    });

    return res.json({
      message: "تم تحديث حالة البلاغ",
      report: serializeReport(refreshedReport),
    });
  } catch (error) {
    console.error("Error updating report status:", error);
    return res.status(500).json({ error: "تعذر تحديث حالة البلاغ" });
  }
});

module.exports = router;
