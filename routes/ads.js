const express = require("express");
const Ads = require("../models/ads");
const router = express.Router();
const upload = require("../middlewares/uploads");
const { sendNotificationToRole } = require("../services/notifications");
const { requireAdmin } = require("../middlewares/auth");

const ADS_CACHE_TTL_MS = 60 * 1000;
const adsCache = new Map();

function normalizePlacement(value) {
  if (value === "store") return "store";
  if (value === "counter") return "counter";
  return "home";
}

function buildAdsCacheKey(placement) {
  return placement ? `placement:${placement}` : "placement:all";
}

function getCachedAds(cacheKey) {
  const cached = adsCache.get(cacheKey);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    adsCache.delete(cacheKey);
    return null;
  }
  return cached.payload;
}

function setCachedAds(cacheKey, payload) {
  adsCache.set(cacheKey, {
    payload,
    expiresAt: Date.now() + ADS_CACHE_TTL_MS,
  });
}

function clearAdsCache() {
  adsCache.clear();
}

function respondWithAdsCacheHeaders(res) {
  res.setHeader("Cache-Control", "private, max-age=30");
}

async function fetchAdsByPlacement(placement) {
  const where = {};
  if (placement) {
    where.placement = placement;
  }

  return Ads.findAll({
    where,
    order: [["createdAt", "DESC"]],
  });
}

router.post("/ads", requireAdmin, upload.array("images", 5), async (req, res) => {
  try {
    const { name, description, placement } = req.body;

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "جميع الحقول مطلوبة" });
    }

    const normalizedPlacement = normalizePlacement(placement);
    const images = req.files.map((file) => file.filename);

    const ads = await Ads.create({
      images,
      title: name,
      description,
      placement: normalizedPlacement,
    });

    clearAdsCache();

    if (normalizedPlacement === "home") {
      await sendNotificationToRole("user", description, name);
    }

    res.status(201).json({ message: "ads created successfully", ads });
  } catch (err) {
    console.error("Error creating ads:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

router.get("/ads", async (req, res) => {
  try {
    const requestedPlacement = req.query.placement;
    const normalizedPlacement =
      requestedPlacement === "home" ||
      requestedPlacement === "store" ||
      requestedPlacement === "counter"
        ? requestedPlacement
        : null;

    const cacheKey = buildAdsCacheKey(normalizedPlacement);
    const cachedAds = getCachedAds(cacheKey);
    respondWithAdsCacheHeaders(res);

    if (cachedAds) {
      return res.json(cachedAds);
    }

    const ads = await fetchAdsByPlacement(normalizedPlacement);
    setCachedAds(cacheKey, ads);

    res.json(ads);
  } catch (err) {
    console.error("Error fetching ads:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

router.get("/ads/store", async (req, res) => {
  try {
    const cacheKey = buildAdsCacheKey("store");
    const cachedAds = getCachedAds(cacheKey);
    respondWithAdsCacheHeaders(res);
    if (cachedAds) {
      return res.json(cachedAds);
    }

    const ads = await fetchAdsByPlacement("store");
    setCachedAds(cacheKey, ads);
    res.json(ads);
  } catch (err) {
    console.error("Error fetching store ads:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

router.get("/ads/counter", async (req, res) => {
  try {
    const cacheKey = buildAdsCacheKey("counter");
    const cachedAds = getCachedAds(cacheKey);
    respondWithAdsCacheHeaders(res);
    if (cachedAds) {
      return res.json(cachedAds);
    }

    const ads = await fetchAdsByPlacement("counter");
    setCachedAds(cacheKey, ads);
    res.json(ads);
  } catch (err) {
    console.error("Error fetching counter ads:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

router.delete("/ads/:id", requireAdmin, async (req, res) => {
  const { id } = req.params;

  try {
    const ad = await Ads.findByPk(id);
    if (!ad) {
      return res.status(404).json({ error: "Ad not found" });
    }

    await ad.destroy();
    clearAdsCache();
    res.status(200).json({ message: "Ad deleted successfully" });
  } catch (err) {
    console.error("Error deleting ad:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

module.exports = router;
