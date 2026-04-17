const express = require('express');
const router = express.Router();
const multer = require("multer");
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, "uploads/");
  },
  filename: function (req, file, cb) {
    const ext = file.originalname.split(".").pop();
    const uniqueSuffix = Date.now().toString() + Math.floor(Math.random() * 1000);
    cb(null, uniqueSuffix + "." + ext);
  }
});
const upload = multer({ storage });
const { User, UserCounter, Counter, Settings, CounterSale} = require("../models");
const { Op } = require("sequelize");
const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");
const { requireAdmin , authenticateTokenUser} = require("../middlewares/auth");


router.post("/counters", requireAdmin, upload.single("image"), async (req, res) => {
  const { type, points, price, isVisible, durationDays, name, image } = req.body;

  if (!["points", "gems"].includes(type)) {
    return res.status(400).json({ error: "type يجب أن يكون 'points' أو 'gems'" });
  }

  const parsedPoints = parseInt(String(points).replace(/,/g, "").trim(), 10);
  const parsedPrice = parseFloat(String(price).replace(/,/g, "").trim());
  const parsedDurationDays = parseInt(String(durationDays).trim(), 10);

  if (Number.isNaN(parsedPoints) || parsedPoints <= 0) {
    return res.status(400).json({ error: "قيمة points غير صحيحة" });
  }

  if (Number.isNaN(parsedPrice) || parsedPrice <= 0) {
    return res.status(400).json({ error: "قيمة price غير صحيحة" });
  }

  if (Number.isNaN(parsedDurationDays) || parsedDurationDays <= 0) {
    return res.status(400).json({ error: "قيمة durationDays غير صحيحة" });
  }

  try {
    const safeName = typeof name === "string" ? name.trim() : "";
    const safeImage = req.file?.filename
      || (typeof image === "string" ? image.trim() : "");
    const imageJson = safeImage.length > 0 ? [safeImage] : null;
    const counter = await Counter.create({
      type,
      points: parsedPoints,
      price: parsedPrice,
      durationDays: parsedDurationDays,
      isVisible: isVisible === "false" ? false : true,
      name: safeName.length > 0 ? safeName : null,
      image: imageJson,
    });

    return res.status(201).json({
      message: "Counter created successfully",
      counter,
    });
  } catch (err) {
    console.error("❌ Error creating counter:", err);
    return res.status(500).json({
      error: err?.message || "Internal Server Error",
    });
  }
});

