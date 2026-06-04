const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const { Op } = require("sequelize");
const upload = require("../middlewares/uploads");
const { requireAdmin, authenticateTokenUser } = require("../middlewares/auth");
const { PremiumFrame, UserPremiumFrame, User } = require("../models");
const { refreshConnectedUserFrame } = require("../socket/socketHandler");

const router = express.Router();
const uploadsDir = path.resolve(process.cwd(), "uploads");

function normalizeStoredPath(filePath) {
  return String(filePath || "").replace(/\\/g, "/");
}

function isGifFile(file) {
  if (!file) return false;
  const ext = path.extname(file.originalname || file.filename || "").toLowerCase();
  return file.mimetype === "image/gif" || ext === ".gif";
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

function parsePositiveInteger(value, fallback = null) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return null;
  }

  return parsed;
}

function serializeFrame(frame, options = {}) {
  if (!frame) return null;
  const plain = typeof frame.toJSON === "function" ? frame.toJSON() : { ...frame };
  const activeSubscription = plain.activeSubscription || null;

  return {
    id: plain.id,
    name: plain.name,
    image: normalizeStoredPath(plain.image),
    price: Number(plain.price || 0),
    durationHours: Number(plain.durationHours || 0),
    isActive: Boolean(plain.isActive),
    createdAt: plain.createdAt,
    updatedAt: plain.updatedAt,
    isOwnedActive: Boolean(activeSubscription),
    activeSubscription: activeSubscription
      ? {
          id: activeSubscription.id,
          activatedAt: activeSubscription.activatedAt,
          expiresAt: activeSubscription.expiresAt,
        }
      : null,
    remainingSeconds: activeSubscription?.expiresAt
      ? Math.max(
          0,
          Math.floor((new Date(activeSubscription.expiresAt).getTime() - Date.now()) / 1000)
        )
      : 0,
    ...options.extra,
  };
}

async function getCurrentActiveSubscription(userId) {
  return UserPremiumFrame.findOne({
    where: {
      userId,
      isActive: true,
      expiresAt: { [Op.gt]: new Date() },
    },
    include: [
      {
        model: PremiumFrame,
        as: "frame",
        required: true,
      },
    ],
    order: [["expiresAt", "DESC"], ["updatedAt", "DESC"]],
  });
}

async function refreshSubscribersForUsers(io, userIds) {
  if (!io || !Array.isArray(userIds) || userIds.length === 0) return;
  for (const userId of Array.from(new Set(userIds.map((value) => Number(value)).filter(Boolean)))) {
    await refreshConnectedUserFrame(io, userId);
  }
}

router.get("/premium-frames", requireAdmin, async (req, res) => {
  try {
    const includeInactive = String(req.query.includeInactive || "").trim() === "true";
    const frames = await PremiumFrame.findAll({
      where: includeInactive ? {} : { isActive: true },
      order: [["createdAt", "DESC"]],
    });

    res.json(frames.map((frame) => serializeFrame(frame)));
  } catch (error) {
    console.error("Error fetching premium frames:", error);
    res.status(500).json({ error: "خطأ في جلب الإطارات" });
  }
});

router.post("/premium-frames", requireAdmin, upload.single("image"), async (req, res) => {
  try {
    if (!req.file || !isGifFile(req.file)) {
      if (req.file?.path) {
        await deleteUploadedFile(req.file.path);
      }
      return res.status(400).json({ error: "يجب رفع صورة GIF للإطار" });
    }

    const name = String(req.body.name || "").trim();
    const price = parsePositiveInteger(req.body.price);
    const durationHours = parsePositiveInteger(req.body.durationHours);
    const isActive =
      req.body.isActive === undefined ? true : String(req.body.isActive).trim() !== "false";

    if (!name) {
      await deleteUploadedFile(req.file.path);
      return res.status(400).json({ error: "اسم الإطار مطلوب" });
    }

    if (price == null || durationHours == null) {
      await deleteUploadedFile(req.file.path);
      return res.status(400).json({ error: "السعر أو المدة غير صالحين" });
    }

    const frame = await PremiumFrame.create({
      name,
      image: normalizeStoredPath(req.file.path),
      price,
      durationHours,
      isActive,
    });

    res.status(201).json(serializeFrame(frame));
  } catch (error) {
    console.error("Error creating premium frame:", error);
    res.status(500).json({ error: "خطأ في إنشاء الإطار" });
  }
});

router.patch("/premium-frames/:id", requireAdmin, upload.single("image"), async (req, res) => {
  try {
    const frame = await PremiumFrame.findByPk(req.params.id);
    if (!frame) {
      if (req.file?.path) {
        await deleteUploadedFile(req.file.path);
      }
      return res.status(404).json({ error: "الإطار غير موجود" });
    }

    if (req.file && !isGifFile(req.file)) {
      await deleteUploadedFile(req.file.path);
      return res.status(400).json({ error: "يجب رفع صورة GIF للإطار" });
    }

    const nextName = req.body.name !== undefined ? String(req.body.name || "").trim() : frame.name;
    const nextPrice =
      req.body.price !== undefined ? parsePositiveInteger(req.body.price) : Number(frame.price);
    const nextDuration =
      req.body.durationHours !== undefined
        ? parsePositiveInteger(req.body.durationHours)
        : Number(frame.durationHours);

    if (!nextName) {
      if (req.file?.path) {
        await deleteUploadedFile(req.file.path);
      }
      return res.status(400).json({ error: "اسم الإطار مطلوب" });
    }

    if (nextPrice == null || nextDuration == null) {
      if (req.file?.path) {
        await deleteUploadedFile(req.file.path);
      }
      return res.status(400).json({ error: "السعر أو المدة غير صالحين" });
    }

    const previousImage = frame.image;
    frame.name = nextName;
    frame.price = nextPrice;
    frame.durationHours = nextDuration;
    if (req.body.isActive !== undefined) {
      frame.isActive = String(req.body.isActive).trim() !== "false";
    }
    if (req.file?.path) {
      frame.image = normalizeStoredPath(req.file.path);
    }

    await frame.save();

    if (req.file?.path && previousImage && previousImage !== frame.image) {
      await deleteUploadedFile(previousImage);
    }

    const subscriberIds = (
      await UserPremiumFrame.findAll({
        where: {
          frameId: frame.id,
          isActive: true,
        },
        attributes: ["userId"],
      })
    ).map((item) => item.userId);

    await refreshSubscribersForUsers(req.app.get("roomsIO"), subscriberIds);

    res.json(serializeFrame(frame));
  } catch (error) {
    console.error("Error updating premium frame:", error);
    res.status(500).json({ error: "خطأ في تحديث الإطار" });
  }
});

