const express = require('express');
const router = express.Router();
const multer = require("multer");
const upload = multer();
const Counter = require('../models/counter');
const User = require("../models/user");
const UserCounter = require("../models/usercounters");
const CounterSale = require("../models/counterSale");
const { Op } = require("sequelize");

router.post("/counters", upload.none(), async (req, res) => {
    const { type, points, price } = req.body;

    if (!["points", "gems"].includes(type)) {
        return res.status(400).json({ error: "type يجب أن يكون 'points' أو 'gems'" });
    }

    try {
        const counter = await Counter.create({ type, points, price });

        res.status(201).json({
            message: "Counter created successfully",
            counter
        });
    } catch (err) {
        console.error("❌ Error creating counter:", err);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

router.get("/counters", async (req, res) => {
    try {
        const counters = await Counter.findAll({
            where: {
                isActive: true
            }
        });
        res.status(200).json(counters);
    } catch (err) {
        console.error("❌ Error fetching counters:", err);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

router.post("/assign-counter", upload.none(), async (req, res) => {
  const { userId, counterId } = req.body;

  if (!userId || !counterId) {
    return res.status(400).json({ error: "يجب توفير userId, counterId" });
  }

  try {
    const user = await User.findByPk(userId);
    if (!user) return res.status(404).json({ error: "المستخدم غير موجود" });

    const counter = await Counter.findByPk(counterId);
    if (!counter) return res.status(404).json({ error: "العداد غير موجود" });

    if (user.sawa < counter.price) {
      return res.status(400).json({ error: "رصيد sawa غير كافي لشراء هذا العداد" });
    }
    
if (typeof user.sawa === "number" && !isNaN(user.sawa)) {
  user.sawa -= counter.price;
}    await user.save();

    const now = new Date();
    const oneYearLater = new Date();
    oneYearLater.setFullYear(oneYearLater.getFullYear() + 1);

    const assign = await UserCounter.create({
      userId,
      counterId,
      points: counter.points,
      type: counter.type,
      price: counter.price,
      startDate: now,
      endDate: oneYearLater
    });

    res.status(201).json({
      message: "تم إضافة العداد للمستخدم",
      assign,
      remainingSawa: user.sawa
    });

  } catch (err) {
    console.error("❌ Error assigning counter:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

router.delete("/counters/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const counter = await Counter.findByPk(id);
    if (!counter) {
      return res.status(404).json({ error: "العداد غير موجود" });
    }

    counter.isActive = false;
    await counter.save();

    res.status(200).json({ message: "تم تعطيل العداد بنجاح" });

  } catch (err) {
    console.error("❌ Error disabling counter:", err);
    res.status(500).json({ error: "حدث خطأ أثناء تعطيل العداد" });
  }
});

router.post("/counters/sell", upload.none(), async (req, res) => {
  const { userId, userCounterId, price } = req.body;

  try {
    const userCounter = await UserCounter.findOne({
      where: { id: userCounterId, userId },
      include: Counter
    });

    if (!userCounter) return res.status(404).json({ error: "العداد غير موجود" });

    if (userCounter.isForSale) {
      return res.status(400).json({ error: "العداد معروض للبيع بالفعل" });
    }

  if (userCounter.points < 10) {
      return res.status(400).json({ error: "لا يمكن عرض العداد للبيع إذا كانت النقاط أقل من 10" });
    }
    
    const originalPoints = userCounter.points; 
    const pointsAfterCut = Math.floor(originalPoints * 0.9);

    const sale = await CounterSale.create({
      userId,
      userCounterId,
      originalPoints,
      pointsAfterCut,
      price
    });

    userCounter.isForSale = true;
    await userCounter.save();

    res.status(201).json({
      message: "تم عرض العداد للبيع بنجاح",
      sale
    });

  } catch (err) {
    console.error("❌ Error offering counter for sale:", err);
    res.status(500).json({ error: "خطأ أثناء عرض العداد للبيع" });
  }
});

router.get("/counters/for-sale", async (req, res) => {
  try {
    const sales = await CounterSale.findAll({
      where: { isSold: false },
      include: [
        { model: User, attributes: ['id', 'name'] },
        { 
          model: UserCounter, 
          include: [Counter] 
        }
      ]
    });

    // نحسب عدد الأيام المتبقية لكل عداد
    const salesWithDays = sales.map(sale => {
      const userCounter = sale.UserCounter;

      let remainingDays = null;
      if (userCounter && userCounter.endDate) {
        const now = new Date();
        const endDate = new Date(userCounter.endDate);
        const diffInMs = endDate - now;
        remainingDays = Math.max(0, Math.ceil(diffInMs / (1000 * 60 * 60 * 24)));
      }

      // نرجع البيانات مع الأيام
      return {
        ...sale.toJSON(),
        remainingDays
      };
    });

    res.status(200).json(salesWithDays);

  } catch (err) {
    console.error("❌ Error fetching counters for sale:", err);
    res.status(500).json({ error: "حدث خطأ أثناء جلب العروض" });
  }
});

router.post("/fix-usercounters", async (req, res) => {
  try {
    // جيب كل UserCounters
    const userCounters = await UserCounter.findAll();

    let updatedCount = 0;

    for (const userCounter of userCounters) {
      // جيب بيانات العداد الأصلي
      const counter = await Counter.findByPk(userCounter.counterId);
      if (counter) {
        // حدث بيانات العداد عند المستخدم
        await userCounter.update({
          points: counter.points,
          type: counter.type,
          price: counter.price
        });
        updatedCount++;
      }
    }

    res.status(200).json({ 
      message: `تم تحديث ${updatedCount} عداد بنجاح`
    });

  } catch (err) {
    console.error("❌ Error fixing UserCounters:", err);
    res.status(500).json({ error: "حدث خطأ أثناء تصحيح العدادات" });
  }
});

router.delete("/counters/sell/:saleId", upload.none(), async (req, res) => {
  const { saleId } = req.params;
  const { userId } = req.body;

  try {
    const sale = await CounterSale.findOne({
      where: { id: saleId, userId },
      include: [{ model: UserCounter }],
    });

    if (!sale) {
      return res.status(404).json({ error: "العرض غير موجود أو ليس من حقك حذفه" });
    }

    await UserCounter.update(
      {
        isForSale: false,
        points: sale.pointsAfterCut,
      },
      { where: { id: sale.userCounterId } }
    );

    await sale.destroy();

    return res.status(200).json({ message: "تم حذف العرض بنجاح" });
  } catch (error) {
    console.error("❌ Error deleting counter sale:", error);
    res.status(500).json({ error: "حدث خطأ أثناء حذف العرض" });
  }
});

router.post("/counters/buy", upload.none(), async (req, res) => {
  const { saleId, buyerId } = req.body;

  try {
    const sale = await CounterSale.findOne({
      where: { id: saleId, isSold: false },
      include: [{ model: UserCounter }]
    });

    if (!sale) {
      return res.status(404).json({ error: "العرض غير موجود أو تم بيعه" });
    }

    const userCounter = sale.UserCounter;

    if (!userCounter) {
      return res.status(404).json({ error: "العداد المرتبط بهذا العرض غير موجود" });
    }

    const seller = await User.findByPk(sale.userId);
    const buyer = await User.findByPk(buyerId);

    if (!buyer) {
      return res.status(404).json({ error: "المشتري غير موجود" });
    }
    if (!seller) {
      return res.status(404).json({ error: "البائع غير موجود" });
    }

    if (buyer.sawa < sale.price) {
      return res.status(400).json({ error: "رصيد المشتري غير كافٍ لإتمام الشراء" });
    }

    buyer.sawa -= sale.price;
    seller.sawa += sale.price;

    await buyer.save();
    await seller.save();

    sale.isSold = true;
    await sale.save();

    userCounter.userId = buyerId;
    userCounter.points = sale.pointsAfterCut;
    userCounter.isForSale = false;
    await userCounter.save();

    res.status(200).json({ message: "تم شراء العداد ونقله بنجاح", sale });

  } catch (error) {
    console.error("❌ Error buying counter:", error);
    res.status(500).json({ error: "خطأ أثناء شراء العداد" });
  }
});


module.exports = router;