router.get("/counters", async (req, res) => {
  try {
    const counters = await Counter.findAll({
      where: { isActive: true, isVisible: true },
      order: [["id", "ASC"]],
    });

    const durationSetting = await Settings.findOne({
      where: { key: "counter_duration_days", isActive: true },
    });
    const defaultDuration = durationSetting ? parseInt(durationSetting.value, 10) : 365;

    const result = counters.map((c) => {
      const counter = c.toJSON();
      const imageList = Array.isArray(counter.image) ? counter.image : null;
      const firstImage = imageList && imageList.length > 0 ? imageList[0] : null;
      return {
        ...counter,
        durationDays: counter.durationDays ?? defaultDuration,
        image: firstImage ?? counter.image,
      };
    });

    return res.status(200).json(result);
  } catch (err) {
    console.error("❌ Error fetching counters:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/assign-counter", authenticateTokenUser, upload.none(), async (req, res) => {
  const { counterId } = req.body;
  const userId = req.user.id;

  if (!counterId) {
    return res.status(400).json({ error: "يجب توفير counterId" });
  }

  try {
    const user = await User.findByPk(userId);
    if (!user) return res.status(404).json({ error: "المستخدم غير موجود" });

    const counter = await Counter.findByPk(counterId);
    if (!counter) return res.status(404).json({ error: "العداد غير موجود" });

    if (user.sawa < counter.price) {
      return res.status(400).json({ error: "رصيد sawa غير كافي لشراء هذا العداد" });
    }

    user.sawa -= counter.price;
    await user.save();

    let durationDays;
    if (counter.durationDays !== null && counter.durationDays !== undefined) {
      durationDays = counter.durationDays;
    } else {
      const durationSetting = await Settings.findOne({
        where: { key: "counter_duration_days", isActive: true },
      });
      durationDays = durationSetting ? parseInt(durationSetting.value) : 365;
    }

    const now = new Date();
    const endDate = new Date();
    endDate.setDate(endDate.getDate() + durationDays);

    const assign = await UserCounter.create({
      userId,
      counterId,
      points: counter.points,
      type: counter.type,
      price: counter.price,
      startDate: now,
      endDate,
      purchaseSource: "system",
    });

    res.status(201).json({
      message: `تم إضافة العداد للمستخدم لمدة ${durationDays} يوم`,
      assign,
      remainingSawa: user.sawa,
    });
  } catch (err) {
    console.error("❌ Error assigning counter:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

router.delete("/counters/:id", requireAdmin, async (req, res) => {
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

router.patch("/counters/:id/visibility", requireAdmin, upload.none(), async (req, res) => {
  const { id } = req.params;
  const visible = req.body?.visible;

  try {
    const counter = await Counter.findByPk(id);
    if (!counter) {
      return res.status(404).json({ error: "العداد غير موجود" });
    }

    if (visible !== undefined) {
      if (visible === "true" || visible === true) {
        counter.isVisible = true;
      } else if (visible === "false" || visible === false) {
        counter.isVisible = false;
      } else {
        return res.status(400).json({
          error: "visible يجب أن تكون true أو false"
        });
      }
    } else {
      counter.isVisible = !counter.isVisible;
    }

    await counter.save();

    return res.json({
      message: counter.isVisible ? "تم إظهار العداد ✅" : "تم إخفاء العداد ✅",
      isVisible: counter.isVisible,
      counter,
    });
  } catch (err) {
    console.error("❌ Error toggling counter visibility:", err);
    res.status(500).json({ error: "حدث خطأ أثناء تعديل رؤية العداد" });
  }
});

router.post("/counters/sell", authenticateTokenUser, upload.none(), async (req, res) => {
  const { userCounterId, price } = req.body;
  const userId = req.user.id;

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
      return res.status(400).json({ error: "لا يمكن عرض العداد للبيع إذا كانت نقاط العداد أقل من 10" });
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

router.patch("/counters/sell/:saleId/visibility/toggle", authenticateTokenUser, upload.none(), async (req, res) => {
    const { saleId } = req.params;

    try {
      const sale = await CounterSale.findByPk(saleId);

      if (!sale) {
        return res.status(404).json({ error: "العرض غير موجود" });
      }
      sale.isVisible = !sale.isVisible;
      await sale.save();
      return res.json({
        message: sale.isVisible
          ? "تم إظهار العرض ✅"
          : "تم إخفاء العرض ✅",
        isVisible: sale.isVisible,
        sale,
      });
    } catch (error) {
      console.error("❌ Error toggling visibility:", error);
      res.status(500).json({ error: "حدث خطأ أثناء تعديل حالة العرض" });
    }
  }
);

router.get("/counters/for-sale", async (req, res) => {
  try {

    const sales = await CounterSale.findAll({
      where: {
        isSold: false,
        isVisible: true, 
      },
      include: [
        {
          model: User,
          required: true,
        },
        {
          model: UserCounter,
          required: true, 
          include: [
            {
              model: Counter,
              required: true,
            },
          ],
        },
      ],
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

router.get("/counters/for-sale-admin", requireAdmin, async (req, res) => {
  try {

    const sales = await CounterSale.findAll({
      where: {
        isSold: false,
      },
      include: [
        {
          model: User,
          required: true,
        },
        {
          model: UserCounter,
          required: true, 
          include: [
            {
              model: Counter,
              required: true,
            },
          ],
        },
      ],
    });

    const salesWithDays = sales.map(sale => {
      const userCounter = sale.UserCounter;

      let remainingDays = null;
      if (userCounter && userCounter.endDate) {
        const now = new Date();
        const endDate = new Date(userCounter.endDate);
        const diffInMs = endDate - now;
        remainingDays = Math.max(0, Math.ceil(diffInMs / (1000 * 60 * 60 * 24)));
      }

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

router.delete("/counters/sell/:saleId", authenticateTokenUser, upload.none(), async (req, res) => {
  const { saleId } = req.params;
  const userId = req.user.id;

  try {
    const sale = await CounterSale.findOne({
      where: { id: saleId },
      include: [{
        model: UserCounter,
        where: { userId } 
      }],
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

router.post("/counters/buy", authenticateTokenUser, upload.none(), async (req, res) => {
  const { saleId } = req.body;
  const buyerId = req.user.id;

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
    userCounter.purchaseSource = "market";
    await userCounter.save();

    res.status(200).json({ message: "تم شراء العداد ونقله بنجاح", sale });

  } catch (error) {
    console.error("❌ Error buying counter:", error);
    res.status(500).json({ error: "خطأ أثناء شراء العداد" });
  }
});

router.get("/admin/fix-db-counter", requireAdmin, async (req, res) => {
  try {
    const queryInterface = sequelize.getQueryInterface();
    const tableDefinition = await queryInterface.describeTable("Counters");
    const addedColumns = [];

    if (!tableDefinition.durationDays) {
      await queryInterface.addColumn("Counters", "durationDays", {
        type: DataTypes.INTEGER,
        allowNull: true,
      });
      addedColumns.push("durationDays");
    }

    if (!tableDefinition.name) {
      await queryInterface.addColumn("Counters", "name", {
        type: DataTypes.STRING,
        allowNull: true,
      });
      addedColumns.push("name");
    }

    if (!tableDefinition.image) {
      await queryInterface.addColumn("Counters", "image", {
        type: DataTypes.JSON,
        allowNull: true,
        defaultValue: null,
      });
      addedColumns.push("image");
    }

    if (addedColumns.length === 0) {
      return res.json({ message: "⚠️ جميع أعمدة Counters موجودة مسبقًا" });
    }

    res.json({
      message: `✅ تم إصلاح جدول Counters وإضافة الأعمدة: ${addedColumns.join(", ")}`,
      addedColumns,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete("/admin/users/:userId/counters", requireAdmin, async (req, res) => {
  const { userId } = req.params;

  try {
    const user = await User.findByPk(userId);
    if (!user) {
      return res.status(404).json({ error: "المستخدم غير موجود" });
    }

    const deletedCount = await UserCounter.destroy({
      where: { userId }
    });

    return res.status(200).json({
      message: "تم حذف عدادات المستخدم بنجاح",
      deletedCount
    });
  } catch (err) {
    console.error("❌ Error deleting user's counters:", err);
    return res.status(500).json({ error: "حدث خطأ أثناء حذف عدادات المستخدم" });
  }
});

module.exports = router;
