const express = require('express');
const bcrypt = require("bcrypt");
const saltRounds = 10;
const router = express.Router();
const jwt = require('jsonwebtoken');
const dotenv = require('dotenv');
dotenv.config();
const multer = require("multer");
const upload = multer();
const { User, OtpCode, UserDevice, IdShop, Referrals, Tearms, Settings, CounterSale, UserCounter, Counter, AgentRequest} = require('../models');
const { Op } = require("sequelize");
const axios = require('axios');
const sequelize = require("../config/db"); 
const nodemailer = require("nodemailer");
const { sendNotificationToUser } = require('../services/notifications');


router.post("/request-agent", upload.none(), async (req, res) => {
  try {
    const userId = req.query.id;
    const { url } = req.body;

    const user = await User.findByPk(userId);
    if (user.role === "agent") {
      return res.status(400).json({ error: "أنت بالفعل وكيل" });
    }

    const existingRequest = await AgentRequest.findOne({
      where: { userId, status: "قيد الانتظار" },
    });

    if (existingRequest) {
      return res.status(400).json({ error: "لديك طلب وكالة قيد المراجعة بالفعل" });
    }

    const newRequest = await AgentRequest.create({
      userId,
      url: url || null,
    });

    res.status(201).json({
      message: "تم إرسال طلب الوكالة بنجاح ✅ سيتم مراجعته قريبًا",
      request: newRequest,
    });
  } catch (err) {
    console.error("❌ Error requesting agent:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

router.get("/admin/agent-requests", async (req, res) => {
  try {
    const requests = await AgentRequest.findAll({
      where: { status: "قيد الانتظار" },
      include: {
        model: User,
        attributes: ["id", "name", "email", "phone", "role"],
      },
      order: [["createdAt", "DESC"]],
    });

    res.status(200).json(requests);
  } catch (err) {
    console.error("❌ Error fetching agent requests:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/admin/agent-requests/:id/action", upload.none(), async (req, res) => {
  try {
    const { id } = req.params;
    const { action } = req.body;

    const request = await AgentRequest.findByPk(id, { include: User });
    if (!request) {
      return res.status(404).json({ error: "الطلب غير موجود" });
    }

    if (request.status !== "قيد الانتظار") {
      return res.status(400).json({ error: "تم التعامل مع هذا الطلب سابقًا" });
    }

    const user = request.User;

    if (action === "مكتمل") {
      request.status = "مكتمل";
      await request.save();

      try {
        await sendNotificationToUser(
          user.id,
          "تمت الموافقة على طلبك لتصبح وكيلًا 🎉",
          "طلب وكالة"
        );
      } catch (notifyErr) {
        console.warn("⚠️ Failed to send notification:", notifyErr);
      }

      res.status(200).json({ message: "✅ تم الموافقة على الطلب والمستخدم أصبح وكيلًا" });
    } else if (action === "مرفوض") {
      request.status = "مرفوض";
      await request.save();

      try {
        await sendNotificationToUser(
          request.User.id,
          "تم رفض طلبك لتصبح وكيلًا ❌",
          "طلب وكالة"
        );
      } catch (notifyErr) {
        console.warn("⚠️ Failed to send notification:", notifyErr);
      }

      res.status(200).json({ message: "❌ تم رفض طلب الوكالة" });
    } else {
      res.status(400).json({ error: "قيمة action غير صالحة" });
    }
  } catch (err) {
    console.error("❌ Error processing agent request:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});


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

const authenticateToken = async (req, res, next) => {
  try {
    const authHeader = req.headers["authorization"];

    if (!authHeader) {
      return res.status(401).json({ error: "Access denied, no token provided" });
    }

    // يدعم:
    // Authorization: Bearer xxx
    // أو إرسال التوكن مباشرة
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.split(" ")[1]
      : authHeader;

    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET || "your-secret-key-123456789"
    );

    if (!decoded.id || !decoded.email) {
      return res.status(403).json({ error: "Invalid token payload" });
    }

    const dbUser = await User.findOne({
      where: {
        id: decoded.id,
        email: decoded.email,
      },
      attributes: ["id", "email", "role", "isActive", "isVerified"],
    });

    if (!dbUser) {
      return res.status(403).json({ error: "Invalid token user" });
    }

    if (dbUser.isActive === false) {
      return res.status(403).json({ error: "User is blocked" });
    }

    req.user = {
      id: dbUser.id,
      email: dbUser.email,
      role: dbUser.role,
      isVerified: dbUser.isVerified,
    };

    next();
  } catch (err) {
    console.error("❌ Token verification error:", err.message);
    return res.status(403).json({ error: "Invalid or expired token" });
  }
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
      from: `"كاك" <${process.env.EMAIL_USER}>`,
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

router.post('/reset-password', upload.none(), async (req, res) => {
  try {
    const { email, newPassword } = req.body;

    if (!email || !newPassword) {
      return res.status(400).json({ message: 'يرجى إدخال البريد الإلكتروني وكلمة المرور الجديدة' });
    }

    const user = await User.findOne({ where: { email } });
    if (!user) {
      return res.status(404).json({ message: 'المستخدم غير موجود' });
    }

    const hashedPassword = await bcrypt.hash(newPassword, saltRounds);
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

router.get("/users/:id/referrals", async (req, res) => {
  try {
    const { id } = req.params;

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;

    const { count, rows: referrals } = await Referrals.findAndCountAll({
      where: { referrerId: id },
      include: [
        {
          model: User,
          as: "referredUser",
          attributes: [
            "id",
            "name",
            "email",
            "phone",
            "isVerified",
            "location",
            "sawa",
            "createdAt"
          ]
        }
      ],
      order: [["createdAt", "DESC"]],
      limit,
      offset
    });

    const referralPercentageSetting = await Settings.findOne({
      where: { key: "referral_reward_percentage", isActive: true }
    });

    const percentage = referralPercentageSetting
      ? parseFloat(referralPercentageSetting.value)
      : 0;

    const allReferrals = await Referrals.findAll({
      where: { referrerId: id },
      include: [
        {
          model: User,
          as: "referredUser",
          attributes: ["sawa"]
        }
      ]
    });

    let totalReferralEarnings = 0;
    let totalUserEarnings = 0;

    allReferrals.forEach((r) => {
      if (r.referredUser && typeof r.referredUser.sawa === "number") {
        totalUserEarnings += r.referredUser.sawa;

        const referralShare = (r.referredUser.sawa * percentage) / 100;
        totalReferralEarnings += referralShare;
      }
    });

    res.status(200).json({
      referrerId: id,

      stats: {
        totalReferrals: count,
        totalUsersEarnings: Math.floor(totalUserEarnings),
        totalReferralEarnings: Math.floor(totalReferralEarnings),
        referralPercentage: percentage
      },

      pagination: {
        totalItems: count,
        totalPages: Math.ceil(count / limit),
        currentPage: page,
        limit: limit,
        hasNextPage: page < Math.ceil(count / limit),
        hasPrevPage: page > 1
      },

      referrals
    });

  } catch (err) {
    console.error("❌ Error fetching referrals:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/users", upload.none(), async (req, res) => {
  const { id, name, email, location, password, note, url, refId, role = "user" } = req.body;
  let phone = req.body.phone;

  const t = await sequelize.transaction();

  try {
    const existingUser = await User.findOne({ where: { email }, transaction: t });
    if (existingUser) {
      await t.rollback();
      return res.status(400).json({ error: "البريد الإلكتروني قيد الاستخدام بالفعل" });
    }

    if (!refId) {
      await t.rollback();
      return res.status(400).json({ error: "يجب إدخال رمز الإحالة" });
    }

    const existingPhone = await User.findOne({ where: { phone }, transaction: t });
    if (existingPhone) {
      await t.rollback();
      return res.status(400).json({ error: "الهاتف قيد الاستخدام بالفعل" });
    }

    let referrer = null;
    if (refId) {
      referrer = await User.findByPk(refId, { transaction: t });

      if (!referrer) {
        await t.rollback();
        return res.status(400).json({ error: "كود الإحالة غير صحيح" });
      }
    }

    const hashedPassword = await bcrypt.hash(password, saltRounds);
    const isVerified = role === "admin" || role === "agent";

    const user = await User.create({
      id: id || undefined,
      name,
      email,
      isVerified,
      phone,
      location,
      password: hashedPassword,
      note: note || null,
      url: url || null,
      role
    }, { transaction: t });

    if (referrer) {
      await Referrals.create({
        referrerId: referrer.id,
        referredUserId: user.id
      }, { transaction: t });
    }

    await t.commit();

    try {
      await sendNotificationToUser(
        referrer.id,
        `قام المستخدم ${user.name} بالتسجيل باستخدام رمز الإحالة الخاص بك`,
        "مستخدم جديد من الإحالة"
      );
    } catch (notifyError) {
      console.warn("⚠️ فشل إرسال إشعار الإحالة:", notifyError.message);
    }

    res.status(201).json({
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      location: user.location,
      role: user.role,
      note: user.note,
      url: user.url,
      isVerified: user.isVerified,
      isLoggedIn: user.isLoggedIn,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt
    });
  } catch (err) {
    await t.rollback();
    console.error("❌ Error creating user:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/users/always-verified", upload.none(), async (req, res) => {
  const { id, name, email, location, password, note, url, role = "user" } = req.body;
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
      url: url || null,
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
      url: user.url,
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
  const { email , password } = req.body;
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

    if (user.isVerified) {
      user.isLoggedIn = false;
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

router.get("/admin/admins", async (req, res) => {
  try {
    const { page = 1, limit = 10 } = req.query;

    const parsedPage = parseInt(page) > 0 ? parseInt(page) : 1;
    const parsedLimit = parseInt(limit) > 0 ? parseInt(limit) : 10;
    const offset = (parsedPage - 1) * parsedLimit;

    const { count, rows: admins } = await User.findAndCountAll({
      where: { role: "admin" },
      limit: parsedLimit,
      offset,
      order: [["createdAt", "DESC"]],
      attributes: ["id", "name", "email", "phone", "role", "isActive", "createdAt", "updatedAt"]
    });

    res.status(200).json({
      totalAdmins: count,
      totalPages: Math.ceil(count / parsedLimit),
      currentPage: parsedPage,
      admins,
    });
  } catch (err) {
    console.error("❌ Error fetching admins:", err);
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
    const user = await User.findOne({
      where: {
        id: req.user.id,
        email: req.user.email,
      },
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

    const userData = user.toJSON();

    userData.UserCounters = (userData.UserCounters || []).map((counter) => {
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

      return {
        ...counter,
        remainingDays: null,
      };
    });

    const conversionRateSetting = await Settings.findOne({
      where: { key: "sawa_to_dollar_rate", isActive: true },
    });

    const conversionRate = conversionRateSetting
      ? parseFloat(conversionRateSetting.value)
      : 1.25;

    userData.dolar = Number((userData.sawa * conversionRate).toFixed(2));

    let totalPoints = 0;
    let totalGems = 0;

    for (const uc of userData.UserCounters) {
      if (uc.Counter) {
        if (uc.Counter.type === "points") {
          totalPoints += uc.Counter.points;
        } else if (uc.Counter.type === "gems") {
          totalGems += uc.Counter.points;
        }
      }
    }

    userData.totalPoints = totalPoints;
    userData.totalGems = totalGems;

    return res.status(200).json(userData);
  } catch (err) {
    console.error("❌ Error fetching user profile:", err);
    return res.status(500).json({ error: "Internal Server Error" });
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
      attributes: ["id", "name", "phone", "sawa", "location","note", "createdAt", "url"],
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
      await t.rollback();
      return res.status(404).json({ error: "العنصر غير موجود أو تم شراؤه" });
    }

    const user = await User.findByPk(userId, { transaction: t });
    if (!user) {
      await t.rollback();
      return res.status(404).json({ error: "المستخدم غير موجود" });
    }

    if (user.sawa < shopItem.price) {
      await t.rollback();
      return res.status(400).json({ error: "رصيدك غير كافي" });
    }

    const oldId = user.id;
    const newId = shopItem.idForSale;

    user.sawa -= shopItem.price;
    await user.save({ transaction: t });

    await UserCounter.update(
      { userId: newId },
      { where: { userId: oldId }, transaction: t }
    );

    await Counter.update(
      { userId: newId },
      { where: { userId: oldId }, transaction: t }
    );

    await Referrals.update(
      { referrerId: newId },
      { where: { referrerId: oldId }, transaction: t }
    );

    await Referrals.update(
      { referredUserId: newId },
      { where: { referredUserId: oldId }, transaction: t }
    );

    await User.update(
      { id: newId },
      { where: { id: oldId }, transaction: t }
    );

    shopItem.isAvailable = false;
    await shopItem.save({ transaction: t });

    await t.commit();

    res.status(200).json({
      message: "✅ تم شراء وتغيير الـ ID بنجاح مع نقل الإحالات",
      oldId,
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