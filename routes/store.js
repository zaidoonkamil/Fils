const express = require('express');
const router = express.Router();
const upload = require("../middlewares/uploads");
const sequelize = require("../config/db");
const { StoreCategory, DigitalProduct, ProductPurchase, User, DigitalProductCode } = require("../models");
const { sendNotificationToUser } = require("../services/notifications");

// ==================== أقسام المتجر ====================

// إضافة قسم جديد (Admin فقط)
router.post("/store/categories", upload.single("image"), async (req, res) => {
  try {
    const { name, description } = req.body;

    if (!name) {
      return res.status(400).json({ error: "اسم الفئة مطلوب" });
    }

    const category = await StoreCategory.create({
      name,
      description,
      image: req.file ? req.file.filename : null,
    });

    res.status(201).json({
      message: "تم إنشاء الفئة بنجاح",
      category,
    });
  } catch (error) {
    console.error("❌ خطأ في إنشاء الفئة:", error);
    res.status(500).json({ error: "حدث خطأ في الخادم" });
  }
});

// الحصول على جميع الأقسام
router.get("/store/categories", async (req, res) => {
  try {
    const categories = await StoreCategory.findAll({
      where: { isActive: true },
      order: [["createdAt", "DESC"]],
    });

    res.status(200).json({
      success: true,
      categories,
    });
  } catch (error) {
    console.error("❌ خطأ في جلب الأقسام:", error);
    res.status(500).json({ error: "حدث خطأ في الخادم" });
  }
});

// تحديث قسم (Admin فقط)
router.put("/store/categories/:id", upload.single("image"), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, isActive } = req.body;

    const category = await StoreCategory.findByPk(id);
    if (!category) {
      return res.status(404).json({ error: "الفئة غير موجودة" });
    }

    category.name = name || category.name;
    category.description = description || category.description;
    if (req.file) category.image = req.file.filename;
    if (isActive !== undefined) category.isActive = isActive;

    await category.save();

    res.status(200).json({
      message: "تم تحديث الفئة بنجاح",
      category,
    });
  } catch (error) {
    console.error("❌ خطأ في تحديث الفئة:", error);
    res.status(500).json({ error: "حدث خطأ في الخادم" });
  }
});

// حذف قسم (Admin فقط)

router.delete("/store/categories/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const category = await StoreCategory.findByPk(id);
    if (!category) {
      return res.status(404).json({ error: "الفئة غير موجودة" });
    }

    await category.destroy();

    res.status(200).json({ message: "تم حذف الفئة بنجاح" });
  } catch (error) {
    console.error("❌ خطأ في حذف الفئة:", error);
    res.status(500).json({ error: "حدث خطأ في الخادم" });
  }
});

// ==================== المنتجات الرقمية ====================

// إضافة منتج رقمي جديد (Admin فقط)
router.post("/store/products", upload.array("images", 5), async (req, res) => {
  try {
    const { categoryId, title, description, price, codes } = req.body;

    if (!categoryId || !title || !price) {
      return res.status(400).json({
        error: "الحقول المطلوبة: categoryId, title, price",
      });
    }

    const category = await StoreCategory.findByPk(categoryId);
    if (!category) {
      return res.status(404).json({ error: "الفئة غير موجودة" });
    }

    const images = req.files ? req.files.map(file => file.filename) : [];

    const product = await DigitalProduct.create({
      categoryId,
      title,
      description,
      price: parseFloat(price),
      images,
      stock: 0,
    });

    let codesArr = [];

    if (codes) {
      codesArr = String(codes)
        .split(/\r?\n|,|;/)
        .map(c => c.trim().replace(/^"|"$/g, "")) 
        .filter(Boolean);
    }

    const duplicateInside = codesArr.filter(
      (c, i) => codesArr.indexOf(c) !== i
    );

    if (duplicateInside.length > 0) {
      return res.status(400).json({
        error: "الأكواد تحتوي تكرار داخل نفس القائمة",
        duplicatedCodes: [...new Set(duplicateInside)],
      });
    }

    if (codesArr.length > 0) {
      const existedCodes = await DigitalProductCode.findAll({
        where: { code: codesArr },
        attributes: ["code"],
      });

      if (existedCodes.length > 0) {
        return res.status(400).json({
          error: "بعض الأكواد موجودة مسبقًا في قاعدة البيانات",
          duplicatedCodes: existedCodes.map(c => c.code),
        });
      }
    }

    if (codesArr.length > 0) {
      const entries = codesArr.map(code => ({
        productId: product.id,
        code
      }));

      await DigitalProductCode.bulkCreate(entries);

      await product.update({ stock: codesArr.length });
    }

    const freshProduct = await DigitalProduct.findByPk(product.id, {
      include: [
        {
          model: DigitalProductCode,
          as: "codes",
          attributes: ["id", "code", "used"],
        },
      ],
    });

    res.status(201).json({
      message: "تم إنشاء المنتج بنجاح",
      product: freshProduct,
    });

  } catch (error) {
    console.error("❌ خطأ في إنشاء المنتج:", error);
    res.status(500).json({ error: "حدث خطأ في السيرفر" });
  }
});

