const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const { Op } = require("sequelize");
const upload = require("../middlewares/uploads");
const { requireAdmin, authenticateTokenUser } = require("../middlewares/auth");
const { EntryEffect, UserEntryEffect, User } = require("../models");

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

function serializeEntryEffect(effect, options = {}) {
  if (!effect) return null;
  const plain = typeof effect.toJSON === "function" ? effect.toJSON() : { ...effect };
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
  return UserEntryEffect.findOne({
    where: {
      userId,
      isActive: true,
      expiresAt: { [Op.gt]: new Date() },
    },
    include: [
      {
        model: EntryEffect,
        as: "effect",
        required: true,
      },
    ],
    order: [["expiresAt", "DESC"], ["updatedAt", "DESC"]],
  });
}

router.get("/entry-effects", requireAdmin, async (req, res) => {
  try {
    const includeInactive = String(req.query.includeInactive || "").trim() === "true";
    const effects = await EntryEffect.findAll({
      where: includeInactive ? {} : { isActive: true },
      order: [["createdAt", "DESC"]],
    });

    res.json(effects.map((effect) => serializeEntryEffect(effect)));
  } catch (error) {
    console.error("Error fetching entry effects:", error);
    res.status(500).json({ error: "خطأ في جلب مؤثرات الدخول" });
  }
});

router.post("/entry-effects", requireAdmin, upload.single("image"), async (req, res) => {
  try {
    if (!req.file || !isGifFile(req.file)) {
      if (req.file?.path) {
        await deleteUploadedFile(req.file.path);
      }
      return res.status(400).json({ error: "يجب رفع صورة GIF لمؤثر الدخول" });
    }

    const name = String(req.body.name || "").trim();
    const price = parsePositiveInteger(req.body.price);
    const durationHours = parsePositiveInteger(req.body.durationHours, 1);
    const isActive =
      req.body.isActive === undefined ? true : String(req.body.isActive).trim() !== "false";

    if (!name) {
      await deleteUploadedFile(req.file.path);
      return res.status(400).json({ error: "اسم المؤثر مطلوب" });
    }

    if (price == null || durationHours == null) {
      await deleteUploadedFile(req.file.path);
      return res.status(400).json({ error: "السعر أو المدة غير صالحين" });
    }

    const effect = await EntryEffect.create({
      name,
      image: normalizeStoredPath(req.file.path),
      price,
      durationHours,
      isActive,
    });

    res.status(201).json(serializeEntryEffect(effect));
  } catch (error) {
    console.error("Error creating entry effect:", error);
    res.status(500).json({ error: "خطأ في إنشاء مؤثر الدخول" });
  }
});

router.patch("/entry-effects/:id", requireAdmin, upload.single("image"), async (req, res) => {
  try {
    const effect = await EntryEffect.findByPk(req.params.id);
    if (!effect) {
      if (req.file?.path) {
        await deleteUploadedFile(req.file.path);
      }
      return res.status(404).json({ error: "مؤثر الدخول غير موجود" });
    }

    if (req.file && !isGifFile(req.file)) {
      await deleteUploadedFile(req.file.path);
      return res.status(400).json({ error: "يجب رفع صورة GIF لمؤثر الدخول" });
    }

    const nextName = req.body.name !== undefined ? String(req.body.name || "").trim() : effect.name;
    const nextPrice =
      req.body.price !== undefined ? parsePositiveInteger(req.body.price) : Number(effect.price);
    const nextDuration =
      req.body.durationHours !== undefined
        ? parsePositiveInteger(req.body.durationHours)
        : Number(effect.durationHours);

    if (!nextName) {
      if (req.file?.path) {
        await deleteUploadedFile(req.file.path);
      }
      return res.status(400).json({ error: "اسم المؤثر مطلوب" });
    }

    if (nextPrice == null || nextDuration == null) {
      if (req.file?.path) {
        await deleteUploadedFile(req.file.path);
      }
      return res.status(400).json({ error: "السعر أو المدة غير صالحين" });
    }

    const previousImage = effect.image;
    effect.name = nextName;
    effect.price = nextPrice;
    effect.durationHours = nextDuration;
    if (req.body.isActive !== undefined) {
      effect.isActive = String(req.body.isActive).trim() !== "false";
    }
    if (req.file?.path) {
      effect.image = normalizeStoredPath(req.file.path);
    }

    await effect.save();

    if (req.file?.path && previousImage && previousImage !== effect.image) {
      await deleteUploadedFile(previousImage);
    }

    res.json(serializeEntryEffect(effect));
  } catch (error) {
    console.error("Error updating entry effect:", error);
    res.status(500).json({ error: "خطأ في تحديث مؤثر الدخول" });
  }
});