router.delete("/premium-frames/:id", requireAdmin, async (req, res) => {
  try {
    const frame = await PremiumFrame.findByPk(req.params.id);
    if (!frame) {
      return res.status(404).json({ error: "الإطار غير موجود" });
    }

    const imagePath = frame.image;

    const subscriberIds = (
      await UserPremiumFrame.findAll({
        where: {
          frameId: frame.id,
        },
        attributes: ["userId"],
      })
    ).map((item) => item.userId);

    await UserPremiumFrame.update(
      {
        isActive: false,
        expiresAt: new Date(),
      },
      {
        where: {
          frameId: frame.id,
          isActive: true,
        },
      }
    );

    await frame.destroy();
    await deleteUploadedFile(imagePath);
    await refreshSubscribersForUsers(req.app.get("roomsIO"), subscriberIds);

    res.json({ success: true });
  } catch (error) {
    console.error("Error deleting premium frame:", error);
    res.status(500).json({ error: "خطأ في حذف الإطار" });
  }
});

router.get("/premium-frames/store", authenticateTokenUser, async (req, res) => {
  try {
    const activeSubscription = await getCurrentActiveSubscription(req.user.id);
    const frames = await PremiumFrame.findAll({
      where: { isActive: true },
      order: [["price", "ASC"], ["createdAt", "DESC"]],
    });

    const activeFrameId = activeSubscription?.frameId ? Number(activeSubscription.frameId) : null;
    const payload = frames.map((frame) =>
      serializeFrame(frame, {
        extra: {
          isCurrentActive: activeFrameId === frame.id,
          currentExpiresAt:
            activeFrameId === frame.id ? activeSubscription?.expiresAt ?? null : null,
        },
      })
    );

    res.json({
      frames: payload,
      activeFrameId,
      activeFrameExpiresAt: activeSubscription?.expiresAt ?? null,
    });
  } catch (error) {
    console.error("Error fetching premium frame store:", error);
    res.status(500).json({ error: "خطأ في جلب متجر الإطارات" });
  }
});

router.post("/premium-frames/:id/buy", authenticateTokenUser, async (req, res) => {
  try {
    const frame = await PremiumFrame.findOne({
      where: {
        id: Number(req.params.id),
        isActive: true,
      },
    });

    if (!frame) {
      return res.status(404).json({ error: "الإطار غير متوفر" });
    }

    const user = await User.findByPk(req.user.id);
    if (!user) {
      return res.status(404).json({ error: "المستخدم غير موجود" });
    }

    const price = Number(frame.price || 0);
    const currentBalance = Number(user.sawa || 0);
    if (currentBalance < price) {
      return res.status(400).json({ error: "لا تملك نقاط كافية لشراء الإطار" });
    }

    const now = new Date();
    const durationHours = Math.max(0, Number(frame.durationHours || 0));
    const extensionMs = durationHours * 60 * 60 * 1000;

    const existingSameFrame = await UserPremiumFrame.findOne({
      where: {
        userId: user.id,
        frameId: frame.id,
        isActive: true,
        expiresAt: { [Op.gt]: now },
      },
      order: [["expiresAt", "DESC"]],
    });

    await UserPremiumFrame.update(
      { isActive: false },
      {
        where: {
          userId: user.id,
          isActive: true,
          ...(existingSameFrame ? { id: { [Op.ne]: existingSameFrame.id } } : {}),
        },
      }
    );

    let subscription = existingSameFrame;
    if (subscription) {
      const baseTime = new Date(subscription.expiresAt).getTime();
      subscription.expiresAt = new Date(baseTime + extensionMs);
      await subscription.save();
    } else {
      subscription = await UserPremiumFrame.create({
        userId: user.id,
        frameId: frame.id,
        activatedAt: now,
        expiresAt: new Date(now.getTime() + extensionMs),
        isActive: true,
      });
    }

    user.sawa = currentBalance - price;
    await user.save();

    const roomsIO = req.app.get("roomsIO");
    const normalizedUser = await refreshConnectedUserFrame(roomsIO, user.id);

    res.json({
      success: true,
      message: "تم تفعيل الإطار بنجاح",
      balance: Number(user.sawa || 0),
      frame: serializeFrame(frame, {
        extra: {
          isCurrentActive: true,
          currentExpiresAt: subscription.expiresAt,
        },
      }),
      activeFrame: normalizedUser?.activeFrame ?? null,
    });
  } catch (error) {
    console.error("Error buying premium frame:", error);
    res.status(500).json({ error: "خطأ في شراء الإطار" });
  }
});

module.exports = router;
