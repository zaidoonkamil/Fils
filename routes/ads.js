const express = require("express");
const Ads = require("../models/ads");
const router = express.Router();
const upload = require("../middlewares/uploads");
const { sendNotificationToRole } = require("../services/notifications");
const { requireAdmin } = require("../middlewares/auth");

function normalizePlacement(value) {
  if (value === "store") return "store";
  if (value === "counter") return "counter";
  return "home";
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
    const where = {};

    if (
      requestedPlacement === "home" ||
      requestedPlacement === "store" ||
      requestedPlacement === "counter"
    ) {
      where.placement = requestedPlacement;
    }

    const ads = await Ads.findAll({
      where,
      order: [["createdAt", "DESC"]],
    });

    res.json(ads);
  } catch (err) {
    console.error("Error fetching ads:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

router.get("/ads/store", async (req, res) => {
  try {
    const ads = await Ads.findAll({
      where: { placement: "store" },
      order: [["createdAt", "DESC"]],
    });
    res.json(ads);
  } catch (err) {
    console.error("Error fetching store ads:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

router.get("/ads/counter", async (req, res) => {
  try {
    const ads = await Ads.findAll({
      where: { placement: "counter" },
      order: [["createdAt", "DESC"]],
    });
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
    res.status(200).json({ message: "Ad deleted successfully" });
  } catch (err) {
    console.error("Error deleting ad:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

module.exports = router;
