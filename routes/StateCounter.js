const express = require("express");
const router = express.Router();
const { Counter, UserCounter } = require("../models");
const { Sequelize } = require("sequelize");
const sequelize = require("../config/db"); 

router.get("/admin/counters/stats", async (req, res) => {
  try {
    const now = new Date();

    const counters = await Counter.findAll({
      where: { isActive: true },
      attributes: [
        "id",
        "type",
        "points",
        "price",

        [Sequelize.fn("COUNT", Sequelize.col("UserCounters.id")), "subscribersCount"],

        [
          Sequelize.fn(
            "SUM",
            Sequelize.literal(`CASE WHEN UserCounters.endDate > ${sequelize.escape(now)} THEN 1 ELSE 0 END`)
          ),
          "activeSubscribersCount",
        ],

        [
          Sequelize.fn(
            "SUM",
            Sequelize.literal(`CASE WHEN UserCounters.endDate <= ${sequelize.escape(now)} THEN 1 ELSE 0 END`)
          ),
          "expiredSubscribersCount",
        ],

        [
          Sequelize.fn(
            "MIN",
            Sequelize.literal(
              `CASE WHEN UserCounters.endDate > ${sequelize.escape(now)} THEN DATEDIFF(UserCounters.endDate, NOW()) ELSE NULL END`
            )
          ),
          "minRemainingDays",
        ],

        [
          Sequelize.fn(
            "MAX",
            Sequelize.literal(
              `CASE WHEN UserCounters.endDate > ${sequelize.escape(now)} THEN DATEDIFF(UserCounters.endDate, NOW()) ELSE NULL END`
            )
          ),
          "maxRemainingDays",
        ],

        [
          Sequelize.fn(
            "AVG",
            Sequelize.literal(
              `CASE WHEN UserCounters.endDate > ${sequelize.escape(now)} THEN DATEDIFF(UserCounters.endDate, NOW()) ELSE NULL END`
            )
          ),
          "avgRemainingDays",
        ],

        [
          Sequelize.fn(
            "SUM",
            Sequelize.literal("CASE WHEN UserCounters.isForSale = 1 THEN 1 ELSE 0 END")
          ),
          "forSaleCount",
        ],

        [
          Sequelize.fn("COALESCE", Sequelize.fn("SUM", Sequelize.col("UserCounters.price")), 0),
          "totalRevenue",
        ],
      ],
      include: [
        {
          model: UserCounter,
          attributes: [],
          required: false,
        },
      ],
      group: ["Counter.id"],
      order: [["id", "ASC"]],
      subQuery: false,
    });

    const result = counters.map((c) => {
      const j = c.toJSON();

      return {
        id: j.id,
        type: j.type,
        points: j.points,
        price: j.price,

        subscribersCount: Number(j.subscribersCount || 0),
        activeSubscribersCount: Number(j.activeSubscribersCount || 0),
        expiredSubscribersCount: Number(j.expiredSubscribersCount || 0),

        minRemainingDays: j.minRemainingDays === null ? null : Math.max(0, Number(j.minRemainingDays)),
        maxRemainingDays: j.maxRemainingDays === null ? null : Math.max(0, Number(j.maxRemainingDays)),
        avgRemainingDays: j.avgRemainingDays === null ? null : Number(Number(j.avgRemainingDays).toFixed(2)),

        forSaleCount: Number(j.forSaleCount || 0),
        totalRevenue: Number(j.totalRevenue || 0),
      };
    });

    return res.status(200).json(result);
  } catch (err) {
    console.error("❌ Error counters stats:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

module.exports = router;