router.post("/store/products/:id/add-codes", upload.none(), async (req, res) => {
  try {
    const { id } = req.params;
    const { codes } = req.body;

    const product = await DigitalProduct.findByPk(id);
    if (!product) {
      return res.status(404).json({ error: "المنتج غير موجود" });
    }

    if (!codes) {
      return res.status(400).json({ error: "حقل codes مطلوب" });
    }

    let codesArr = [];

    if (Array.isArray(codes)) {
      codesArr = codes;
    } else {
      codesArr = String(codes)
        .split(/\r?\n|,|;/)
        .map((c) => c.trim())
        .filter(Boolean);
    }

    if (codesArr.length === 0) {
      return res.status(400).json({ error: "لا توجد أكواد صالحة" });
    }

    const duplicatesInsideList = codesArr.filter((item, index) => codesArr.indexOf(item) !== index);

    if (duplicatesInsideList.length > 0) {
      return res.status(400).json({
        error: "الأكواد تحتوي تكرار داخل نفس القائمة",
        duplicatedCodes: [...new Set(duplicatesInsideList)],
      });
    }

    const existedCodes = await DigitalProductCode.findAll({
      where: { code: codesArr },
      attributes: ["code"],
    });

    if (existedCodes.length > 0) {
      return res.status(400).json({
        error: "بعض الأكواد موجودة مسبقاً في القاعدة",
        duplicatedCodes: existedCodes.map((c) => c.code),
      });
    }

    const entries = codesArr.map((code) => ({
      productId: id,
      code,
    }));

    await DigitalProductCode.bulkCreate(entries);

    const remaining = await DigitalProductCode.count({
      where: { productId: id, used: false },
    });

    await DigitalProduct.update({ stock: remaining }, { where: { id } });

    res.status(201).json({
      success: true,
      message: "تمت إضافة الأكواد بنجاح",
      added: codesArr.length,
      newStock: remaining,
    });

  } catch (error) {
    console.error("❌ خطأ أثناء إضافة الأكواد:", error);
    res.status(500).json({ error: "حدث خطأ في الخادم" });
  }
});

// الحصول على منتجات قسم معين
router.get("/store/categories/:categoryId/products", async (req, res) => {
  try {
    const { categoryId } = req.params;

    const category = await StoreCategory.findByPk(categoryId);
    if (!category) {
      return res.status(404).json({ error: "الفئة غير موجودة" });
    }

    const products = await DigitalProduct.findAll({
      where: {
        categoryId,
        isActive: true,
      },
      include: [
        {
          model: require("../models").DigitalProductCode,
          as: "codes",
          attributes: ["id", "code", "used", "usedBy", "usedAt"],
          required: false,
        },
      ],
      order: [["createdAt", "DESC"]],
    });

    const productsWithStock = await Promise.all(products.map(async (product) => {
      const unusedCodesCount = await require("../models").DigitalProductCode.count({
        where: { productId: product.id, used: false }
      });
      product.stock = unusedCodesCount;
      return product;
    }));

    res.status(200).json({
      success: true,
      categoryName: category.name,
      products: productsWithStock,
    });

  } catch (error) {
    console.error("❌ خطأ في جلب المنتجات:", error);
    res.status(500).json({ error: "حدث خطأ في الخادم" });
  }
});

// حذف منتج (Admin فقط)
router.delete("/store/products/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const product = await DigitalProduct.findByPk(id);
    if (!product) {
      return res.status(404).json({ error: "المنتج غير موجود" });
    }

    await product.destroy();

    res.status(200).json({ message: "تم حذف المنتج بنجاح" });
  } catch (error) {
    console.error("❌ خطأ في حذف المنتج:", error);
    res.status(500).json({ error: "حدث خطأ في الخادم" });
  }
});

// ==================== عملية الشراء ====================

