const express = require('express');
const router = express.Router();
const upload = require("../middlewares/uploads");
const sequelize = require("../config/db");
const { StoreCategory, DigitalProduct, ProductPurchase, User, DigitalProductCode } = require("../models");
const { sendNotificationToUser } = require("../services/notifications");
const { requireAdmin , authenticateTokenUser} = require("../middlewares/auth");

let cachedDigitalProductCodeColumns = null;

async function getDigitalProductCodeColumns() {
  if (cachedDigitalProductCodeColumns !== null) {
    return cachedDigitalProductCodeColumns;
  }

  try {
    cachedDigitalProductCodeColumns = await sequelize.getQueryInterface().describeTable("digital_product_codes");
  } catch (error) {
    console.warn("⚠️ تعذر قراءة أعمدة جدول digital_product_codes، سيتم استخدام أعمدة افتراضية:", error.message);
    cachedDigitalProductCodeColumns = {};
  }

  return cachedDigitalProductCodeColumns;
}

async function hasDigitalProductCodeColumn(columnName) {
  const columns = await getDigitalProductCodeColumns();
  return Object.prototype.hasOwnProperty.call(columns, columnName);
}

async function getDigitalProductCodeAttributes() {
  const attributes = ["id", "productId", "used"];

  if (await hasDigitalProductCodeColumn("code")) {
    attributes.push("code");
  }
  if ((await hasDigitalProductCodeColumn("usedBy")) && Object.prototype.hasOwnProperty.call(DigitalProductCode.rawAttributes, "usedBy")) {
    attributes.push("usedBy");
  }
  if ((await hasDigitalProductCodeColumn("usedAt")) && Object.prototype.hasOwnProperty.call(DigitalProductCode.rawAttributes, "usedAt")) {
    attributes.push("usedAt");
  }

  return attributes;
}

function buildDummyDigitalCode(record = {}) {
  const id = record.id ?? record.codeId ?? 0;
  const productId = record.productId ?? 0;
  return `CARD-${productId}-${id}`;
}

function normalizeDigitalCodeRecord(record) {
  const rawRecord = record && typeof record.toJSON === "function"
    ? record.toJSON()
    : { ...(record || {}) };

  return {
    ...rawRecord,
    code: String(rawRecord.code || buildDummyDigitalCode(rawRecord)),
    usedBy: Object.prototype.hasOwnProperty.call(rawRecord, "usedBy") ? rawRecord.usedBy : null,
    usedAt: Object.prototype.hasOwnProperty.call(rawRecord, "usedAt") ? rawRecord.usedAt : null,
  };
}

function normalizeProductCodes(productPayload) {
  if (!productPayload || !Array.isArray(productPayload.codes)) {
    return productPayload;
  }

  return {
    ...productPayload,
    codes: productPayload.codes.map((codeItem) => normalizeDigitalCodeRecord(codeItem)),
  };
}

class StorePurchaseError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = "StorePurchaseError";
    this.statusCode = statusCode;
  }
}

// ==================== أقسام المتجر ====================

