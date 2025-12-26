const express = require('express');
const router = express.Router();
const upload = require("../middlewares/uploads");
const sequelize = require("../config/db");
const { ConsumableCategory, ConsumableProduct, ConsumablePurchase, User } = require("../models");
const { sendNotificationToUser } = require("../services/notifications");
const { Op } = require("sequelize");

// ==================== أقسام المتجر الاستهلاكي ====================

// إضافة قسم جديد (Admin فقط)
router.post("/consumable-store/categories", upload.single("image"), async (req, res) => {
  try {
    const { name, description } = req.body;

    if (!name) {
      return res.status(400).json({ error: "اسم الفئة مطلوب" });
    }

    const category = await ConsumableCategory.create({
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
router.get("/consumable-store/categories", async (req, res) => {
  try {
    const categories = await ConsumableCategory.findAll({
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
router.put("/consumable-store/categories/:id", upload.single("image"), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, isActive } = req.body;

    const category = await ConsumableCategory.findByPk(id);
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
router.delete("/consumable-store/categories/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const category = await ConsumableCategory.findByPk(id);
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

// ==================== المنتجات الاستهلاكية ====================

// إضافة منتج جديد (Admin فقط)
router.post("/consumable-store/products", upload.array("images", 5), async (req, res) => {
  try {
    const { categoryId, name, description, price, stock } = req.body;

    if (!categoryId || !name || !price || stock === undefined) {
      return res.status(400).json({ 
        error: "الحقول المطلوبة: categoryId, name, price, stock" 
      });
    }

    const category = await ConsumableCategory.findByPk(categoryId);
    if (!category) {
      return res.status(404).json({ error: "الفئة غير موجودة" });
    }

    const images = req.files ? req.files.map(file => file.filename) : [];

    const product = await ConsumableProduct.create({
      categoryId,
      name,
      description,
      price: parseFloat(price),
      stock: parseInt(stock),
      images,
    });

    res.status(201).json({
      message: "تم إنشاء المنتج بنجاح",
      product,
    });
  } catch (error) {
    console.error("❌ خطأ في إنشاء المنتج:", error);
    res.status(500).json({ error: "حدث خطأ في الخادم" });
  }
});

// الحصول على منتجات قسم معين
router.get("/consumable-store/categories/:categoryId/products", async (req, res) => {
  try {
    const { categoryId } = req.params;

    const category = await ConsumableCategory.findByPk(categoryId);
    if (!category) {
      return res.status(404).json({ error: "الفئة غير موجودة" });
    }

    const products = await ConsumableProduct.findAll({
      where: {
        categoryId,
        isActive: true,
        stock: { [Op.gt]: 0 },
      },
      order: [["createdAt", "DESC"]],
    });

    res.status(200).json({
      success: true,
      categoryName: category.name,
      products,
    });
  } catch (error) {
    console.error("❌ خطأ في جلب المنتجات:", error);
    res.status(500).json({ error: "حدث خطأ في الخادم" });
  }
});

// الحصول على تفاصيل منتج واحد
router.get("/consumable-store/products/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const product = await ConsumableProduct.findByPk(id, {
      include: [{ model: ConsumableCategory, as: "category" }],
    });

    if (!product) {
      return res.status(404).json({ error: "المنتج غير موجود" });
    }

    res.status(200).json({
      success: true,
      product,
    });
  } catch (error) {
    console.error("❌ خطأ في جلب المنتج:", error);
    res.status(500).json({ error: "حدث خطأ في الخادم" });
  }
});

// تحديث منتج (Admin فقط)
router.put("/consumable-store/products/:id", upload.array("images", 5), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, price, stock, isActive } = req.body;

    const product = await ConsumableProduct.findByPk(id);
    if (!product) {
      return res.status(404).json({ error: "المنتج غير موجود" });
    }

    product.name = name || product.name;
    product.description = description || product.description;
    if (price) product.price = parseFloat(price);
    if (stock !== undefined) product.stock = parseInt(stock);
    if (isActive !== undefined) product.isActive = isActive;

    if (req.files && req.files.length > 0) {
      const newImages = req.files.map(file => file.filename);
      product.images = newImages;
    }

    await product.save();

    res.status(200).json({
      message: "تم تحديث المنتج بنجاح",
      product,
    });
  } catch (error) {
    console.error("❌ خطأ في تحديث المنتج:", error);
    res.status(500).json({ error: "حدث خطأ في الخادم" });
  }
});

// تحديث المخزون منتج (Admin فقط)
router.put("/consumable-store/products/:id/stock", upload.none(), async (req, res) => {
  try {
    const { id } = req.params;
    const { stock } = req.body;
    if (stock === undefined) {
        return res.status(400).json({ error: "حقل stock مطلوب" });
    }

    const product = await ConsumableProduct.findByPk(id);
    if (!product) {
        return res.status(404).json({ error: "المنتج غير موجود" });
    }
    product.stock = parseInt(stock);
    await product.save();
    res.status(200).json({
        message: "تم تحديث المخزون بنجاح",
        product,
    });
  } catch (error) {
    console.error("❌ خطأ في تحديث المخزون:", error);
    res.status(500).json({ error: "حدث خطأ في الخادم" });
  }
});

// حذف منتج (Admin فقط)
router.delete("/consumable-store/products/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const product = await ConsumableProduct.findByPk(id);
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

// شراء منتج استهلاكي
router.post("/consumable-store/buy-product", upload.none(), async (req, res) => {
  try {
    const { userId, productId, quantity, phone, location } = req.body;

    if (!userId || !productId || !quantity) {
      return res.status(400).json({ error: "userId, productId, quantity مطلوبة" });
    }

    if (!phone || !location) {
      return res.status(400).json({ error: "phone و location مطلوبة" });
    }

    const user = await User.findByPk(userId);
    if (!user) return res.status(404).json({ error: "المستخدم غير موجود" });

    const product = await ConsumableProduct.findByPk(productId);
    if (!product) return res.status(404).json({ error: "المنتج غير موجود" });

    const qty = parseInt(quantity);
    if (qty <= 0) return res.status(400).json({ error: "الكمية يجب أن تكون أكبر من صفر" });

    if (product.stock < qty) {
      return res.status(400).json({ error: `المخزون غير كافي. المتوفر: ${product.stock}` });
    }

    const result = await sequelize.transaction(async (t) => {
      const prod = await ConsumableProduct.findByPk(productId, { transaction: t });
      if (!prod) throw new Error("المنتج غير موجود أثناء المعاملة");

      if (prod.stock < qty) throw new Error("المخزون غير كافي");

      const totalPrice = prod.price * qty;
      if (user.sawa < totalPrice) throw new Error("رصيد المستخدم غير كافي");

      user.sawa -= totalPrice;
      await user.save({ transaction: t });

      prod.stock -= qty;
      await prod.save({ transaction: t });

      const purchase = await ConsumablePurchase.create({
        userId,
        productId,
        quantity: qty,
        totalPrice,
        phone: String(phone).trim(),
        location: String(location).trim(),
      }, { transaction: t });

      return { purchase, prod };
    });

    await sendNotificationToUser(
      userId,
      `تم شراء ${quantity} من "${result.prod.name}" بنجاح. الإجمالي: ${result.purchase.totalPrice} sawa\nالموقع: ${location}\nالهاتف: ${phone}`,
      "شراء منتج استهلاكي"
    );

    res.status(200).json({
      success: true,
      message: "تم الشراء بنجاح",
      purchase: {
        id: result.purchase.id,
        productName: result.prod.name,
        quantity: qty,
        unitPrice: result.prod.price,
        totalPrice: result.purchase.totalPrice,
        phone: phone,
        location: location,
        purchasedAt: result.purchase.createdAt,
      },
      userBalance: user.sawa,
    });

  } catch (error) {
    console.error("❌ خطأ في عملية الشراء:", error);
    res.status(500).json({ error: error.message || "حدث خطأ في الخادم" });
  }
});

// جلب سجل مشتريات المستخدم
router.get("/consumable-store/my-purchases/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;
    const status = req.query.status; // optional filter

    const user = await User.findByPk(userId);
    if (!user) {
      return res.status(404).json({ error: "المستخدم غير موجود" });
    }

    const whereClause = { userId };
    if (status) {
      whereClause.status = status;
    }

    const { count, rows: purchases } = await ConsumablePurchase.findAndCountAll({
      where: whereClause,
      include: [
        {
          model: ConsumableProduct,
          as: "product",
          attributes: ["id", "name", "price", "images"],
        },
      ],
      order: [["createdAt", "DESC"]],
      limit,
      offset,
    });

    res.status(200).json({
      success: true,
      purchases,
      pagination: {
        total: count,
        page,
        limit,
        totalPages: Math.ceil(count / limit),
      },
    });

  } catch (error) {
    console.error("❌ خطأ في جلب المشتريات:", error);
    res.status(500).json({ error: "حدث خطأ في الخادم" });
  }
});

// جلب كل الطلبات (Admin) - مرتبة من الأحدث للأقدم مع pagination
router.get("/consumable-store/orders", async (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 30;
    const offset = (page - 1) * limit;
    const status = req.query.status; // optional filter

    const whereClause = status ? { status } : {};

    const { count, rows } = await ConsumablePurchase.findAndCountAll({
      where: whereClause,
      attributes: ["id", "userId", "productId", "quantity", "totalPrice", "phone", "location", "status", "createdAt", "updatedAt"],
      order: [["createdAt", "DESC"]],
      limit,
      offset,
      include: [
        { model: ConsumableProduct, as: "product", attributes: ["id", "name", "price", "images"] },
        { model: User, as: "user", attributes: ["id", "name", "phone", "location"] },
      ],
    });

    res.status(200).json({
      success: true,
      orders: rows,
      pagination: {
        total: count,
        page,
        limit,
        totalPages: Math.ceil(count / limit) || 0,
      },
    });
  } catch (error) {
    console.error("❌ خطأ في جلب الطلبات:", error);
    res.status(500).json({ error: "حدث خطأ في الخادم" });
  }
});

// تحديث حالة الطلب (Admin فقط)
router.put("/consumable-store/orders/:orderId/status", upload.none(), async (req, res) => {
  try {
    const { orderId } = req.params;
    const { status } = req.body;

    const validStatuses = ["pending", "in_delivery", "completed", "cancelled"];
    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({ 
        error: "الحالة غير صحيحة. الحالات المتاحة: pending, in_delivery, completed, cancelled" 
      });
    }

    const purchase = await ConsumablePurchase.findByPk(orderId);
    if (!purchase) {
      return res.status(404).json({ error: "الطلب غير موجود" });
    }

    const oldStatus = purchase.status;
    purchase.status = status;
    await purchase.save();

    const statusMessages = {
      pending: "جاري معالجة طلبك",
      in_delivery: "طلبك في الطريق للتوصيل",
      completed: "تم تسليم طلبك بنجاح",
      cancelled: "تم إلغاء طلبك"
    };

    await sendNotificationToUser(
      purchase.userId,
      `تحديث حالة الطلب #${orderId}: ${statusMessages[status]}`,
      "تحديث حالة الطلب"
    );

    res.status(200).json({
      success: true,
      message: "تم تحديث حالة الطلب بنجاح",
      order: {
        id: purchase.id,
        oldStatus,
        newStatus: purchase.status,
        updatedAt: purchase.updatedAt,
      },
    });

  } catch (error) {
    console.error("❌ خطأ في تحديث حالة الطلب:", error);
    res.status(500).json({ error: "حدث خطأ في الخادم" });
  }
});

// جلب الطلبات حسب الحالة مع إحصائيات (Admin فقط)
router.get("/consumable-store/orders/status-summary", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 10;
    const statusParam = req.query.status;
    const validStatuses = ["pending", "in_delivery", "completed", "cancelled"];

    if (statusParam) {
      if (!validStatuses.includes(statusParam)) {
        return res.status(400).json({ error: "الحالة غير صحيحة. المتاحة: pending, in_delivery, completed, cancelled" });
      }

      const counts = await ConsumablePurchase.findAll({
        where: { status: statusParam },
        attributes: [
          "status",
          [sequelize.fn("COUNT", sequelize.col("id")), "count"],
          [sequelize.fn("SUM", sequelize.col("totalPrice")), "totalRevenue"],
        ],
        group: ["status"],
        raw: true,
      });

      const summarySingle = {};
      summarySingle[statusParam] = {
        count: counts && counts[0] ? parseInt(counts[0].count) || 0 : 0,
        revenue: counts && counts[0] ? parseFloat(counts[0].totalRevenue) || 0 : 0,
      };

      const orders = await ConsumablePurchase.findAll({
        where: { status: statusParam },
        attributes: ["id", "userId", "productId", "quantity", "totalPrice", "phone", "location", "status", "createdAt", "updatedAt"],
        include: [
          { model: ConsumableProduct, as: "product", attributes: ["id", "name", "price", "images"] },
          { model: User, as: "user", attributes: ["id", "name", "phone", "location"] },
        ],
        order: [["createdAt", "DESC"]],
        limit,
      });

      return res.status(200).json({
        success: true,
        summary: summarySingle,
        orders: { [statusParam]: orders },
      });
    }

    const statusCounts = await ConsumablePurchase.findAll({
      attributes: [
        "status",
        [sequelize.fn("COUNT", sequelize.col("id")), "count"],
        [sequelize.fn("SUM", sequelize.col("totalPrice")), "totalRevenue"],
      ],
      group: ["status"],
      raw: true,
    });

    const summary = {
      pending: { count: 0, revenue: 0 },
      in_delivery: { count: 0, revenue: 0 },
      completed: { count: 0, revenue: 0 },
      cancelled: { count: 0, revenue: 0 },
    };

    statusCounts.forEach(item => {
      summary[item.status] = {
        count: parseInt(item.count) || 0,
        revenue: parseFloat(item.totalRevenue) || 0,
      };
    });

    const statuses = validStatuses;
    const ordersByStatus = {};
    for (const s of statuses) {
      const orders = await ConsumablePurchase.findAll({
        where: { status: s },
        attributes: ["id", "userId", "productId", "quantity", "totalPrice", "phone", "location", "status", "createdAt", "updatedAt"],
        include: [
          { model: ConsumableProduct, as: "product", attributes: ["id", "name", "price", "images"] },
          { model: User, as: "user", attributes: ["id", "name", "phone", "location"] },
        ],
        order: [["createdAt", "DESC"]],
        limit,
      });

      ordersByStatus[s] = orders;
    }

    res.status(200).json({
      success: true,
      summary,
      orders: ordersByStatus,
    });

  } catch (error) {
    console.error("❌ خطأ في جلب ملخص الحالات:", error);
    res.status(500).json({ error: "حدث خطأ في الخادم" });
  }
});

