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
const { User, UserDevice } = require('../models');
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
        process.env.JWT_SECRET,
        { expiresIn: '350d' } 
    );
};

const authenticateToken = (req, res, next) => {
    const token = req.headers['authorization'];
    if (!token) return res.status(401).json({ error: "Access denied, no token provided" });

    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
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

    if (user.isLoggedIn) {
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

router.get("/allusers", async (req, res) => {
    try {
        const users = await User.findAll(); 
        res.status(200).json(users); 
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

    userData.dolar = Number((userData.sawa * 1.25).toFixed(2))

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

    userData.dolar = Number((userData.sawa * 1.25).toFixed(2))


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


module.exports = router;