// إضافة قسم جديد (Admin فقط)
router.post("/store/categories", requireAdmin, upload.single("image"), async (req, res) => {
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
router.put("/store/categories/:id", requireAdmin, upload.single("image"), async (req, res) => {
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
router.delete("/store/categories/:id", requireAdmin, async (req, res) => {
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
router.post("/store/products", requireAdmin, upload.array("images", 5), async (req, res) => {
  try {
    const { categoryId, title, description, price, codes } = req.body;
    const codeColumnExists = await hasDigitalProductCodeColumn("code");

    if (!categoryId || !title || !price) {
      return res.status(400).json({
        error: "الحقول المطلوبة: categoryId, title, price",
      });
    }

    const category = await StoreCategory.findByPk(categoryId);
    if (!category) {
      return res.status(404).json({ error: "الفئة غير موجودة" });
    }

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

    if (false && duplicateInside.length > 0) {
      return res.status(400).json({
        error: "الأكواد تحتوي تكرار داخل نفس القائمة",
        duplicatedCodes: [...new Set(duplicateInside)],
      });
    }

    if (codeColumnExists && false && codesArr.length > 0) {
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

    const images = req.files ? req.files.map(file => file.filename) : [];

    const product = await DigitalProduct.create({
      categoryId,
      title,
      description,
      price: parseFloat(price),
      images,
      stock: 0,
    });

    if (codesArr.length > 0) {
      const entries = codesArr.map((code) => ({
        productId: product.id,
        ...(codeColumnExists ? { code } : {}),
      }));

      await DigitalProductCode.bulkCreate(entries);

      await product.update({ stock: codesArr.length });
    }

    const freshProduct = await DigitalProduct.findByPk(product.id, {
      include: [
        {
          model: DigitalProductCode,
          as: "codes",
          attributes: await getDigitalProductCodeAttributes(),
        },
      ],
    });

    res.status(201).json({
      message: "تم إنشاء المنتج بنجاح",
      product: normalizeProductCodes(freshProduct?.toJSON()),
    });

  } catch (error) {
    console.error("❌ خطأ في إنشاء المنتج:", error);
    res.status(500).json({ error: "حدث خطأ في السيرفر" });
  }
});


router.post("/store/products/:id/add-codes", requireAdmin, upload.none(), async (req, res) => {
  try {
    const { id } = req.params;
    const { codes } = req.body;
    const codeColumnExists = await hasDigitalProductCodeColumn("code");

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

    if (false && duplicatesInsideList.length > 0) {
      return res.status(400).json({
        error: "الأكواد تحتوي تكرار داخل نفس القائمة",
        duplicatedCodes: [...new Set(duplicatesInsideList)],
      });
    }

    const existedCodes = codeColumnExists
      ? await DigitalProductCode.findAll({
          where: { code: codesArr },
          attributes: ["code"],
        })
      : [];

    /*if (existedCodes.length > 0) {
      return res.status(400).json({
        error: "بعض الأكواد موجودة مسبقاً في القاعدة",
        duplicatedCodes: existedCodes.map((c) => c.code),
      });
    }*/

    const entries = codesArr.map((code) => ({
      productId: id,
      ...(codeColumnExists ? { code } : {}),
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
    const digitalProductCodeAttributes = await getDigitalProductCodeAttributes();

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
          model: DigitalProductCode,
          as: "codes",
          attributes: digitalProductCodeAttributes,
          required: false,
        },
      ],
      order: [["createdAt", "DESC"]],
    });

    const filteredProducts = [];

    for (const product of products) {
      const unusedCodesCount = await DigitalProductCode.count({
        where: { productId: product.id, used: false }
      });

      if (unusedCodesCount > 0) {
        filteredProducts.push(normalizeProductCodes({
          ...product.toJSON(),
          stock: unusedCodesCount,
        }));
      }
    }

    res.status(200).json({
      success: true,
      categoryName: category.name,
      products: filteredProducts,
    });

  } catch (error) {
    console.error("❌ خطأ في جلب المنتجات:", error);
    res.status(500).json({ error: "حدث خطأ في الخادم" });
  }
});

router.get("/store/admin/categories/:categoryId/products", requireAdmin, async (req, res) => {
  try {
    const { categoryId } = req.params;
    const digitalProductCodeAttributes = await getDigitalProductCodeAttributes();

    const category = await StoreCategory.findByPk(categoryId);
    if (!category) {
      return res.status(404).json({ error: "الفئة غير موجودة" });
    }

    const products = await DigitalProduct.findAll({
      where: {
        categoryId,
      },
      include: [
        {
          model: DigitalProductCode,
          as: "codes",
          attributes: digitalProductCodeAttributes,
          required: false,
        },
      ],
      order: [["createdAt", "DESC"]],
    });

    const normalizedProducts = [];

    for (const product of products) {
      const unusedCodesCount = Array.isArray(product.codes)
        ? product.codes.filter((code) => !code.used).length
        : await DigitalProductCode.count({
            where: { productId: product.id, used: false }
          });

      product.stock = unusedCodesCount;
      normalizedProducts.push(normalizeProductCodes({
        ...product.toJSON(),
        stock: unusedCodesCount,
        hiddenForUsers: unusedCodesCount <= 0,
        hiddenReason: unusedCodesCount <= 0
            ? ((Array.isArray(product.codes) && product.codes.length === 0)
                ? "no_codes_added"
                : "all_codes_used")
            : null,
      }));
    }

    res.status(200).json({
      success: true,
      categoryName: category.name,
      products: normalizedProducts,
    });
  } catch (error) {
    console.error("❌ خطأ في جلب منتجات القسم للأدمن:", error);
    res.status(500).json({ error: "حدث خطأ في الخادم" });
  }
});

// جلب المنتجات المخفية من المتجر (الأكواد نفدت أو لا توجد أكواد متاحة)
router.get("/store/admin/hidden-products", requireAdmin, async (req, res) => {
  try {
    const products = await DigitalProduct.findAll({
      include: [
        {
          model: StoreCategory,
          as: "category",
          attributes: ["id", "name", "image"],
        },
        {
          model: DigitalProductCode,
          as: "codes",
          attributes: ["id", "used"],
          required: false,
        },
      ],
      order: [["createdAt", "DESC"]],
    });

    const hiddenProducts = products
      .map((product) => {
        const codes = Array.isArray(product.codes) ? product.codes : [];
        const totalCodes = codes.length;
        const unusedCodes = codes.filter((code) => !code.used).length;
        const usedCodes = totalCodes - unusedCodes;

        if (unusedCodes > 0) {
          return null;
        }

        return {
          ...product.toJSON(),
          stock: 0,
          hiddenReason: totalCodes === 0 ? "no_codes_added" : "all_codes_used",
          totalCodes,
          unusedCodes,
          usedCodes,
        };
      })
      .filter(Boolean);

    res.status(200).json({
      success: true,
      totalHiddenProducts: hiddenProducts.length,
      hiddenProducts,
    });
  } catch (error) {
    console.error("❌ خطأ في جلب المنتجات المخفية:", error);
    res.status(500).json({ error: "حدث خطأ في الخادم" });
  }
});

// حذف منتج (Admin فقط)
router.delete("/store/products/:id", requireAdmin, async (req, res) => {
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
router.post("/store/buy-product", authenticateTokenUser, upload.none(), async (req, res) => {
  try {
    const { productId } = req.body;
    const userId = req.user.id;
    const productCodeAttributes = await getDigitalProductCodeAttributes();

    if (!userId || !productId) {
      return res.status(400).json({ error: "userId \u0648 productId \u0645\u0637\u0644\u0648\u0628\u0629" });
    }

    const user = await User.findByPk(userId);
    if (!user) {
      return res.status(404).json({ error: "\u0627\u0644\u0645\u0633\u062a\u062e\u062f\u0645 \u063a\u064a\u0631 \u0645\u0648\u062c\u0648\u062f" });
    }

    const product = await DigitalProduct.findByPk(productId);
    if (!product) {
      return res.status(404).json({ error: "\u0627\u0644\u0645\u0646\u062a\u062c \u063a\u064a\u0631 \u0645\u0648\u062c\u0648\u062f" });
    }

    if (product.stock <= 0) {
      return res.status(400).json({ error: "\u0627\u0644\u0645\u0646\u062a\u062c \u063a\u064a\u0631 \u0645\u062a\u0648\u0641\u0631 \u062d\u0627\u0644\u064a\u0627\u064b" });
    }

    const result = await sequelize.transaction(async (t) => {
      const lockedUser = await User.findByPk(userId, {
        transaction: t,
        lock: t.LOCK.UPDATE,
      });
      if (!lockedUser) {
        throw new StorePurchaseError("\u0627\u0644\u0645\u0633\u062a\u062e\u062f\u0645 \u063a\u064a\u0631 \u0645\u0648\u062c\u0648\u062f \u0623\u062b\u0646\u0627\u0621 \u0627\u0644\u0645\u0639\u0627\u0645\u0644\u0629", 404);
      }

      const prod = await DigitalProduct.findByPk(productId, {
        transaction: t,
        lock: t.LOCK.UPDATE,
      });
      if (!prod) {
        throw new StorePurchaseError("\u0627\u0644\u0645\u0646\u062a\u062c \u063a\u064a\u0631 \u0645\u0648\u062c\u0648\u062f \u0623\u062b\u0646\u0627\u0621 \u0627\u0644\u0645\u0639\u0627\u0645\u0644\u0629", 404);
      }

      const productPrice = Number(prod.price || 0);
      const userBalance = Number(lockedUser.sawa || 0);

      if (prod.stock <= 0) {
        throw new StorePurchaseError("\u0627\u0644\u0645\u0646\u062a\u062c \u063a\u064a\u0631 \u0645\u062a\u0648\u0641\u0631 \u062d\u0627\u0644\u064a\u0627\u064b");
      }

      if (!Number.isFinite(productPrice) || productPrice < 0) {
        throw new StorePurchaseError("\u0633\u0639\u0631 \u0627\u0644\u0645\u0646\u062a\u062c \u063a\u064a\u0631 \u0635\u0627\u0644\u062d", 500);
      }

      if (!Number.isFinite(userBalance)) {
        throw new StorePurchaseError("\u0631\u0635\u064a\u062f \u0627\u0644\u0645\u0633\u062a\u062e\u062f\u0645 \u063a\u064a\u0631 \u0635\u0627\u0644\u062d", 500);
      }

      if (userBalance < productPrice) {
        throw new StorePurchaseError("\u0631\u0635\u064a\u062f \u0627\u0644\u0645\u0633\u062a\u062e\u062f\u0645 \u063a\u064a\u0631 \u0643\u0627\u0641\u064a");
      }

      const codeRow = await DigitalProductCode.findOne({
        where: { productId: prod.id, used: false },
        attributes: productCodeAttributes,
        transaction: t,
        lock: t.LOCK.UPDATE,
      });

      if (!codeRow) {
        throw new StorePurchaseError("\u0644\u0627 \u062a\u0648\u062c\u062f \u0623\u0643\u0648\u0627\u062f \u0645\u062a\u0627\u062d\u0629 \u062d\u0627\u0644\u064a\u0627\u064b");
      }

      lockedUser.sawa = Math.max(0, Math.floor(userBalance - productPrice));
      await lockedUser.save({ transaction: t });

      codeRow.used = true;
      if (Object.prototype.hasOwnProperty.call(DigitalProductCode.rawAttributes, "usedBy")) {
        codeRow.usedBy = userId;
      }
      if (Object.prototype.hasOwnProperty.call(DigitalProductCode.rawAttributes, "usedAt")) {
        codeRow.usedAt = new Date();
      }
      await codeRow.save({ transaction: t });

      const remaining = await DigitalProductCode.count({
        where: { productId: prod.id, used: false },
        transaction: t,
      });

      await DigitalProduct.update(
        { stock: remaining },
        { where: { id: prod.id }, transaction: t }
      );

      const normalizedCode = normalizeDigitalCodeRecord(codeRow);

      const purchase = await ProductPurchase.create({
        userId,
        productId,
        cardCode: normalizedCode.code,
        price: productPrice,
      }, { transaction: t });

      return { purchase, prod, code: normalizedCode, userBalance: lockedUser.sawa };
    });

    await sendNotificationToUser(
      userId,
      `\u062a\u0645 \u0634\u0631\u0627\u0621 "${result.prod.title}" \u0628\u0646\u062c\u0627\u062d. \u0643\u0648\u062f \u0627\u0644\u0628\u0637\u0627\u0642\u0629: ${result.code.code}`,
      "\u0634\u0631\u0627\u0621 \u0645\u0646\u062a\u062c \u0631\u0642\u0645\u064a"
    );

    res.status(200).json({
      success: true,
      message: "\u062a\u0645 \u0627\u0644\u0634\u0631\u0627\u0621 \u0628\u0646\u062c\u0627\u062d",
      purchase: {
        id: result.purchase.id,
        productTitle: result.prod.title,
        cardCode: result.code.code,
        price: result.purchase.price,
        purchasedAt: result.purchase.createdAt,
      },
      userBalance: result.userBalance,
    });
  } catch (error) {
    console.error("? ??? ?? ????? ??????:", error);
    if (error instanceof StorePurchaseError) {
      return res.status(error.statusCode || 400).json({ error: error.message });
    }
    res.status(500).json({ error: "\u062d\u062f\u062b \u062e\u0637\u0623 \u0641\u064a \u0627\u0644\u062e\u0627\u062f\u0645" });
  }
});

router.get("/store/featured-products", async (req, res) => {
  try {
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
      limit: 40,
    });

    const filtered = [];

    for (const product of products) {
      const unusedCodes = await DigitalProductCode.count({
        where: { productId: product.id, used: false }
      });

      if (unusedCodes > 0) {
        filtered.push({
          ...product.toJSON(),
          stock: unusedCodes,
        });
      }

      if (filtered.length === 20) break;
    }

    res.status(200).json({
      success: true,
      message: "أبرز منتجات عشوائية",
      featuredProducts: filtered,
    });

  } catch (error) {
    console.error("❌ خطأ في جلب أبرز المنتجات:", error);
    res.status(500).json({ error: "حدث خطأ في الخادم" });
  }
});

// جلب احصائيات المتجر (Admin فقط)
router.get("/store/statistics", requireAdmin, async (req, res) => {
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


// جلب قائمة المشترين من المتجر (Admin فقط)
router.get("/store/buyers", requireAdmin, async (req, res) => {
  try {
    const purchases = await ProductPurchase.findAll({
      include: [
        {
          model: User,
          as: "user",
          attributes: ["id", "name"],
        },
        {
          model: DigitalProduct,
          as: "product",
          attributes: ["id", "title", "price"],
        },
      ],
      order: [["createdAt", "DESC"]],
    });

    const buyers = purchases.map((p) => ({
      purchaseId: p.id,
      purchasedAt: p.createdAt,
      pricePaid: p.price,
      user: p.user
        ? { id: p.user.id, name: p.user.name }
        : { id: p.userId, name: "غير معروف" },
      product: p.product
        ? { id: p.product.id, title: p.product.title }
        : { id: p.productId, title: "منتج محذوف" },
    }));

    res.status(200).json({
      success: true,
      total: buyers.length,
      buyers,
    });
  } catch (error) {
    console.error("❌ خطأ في جلب المشترين:", error);
    res.status(500).json({ error: "حدث خطأ في الخادم" });
  }
});

// سجل كامل لمشتريات متجر البطاقات (Admin فقط)
router.get("/store/admin/purchase-log", requireAdmin, async (req, res) => {
  try {
    const { Op } = require("sequelize");
    const page = Math.max(Number.parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 20, 1), 100);
    const search = String(req.query.search || "").trim();
    const userId = Number.parseInt(req.query.userId, 10);
    const productId = Number.parseInt(req.query.productId, 10);
    const fromDate = req.query.fromDate ? new Date(String(req.query.fromDate)) : null;
    const toDate = req.query.toDate ? new Date(String(req.query.toDate)) : null;

    const where = {};
    if (Number.isInteger(userId) && userId > 0) {
      where.userId = userId;
    }
    if (Number.isInteger(productId) && productId > 0) {
      where.productId = productId;
    }
    if (fromDate && !Number.isNaN(fromDate.getTime())) {
      where.createdAt = {
        ...(where.createdAt || {}),
        [Op.gte]: new Date(fromDate.setHours(0, 0, 0, 0)),
      };
    }
    if (toDate && !Number.isNaN(toDate.getTime())) {
      where.createdAt = {
        ...(where.createdAt || {}),
        [Op.lte]: new Date(toDate.setHours(23, 59, 59, 999)),
      };
    }

    if (search) {
      where.cardCode = { [Op.like]: `%${search}%` };
    }

    const purchaseRows = await ProductPurchase.findAll({
      where,
      order: [["createdAt", "DESC"]],
    });

    const uniqueUserIds = [...new Set(purchaseRows.map((item) => item.userId).filter(Boolean))];
    const uniqueProductIds = [...new Set(purchaseRows.map((item) => item.productId).filter(Boolean))];

    const users = uniqueUserIds.length
      ? await User.findAll({
          where: { id: uniqueUserIds },
          attributes: ["id", "name", "phone", "email", "location", "role"],
        })
      : [];

    const products = uniqueProductIds.length
      ? await DigitalProduct.findAll({
          where: { id: uniqueProductIds },
          attributes: ["id", "title", "price", "images", "categoryId"],
          include: [
            {
              model: StoreCategory,
              as: "category",
              attributes: ["id", "name"],
            },
          ],
        })
      : [];

    const usersMap = new Map(users.map((item) => [item.id, item]));
    const productsMap = new Map(products.map((item) => [item.id, item]));

    let mergedPurchases = purchaseRows.map((purchase) => {
      const user = usersMap.get(purchase.userId) || null;
      const product = productsMap.get(purchase.productId) || null;

      return {
        id: purchase.id,
        cardCode: purchase.cardCode,
        price: purchase.price,
        purchasedAt: purchase.createdAt,
        user: user
          ? {
              id: user.id,
              name: user.name,
              phone: user.phone,
              email: user.email,
              location: user.location,
              role: user.role,
            }
          : null,
        product: product
          ? {
              id: product.id,
              title: product.title,
              price: product.price,
              images: product.images,
              category: product.category
                ? {
                    id: product.category.id,
                    name: product.category.name,
                  }
                : null,
            }
          : null,
      };
    });

    if (search) {
      const loweredSearch = search.toLowerCase();
      mergedPurchases = mergedPurchases.filter((purchase) => {
        const values = [
          purchase.cardCode,
          purchase.user?.name,
          purchase.user?.phone,
          purchase.user?.email,
          purchase.product?.title,
          purchase.product?.category?.name,
        ]
          .filter(Boolean)
          .map((value) => String(value).toLowerCase());

        return values.some((value) => value.includes(loweredSearch));
      });
    }

    const count = mergedPurchases.length;
    const totalRevenue = mergedPurchases.reduce(
      (sum, item) => sum + (Number(item.price) || 0),
      0,
    );
    const totalBuyers = new Set(
      mergedPurchases
        .map((item) => item.user?.id)
        .filter(Boolean),
    ).size;

    const offset = (page - 1) * limit;
    const purchases = mergedPurchases.slice(offset, offset + limit);

    return res.status(200).json({
      success: true,
      summary: {
        totalPurchases: count,
        totalRevenue: totalRevenue || 0,
        totalBuyers,
      },
      pagination: {
        page,
        limit,
        total: count,
        totalPages: Math.max(Math.ceil(count / limit), 1),
      },
      purchases,
    });
  } catch (error) {
    console.error("❌ خطأ في جلب سجل متجر البطاقات:", error);
    return res.status(500).json({ error: "حدث خطأ أثناء جلب سجل متجر البطاقات" });
  }
});

module.exports = router;

