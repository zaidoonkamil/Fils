const express = require('express');
const Referrals = require('../models/referrals');
const bcrypt = require("bcrypt");
const saltRounds = 10;
const router = express.Router();
const jwt = require('jsonwebtoken');
const dotenv = require('dotenv');
dotenv.config();
const multer = require("multer");
const upload = multer();
const { User, UserDevice, IdShop } = require('../models');
const Tearms = require("../models/TermsAndConditions");
const Settings = require('../models/settings');
const UserCounter = require("../models/usercounters");
const Counter = require("../models/counter");
const { Op } = require("sequelize");
const CounterSale = require("../models/counterSale");
const OtpCode = require("../models/OtpCode");
const axios = require('axios');
const sequelize = require("../config/db"); 
const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

const generateToken = (user) => {
    return jwt.sign(
        { id: user.id, email: user.email, role: user.role },
        process.env.JWT_SECRET || 'your-secret-key-123456789',
        { expiresIn: '350d' } 
    );
};

const authenticateToken = (req, res, next) => {
    const token = req.headers['authorization'];
    if (!token) return res.status(401).json({ error: "Access denied, no token provided" });

    jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key-123456789', (err, user) => {
        if (err) return res.status(403).json({ error: "Invalid token" });
        req.user = user;
        next();
    });
};