// شراء منتج رقمي
router.post("/store/buy-product", upload.none(), async (req, res) => {
  try {
    const { userId, productId } = req.body;

    if (!userId || !productId) {
      return res.status(400).json({ error: "userId و productId مطلوبة" });
    }

    const user = await User.findByPk(userId);
    if (!user) return res.status(404).json({ error: "المستخدم غير موجود" });

    const product = await DigitalProduct.findByPk(productId);
    if (!product) return res.status(404).json({ error: "المنتج غير موجود" });

    if (product.stock <= 0) {
      return res.status(400).json({ error: "المنتج غير متوفر حالياً" });
    }

    const result = await sequelize.transaction(async (t) => {
      const prod = await DigitalProduct.findByPk(productId, { transaction: t });
      if (!prod) throw new Error("المنتج غير موجود أثناء المعاملة");

      if (prod.stock <= 0) throw new Error("المنتج غير متوفر حالياً");

      if (user.sawa < prod.price) throw new Error("رصيد المستخدم غير كافي");

      const codeRow = await DigitalProductCode.findOne({
        where: { productId: prod.id, used: false },
        transaction: t,
      });

      if (!codeRow) throw new Error("لا توجد أكواد متاحة حالياً");

      user.sawa -= prod.price;
      await user.save({ transaction: t });

      codeRow.used = true;
      codeRow.usedBy = userId;
      codeRow.usedAt = new Date();
      await codeRow.save({ transaction: t });

      const remaining = await DigitalProductCode.count({
        where: { productId: prod.id, used: false },
        transaction: t
      });

      await DigitalProduct.update(
        { stock: remaining },
        { where: { id: prod.id }, transaction: t }
      );

      const purchase = await ProductPurchase.create({
        userId,
        productId,
        cardCode: codeRow.code,
        price: prod.price,
      }, { transaction: t });

      return { purchase, prod, code: codeRow };
    });

    await sendNotificationToUser(
      userId,
      `تم شراء "${result.prod.title}" بنجاح. كود البطاقة: ${result.code.code}`,
      "شراء منتج رقمي"
    );

    res.status(200).json({
      success: true,
      message: "تم الشراء بنجاح",
      purchase: {
        id: result.purchase.id,
        productTitle: result.prod.title,
        cardCode: result.code.code,
        price: result.purchase.price,
        purchasedAt: result.purchase.createdAt,
      },
      userBalance: user.sawa,
    });

  } catch (error) {
    console.error("❌ خطأ في عملية الشراء:", error);
    res.status(500).json({ error: error.message || "حدث خطأ في الخادم" });
  }
});

// جلب أبرز المنتجات بشكل عشوائي (حد أقصى 20 منتج)
router.get("/store/featured-products", async (req, res) => {
  try {
    // جلب 20 منتج مفعّل بطريقة عشوائية
    const products = await DigitalProduct.findAll({
      where: { isActive: true },
      include: [
        {
          model: StoreCategory,
          as: "category",
          attributes: ["id", "name", "image"],
        }
      ],
      order: sequelize.literal("RAND()"),
      limit: 20,
    });

    // حساب المخزون لكل منتج
    const enhancedProducts = await Promise.all(
      products.map(async (product) => {
        const unusedCodes = await DigitalProductCode.count({
          where: { productId: product.id, used: false }
        });

        return {
          ...product.toJSON(),
          stock: unusedCodes,
        };
      })
    );

    res.status(200).json({
      success: true,
      message: "أبرز منتجات عشوائية",
      featuredProducts: enhancedProducts,
    });

  } catch (error) {
    console.error("❌ خطأ في جلب أبرز المنتجات:", error);
    res.status(500).json({ error: "حدث خطأ في الخادم" });
  }
});

// جلب احصائيات المتجر (Admin فقط)
router.get("/store/statistics", async (req, res) => {
  try {
    const { Op } = require("sequelize");

    const today = new Date();
    const startOfDay = new Date(today.setHours(0, 0, 0, 0));
    const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    const startOfYear = new Date(today.getFullYear(), 0, 1);

    const totalCategories = await StoreCategory.count();
    const totalProducts = await DigitalProduct.count();
    const totalPurchases = await ProductPurchase.count();
    const totalRevenue = await ProductPurchase.sum("price");

    const todayRevenue = await ProductPurchase.sum("price", {
      where: { createdAt: { [Op.gte]: startOfDay } }
    });

    const monthRevenue = await ProductPurchase.sum("price", {
      where: { createdAt: { [Op.gte]: startOfMonth } }
    });

    const yearRevenue = await ProductPurchase.sum("price", {
      where: { createdAt: { [Op.gte]: startOfYear } }
    });

    const topProduct = await ProductPurchase.findOne({
      attributes: [
        "productId",
        [sequelize.fn("COUNT", sequelize.col("productId")), "sales"]
      ],
      group: ["productId"],
      order: [[sequelize.literal("sales"), "DESC"]],
      include: [{ model: DigitalProduct, as: "product", attributes: ["title", "price"] }]
    });

    const totalBuyers = await ProductPurchase.count({
      distinct: true,
      col: "userId"
    });

    const todayPurchases = await ProductPurchase.count({
      where: { createdAt: { [Op.gte]: startOfDay } }
    });

    const monthPurchases = await ProductPurchase.count({
      where: { createdAt: { [Op.gte]: startOfMonth } }
    });

    res.status(200).json({
      success: true,
      statistics: {
        categories: totalCategories,
        products: totalProducts,
        purchases: totalPurchases,
        buyers: totalBuyers,

        revenue: {
          total: totalRevenue || 0,
          today: todayRevenue || 0,
          month: monthRevenue || 0,
          year: yearRevenue || 0,
        },

        salesStats: {
          todayPurchases,
          monthPurchases
        },

        topProduct: topProduct ? {
          id: topProduct.productId,
          title: topProduct.product.title,
          price: topProduct.product.price,
          sales: topProduct.dataValues.sales
        } : null
      }
    });

  } catch (error) {
    console.error("❌ خطأ في جلب الإحصائيات:", error);
    res.status(500).json({ error: "حدث خطأ في الخادم" });
  }
});


module.exports = router;