router.delete("/entry-effects/:id", requireAdmin, async (req, res) => {
  try {
    const effect = await EntryEffect.findByPk(req.params.id);
    if (!effect) {
      return res.status(404).json({ error: "مؤثر الدخول غير موجود" });
    }

    const imagePath = effect.image;

    await UserEntryEffect.update(
      {
        isActive: false,
        expiresAt: new Date(),
      },
      {
        where: {
          effectId: effect.id,
          isActive: true,
        },
      }
    );

    await effect.destroy();
    await deleteUploadedFile(imagePath);

    res.json({ success: true });
  } catch (error) {
    console.error("Error deleting entry effect:", error);
    res.status(500).json({ error: "خطأ في حذف مؤثر الدخول" });
  }
});

router.get("/entry-effects/store", authenticateTokenUser, async (req, res) => {
  try {
    const activeSubscription = await getCurrentActiveSubscription(req.user.id);
    const effects = await EntryEffect.findAll({
      where: { isActive: true },
      order: [["price", "ASC"], ["createdAt", "DESC"]],
    });

    const activeEffectId = activeSubscription?.effectId ? Number(activeSubscription.effectId) : null;
    const payload = effects.map((effect) =>
      serializeEntryEffect(effect, {
        extra: {
          isCurrentActive: activeEffectId === effect.id,
          currentExpiresAt:
            activeEffectId === effect.id ? activeSubscription?.expiresAt ?? null : null,
        },
      })
    );

    res.json({
      effects: payload,
      activeEffectId,
      activeEffectExpiresAt: activeSubscription?.expiresAt ?? null,
    });
  } catch (error) {
    console.error("Error fetching entry effects store:", error);
    res.status(500).json({ error: "خطأ في جلب متجر مؤثرات الدخول" });
  }
});

router.post("/entry-effects/:id/buy", authenticateTokenUser, async (req, res) => {
  try {
    const effect = await EntryEffect.findOne({
      where: {
        id: Number(req.params.id),
        isActive: true,
      },
    });

    if (!effect) {
      return res.status(404).json({ error: "مؤثر الدخول غير متوفر" });
    }

    const user = await User.findByPk(req.user.id);
    if (!user) {
      return res.status(404).json({ error: "المستخدم غير موجود" });
    }

    const price = Number(effect.price || 0);
    const currentBalance = Number(user.sawa || 0);
    if (currentBalance < price) {
      return res.status(400).json({ error: "لا تملك نقاط كافية لشراء مؤثر الدخول" });
    }

    const now = new Date();
    const durationHours = Math.max(0, Number(effect.durationHours || 0));
    const extensionMs = durationHours * 60 * 60 * 1000;

    const existingSameEffect = await UserEntryEffect.findOne({
      where: {
        userId: user.id,
        effectId: effect.id,
        isActive: true,
        expiresAt: { [Op.gt]: now },
      },
      order: [["expiresAt", "DESC"]],
    });

    await UserEntryEffect.update(
      { isActive: false },
      {
        where: {
          userId: user.id,
          isActive: true,
          ...(existingSameEffect ? { id: { [Op.ne]: existingSameEffect.id } } : {}),
        },
      }
    );

    let subscription = existingSameEffect;
    if (subscription) {
      const baseTime = new Date(subscription.expiresAt).getTime();
      subscription.expiresAt = new Date(baseTime + extensionMs);
      await subscription.save();
    } else {
      subscription = await UserEntryEffect.create({
        userId: user.id,
        effectId: effect.id,
        activatedAt: now,
        expiresAt: new Date(now.getTime() + extensionMs),
        isActive: true,
      });
    }

    user.sawa = currentBalance - price;
    await user.save();

    res.json({
      success: true,
      message: "تم تفعيل مؤثر الدخول بنجاح",
      balance: Number(user.sawa || 0),
      effect: serializeEntryEffect(effect, {
        extra: {
          isCurrentActive: true,
          currentExpiresAt: subscription.expiresAt,
        },
      }),
    });
  } catch (error) {
    console.error("Error buying entry effect:", error);
    res.status(500).json({ error: "خطأ في شراء مؤثر الدخول" });
  }
});

module.exports = router;