router.post("/otp/generate", upload.none(), async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: "يجب إدخال البريد الإلكتروني" });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    const expiryDate = new Date(Date.now() + 2 * 60 * 1000);

    await OtpCode.create({
      email,
      code: otp,
      expiryDate,
    });

    await transporter.sendMail({
      from: `"فلس" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: "رمز التحقق OTP",
      text: `رمز التحقق الخاص بك هو: ${otp} صالح لمدة دقيقتين.`,
    });

    return res.status(201).json({
      message: "تم إرسال OTP إلى البريد الإلكتروني",
    });
  } catch (err) {
    console.error("❌ Error generating OTP:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/otp/verify", upload.none(), async (req, res) => {
  try {
    const { email, code } = req.body;

    if (!email || !code) {
      return res.status(400).json({ error: "البريد الإلكتروني والكود مطلوبان" });
    }

    const otpRecord = await OtpCode.findOne({
      where: { email, code, isUsed: false }
    });

    if (!otpRecord) {
      return res.status(400).json({ error: "OTP غير صحيح" });
    }

    if (otpRecord.expiryDate < new Date()) {
      return res.status(400).json({ error: "انتهت صلاحية OTP" });
    }

    otpRecord.isUsed = true;
    await otpRecord.save();

    const user = await User.findOne({ where: { email } });
    if (user) {
      user.isVerified = true;
      await user.save();
    }

    return res.status(200).json({ 
      message: "تم التحقق من OTP بنجاح",
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        isVerified: user.isVerified
      }
    });
  } catch (err) {
    console.error("❌ Error verifying OTP:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post('/admin/reset-password', upload.none(), async (req, res) => {
  try {
    const { email, newPassword } = req.body;

    if (!email || !newPassword) {
      return res.status(400).json({ message: 'يرجى إدخال البريد الإلكتروني وكلمة المرور الجديدة' });
    }

    const user = await User.findOne({ where: { email } });
    if (!user) {
      return res.status(404).json({ message: 'المستخدم غير موجود' });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    user.password = hashedPassword;
    await user.save();

    return res.json({ message: 'تم تحديث كلمة المرور بنجاح ✅' });
  } catch (error) {
    console.error('خطأ:', error);
    return res.status(500).json({ message: 'حدث خطأ في السيرفر' });
  }
});

router.delete("/users/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const user = await User.findByPk(id, {
      include: { model: UserDevice, as: "devices" },
    });

    if (!user) {
      return res.status(404).json({ error: "المستخدم غير موجود" });
    }

    await user.destroy(); 

    res.status(200).json({ message: "تم حذف المستخدم وأجهزته بنجاح" });
  } catch (err) {
    console.error("❌ خطأ أثناء الحذف:", err);
    res.status(500).json({ error: "حدث خطأ أثناء عملية الحذف" });
  }
});

router.post("/users", upload.none() ,async (req, res) => {
    const { id, name, email, location ,password , note, role = 'user'} = req.body;
    let phone = req.body.phone;
    try {
        const existingUser = await User.findOne({ where: { email } });

        if (existingUser) {
            return res.status(400).json({ error: "البريد الإلكتروني قيد الاستخدام بالفعل" });
        }

        const existingPhone = await User.findOne({ where: { phone } });
        if (existingPhone) {
          return res.status(400).json({ error: "الهاتف قيد الاستخدام بالفعل" });
        }

        const hashedPassword = await bcrypt.hash(password, saltRounds);
        const isVerified = role === "admin" || role === "agent";

        const user = await User.create({ id: id || undefined, name, email, isVerified, phone, location, password: hashedPassword, note: note || null , role });

        res.status(201).json({
        id: id || undefined,
        name: user.name,
        email: user.email,
        phone: user.phone,
        location: user.location,
        role: role,
        note: user.note,
        isVerified: user.isVerified,
        isLoggedIn: user.isLoggedIn, 
        createdAt: user.createdAt,
        updatedAt: user.updatedAt
     });
    } catch (err) {
        console.error("❌ Error creating user:", err);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

router.post("/users/always-verified", upload.none(), async (req, res) => {
  const { id, name, email, location, password, note, role = "user" } = req.body;
  let phone = req.body.phone;

  try {
    const existingUser = await User.findOne({ where: { email } });
    if (existingUser) {
      return res.status(400).json({ error: "البريد الإلكتروني قيد الاستخدام بالفعل" });
    }

    const existingPhone = await User.findOne({ where: { phone } });
    if (existingPhone) {
      return res.status(400).json({ error: "الهاتف قيد الاستخدام بالفعل" });
    }

    const hashedPassword = await bcrypt.hash(password, saltRounds);

    const isVerified = true;

    const user = await User.create({
      id: id || undefined,
      name,
      email,
      isVerified,
      phone,
      location,
      password: hashedPassword,
      note: note || null,
      role,
    });

    res.status(201).json({
      id: id || undefined,
      name: user.name,
      email: user.email,
      phone: user.phone,
      location: user.location,
      role: user.role,
      note: user.note,
      isVerified: user.isVerified,
      isLoggedIn: user.isLoggedIn,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    });
  } catch (err) {
    console.error("❌ Error creating verified user:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/login", upload.none(), async (req, res) => {
  const { email , password, refId } = req.body;
  try {

    if (!email) {
      return res.status(400).json({ error: "يرجى إدخال البريد الإلكتروني" });
    }

    const user = await User.findOne({ where: { email } });
    if (!user) {
      return res.status(400).json({ error: "البريد الإلكتروني غير صحيح" });
    }

    if (user.role !== 'admin' && user.isLoggedIn) {
      return res.status(403).json({ error: "لا يمكن تسجيل الدخول من أكثر من جهاز في نفس الوقت" });
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return res.status(400).json({ error: "كلمة المرور غير صحيحة" });
    }

    if (refId) {
      const friend = await User.findOne({ where: { id: refId } });
      if (!friend) {
        return res.status(400).json({ error: "كود الإحالة غير صحيح" });
      }

      const alreadyReferred = await Referrals.findOne({
        where: { referredUserId: user.id }
      });

      if (!alreadyReferred) {
        friend.sawa += 5;
        await friend.save();

        await Referrals.create({
          referrerId: friend.id,
          referredUserId: user.id
        });
      }
    }

    if (user.isVerified) {
      user.isLoggedIn = true;
      await user.save();
    }


    const token = generateToken(user);

    res.status(200).json({
      message: "Login successful",
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        isVerified: user.isVerified,
        sawa: user.sawa,
        role: user.role,
        isLoggedIn: user.isLoggedIn,
        location: user.location,
        Jewel: user.Jewel,
        dolar: user.dolar
      },
      token
    });

  } catch (err) {
    console.error("❌ خطأ أثناء تسجيل الدخول:", err);
    res.status(500).json({ error: "خطأ داخلي في الخادم" });
  }
});

router.post("/logout", upload.none(), async (req, res) => {
  const { id } = req.body;

  if (!id) {
    return res.status(400).json({ error: "يجب إرسال id المستخدم" });
  }

  try {
    const user = await User.findByPk(id);
    if (!user) {
      return res.status(404).json({ error: "المستخدم غير موجود" });
    }

    user.isLoggedIn = false;
    await user.save();

    res.json({ message: "تم تسجيل الخروج بنجاح" });
  } catch (err) {
    console.error("❌ خطأ أثناء تسجيل الخروج:", err);
    res.status(500).json({ error: "خطأ داخلي في الخادم" });
  }
});

router.patch("/users/:id/status", async (req, res) => {
  const { id } = req.params;
  const { isActive } = req.body;

  try {
    const user = await User.findByPk(id);
    if (!user) {
      return res.status(404).json({ error: "المستخدم غير موجود" });
    }

    user.isActive = isActive;
    await user.save();

    res.json({
      message: `تم تحديث حالة المستخدم إلى ${isActive ? "مفعل ✅" : "محظور 🚫"}`,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        isActive: user.isActive,
      },
    });
  } catch (err) {
    console.error("❌ خطأ أثناء تحديث الحالة:", err);
    res.status(500).json({ error: "خطأ داخلي في الخادم" });
  }
});

router.get("/allusers", async (req, res) => {
  try {
    const { page = 1, limit = 10 } = req.query; 

    const offset = (page - 1) * limit; 

    const { count, rows: users } = await User.findAndCountAll({
      limit: parseInt(limit),
      offset: parseInt(offset),
    });

    res.status(200).json({
      totalUsers: count,
      totalPages: Math.ceil(count / limit),
      currentPage: parseInt(page),
      users,
    });
  } catch (err) {
    console.error("❌ Error fetching users:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

router.get("/users", async (req, res) => {
  try {
    const users = await User.findAll({
      where: {
        role: {
          [Op.ne]: "admin"
        }
      }
    });
    res.status(200).json(users);
  } catch (err) {
    console.error("❌ Error fetching users:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

router.get("/profile", authenticateToken, async (req, res) => {
  try {
    const user = await User.findByPk(req.user.id, {
      include: [
        {
          model: UserCounter,
          include: [
            {
              model: Counter,
              paranoid: false,
            },
            {
              model: CounterSale,
              where: { isSold: false },
              required: false, 
            },
          ],
        },
      ],
    });

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    if (!user.isActive) {
      return res.status(403).json({ error: "تم حظر حسابك من قبل الإدارة" });
    }

    const userData = user.toJSON();

    userData.UserCounters = userData.UserCounters.map((counter) => {
      if (counter.endDate) {
        const now = new Date();
        const endDate = new Date(counter.endDate);
        const diffInMs = endDate - now;
        const diffInDays = Math.ceil(diffInMs / (1000 * 60 * 60 * 24));

        return {
          ...counter,
          remainingDays: diffInDays > 0 ? diffInDays : 0,
        };
      }
      return { ...counter, remainingDays: null };
    });

    // Get conversion rate from settings, default to 1.25 if not found
    const conversionRateSetting = await Settings.findOne({ 
      where: { key: 'sawa_to_dollar_rate', isActive: true } 
    });
    const conversionRate = conversionRateSetting ? parseFloat(conversionRateSetting.value) : 1.25;
    
    userData.dolar = Number((userData.sawa * conversionRate).toFixed(2))

    let totalPoints = 0;
    let totalGems = 0;

    userData.UserCounters.forEach((uc) => {
      if (uc.Counter) {
        if (uc.Counter.type === "points") {
          totalPoints += uc.Counter.points;
        } else if (uc.Counter.type === "gems") {
          totalGems += uc.Counter.points;
        }
      }
    });

    userData.totalPoints = totalPoints;
    userData.totalGems = totalGems;

    res.status(200).json(userData);
  } catch (err) {
    console.error("❌ Error fetching user profile:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

router.get("/users/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const user = await User.findByPk(id, {
      include: [
        {
          model: UserCounter,
           include: [{
            model: Counter,
            paranoid: false, 
          }],
        }
      ]
    });

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const userData = user.toJSON();

    userData.UserCounters = userData.UserCounters.map(counter => {
      if (counter.endDate) {
        const now = new Date();
        const endDate = new Date(counter.endDate);
        const diffInMs = endDate - now;
        const diffInDays = Math.ceil(diffInMs / (1000 * 60 * 60 * 24));

        return {
          ...counter,
          remainingDays: diffInDays > 0 ? diffInDays : 0
        };
      } else {
        return {
          ...counter,
          remainingDays: null
        };
      }
    });

    // Get conversion rate from settings, default to 1.25 if not found
    const conversionRateSetting2 = await Settings.findOne({ 
      where: { key: 'sawa_to_dollar_rate', isActive: true } 
    });
    const conversionRate2 = conversionRateSetting2 ? parseFloat(conversionRateSetting2.value) : 1.25;
    
    userData.dolar = Number((userData.sawa * conversionRate2).toFixed(2))


    let totalPoints = 0;
    let totalGems = 0;

    userData.UserCounters.forEach(uc => {
      if (uc.Counter) {
        if (uc.Counter.type === "points") {
          totalPoints += uc.Counter.points;
        } else if (uc.Counter.type === "gems") {
          totalGems += uc.Counter.points;
        }
      }
    });

    userData.totalPoints = totalPoints;
    userData.totalGems = totalGems;

    res.status(200).json(userData);

  } catch (err) {
    console.error("Error fetching user:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

router.get("/roleAgents", async (req, res) => {
  try {
    const agents = await User.findAll({
      where: { role: "agent" },
      attributes: ["id", "name", "phone", "sawa", "location","note", "createdAt"],
      order: [["createdAt", "DESC"]],
    });

    res.status(200).json(agents);
  } catch (err) {
    console.error("❌ خطأ أثناء جلب الوكلاء:", err);
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

router.put("/users/:id/gems", upload.none() , async (req, res) => {
  const { id } = req.params;
  const { gems } = req.body;

  try {
    const user = await User.findByPk(id);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    user.Jewel = gems;

    await user.save();

    res.status(200).json({ message: "Jewel updated successfully", user });
  } catch (err) {
    console.error("Error updating gems:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

router.get("/store/id", async (req, res) => {
  try {
    const items = await IdShop.findAll({
      where: { isAvailable: true },
    });
    res.status(200).json(items);
  } catch (err) {
    console.error("❌ Error fetching store items:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/store/buy-id/:shopId/:userId", async (req, res) => {
  const { shopId, userId } = req.params;

  const t = await sequelize.transaction();
  try {
    const shopItem = await IdShop.findByPk(shopId, { transaction: t });
    if (!shopItem || !shopItem.isAvailable) {
      return res.status(404).json({ error: "العنصر غير موجود أو تم شراؤه" });
    }

    const user = await User.findByPk(userId, { transaction: t });
    if (!user) {
      return res.status(404).json({ error: "المستخدم غير موجود" });
    }

    if (user.sawa < shopItem.price) {
      return res.status(400).json({ error: "رصيدك غير كافي" });
    }

    user.sawa -= shopItem.price;
    await user.save({ transaction: t });

    const newId = shopItem.idForSale;

    await UserCounter.update(
      { userId: newId },
      { where: { userId: user.id }, transaction: t }
    );

    await Counter.update(
      { userId: newId },
      { where: { userId: user.id }, transaction: t }
    );

    await User.update(
      { id: newId },
      { where: { id: user.id }, transaction: t }
    );

    shopItem.isAvailable = false;
    await shopItem.save({ transaction: t });

    await t.commit();

    res.status(200).json({
      message: "✅ تم شراء وتغيير الـ ID بنجاح",
      oldId: user.id,
      newId,
    });
  } catch (err) {
    await t.rollback();
    console.error("❌ Error buying ID:", err);
    res.status(500).json({ error: "Internal Server Error", details: err.message });
  }
});

router.post("/store/add", upload.none(), async (req, res) => {
  try {
    const { idForSale, price } = req.body;

    if (!idForSale || !price) {
      return res.status(400).json({ error: "يجب إدخال id والسعر" });
    }

    const existingUser = await User.findByPk(idForSale);
    if (existingUser) {
      return res.status(400).json({ error: "هذا الـ ID مستخدم من قبل مستخدم آخر" });
    }

    const existingShopItem = await IdShop.findOne({
      where: { idForSale, isAvailable: true },
    });
    if (existingShopItem) {
      return res.status(400).json({ error: "هذا الـ ID معروض بالفعل في المتجر" });
    }

    const newShopItem = await IdShop.create({
      idForSale,
      price,
      isAvailable: true,
    });

    res.status(201).json({
      message: "تمت إضافة الـ ID للمتجر بنجاح ✅",
      shopItem: newShopItem,
    });
  } catch (err) {
    console.error("❌ Error adding id to store:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

router.delete("/store/:shopId", async (req, res) => {
  const { shopId } = req.params;
  try {
    if (isNaN(shopId)) {
      return res.status(400).json({ error: "معرف المتجر shopId غير صالح" });
    }

    const shopItem = await IdShop.findByPk(shopId);

    if (!shopItem) {
      return res.status(404).json({ error: `العنصر بالمعرف ${shopId} غير موجود` });
    }

    await shopItem.destroy();

    res.status(200).json({
      message: "✅ تمت إزالة العنصر من المتجر بنجاح",
      removedId: shopId,
    });
  } catch (err) {
    console.error("❌ خطأ أثناء إزالة العنصر من المتجر:");
    console.error("📌 الرسالة:", err.message);
    console.error("📌 التفاصيل:", err);

    res.status(500).json({
      error: "Internal Server Error",
      details: err.message,
    });
  }
});

router.get("/admin/stats", async (req, res) => {
  try {
    const totalUsers = await User.count();

    const totalAgents = await User.count({ where: { role: "agent" } });

    const activeUsers = await User.count({ where: { isActive: true } });

    const totalSawa = await User.sum("sawa") || 0;

    const totalGems = await User.sum("Jewel") || 0;

    const totalStoreItems = await IdShop.count();

    const availableStoreItems = await IdShop.count({ where: { isAvailable: true } });

    const activePercentage = totalUsers > 0 ? ((activeUsers / totalUsers) * 100).toFixed(1) : 0;

    const totalAdmins = await User.count({ where: { role: "admin" } });
    const totalUsersOnly = await User.count({ where: { role: "user" } });
    const totalVerifiedUsers = await User.count({ where: { isVerified: true } });
    const totalUnverifiedUsers = await User.count({ where: { isVerified: false } });

    res.status(200).json({
      totalUsers,
      totalAgents,
      activeUsers,
      totalSawa,
      totalGems,
      totalStoreItems,
      availableStoreItems,
      activePercentage,
      extra: {
        totalAdmins,
        totalUsersOnly,
        totalVerifiedUsers,
        totalUnverifiedUsers,
      }
    });
  } catch (err) {
    console.error("❌ Error fetching stats:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

router.get("/admin/settings", async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;

    const offset = (page - 1) * limit;

    const { count, rows: settings } = await Settings.findAndCountAll({
      where: { isActive: true },
      limit: parseInt(limit), 
      offset: parseInt(offset),
    });

    res.status(200).json({
      totalItems: count,
      totalPages: Math.ceil(count / limit),
      currentPage: parseInt(page),
      settings,
    });
  } catch (err) {
    console.error("❌ Error fetching settings:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/admin/settings", upload.none(), async (req, res) => {
  try {
    const { key, value, description } = req.body;

    if (!key || value === undefined) {
      return res.status(400).json({ error: "Key and value are required" });
    }

    const existingSetting = await Settings.findOne({ where: { key } });

    if (existingSetting) {
      await existingSetting.update({ value, description });
      res.status(200).json({ 
        message: "Setting updated successfully", 
        setting: existingSetting 
      });
    } else {
      const newSetting = await Settings.create({ key, value, description });
      res.status(201).json({ 
        message: "Setting created successfully", 
        setting: newSetting 
      });
    }
  } catch (err) {
    console.error("❌ Error managing setting:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

router.get("/admin/settings/:key", async (req, res) => {
  try {

    const { key } = req.params;
    const setting = await Settings.findOne({ where: { key, isActive: true } });

    if (!setting) {
      return res.status(404).json({ error: "Setting not found" });
    }

    res.status(200).json(setting);
  } catch (err) {
    console.error("❌ Error fetching setting:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

router.get("/terms", async (req, res) => {
    try {
        const terms = await Tearms.findAll();
        res.status(200).json(terms);
    } catch (error) {
        console.error("Error fetching terms:", error);
        res.status(500).json({ error: "Failed to fetch terms" });
    }
});

router.post("/terms", upload.none(), async (req, res) => {
    try {
        const { content } = req.body;

        if (!content) {
            return res.status(400).json({ error: "Content is required" });
        }
        const existingTerm = await Tearms.findOne();

        if (existingTerm) {
            existingTerm.description = content;
            await existingTerm.save();
            return res.status(200).json({ message: "Term updated successfully", term: existingTerm });
        } else {
            const newTerm = await Tearms.create({ description: content });
            return res.status(201).json({ message: "Term created successfully", term: newTerm });
        }
    } catch (error) {
        console.error("Error creating or updating term:", error);
        res.status(500).json({ error: "Failed to create or update term" });
    }
});


module.exports = router;