// جلب احصائيات متجر المنتجات الاستهلاكية (Admin فقط)
router.get("/consumable-store/statistics", async (req, res) => {
  try {
    const today = new Date();
    const startOfDay = new Date(today.setHours(0, 0, 0, 0));
    const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    const startOfYear = new Date(today.getFullYear(), 0, 1);

    const totalCategories = await ConsumableCategory.count();
    const totalProducts = await ConsumableProduct.count();
    const totalPurchases = await ConsumablePurchase.count();
    const totalRevenue = await ConsumablePurchase.sum("totalPrice");

    const todayRevenue = await ConsumablePurchase.sum("totalPrice", {
      where: { createdAt: { [Op.gte]: startOfDay } }
    });

    const monthRevenue = await ConsumablePurchase.sum("totalPrice", {
      where: { createdAt: { [Op.gte]: startOfMonth } }
    });

    const yearRevenue = await ConsumablePurchase.sum("totalPrice", {
      where: { createdAt: { [Op.gte]: startOfYear } }
    });

    const totalBuyers = await ConsumablePurchase.count({
      distinct: true,
      col: "userId"
    });

    const todayPurchases = await ConsumablePurchase.count({
      where: { createdAt: { [Op.gte]: startOfDay } }
    });

    const monthPurchases = await ConsumablePurchase.count({
      where: { createdAt: { [Op.gte]: startOfMonth } }
    });

    // إحصائيات حسب الحالة
    const completedPurchases = await ConsumablePurchase.count({
      where: { status: "completed" }
    });

    const pendingPurchases = await ConsumablePurchase.count({
      where: { status: "pending" }
    });

    const inDeliveryPurchases = await ConsumablePurchase.count({
      where: { status: "in_delivery" }
    });

    const cancelledPurchases = await ConsumablePurchase.count({
      where: { status: "cancelled" }
    });

    const topProduct = await ConsumablePurchase.findOne({
      attributes: [
        "productId",
        [sequelize.fn("COUNT", sequelize.col("productId")), "sales"]
      ],
      include: [
        {
          model: ConsumableProduct,
          as: "product",
          attributes: ["id", "name", "price"],
          required: true,
        }
      ],
      group: ["productId"],
      order: [[sequelize.literal("sales"), "DESC"]],
      subQuery: false,
      raw: false,
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

        orderStatusStats: {
          completed: completedPurchases,
          pending: pendingPurchases,
          in_delivery: inDeliveryPurchases,
          cancelled: cancelledPurchases,
        },

        topProduct: topProduct ? {
          id: topProduct.product.id,
          name: topProduct.product.name,
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

// أبرز منتجات المتجر الاستهلاكي 
router.get("/consumable-store/featured-products", async (req, res) => {
  try {
    const products = await ConsumableProduct.findAll({
      where: {
        isActive: true,
        stock: { [Op.gt]: 0 } 
      },
      include: [
        {
          model: ConsumableCategory,
          as: "category",
          attributes: ["id", "name", "image"]
        }
      ],
      order: sequelize.literal("RAND()"), 
      limit: 20
    });

    res.status(200).json({
      success: true,
      message: "20 منتج استهلاكي عشوائي",
      featuredProducts: products
    });

  } catch (error) {
    console.error("❌ خطأ في جلب أبرز المنتجات:", error);
    res.status(500).json({ error: "حدث خطأ في الخادم" });
  }
});

module.exports = router;