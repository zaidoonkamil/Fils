const express = require('express');
const bcrypt = require("bcrypt");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const saltRounds = 10;
const router = express.Router();
const jwt = require('jsonwebtoken');
const dotenv = require('dotenv');
dotenv.config();
const multer = require("multer");
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, "uploads/");
  },
  filename: function (req, file, cb) {
    const ext = file.originalname.split(".").pop();
    // نستخدم Date.now() مع رقم عشوائي صغير لتجنب تعارض الأسماء إذا تم رفع أكثر من صورة في نفس اللحظة
    const uniqueSuffix = Date.now().toString() + Math.floor(Math.random() * 1000);
    cb(null, uniqueSuffix + "." + ext);
  }
});
const upload = multer({ storage: storage });
const { 
  User, OtpCode, UserDevice, IdShop, Referrals, Tearms, Settings, 
  CounterSale, UserCounter, Counter, AgentRequest, Message, Room,
  DeviceFingerprint, DeviceFingerprintUser, UserInternalVerification,
  DailyAction, TransferHistory, WithdrawalRequest, ChatMessage,
  ProductPurchase, ConsumablePurchase, UserGift, AdminBalanceLog, GiftItem
} = require('../models');
const { Op } = require("sequelize");
const axios = require('axios');
const sequelize = require("../config/db"); 
const nodemailer = require("nodemailer");
const { sendNotificationToUser } = require('../services/notifications');
const { requireAdmin, authenticateTokenUser } = require("../middlewares/auth");
const { maskArabicProfanity } = require("../services/profanityFilter");

async function findOrCreateDeviceFingerprint(installId, transaction) {
  const options = { where: { install_id: installId } };
  if (transaction) {
    options.transaction = transaction;
    options.lock = transaction.LOCK.UPDATE;
  }

  let device = await DeviceFingerprint.findOne(options);
  if (!device) {
    device = await DeviceFingerprint.create(
      { install_id: installId, last_seen_at: new Date() },
      transaction ? { transaction } : undefined
    );
  } else {
    device.last_seen_at = new Date();
    await device.save(transaction ? { transaction } : undefined);
  }
  return device;
}

async function linkDeviceToUser(deviceId, userId, transaction) {
  const options = { where: { device_id: deviceId, user_id: userId } };
  if (transaction) {
    options.transaction = transaction;
    options.lock = transaction.LOCK.UPDATE;
  }

  const existing = await DeviceFingerprintUser.findOne(options);
  if (existing) {
    existing.last_seen_at = new Date();
    await existing.save(transaction ? { transaction } : undefined);
    return existing;
  }

  return await DeviceFingerprintUser.create(
    { device_id: deviceId, user_id: userId, last_seen_at: new Date() },
    transaction ? { transaction } : undefined
  );
}

function getOneSignalInstallId(playerId) {
  if (playerId && typeof playerId === "string" && playerId.trim()) {
    return `onesignal:${playerId.trim()}`;
  }
  return null;
}

function normalizePlayerId(playerId) {
  if (playerId && typeof playerId === "string" && playerId.trim()) {
    return playerId.trim();
  }
  return null;
}

function normalizeText(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

function normalizeDateOnly(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}

function buildInternalVerificationFlags(user) {
  return {
    hasExtraPassword: Boolean(user.extraPassword),
    isInternalVerified: Boolean(user.isInternalVerified),
    internalVerifiedAt: user.internalVerifiedAt || null,
    needsExtraPasswordSetup: !user.extraPassword,
    needsInternalVerification: !user.isInternalVerified,
  };
}

function getLegacyExtraPasswordToken(user) {
  return user && user.extraPassword ? "__configured__" : "";
}

function sanitizeInternalVerificationRecord(record) {
  if (!record) return null;

  return {
    fullName: record.fullName,
    motherName: record.motherName,
    birthDate: record.birthDate,
    governorate: record.governorate,
    district: record.district,
    phone: record.phone,
    email: record.email,
    acceptedResponsibility: record.acceptedResponsibility,
    verifiedAt: record.verifiedAt,
    lastExtraPasswordResetAt: record.lastExtraPasswordResetAt,
    extraPasswordResetCount: record.extraPasswordResetCount,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function buildMaskedEmail(email) {
  const normalizedEmail = String(email || "").trim();
  const [localPart = "", domain = ""] = normalizedEmail.split("@");

  if (!localPart || !domain) {
    return normalizedEmail;
  }

  if (localPart.length <= 2) {
    return `${localPart[0] || "*"}***@${domain}`;
  }

  return `${localPart.slice(0, 2)}***@${domain}`;
}

function generateTemporaryExtraPassword() {
  return crypto.randomInt(100000, 999999).toString();
}

async function syncUserDevice(userId, playerId, transaction) {
  const normalizedPlayerId = normalizePlayerId(playerId);
  if (!normalizedPlayerId) {
    return null;
  }

  const queryOptions = { where: { player_id: normalizedPlayerId } };
  if (transaction) {
    queryOptions.transaction = transaction;
    queryOptions.lock = transaction.LOCK.UPDATE;
  }

  const existingDevice = await UserDevice.findOne(queryOptions);
  if (existingDevice) {
    if (existingDevice.user_id !== userId) {
      existingDevice.user_id = userId;
      await existingDevice.save(transaction ? { transaction } : undefined);
    }
    return existingDevice;
  }

  return await UserDevice.create(
    { user_id: userId, player_id: normalizedPlayerId },
    transaction ? { transaction } : undefined
  );
}

async function isUserLinkedToBannedDevice(userId) {
  const bannedLink = await DeviceFingerprintUser.findOne({
    where: { user_id: userId },
    include: [
      {
        model: DeviceFingerprint,
        as: "device",
        where: { is_banned: true },
        required: true,
      },
    ],
  });

  return !!bannedLink;
}


router.post("/request-agent", authenticateTokenUser, upload.none(), async (req, res) => {
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

router.get("/admin/agent-requests", requireAdmin, async (req, res) => {
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

router.post("/admin/agent-requests/:id/action", requireAdmin, upload.none(), async (req, res) => {
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

const sendMailWithFallback = async (mailOptions) => {
  const accounts = [
    { user: process.env.EMAIL_USER,  pass: process.env.EMAIL_PASS  },
    { user: process.env.EMAIL_USER2, pass: process.env.EMAIL_PASS2 },
    { user: process.env.EMAIL_USER3, pass: process.env.EMAIL_PASS3 },
    { user: process.env.EMAIL_USER4, pass: process.env.EMAIL_PASS4 },
  ];

  for (let i = 0; i < accounts.length; i++) {
    try {
      const transporter = nodemailer.createTransport({
        service: "gmail",
        auth: { user: accounts[i].user, pass: accounts[i].pass },
      });

      await transporter.sendMail({
        ...mailOptions,
        from: `"كاك" <${accounts[i].user}>`,
      });

      console.log(`✅ Email sent via account ${i + 1}`);
      return;
    } catch (err) {
      console.warn(`⚠️ Account ${i + 1} failed: ${err.message}`);
    }
  }

  console.error("❌ All email accounts failed");
};

const generateToken = (user) => {
    const expiresIn = user.role === "admin" ? "1d" : "350d";
    return jwt.sign(
        { id: user.id, email: user.email, role: user.role },
        process.env.JWT_SECRET || 'your-secret-key-123456789',
        { expiresIn } 
    );
};

const PUBLIC_READABLE_SETTINGS = new Set([
  "domino_win_fee",
  "domino_entry_fee",
  "gift_buy_commission",
  "profile_update_cost",
  "sawa_to_dollar_rate",
  "withdrawal_min_amount",
  "withdrawal_commission",
]);

const authorizeSettingRead = async (req, res, next) => {
  if (PUBLIC_READABLE_SETTINGS.has(req.params.key)) {
    return authenticateTokenUser(req, res, next);
  }

  return requireAdmin(req, res, next);
};

router.post("/users/:id/profile-edit-access", authenticateTokenUser, upload.none(), async (req, res) => {
  const transaction = await sequelize.transaction();

  try {
    const { id } = req.params;
    const loggedInUser = req.user;

    if (loggedInUser.role !== "admin" && String(loggedInUser.id) !== String(id)) {
      await transaction.rollback();
      return res.status(403).json({ error: "غير مسموح لك طلب تعديل بيانات مستخدم آخر" });
    }

    const user = await User.findByPk(id, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });

    if (!user) {
      await transaction.rollback();
      return res.status(404).json({ error: "المستخدم غير موجود" });
    }

    // Admins can access profile edit without being charged.
    if (loggedInUser.role === "admin") {
      await transaction.commit();
      return res.status(200).json({
        message: "تم منح صلاحية التعديل بنجاح",
        deductedPoints: 0,
        remainingSawa: Number(user.sawa ?? 0),
      });
    }

    const profileUpdateCostSetting = await Settings.findOne({
      where: { key: "profile_update_cost", isActive: true },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });

    const profileUpdateCost = profileUpdateCostSetting
      ? parseInt(String(profileUpdateCostSetting.value).trim(), 10) || 0
      : 0;

    const currentBalance = Number(user.sawa ?? 0);
    if (currentBalance < profileUpdateCost) {
      await transaction.rollback();
      return res.status(400).json({
        error: "رصيدك غير كافٍ لتعديل الحساب",
        requiredPoints: profileUpdateCost,
        availablePoints: currentBalance,
      });
    }

    const remainingSawa = currentBalance - profileUpdateCost;
    if (profileUpdateCost > 0) {
      user.sawa = remainingSawa;
      await user.save({ transaction });
    }

    await transaction.commit();

    return res.status(200).json({
      message: "تم خصم تكلفة تعديل الحساب بنجاح",
      deductedPoints: profileUpdateCost,
      remainingSawa,
    });
  } catch (err) {
    await transaction.rollback();
    console.error("❌ Error charging profile edit access:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.put("/users/:id", authenticateTokenUser, upload.array("images", 5), async (req, res) => {
  try {
    console.log("==== PUT /users/" + req.params.id + " ====");
    console.log("REQ.FILES:", req.files);
    console.log("REQ.BODY:", JSON.stringify(req.body, null, 2));
    const { id } = req.params;
    const {
      name, email, phone, location, note, url,
      password, extraPassword, isActive, isVerified, role
    } = req.body;

    const loggedInUser = req.user;

    if (loggedInUser.role !== "admin" && String(loggedInUser.id) !== String(id)) {
      return res.status(403).json({ error: "غير مسموح لك تعديل بيانات مستخدم آخر" });
    }

    const user = await User.findByPk(id);

    if (!user) {
      return res.status(404).json({ error: "المستخدم غير موجود" });
    }

    if (req.files && req.files.length > 0) {
      if (user.images && user.images.length > 0) {
        user.images.forEach((oldImage) => {
          const oldImagePath = path.join(__dirname, "..", "uploads", oldImage);
          if (fs.existsSync(oldImagePath)) {
            fs.unlinkSync(oldImagePath);
          }
        });
      }

      const images = req.files
        .map(file => file.filename)
        .filter(Boolean);

      user.images = images;
    }

    // باقي الحقول
    if (email && email !== user.email) {
      const existingEmail = await User.findOne({ where: { email } });
      if (existingEmail) {
        return res.status(400).json({ error: "البريد الإلكتروني قيد الاستخدام بالفعل" });
      }
      user.email = email;
    }

    if (phone && phone !== user.phone) {
      const existingPhone = await User.findOne({ where: { phone } });
      if (existingPhone) {
        return res.status(400).json({ error: "الهاتف قيد الاستخدام بالفعل" });
      }
      user.phone = phone;
    }

    if (name !== undefined) user.name = name;
    if (location !== undefined) user.location = location;
    if (note !== undefined) user.note = note;
    if (url !== undefined) user.url = url;

    if (password) {
      user.password = await bcrypt.hash(password, saltRounds);
    }

    if (extraPassword) {
      user.extraPassword = await bcrypt.hash(extraPassword, saltRounds);
    }

    // admin
    if (loggedInUser.role === "admin") {
      if (isActive !== undefined) user.isActive = isActive === "true" || isActive === true;
      if (isVerified !== undefined) user.isVerified = isVerified === "true" || isVerified === true;
      if (role) user.role = role;
    }

    await user.save();

    res.status(200).json({
      message: "تم التعديل بنجاح",
      user
    });

  } catch (err) {
    console.error("❌ Error updating user:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/users/extra-password/change", authenticateTokenUser, upload.none(), async (req, res) => {
  try {
    const id = req.user.id;

    const { currentExtraPassword, newExtraPassword } = req.body;

    if (!currentExtraPassword || !newExtraPassword) {
      return res.status(400).json({ error: "يرجى إدخال الرمز الحالي والرمز الجديد" });
    }

    const user = await User.findByPk(id);
    if (!user) {
      return res.status(404).json({ error: "المستخدم غير موجود" });
    }

    if (!user.extraPassword) {
      return res.status(400).json({ error: "لم يتم تعيين الرمز الإضافي بعد" });
    }

    const isValid = await bcrypt.compare(currentExtraPassword, user.extraPassword);
    if (!isValid) {
      return res.status(400).json({ error: "الرمز الإضافي الحالي غير صحيح" });
    }

    const isSame = await bcrypt.compare(newExtraPassword, user.extraPassword);
    if (isSame) {
      return res.status(400).json({ error: "الرمز الجديد يجب أن يكون مختلفاً عن الحالي" });
    }

    user.extraPassword = await bcrypt.hash(newExtraPassword, saltRounds);
    await user.save();

    return res.status(200).json({ message: "تم تغيير الرمز الإضافي بنجاح" });

  } catch (err) {
    console.error("❌ Error changing extra password:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/users/:id/extra-password/set", authenticateTokenUser, upload.none(), async (req, res) => {
  try {
    const { id } = req.params;
    const { extraPassword } = req.body;

    if (req.user.role !== "admin" && String(req.user.id) !== String(id)) {
      return res.status(403).json({ error: "غير مسموح لك تعيين رمز لمستخدم آخر" });
    }

    if (!extraPassword) {
      return res.status(400).json({ error: "يرجى إدخال الرمز الإضافي" });
    }

    const user = await User.findByPk(id);
    if (!user) {
      return res.status(404).json({ error: "المستخدم غير موجود" });
    }

    if (user.extraPassword) {
      return res.status(400).json({ error: "الرمز الإضافي مُعيَّن مسبقاً، تواصل مع الأدمن لإعادة تعيينه" });
    }

    user.extraPassword = await bcrypt.hash(extraPassword, saltRounds);
    await user.save();

    return res.status(200).json({ message: "تم تعيين الرمز الإضافي بنجاح" });

  } catch (err) {
    console.error("❌ Error setting extra password:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/users/:id/extra-password/verify", authenticateTokenUser, upload.none(), async (req, res) => {
  try {
    const { id } = req.params;
    const { extraPassword } = req.body;

    if (!extraPassword) {
      return res.status(400).json({ error: "يرجى إدخال الرمز الإضافي" });
    }

    if (req.user.role !== "admin" && String(req.user.id) !== String(id)) {
      return res.status(403).json({ error: "غير مسموح لك التحقق لمستخدم آخر" });
    }

    const user = await User.findByPk(id);
    if (!user) {
      return res.status(404).json({ error: "المستخدم غير موجود" });
    }

    if (!user.extraPassword) {
      return res.status(400).json({ error: "لم يتم تعيين الرمز الإضافي لهذا المستخدم بعد" });
    }

    const isValid = await bcrypt.compare(extraPassword, user.extraPassword);

    return res.status(200).json({
      valid: isValid,
      message: isValid ? "الرمز الإضافي صحيح" : "الرمز الإضافي غير صحيح"
    });
  } catch (err) {
    console.error("❌ Error verifying extra password:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.get("/users/internal-verification/status", authenticateTokenUser, async (req, res) => {
  try {
    const user = await User.findByPk(req.user.id, {
      include: [
        {
          model: UserInternalVerification,
          as: "internalVerification",
        },
      ],
    });

    if (!user) {
      return res.status(404).json({ error: "المستخدم غير موجود" });
    }

    return res.status(200).json({
      success: true,
      flags: buildInternalVerificationFlags(user),
      verification: user.isInternalVerified
        ? sanitizeInternalVerificationRecord(user.internalVerification)
        : null,
      defaults: {
        fullName: "",
        phone: user.phone,
        email: user.email,
        location: user.location,
      },
    });
  } catch (err) {
    console.error("❌ Error fetching internal verification status:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/users/internal-verification", authenticateTokenUser, upload.none(), async (req, res) => {
  const transaction = await sequelize.transaction();

  try {
    const {
      fullName,
      motherName,
      birthDate,
      governorate,
      district,
      phone,
      extraPassword,
      confirmExtraPassword,
      email,
      accountPassword,
      acceptedResponsibility,
    } = req.body;

    if (
      !fullName ||
      !motherName ||
      !birthDate ||
      !governorate ||
      !district ||
      !phone ||
      !extraPassword ||
      !confirmExtraPassword ||
      !email ||
      !accountPassword
    ) {
      await transaction.rollback();
      return res.status(400).json({ error: "جميع حقول التوثيق مطلوبة" });
    }

    const accepted =
      acceptedResponsibility === true ||
      acceptedResponsibility === "true" ||
      acceptedResponsibility === "1" ||
      acceptedResponsibility === 1;

    if (!accepted) {
      await transaction.rollback();
      return res.status(400).json({ error: "يجب الموافقة على مسؤولية صحة المعلومات" });
    }

    if (String(extraPassword) !== String(confirmExtraPassword)) {
      await transaction.rollback();
      return res.status(400).json({ error: "تأكيد كلمة الأمان الإضافية غير مطابق" });
    }

    const normalizedBirthDate = normalizeDateOnly(birthDate);
    if (!normalizedBirthDate) {
      await transaction.rollback();
      return res.status(400).json({ error: "تاريخ الميلاد غير صالح" });
    }

    const user = await User.findByPk(req.user.id, {
      transaction,
      lock: transaction.LOCK.UPDATE,
      include: [
        {
          model: UserInternalVerification,
          as: "internalVerification",
        },
      ],
    });

    if (!user) {
      await transaction.rollback();
      return res.status(404).json({ error: "المستخدم غير موجود" });
    }

    const isPasswordValid = await bcrypt.compare(accountPassword, user.password);
    if (!isPasswordValid) {
      await transaction.rollback();
      return res.status(400).json({ error: "كلمة سر الحساب غير صحيحة" });
    }

    const normalizedUserEmail = normalizeText(user.email);
    const normalizedSubmittedEmail = normalizeText(email);
    if (normalizedSubmittedEmail !== normalizedUserEmail) {
      await transaction.rollback();
      return res.status(400).json({ error: "البريد الإلكتروني يجب أن يطابق بريد الحساب الحالي" });
    }

    const normalizedUserPhone = normalizePhone(user.phone);
    const normalizedSubmittedPhone = normalizePhone(phone);
    if (normalizedSubmittedPhone !== normalizedUserPhone) {
      await transaction.rollback();
      return res.status(400).json({ error: "رقم الهاتف يجب أن يطابق رقم الحساب الحالي" });
    }

    if (user.extraPassword) {
      const matchesExistingExtraPassword = await bcrypt.compare(extraPassword, user.extraPassword);
      if (!matchesExistingExtraPassword) {
        await transaction.rollback();
        return res.status(400).json({ error: "كلمة الأمان الإضافية الحالية غير صحيحة" });
      }
    } else {
      user.extraPassword = await bcrypt.hash(extraPassword, saltRounds);
    }

    const verificationPayload = {
      fullName: String(fullName).trim(),
      motherName: String(motherName).trim(),
      birthDate: normalizedBirthDate,
      governorate: String(governorate).trim(),
      district: String(district).trim(),
      phone: String(phone).trim(),
      email: String(email).trim().toLowerCase(),
      acceptedResponsibility: true,
      verifiedAt: new Date(),
    };

    if (user.internalVerification) {
      await user.internalVerification.update(verificationPayload, { transaction });
    } else {
      await UserInternalVerification.create(
        {
          userId: user.id,
          ...verificationPayload,
        },
        { transaction }
      );
    }

    user.isInternalVerified = true;
    user.internalVerifiedAt = new Date();
    await user.save({ transaction });

    const freshVerification = await UserInternalVerification.findOne({
      where: { userId: user.id },
      transaction,
    });

    await transaction.commit();

    return res.status(200).json({
      success: true,
      message: "تم توثيق الحساب الداخلي بنجاح",
      flags: buildInternalVerificationFlags(user),
      verification: sanitizeInternalVerificationRecord(freshVerification),
    });
  } catch (err) {
    await transaction.rollback();
    console.error("❌ Error creating internal verification:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/users/internal-verification/access", authenticateTokenUser, upload.none(), async (req, res) => {
  try {
    const { extraPassword } = req.body;

    if (!extraPassword) {
      return res.status(400).json({ error: "يرجى إدخال كلمة الأمان الإضافية" });
    }

    const user = await User.findByPk(req.user.id, {
      include: [
        {
          model: UserInternalVerification,
          as: "internalVerification",
        },
      ],
    });

    if (!user) {
      return res.status(404).json({ error: "المستخدم غير موجود" });
    }

    if (!user.extraPassword) {
      return res.status(400).json({ error: "لم يتم تعيين كلمة الأمان الإضافية بعد" });
    }

    if (!user.isInternalVerified || !user.internalVerification) {
      return res.status(404).json({ error: "لا توجد بيانات توثيق داخلي لهذا المستخدم" });
    }

    const isValid = await bcrypt.compare(extraPassword, user.extraPassword);
    if (!isValid) {
      return res.status(403).json({ error: "كلمة الأمان الإضافية غير صحيحة" });
    }

    return res.status(200).json({
      success: true,
      verification: sanitizeInternalVerificationRecord(user.internalVerification),
      flags: buildInternalVerificationFlags(user),
    });
  } catch (err) {
    console.error("❌ Error accessing internal verification:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/users/internal-verification/recover-extra-password", authenticateTokenUser, upload.none(), async (req, res) => {
  const transaction = await sequelize.transaction();

  try {
    const {
      fullName,
      motherName,
      birthDate,
      governorate,
      district,
      phone,
      email,
      accountPassword,
    } = req.body;

    if (!fullName || !motherName || !birthDate || !governorate || !district || !phone || !email || !accountPassword) {
      await transaction.rollback();
      return res.status(400).json({ error: "جميع حقول الاسترجاع مطلوبة" });
    }

    const normalizedBirthDate = normalizeDateOnly(birthDate);
    if (!normalizedBirthDate) {
      await transaction.rollback();
      return res.status(400).json({ error: "تاريخ الميلاد غير صالح" });
    }

    const user = await User.findByPk(req.user.id, {
      transaction,
      lock: transaction.LOCK.UPDATE,
      include: [
        {
          model: UserInternalVerification,
          as: "internalVerification",
        },
      ],
    });

    if (!user) {
      await transaction.rollback();
      return res.status(404).json({ error: "المستخدم غير موجود" });
    }

    if (!user.internalVerification || !user.isInternalVerified) {
      await transaction.rollback();
      return res.status(404).json({ error: "لا توجد بيانات توثيق داخلي مطابقة لهذا الحساب" });
    }

    const isPasswordValid = await bcrypt.compare(accountPassword, user.password);
    if (!isPasswordValid) {
      await transaction.rollback();
      return res.status(400).json({ error: "كلمة سر الحساب غير صحيحة" });
    }

    const verification = user.internalVerification;
    const isMatch =
      normalizeText(fullName) === normalizeText(verification.fullName) &&
      normalizeText(motherName) === normalizeText(verification.motherName) &&
      normalizedBirthDate === normalizeDateOnly(verification.birthDate) &&
      normalizeText(governorate) === normalizeText(verification.governorate) &&
      normalizeText(district) === normalizeText(verification.district) &&
      normalizePhone(phone) === normalizePhone(verification.phone) &&
      normalizeText(email) === normalizeText(verification.email);

    if (!isMatch) {
      await transaction.rollback();
      return res.status(400).json({ error: "المعلومات المدخلة لا تطابق بيانات التوثيق الداخلي" });
    }

    const newExtraPassword = generateTemporaryExtraPassword();
    user.extraPassword = await bcrypt.hash(newExtraPassword, saltRounds);
    await user.save({ transaction });

    verification.lastExtraPasswordResetAt = new Date();
    verification.extraPasswordResetCount = Number(verification.extraPasswordResetCount || 0) + 1;
    await verification.save({ transaction });

    await transaction.commit();

    await sendMailWithFallback({
      to: verification.email,
      subject: "استرجاع كلمة الأمان الإضافية",
      text: `تم إنشاء كلمة أمان إضافية جديدة لحسابك: ${newExtraPassword} . يمكنك استخدامها فورًا داخل التطبيق.`,
    });

    return res.status(200).json({
      success: true,
      message: "تم إرسال كلمة أمان إضافية جديدة إلى بريدك الإلكتروني",
      sentTo: buildMaskedEmail(verification.email),
    });
  } catch (err) {
    await transaction.rollback();
    console.error("❌ Error recovering extra password:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post('/admin/users/:id/reset-extra-password', requireAdmin, upload.none(), async (req, res) => {
  try {
    const { id } = req.params;
    const { newExtraPassword } = req.body;

    if (!newExtraPassword) {
      return res.status(400).json({ message: 'يرجى إدخال الرمز الإضافي الجديد' });
    }

    const user = await User.findByPk(id);
    if (!user) {
      return res.status(404).json({ message: 'المستخدم غير موجود' });
    }

    user.extraPassword = await bcrypt.hash(newExtraPassword, saltRounds);
    await user.save();

    return res.status(200).json({ message: 'تم تحديث الرمز الإضافي بنجاح' });
  } catch (error) {
    console.error('خطأ في إعادة تعيين الرمز الإضافي:', error);
    return res.status(500).json({ message: 'حدث خطأ في السيرفر' });
  }
});

router.post("/admin/users/reset-all-extra-passwords", requireAdmin, upload.none(), async (req, res) => {
  const transaction = await sequelize.transaction();

  try {
    const users = await User.findAll({
      where: {
        role: { [Op.ne]: "admin" },
      },
      attributes: ["id"],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });

    const userIds = users.map((user) => user.id);

    const [updatedUsersCount] = await User.update(
      {
        extraPassword: null,
        isInternalVerified: false,
        internalVerifiedAt: null,
      },
      {
        where: {
          id: { [Op.in]: userIds.length > 0 ? userIds : [0] },
        },
        transaction,
      }
    );

    const deletedVerificationsCount = await UserInternalVerification.destroy({
      where: {
        userId: { [Op.in]: userIds.length > 0 ? userIds : [0] },
      },
      transaction,
    });

    await transaction.commit();

    return res.status(200).json({
      success: true,
      message: "تم تصفير كلمات الأمان الإضافية وحذف بيانات التوثيق الداخلي للمستخدمين",
      updatedUsersCount,
      deletedVerificationsCount,
    });
  } catch (err) {
    await transaction.rollback();
    console.error("❌ Error resetting all extra passwords:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/otp/generate", upload.none(), async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: "يجب إدخال البريد الإلكتروني" });
    }
    await OtpCode.destroy({ where: { email, isUsed: false } });

    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    const expiryDate = new Date(Date.now() + 2 * 60 * 1000);

    await OtpCode.create({
      email,
      code: otp,
      expiryDate,
    });

    sendMailWithFallback({
      to: email,
      subject: "رمز التحقق OTP",
      text: `رمز التحقق الخاص بك هو: ${otp} صالح لمدة دقيقتين.`,
    }).catch(err => console.error("❌ Mail error:", err.message));

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
    
    // ✅ الإضافة هنا — فحص إذا المستخدم موجود
    if (!user) {
      return res.status(200).json({ 
        message: "تم التحقق من OTP بنجاح",
        user: null  // أو ما ترجع user أصلاً
      });
    }

    user.isVerified = true;
    await user.save();

    const resetToken = jwt.sign(
      { email, purpose: "reset_password" },
      process.env.JWT_SECRET || 'your-secret-key-123456789',
      { expiresIn: '10m' }
    );

    return res.status(200).json({ 
      message: "تم التحقق من OTP بنجاح",
      resetToken,
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


router.post('/admin/reset-password', requireAdmin, upload.none(), async (req, res) => {
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

router.post('/admin/users/:id/reset-password', requireAdmin, upload.none(), async (req, res) => {
  try {
    const { id } = req.params;
    const { newPassword } = req.body;

    if (!newPassword || !String(newPassword).trim()) {
      return res.status(400).json({ message: 'يرجى إدخال كلمة المرور الجديدة' });
    }

    const user = await User.findByPk(id);
    if (!user) {
      return res.status(404).json({ message: 'المستخدم غير موجود' });
    }

    user.password = await bcrypt.hash(String(newPassword).trim(), 10);
    await user.save();

    return res.status(200).json({
      success: true,
      message: 'تم تحديث كلمة المرور بنجاح',
    });
  } catch (error) {
    console.error('خطأ في تحديث كلمة مرور المستخدم:', error);
    return res.status(500).json({ message: 'حدث خطأ في السيرفر' });
  }
});

router.patch("/admin/users/:id/name", requireAdmin, upload.none(), async (req, res) => {
  try {
    const { id } = req.params;
    const { name } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: "الاسم مطلوب" });
    }

    const user = await User.findByPk(id);

    if (!user) {
      return res.status(404).json({ error: "المستخدم غير موجود" });
    }

    user.name = name.trim();
    await user.save();

    return res.status(200).json({
      message: "تم تعديل اسم المستخدم بنجاح ✅",
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        updatedAt: user.updatedAt,
      },
    });
  } catch (err) {
    console.error("❌ Error updating user name:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/reset-password", upload.none(), async (req, res) => {
  try {
    const { resetToken, newPassword } = req.body;

    if (!resetToken || !newPassword) {
      return res.status(400).json({ error: "يرجى إدخال البريد الإلكتروني وكلمة المرور الجديدة" });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ error: "كلمة المرور يجب ألا تقل عن 6 أحرف" });
    }

    let tokenPayload;
    try {
      tokenPayload = jwt.verify(resetToken, process.env.JWT_SECRET || 'your-secret-key-123456789');
    } catch (err) {
      return res.status(400).json({ error: "رمز التحقق غير صالح أو منتهي" });
    }

    if (!tokenPayload || tokenPayload.purpose !== "reset_password" || !tokenPayload.email) {
      return res.status(400).json({ error: "رمز التحقق غير صالح أو منتهي" });
    }

    const email = tokenPayload.email;
    const user = await User.findOne({ where: { email } });
    if (!user) {
      return res.status(404).json({ error: "المستخدم غير موجود" });
    }

    const hashedPassword = await bcrypt.hash(newPassword, saltRounds);
    user.password = hashedPassword;
    await user.save();

    await OtpCode.destroy({ where: { email } });

    return res.json({ message: "تم تحديث كلمة المرور بنجاح ✅" });
  } catch (error) {
    console.error("Reset password error:", error);
    return res.status(500).json({ error: "حدث خطأ في السيرفر" });
  }
});

router.delete("/users/:id", requireAdmin, async (req, res) => {
  const { id } = req.params;
  const t = await sequelize.transaction();

  try {
    const qi = sequelize.getQueryInterface();
    const qg = qi.queryGenerator;
    const describedTables = new Map();
    const getTableInfo = (model) => {
      const info = model.getTableName();
      return {
        raw: info,
        name: typeof info === "object" ? info.tableName : info,
      };
    };
    const getTableColumns = async (model) => {
      const { name } = getTableInfo(model);
      if (!describedTables.has(name)) {
        describedTables.set(name, await qi.describeTable(name, { transaction: t }));
      }
      return describedTables.get(name);
    };
    const resolveColumnName = async (model, candidates) => {
      const attributes = model.getAttributes ? model.getAttributes() : model.rawAttributes || {};

      for (const candidate of candidates) {
        if (attributes[candidate]) {
          return attributes[candidate].field || candidate;
        }
      }

      for (const attribute of Object.values(attributes)) {
        if (attribute?.field && candidates.includes(attribute.field)) {
          return attribute.field;
        }
      }

      const columns = await getTableColumns(model);
      for (const candidate of candidates) {
        if (columns[candidate]) {
          return candidate;
        }
      }

      return null;
    };

    const user = await User.findByPk(id, {
      include: [{ model: UserDevice, as: "devices" }],
      transaction: t,
      lock: t.LOCK.UPDATE,
    });

    if (!user) {
      await t.rollback();
      return res.status(404).json({ error: "المستخدم غير موجود" });
    }

    // 1) فك الارتباط من أي رسالة ترد على رسائل هذا المستخدم
    const messageTableInfo = getTableInfo(Message);
    const messageUserIdCol = await resolveColumnName(Message, ["userId", "user_id"]);
    const replyToIdCol = await resolveColumnName(Message, ["replyToId", "reply_to_id"]);
    const idCol = await resolveColumnName(Message, ["id"]);

    if (!messageUserIdCol || !replyToIdCol || !idCol) {
      throw new Error("تعذر تحديد أعمدة جدول الرسائل المطلوبة لعملية الحذف");
    }

    const qTable = qg.quoteTable(messageTableInfo.raw);
    const qUserId = qg.quoteIdentifier(messageUserIdCol);
    const qReplyToId = qg.quoteIdentifier(replyToIdCol);
    const qId = qg.quoteIdentifier(idCol);

    await sequelize.query(
      `UPDATE ${qTable} AS m
       JOIN ${qTable} AS u ON m.${qReplyToId} = u.${qId}
       SET m.${qReplyToId} = NULL
       WHERE u.${qUserId} = :userId`,
      {
        replacements: { userId: id },
        transaction: t,
      }
    );

    // 2) فك تثبيت أي رسالة داخل الغرف إذا كانت تعود لهذا المستخدم
    const roomPinnedMessageIdCol = await resolveColumnName(Room, ["pinnedMessageId", "pinned_message_id"]);
    const roomPinnedMessageCol = await resolveColumnName(Room, ["pinnedMessage", "pinned_message"]);

    if (roomPinnedMessageIdCol) {
      const roomTableInfo = getTableInfo(Room);
      const qRoomTable = qg.quoteTable(roomTableInfo.raw);
      const qPinnedMessageId = qg.quoteIdentifier(roomPinnedMessageIdCol);
      const qPinnedMessage = roomPinnedMessageCol
        ? qg.quoteIdentifier(roomPinnedMessageCol)
        : null;

      await sequelize.query(
        `UPDATE ${qRoomTable}
         SET ${qPinnedMessageId} = NULL${qPinnedMessage ? `, ${qPinnedMessage} = NULL` : ""}
         WHERE ${qPinnedMessageId} IN (
           SELECT ${qId} FROM ${qTable} WHERE ${qUserId} = :userId
         )`,
        {
          replacements: { userId: id },
          transaction: t,
        }
      );
    }

    // 3) حذف رسائل المستخدم نفسه (حسب اسم العمود الحقيقي)
    await Message.destroy({
      where: { [messageUserIdCol]: id },
      transaction: t,
    });

    // 4) حذف الأجهزة المرتبطة
    const userDeviceUserIdCol = await resolveColumnName(UserDevice, ["userId", "user_id"]);
    await UserDevice.destroy({
      where: { [userDeviceUserIdCol || "user_id"]: id },
      transaction: t,
    });

    // 5) حذف طلبات الوكالة المرتبطة
    const agentRequestUserIdCol = await resolveColumnName(AgentRequest, ["userId", "user_id"]);
    await AgentRequest.destroy({
      where: { [agentRequestUserIdCol || "userId"]: id },
      transaction: t,
    });

    // 6) حذف الإحالات المرتبطة بالمستخدم سواء كان مُحيل أو مُحال
    const referrerIdCol = await resolveColumnName(Referrals, ["referrerId", "referrer_id"]);
    const referredUserIdCol = await resolveColumnName(Referrals, ["referredUserId", "referred_user_id"]);
    await Referrals.destroy({
      where: {
        [Op.or]: [
          { [referrerIdCol || "referrerId"]: id },
          { [referredUserIdCol || "referredUserId"]: id },
        ],
      },
      transaction: t,
    });

    // 7) حذف العدادات المرتبطة بالمستخدم
    const userCounterUserIdCol = await resolveColumnName(UserCounter, ["userId", "user_id"]);
    const counterSaleUserIdCol = await resolveColumnName(CounterSale, ["userId", "user_id"]);
    if (counterSaleUserIdCol) {
      await CounterSale.destroy({
        where: { [counterSaleUserIdCol]: id },
        transaction: t,
      });
    }

    await UserCounter.destroy({
      where: { [userCounterUserIdCol || "userId"]: id },
      transaction: t,
    });

    const counterUserIdCol = await resolveColumnName(Counter, ["userId", "user_id"]);
    if (counterUserIdCol) {
      await Counter.destroy({
        where: { [counterUserIdCol]: id },
        transaction: t,
      });
    }

    // 8) حذف أكواد OTP الخاصة ببريد المستخدم إذا موجود
    if (user.email) {
      await OtpCode.destroy({
        where: { email: user.email },
        transaction: t,
      });
    }

    // 9) حذف المستخدم نفسه
    await User.destroy({
      where: { id },
      transaction: t,
    });

    await t.commit();

    return res.status(200).json({
      message: "تم حذف المستخدم وكل البيانات المرتبطة به بنجاح ✅",
      deletedUserId: Number(id),
    });

  } catch (err) {
    await t.rollback();
    console.error("❌ خطأ أثناء الحذف:", err);

    return res.status(500).json({
      error: "حدث خطأ أثناء عملية الحذف",
    });
  }
});

router.get("/users/:id/referrals", authenticateTokenUser, async (req, res) => {
  try {
    const { id } = req.params;

    if (req.user.role !== "admin" && String(req.user.id) !== String(id)) {
      return res.status(403).json({ error: "غير مسموح لك بعرض إحالات مستخدم آخر" });
    }

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;

    const { count, rows } = await Referrals.findAndCountAll({
      where: { referrerId: id },
      include: [
        {
          model: User,
          as: "referredUser",
          distinct: true,
          col: 'id',
          where: { 
            isActive: true,
            isVerified: true
          },
          attributes: [
            "id",
            "name",
            "email",
            "phone",
            "isVerified",
            "location",
            "createdAt"
          ],
          include: [
            {
              model: UserCounter,
              attributes: ["id", "points", "type", "purchaseSource"],
              where: {
                type: "points",
                purchaseSource: "system"
              },
              required: false
            }
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

    let totalReferralEarnings = 0;
    let totalUsersCounterPoints = 0;

    const referrals = rows.map((r) => {
      const referredUser = r.referredUser;

      const counterPoints = (referredUser?.UserCounters || []).reduce((sum, uc) => {
        return sum + (Number(uc.points) || 0);
      }, 0);

      const referralProfit = (counterPoints * percentage) / 100;

      totalUsersCounterPoints += counterPoints;
      totalReferralEarnings += referralProfit;

      const referral = {
        id: r.id,
        referrerId: Number(id),
        createdAt: r.createdAt,
        updatedAt: r.updatedAt ?? r.createdAt,
      };

      // أضف referredUserId فقط إذا موجود
      if (r.referredUserId !== null && r.referredUserId !== undefined) {
        referral.referredUserId = r.referredUserId;
      }

      // أضف referredUser فقط إذا موجود
      if (referredUser) {
        referral.referredUser = {
          id: referredUser.id,
          name: referredUser.name,
          email: referredUser.email,
          phone: referredUser.phone,
          isVerified: referredUser.isVerified,
          location: referredUser.location,
          sawa: Math.floor(counterPoints),
          createdAt: referredUser.createdAt,
        };
      }

      return referral;
    });

    res.status(200).json({
      referrerId: String(id),
      stats: {
        totalReferrals: count,
        totalUsersEarnings: Math.floor(totalUsersCounterPoints), // نفس الاسم القديم
        totalReferralEarnings: Math.floor(totalReferralEarnings),
        referralPercentage: percentage
      },
      pagination: {
        totalItems: count,
        totalPages: Math.ceil(count / limit),
        currentPage: page,
        limit,
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
  const { id, name, email, location, password, note, url, refId, player_id } = req.body;
  const phone = req.body.phone;

  const t = await sequelize.transaction();

  try {
    const resolvedInstallId = getOneSignalInstallId(player_id);
    let device = null;
    if (resolvedInstallId) {
      device = await findOrCreateDeviceFingerprint(resolvedInstallId, t);
      if (device.is_banned) {
        await t.rollback();
        return res.status(403).json({ error: "هذا الجهاز محظور" });
      }
    }

    const existingUser = await User.findOne({ where: { email }, transaction: t });
    if (existingUser) {
      await t.rollback();
      return res.status(400).json({ error: "البريد الإلكتروني قيد الاستخدام بالفعل" });
    }
    if (!name || !email || !password || !phone) {
      await t.rollback();
      return res.status(400).json({ error: "الاسم والبريد وكلمة المرور والهاتف مطلوبة" });
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

    const referrer = await User.findByPk(refId, { transaction: t });
    if (!referrer) {
      await t.rollback();
      return res.status(400).json({ error: "كود الإحالة غير صحيح" });
    }

    const hashedPassword = await bcrypt.hash(password, saltRounds);

    const sanitizedName = maskArabicProfanity(name);

    const user = await User.create({
      id: id || undefined,
      name: sanitizedName,
      email,
      isVerified: false,
      phone,
      location,
      password: hashedPassword,
      note: note || null,
      url: url || null,
      role: "user"
    }, { transaction: t });

    if (device) {
      await linkDeviceToUser(device.id, user.id, t);
    }

    await syncUserDevice(user.id, player_id, t);

    await Referrals.create({
      referrerId: referrer.id,
      referredUserId: user.id
    }, { transaction: t });

    await t.commit();

    try {
      await sendNotificationToUser(
        referrer.id,
        `قام المستخدم ${user.name}  بالتسجيل باستخدام رمز الإحالة الخاص بك للعلم لا يدخل الى الفريق الابتوثيق حسابه`,
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

router.post("/users/always-verified", requireAdmin, upload.none(), async (req, res) => {
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
  const { email, password, player_id } = req.body;
  let resolvedInstallId = null;
  try {

    if (!email) {
      return res.status(400).json({ error: "يرجى إدخال البريد الإلكتروني" });
    }

    if (!password) {
      return res.status(400).json({ error: "يرجى إدخال كلمة المرور" });
    }

    const user = await User.findOne({ where: { email } });
    if (!user) {
      return res.status(400).json({ error: "البريد الإلكتروني غير صحيح" });
    }

    if (!user.isActive) {
      return res.status(403).json({ error: "الحساب محظور" });
    }

    if (user.role !== 'admin' && user.isLoggedIn) {
      return res.status(403).json({ error: "لا يمكن تسجيل الدخول من أكثر من جهاز في نفس الوقت" });
    }

    if (user.role !== "admin") {
      const linkedBanned = await isUserLinkedToBannedDevice(user.id);
      if (linkedBanned) {
        user.isActive = false;
        await user.save();
        return res.status(403).json({ error: "هذا الجهاز محظور" });
      }
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return res.status(400).json({ error: "كلمة المرور غير صحيحة" });
    }

    if (user.role !== "admin") {
      let fallbackPlayerId = normalizePlayerId(player_id);
      if (!fallbackPlayerId) {
        const storedDevice = await UserDevice.findOne({
          where: { user_id: user.id },
          attributes: ["player_id"],
        });
        if (storedDevice && storedDevice.player_id) {
          fallbackPlayerId = storedDevice.player_id;
        }
      }

      resolvedInstallId = getOneSignalInstallId(fallbackPlayerId);
      if (resolvedInstallId) {
        const device = await findOrCreateDeviceFingerprint(resolvedInstallId);
        if (device.is_banned) {
          if (user.isActive) {
            user.isActive = false;
            await user.save();
          }
          return res.status(403).json({ error: "هذا الجهاز محظور" });
        }

        await linkDeviceToUser(device.id, user.id);
        await syncUserDevice(user.id, fallbackPlayerId);
      }
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
        dolar: user.dolar,
        extraPassword: getLegacyExtraPasswordToken(user),
        ...buildInternalVerificationFlags(user),
      },
      token
    });

  } catch (err) {
    console.error("❌ خطأ أثناء تسجيل الدخول:", err);
    res.status(500).json({ error: "خطأ داخلي في الخادم" });
  }
});

router.post("/admin/login", upload.none(), async (req, res) => {
  const { email, password } = req.body;

  try {
    if (!email || !password) {
      return res.status(400).json({ error: "يرجى إدخال البريد الإلكتروني وكلمة المرور" });
    }

    const user = await User.findOne({ where: { email } });

    if (!user) {
      return res.status(400).json({ error: "البريد الإلكتروني غير صحيح" });
    }

    if (user.role !== "admin") {
      return res.status(403).json({ error: "هذا الرابط مخصص للأدمن فقط" });
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);

    if (!isPasswordValid) {
      return res.status(400).json({ error: "كلمة المرور غير صحيحة" });
    }

    const token = generateToken(user);

    res.status(200).json({
      message: "Admin login successful",
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role
      },
      token
    });

  } catch (err) {
    console.error("❌ خطأ أثناء تسجيل دخول الأدمن:", err);
    res.status(500).json({ error: "خطأ داخلي في الخادم" });
  }
});

router.patch("/users/:id/status", requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { isActive } = req.body;

  try {
    const user = await User.findByPk(id);
    if (!user) {
      return res.status(404).json({ error: "المستخدم غير موجود" });
    }

    user.isActive = isActive;
    await user.save();

    // اذا تم الحظر/فك الحظر من لوحة الادمن نطبّقه على الجهاز المرتبط ايضا
    if (isActive === false) {
      const links = await DeviceFingerprintUser.findAll({
        where: { user_id: id },
        attributes: ["device_id"],
      });
      const deviceIds = links.map((l) => l.device_id);
      if (deviceIds.length > 0) {
        await DeviceFingerprint.update(
          {
            is_banned: true,
            banned_by: req.user.id,
            banned_reason: "حظر من لوحة الادمن",
          },
          { where: { id: { [Op.in]: deviceIds } } }
        );
      }
    } else if (isActive === true) {
      const links = await DeviceFingerprintUser.findAll({
        where: { user_id: id },
        attributes: ["device_id"],
      });
      const deviceIds = links.map((l) => l.device_id);
      if (deviceIds.length > 0) {
        await DeviceFingerprint.update(
          {
            is_banned: false,
            banned_by: null,
            banned_reason: null,
          },
          { where: { id: { [Op.in]: deviceIds } } }
        );
      }
    }

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

router.post("/admin/device-ban", requireAdmin, upload.none(), async (req, res) => {
  const { userId, player_id, reason } = req.body;

  try {
    if (!userId && !player_id) {
      return res.status(400).json({ error: "يرجى إدخال userId أو player_id" });
    }

    const deviceIds = new Set();
    if (player_id) {
      const installId = getOneSignalInstallId(player_id);
      const device = await DeviceFingerprint.findOne({ where: { install_id: installId } });
      if (!device) {
        return res.status(404).json({ error: "معرف الجهاز غير موجود" });
      }
      deviceIds.add(device.id);
    }

    if (userId) {
      const user = await User.findByPk(userId);
      if (!user) {
        return res.status(404).json({ error: "المستخدم غير موجود" });
      }

      const links = await DeviceFingerprintUser.findAll({
        where: { user_id: userId },
        attributes: ["device_id"],
      });

      links.forEach(link => deviceIds.add(link.device_id));

      user.isActive = false;
      await user.save();
    }

    if (deviceIds.size === 0) {
      return res.json({
        message: "تم حظر الحساب (لا يوجد جهاز مرتبط)",
        deviceCount: 0,
      });
    }

    await DeviceFingerprint.update(
      {
        is_banned: true,
        banned_by: req.user.id,
        banned_reason: reason || null,
      },
      { where: { id: { [Op.in]: Array.from(deviceIds) } } }
    );

    const linkedUsers = await DeviceFingerprintUser.findAll({
      where: { device_id: { [Op.in]: Array.from(deviceIds) } },
      attributes: ["user_id"],
    });

    if (linkedUsers.length > 0) {
      await User.update(
        { isActive: false },
        { where: { id: { [Op.in]: linkedUsers.map(item => item.user_id) } } }
      );
    }

    return res.json({
      message: "تم حظر الجهاز بنجاح",
      deviceCount: deviceIds.size,
    });
  } catch (err) {
    console.error("❌ خطأ أثناء حظر الجهاز:", err);
    return res.status(500).json({ error: "خطأ داخلي في الخادم" });
  }
});

router.post("/admin/device-unban", requireAdmin, upload.none(), async (req, res) => {
  const { userId, player_id } = req.body;

  try {
    if (!userId && !player_id) {
      return res.status(400).json({ error: "يرجى إدخال userId أو player_id" });
    }

    const deviceIds = new Set();

    if (player_id) {
      const installId = getOneSignalInstallId(player_id);
      const device = await DeviceFingerprint.findOne({ where: { install_id: installId } });
      if (!device) {
        return res.status(404).json({ error: "معرف الجهاز غير موجود" });
      }
      deviceIds.add(device.id);
    }

    if (userId) {
      const user = await User.findByPk(userId);
      if (!user) {
        return res.status(404).json({ error: "المستخدم غير موجود" });
      }
      user.isActive = true;
      await user.save();

      const links = await DeviceFingerprintUser.findAll({
        where: { user_id: userId },
        attributes: ["device_id"],
      });

      links.forEach(link => deviceIds.add(link.device_id));
    }

    if (deviceIds.size === 0) {
      return res.json({
        message: "تم إلغاء حظر الحساب (لا يوجد جهاز مرتبط)",
        deviceCount: 0,
      });
    }

    await DeviceFingerprint.update(
      {
        is_banned: false,
        banned_by: null,
        banned_reason: null,
      },
      { where: { id: { [Op.in]: Array.from(deviceIds) } } }
    );

    const linkedUsers = await DeviceFingerprintUser.findAll({
      where: { device_id: { [Op.in]: Array.from(deviceIds) } },
      attributes: ["user_id"],
    });

    if (linkedUsers.length > 0) {
      await User.update(
        { isActive: true },
        { where: { id: { [Op.in]: linkedUsers.map(item => item.user_id) } } }
      );
    }

    return res.json({
      message: "تم إلغاء حظر الجهاز بنجاح",
      deviceCount: deviceIds.size,
    });
  } catch (err) {
    console.error("❌ خطأ أثناء إلغاء الحظر:", err);
    return res.status(500).json({ error: "خطأ داخلي في الخادم" });
  }
});

router.get("/allusers", requireAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 10 } = req.query; 

    const offset = (page - 1) * limit; 

    const { count, rows: users } = await User.findAndCountAll({
      limit: parseInt(limit),
      offset: parseInt(offset),
      attributes: { exclude: ["password", "extraPassword"] },
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

router.get("/admin/admins", requireAdmin, async (req, res) => {
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

router.get("/users", requireAdmin, async (req, res) => {
  try {
    const users = await User.findAll({
      where: {
        role: {
          [Op.ne]: "admin"
        }
      },
      attributes: { exclude: ["password", "extraPassword"] },
    });
    res.status(200).json(users);
  } catch (err) {
    console.error("❌ Error fetching users:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

router.get("/profile", authenticateTokenUser, async (req, res) => {
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
    delete userData.password;
    delete userData.extraPassword;
    userData.extraPassword = getLegacyExtraPasswordToken(user);

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
    userData.internalVerification = buildInternalVerificationFlags(user);

    return res.status(200).json(userData);
  } catch (err) {
    console.error("❌ Error fetching user profile:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.get("/users/search", requireAdmin, async (req, res) => {
  try {
    const { q } = req.query;

    if (!q) {
      return res.status(400).json({ error: "يرجى إدخال كلمة البحث" });
    }

    const users = await User.findAll({
      where: {
        [Op.or]: [
          { name: { [Op.like]: `%${q}%` } },
          { email: { [Op.like]: `%${q}%` } },
          { phone: { [Op.like]: `%${q}%` } },
        ],
      },
      attributes: ["id", "name", "email", "phone", "role", "isActive", "isVerified"],
      order: [["createdAt", "DESC"]],
    });

    res.status(200).json(users);
  } catch (err) {
    console.error("❌ Error searching users:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

router.get("/users/:id", authenticateTokenUser, async (req, res) => {
  const { id } = req.params;

  try {
    if (req.user.role !== "admin" && String(req.user.id) !== String(id)) {
      return res.status(403).json({ error: "غير مسموح لك بعرض بيانات مستخدم آخر" });
    }

    const user = await User.findByPk(id, {
      include: [
        {
          model: UserCounter,
           include: [{
            model: Counter,
            paranoid: false, 
          }],
        },
        {
          model: UserInternalVerification,
          as: "internalVerification",
        },
      ]
    });

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const userData = user.toJSON();
    delete userData.password;
    delete userData.extraPassword;
    userData.extraPassword = getLegacyExtraPasswordToken(user);

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
    userData.internalVerification = buildInternalVerificationFlags(user);
    userData.internalVerificationFlags = buildInternalVerificationFlags(user);
    userData.internalVerificationRecord = sanitizeInternalVerificationRecord(
      user.internalVerification
    );

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
      attributes: [
        "id",
        "name",
        "images",
        "phone",
        "sawa",
        "location",
        "note",
        "createdAt",
        "url",
        "isActive",
        "agentPrivateChatEnabled",
      ],
    });

    const shuffled = agents.sort(() => Math.random() - 0.5);

    res.status(200).json(shuffled);
  } catch (err) {
    console.error("❌ خطأ أثناء جلب الوكلاء:", err);
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

router.put("/users/:id/gems", requireAdmin, upload.none() , async (req, res) => {
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

router.post("/store/buy-id/:shopId/:userId", authenticateTokenUser, async (req, res) => {
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

    const existingUserWithNewId = await User.findByPk(newId, { transaction: t });
    if (existingUserWithNewId) {
      await t.rollback();
      return res.status(400).json({ error: "هذا الـ ID مستخدم بالفعل" });
    }

    user.sawa -= shopItem.price;
    await user.save({ transaction: t });

    await User.update(
      { id: newId },
      { where: { id: oldId }, transaction: t }
    );

    await UserCounter.update(
      { userId: newId },
      { where: { userId: oldId }, transaction: t }
    );

    await Counter.update(
      { userId: newId },
      { where: { userId: oldId }, transaction: t }
    );

    await DailyAction.update(
      { user_id: newId },
      { where: { user_id: oldId }, transaction: t }
    );

    await UserDevice.update(
      { user_id: newId },
      { where: { user_id: oldId }, transaction: t }
    );

    await DeviceFingerprintUser.update(
      { user_id: newId },
      { where: { user_id: oldId }, transaction: t }
    );

    await AgentRequest.update(
      { userId: newId },
      { where: { userId: oldId }, transaction: t }
    );

    await Message.update(
      { userId: newId },
      { where: { userId: oldId }, transaction: t }
    );

    await TransferHistory.update(
      { senderId: newId },
      { where: { senderId: oldId }, transaction: t }
    );

    await TransferHistory.update(
      { receiverId: newId },
      { where: { receiverId: oldId }, transaction: t }
    );

    await WithdrawalRequest.update(
      { userId: newId },
      { where: { userId: oldId }, transaction: t }
    );

    await ChatMessage.update(
      { senderId: newId },
      { where: { senderId: oldId }, transaction: t }
    );

    await ChatMessage.update(
      { receiverId: newId },
      { where: { receiverId: oldId }, transaction: t }
    );

    await ProductPurchase.update(
      { userId: newId },
      { where: { userId: oldId }, transaction: t }
    );

    await ConsumablePurchase.update(
      { userId: newId },
      { where: { userId: oldId }, transaction: t }
    );

    await UserGift.update(
      { userId: newId },
      { where: { userId: oldId }, transaction: t }
    );

    await UserGift.update(
      { senderId: newId },
      { where: { senderId: oldId }, transaction: t }
    );

    await UserGift.update(
      { roomOwnerId: newId },
      { where: { roomOwnerId: oldId }, transaction: t }
    );

    await UserInternalVerification.update(
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
    res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/store/add", requireAdmin, upload.none(), async (req, res) => {
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

router.delete("/store/:shopId", requireAdmin, async (req, res) => {
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
    console.error("📌 التفاصيل:", err);

    res.status(500).json({
      error: "Internal Server Error",
    });
  }
});

router.patch("/admin/users/:id/internal-verification", requireAdmin, upload.none(), async (req, res) => {
  try {
    const { id } = req.params;
    const {
      fullName,
      motherName,
      birthDate,
      governorate,
      district,
      phone,
      email,
      acceptedResponsibility,
      isInternalVerified,
      verifiedAt,
    } = req.body;

    const user = await User.findByPk(id, {
      include: [
        {
          model: UserInternalVerification,
          as: "internalVerification",
        },
      ],
    });

    if (!user) {
      return res.status(404).json({ error: "المستخدم غير موجود" });
    }

    const normalizedPayload = {
      fullName: String(fullName || "").trim(),
      motherName: String(motherName || "").trim(),
      birthDate: String(birthDate || "").trim(),
      governorate: String(governorate || "").trim(),
      district: String(district || "").trim(),
      phone: String(phone || "").trim(),
      email: String(email || "").trim().toLowerCase(),
      acceptedResponsibility:
        acceptedResponsibility === true ||
        acceptedResponsibility === "true" ||
        acceptedResponsibility === 1 ||
        acceptedResponsibility === "1",
      verifiedAt: verifiedAt ? new Date(verifiedAt) : new Date(),
    };

    const requiredFields = [
      normalizedPayload.fullName,
      normalizedPayload.motherName,
      normalizedPayload.birthDate,
      normalizedPayload.governorate,
      normalizedPayload.district,
      normalizedPayload.phone,
      normalizedPayload.email,
    ];

    if (requiredFields.some((value) => !value)) {
      return res.status(400).json({ error: "يرجى إدخال جميع معلومات التوثيق" });
    }

    if (user.internalVerification) {
      await user.internalVerification.update(normalizedPayload);
    } else {
      await UserInternalVerification.create({
        userId: user.id,
        ...normalizedPayload,
      });
    }

    const shouldBeVerified =
      isInternalVerified === true ||
      isInternalVerified === "true" ||
      isInternalVerified === 1 ||
      isInternalVerified === "1";

    user.isInternalVerified = shouldBeVerified;
    user.internalVerifiedAt = shouldBeVerified ? normalizedPayload.verifiedAt : null;
    await user.save();

    const freshVerification = await UserInternalVerification.findOne({
      where: { userId: user.id },
    });

    return res.status(200).json({
      success: true,
      message: "تم تحديث معلومات التوثيق بنجاح",
      flags: buildInternalVerificationFlags(user),
      verification: sanitizeInternalVerificationRecord(freshVerification),
    });
  } catch (err) {
    console.error("❌ Error updating internal verification by admin:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.patch("/admin/agents/:id/private-chat", requireAdmin, upload.none(), async (req, res) => {
  try {
    const { id } = req.params;
    const { enabled } = req.body;

    const agent = await User.findByPk(id);
    if (!agent || agent.role !== "agent") {
      return res.status(404).json({ error: "الوكيل غير موجود" });
    }

    agent.agentPrivateChatEnabled = enabled === true || enabled === "true";
    await agent.save();

    return res.status(200).json({
      message: agent.agentPrivateChatEnabled
        ? "تم تفعيل الشات الخاص للوكيل"
        : "تم إيقاف الشات الخاص للوكيل",
      agent: {
        id: agent.id,
        agentPrivateChatEnabled: agent.agentPrivateChatEnabled,
      },
    });
  } catch (err) {
    console.error("❌ خطأ أثناء تحديث حالة الشات الخاص للوكيل:", err);
    return res.status(500).json({ error: "خطأ في الخادم" });
  }
});

router.get("/admin/users/:userId/onesignal-data", requireAdmin, async (req, res) => {
  try {
    const userId = Number.parseInt(req.params.userId, 10);
    if (!Number.isFinite(userId)) {
      return res.status(400).json({ error: "معرف المستخدم غير صالح" });
    }

    const user = await User.findByPk(userId, {
      attributes: ["id", "name", "email", "phone", "role", "isActive", "createdAt", "updatedAt"],
    });

    if (!user) {
      return res.status(404).json({ error: "المستخدم غير موجود" });
    }

    const devices = await UserDevice.findAll({
      where: { user_id: userId },
      attributes: ["id", "player_id", "createdAt", "updatedAt"],
      order: [["updatedAt", "DESC"]],
    });

    const deviceLinks = await DeviceFingerprintUser.findAll({
      where: { user_id: userId },
      attributes: ["id", "device_id", "last_seen_at", "createdAt", "updatedAt"],
      include: [
        {
          model: DeviceFingerprint,
          as: "device",
          attributes: ["id", "install_id", "is_banned", "banned_reason", "banned_by", "last_seen_at", "createdAt", "updatedAt"],
        },
      ],
      order: [["updatedAt", "DESC"]],
    });

    const linkedDeviceIds = [...new Set(deviceLinks.map((link) => link.device_id).filter(Boolean))];

    let relatedAccounts = [];
    if (linkedDeviceIds.length > 0) {
      const relatedLinks = await DeviceFingerprintUser.findAll({
        where: { device_id: { [Op.in]: linkedDeviceIds } },
        attributes: ["device_id", "user_id", "last_seen_at", "createdAt", "updatedAt"],
        include: [
          {
            model: User,
            as: "user",
            attributes: ["id", "name", "phone", "email", "role", "isActive", "createdAt"],
          },
          {
            model: DeviceFingerprint,
            as: "device",
            attributes: ["id", "install_id", "is_banned", "last_seen_at"],
          },
        ],
        order: [["updatedAt", "DESC"]],
      });

      relatedAccounts = relatedLinks.map((link) => ({
        userId: link.user_id,
        deviceId: link.device_id,
        lastSeenAt: link.last_seen_at,
        linkedAt: link.createdAt,
        user: link.user
          ? {
              id: link.user.id,
              name: link.user.name,
              phone: link.user.phone,
              email: link.user.email,
              role: link.user.role,
              isActive: link.user.isActive,
              createdAt: link.user.createdAt,
            }
          : null,
        device: link.device
          ? {
              id: link.device.id,
              installId: link.device.install_id,
              isBanned: link.device.is_banned,
              lastSeenAt: link.device.last_seen_at,
            }
          : null,
      }));
    }

    return res.status(200).json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        isActive: user.isActive,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      },
      searchHints: {
        externalIdCandidates: [String(user.id), user.email, user.phone].filter(Boolean),
        playerIds: devices.map((device) => device.player_id).filter(Boolean),
        installIds: deviceLinks
          .map((link) => link.device?.install_id)
          .filter(Boolean),
      },
      oneSignalDevices: devices.map((device) => ({
        id: device.id,
        playerId: device.player_id,
        createdAt: device.createdAt,
        updatedAt: device.updatedAt,
      })),
      fingerprintDevices: deviceLinks.map((link) => ({
        linkId: link.id,
        deviceId: link.device_id,
        lastSeenAt: link.last_seen_at,
        linkedAt: link.createdAt,
        updatedAt: link.updatedAt,
        device: link.device
          ? {
              id: link.device.id,
              installId: link.device.install_id,
              isBanned: link.device.is_banned,
              bannedReason: link.device.banned_reason,
              bannedBy: link.device.banned_by,
              lastSeenAt: link.device.last_seen_at,
              createdAt: link.device.createdAt,
              updatedAt: link.device.updatedAt,
            }
          : null,
      })),
      relatedAccounts,
    });
  } catch (err) {
    console.error("❌ Error fetching OneSignal lookup data:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.get("/admin/stats", requireAdmin, async (req, res) => {
  try {
    const totalUsers = await User.count();

    const totalAgents = await User.count({ where: { role: "agent" } });

    const activeUsers = await User.count({ where: { isActive: true } });

    const totalSawa = await User.sum("sawa") || 0;

    const totalGems = await User.sum("Jewel") || 0;

    const totalStoreItems = await IdShop.count();

    const availableStoreItems = await IdShop.count({ where: { isAvailable: true } });

    const totalAdminTransferFees = await TransferHistory.sum("fee") || 0;

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
      totalAdminTransferFees: Number(totalAdminTransferFees || 0),
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

router.get("/admin/settings", requireAdmin, async (req, res) => {
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

router.post("/admin/settings", requireAdmin, upload.none(), async (req, res) => {
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

router.get("/admin/settings/:key", authorizeSettingRead, async (req, res) => {
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

router.post("/terms", requireAdmin, upload.none(), async (req, res) => {
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

router.patch("/users/:id/change-id", requireAdmin, upload.none(), async (req, res) => {
  const { id } = req.params;
  const { newId } = req.body;

  const t = await sequelize.transaction();

  try {
    if (!newId) {
      await t.rollback();
      return res.status(400).json({ error: "الـ newId مطلوب" });
    }

    if (String(newId) === String(id)) {
      await t.rollback();
      return res.status(400).json({ error: "الـ newId يجب أن يكون مختلف عن الـ id الحالي" });
    }

    const existingUserWithNewId = await User.findByPk(newId, { transaction: t });
    if (existingUserWithNewId) {
      await t.rollback();
      return res.status(400).json({ error: "هذا الـ ID مستخدم بالفعل" });
    }

    const user = await User.findByPk(id, { transaction: t });
    if (!user) {
      await t.rollback();
      return res.status(404).json({ error: "المستخدم غير موجود" });
    }

    const oldId = user.id;

    await User.update(
      { id: newId },
      { where: { id: oldId }, transaction: t }
    );

    await UserCounter.update(
      { userId: newId },
      { where: { userId: oldId }, transaction: t }
    );

    await Counter.update(
      { userId: newId },
      { where: { userId: oldId }, transaction: t }
    );

    await DailyAction.update(
      { user_id: newId },
      { where: { user_id: oldId }, transaction: t }
    );

    await UserDevice.update(
      { user_id: newId },
      { where: { user_id: oldId }, transaction: t }
    );

    await DeviceFingerprintUser.update(
      { user_id: newId },
      { where: { user_id: oldId }, transaction: t }
    );

    await AgentRequest.update(
      { userId: newId },
      { where: { userId: oldId }, transaction: t }
    );

    await Message.update(
      { userId: newId },
      { where: { userId: oldId }, transaction: t }
    );

    await TransferHistory.update(
      { senderId: newId },
      { where: { senderId: oldId }, transaction: t }
    );

    await TransferHistory.update(
      { receiverId: newId },
      { where: { receiverId: oldId }, transaction: t }
    );

    await WithdrawalRequest.update(
      { userId: newId },
      { where: { userId: oldId }, transaction: t }
    );

    await ChatMessage.update(
      { senderId: newId },
      { where: { senderId: oldId }, transaction: t }
    );

    await ChatMessage.update(
      { receiverId: newId },
      { where: { receiverId: oldId }, transaction: t }
    );

    await ProductPurchase.update(
      { userId: newId },
      { where: { userId: oldId }, transaction: t }
    );

    await ConsumablePurchase.update(
      { userId: newId },
      { where: { userId: oldId }, transaction: t }
    );

    await UserGift.update(
      { userId: newId },
      { where: { userId: oldId }, transaction: t }
    );

    await UserGift.update(
      { senderId: newId },
      { where: { senderId: oldId }, transaction: t }
    );

    await UserGift.update(
      { roomOwnerId: newId },
      { where: { roomOwnerId: oldId }, transaction: t }
    );

    await UserInternalVerification.update(
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

    await t.commit();

    const updatedUser = await User.findByPk(newId);

    return res.status(200).json({
      message: "تم تغيير الـ ID بنجاح بدون فقدان البيانات ✅",
      oldId,
      newId,
      user: {
        id: updatedUser.id,
        name: updatedUser.name,
        email: updatedUser.email,
        phone: updatedUser.phone,
        role: updatedUser.role,
      }
    });

  } catch (err) {
    await t.rollback();
    console.error("❌ Error changing user ID:", err);
    return res.status(500).json({
      error: "Internal Server Error"
    });
  }
});

router.delete("/emergency/fix-user/:userId", requireAdmin, async (req, res) => {
  const { userId } = req.params;
  const t = await sequelize.transaction();

  try {
    const user = await User.findByPk(userId, { transaction: t });
    if (!user) {
      await t.rollback();
      return res.status(404).json({ error: "المستخدم غير موجود" });
    }

    const deleted = await UserCounter.destroy({
      where: { userId },
      transaction: t
    });

    user.sawa = 0;
    await user.save({ transaction: t });

    await t.commit();

    return res.status(200).json({
      message: "✅ تم حذف العدادات وتصفير الرصيد",
      userId,
      deletedCounters: deleted,
      newBalance: 0
    });

  } catch (err) {
    await t.rollback();
    console.error("❌ Error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.get("/leaderboard/sawa", requireAdmin, async (req, res) => {
  try {
    const { limit = 10 } = req.query;

    const users = await User.findAll({
      where: {
        role: "user",
        isActive: true
      },
      attributes: ["id", "name", "sawa"],
      order: [["sawa", "DESC"]],
      limit: parseInt(limit),
      include: [
        {
          model: UserCounter,
          include: [{ model: Counter, paranoid: false }]
        }
      ]
    });

    const conversionRateSetting = await Settings.findOne({
      where: { key: "sawa_to_dollar_rate", isActive: true }
    });

    const conversionRate = conversionRateSetting
      ? parseFloat(conversionRateSetting.value)
      : 1.25;

    const result = users.map(u => {
      const userData = u.toJSON();

      let totalPoints = 0;
      let totalGems = 0;

      (userData.UserCounters || []).forEach(uc => {
        if (uc.Counter) {
          if (uc.Counter.type === "points") totalPoints += uc.Counter.points;
          else if (uc.Counter.type === "gems") totalGems += uc.Counter.points;
        }
      });

      return {
        id: userData.id,
        name: userData.name,
        sawa: userData.sawa,
        dolar: Number((userData.sawa * conversionRate).toFixed(2)),
        totalPoints,
        totalGems
      };
    });

    res.status(200).json(result);

  } catch (err) {
    console.error("❌ Error fetching leaderboard:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

router.get("/admin/users/:referralCode/sawa-activity", requireAdmin, async (req, res) => {
  try {
    const referralCode = Number.parseInt(req.params.referralCode, 10);
    if (!Number.isFinite(referralCode)) {
      return res.status(400).json({ error: "رمز الإحالة غير صالح" });
    }

    const user = await User.findByPk(referralCode, {
      attributes: ["id", "name", "phone", "sawa", "role", "createdAt"],
    });

    if (!user) {
      return res.status(404).json({ error: "المستخدم غير موجود" });
    }

    const [
      adminLogs,
      sentTransfers,
      receivedTransfers,
      withdrawals,
      productPurchases,
      consumablePurchases,
      sentGifts,
      receivedGifts,
      createdRooms,
      boughtCounters,
      soldCounters,
    ] = await Promise.all([
      AdminBalanceLog.findAll({
        where: { targetUserId: user.id, balanceType: "sawa" },
        include: [
          {
            model: User,
            as: "admin",
            attributes: ["id", "name", "role"],
          },
        ],
        order: [["createdAt", "DESC"]],
      }),
      TransferHistory.findAll({
        where: { senderId: user.id },
        include: [
          { model: User, as: "Receiver", attributes: ["id", "name", "phone"] },
        ],
        order: [["createdAt", "DESC"]],
      }),
      TransferHistory.findAll({
        where: { receiverId: user.id },
        include: [
          { model: User, as: "Sender", attributes: ["id", "name", "phone"] },
        ],
        order: [["createdAt", "DESC"]],
      }),
      WithdrawalRequest.findAll({
        where: { userId: user.id },
        attributes: [
          "id",
          "amount",
          "method",
          "accountNumber",
          "status",
          "createdAt",
          "updatedAt",
        ],
        order: [["createdAt", "DESC"]],
      }),
      ProductPurchase.findAll({
        where: { userId: user.id },
        attributes: ["id", "productId", "price", "createdAt"],
        order: [["createdAt", "DESC"]],
      }),
      ConsumablePurchase.findAll({
        where: { userId: user.id },
        attributes: ["id", "productId", "quantity", "totalPrice", "status", "createdAt"],
        order: [["createdAt", "DESC"]],
      }),
      UserGift.findAll({
        where: { senderId: user.id },
        include: [
          {
            model: GiftItem,
            as: "item",
            attributes: ["id", "name", "points"],
          },
          {
            model: User,
            as: "user",
            attributes: ["id", "name", "phone"],
          },
        ],
        order: [["createdAt", "DESC"]],
      }),
      UserGift.findAll({
        where: { userId: user.id },
        include: [
          {
            model: GiftItem,
            as: "item",
            attributes: ["id", "name", "points"],
          },
          {
            model: User,
            as: "sender",
            attributes: ["id", "name", "phone"],
          },
        ],
        order: [["createdAt", "DESC"]],
      }),
      Room.findAll({
        where: { creatorId: user.id },
        attributes: ["id", "name", "cost", "createdAt"],
        order: [["createdAt", "DESC"]],
      }),
      UserCounter.findAll({
        where: {
          userId: user.id,
          price: { [Op.gt]: 0 },
        },
        attributes: ["id", "counterId", "price", "purchaseSource", "createdAt"],
        include: [
          {
            model: Counter,
            attributes: ["id", "name", "type", "points"],
          },
        ],
        order: [["createdAt", "DESC"]],
      }),
      CounterSale.findAll({
        where: {
          userId: user.id,
          isSold: true,
        },
        attributes: ["id", "price", "pointsAfterCut", "originalPoints", "updatedAt", "createdAt"],
        order: [["updatedAt", "DESC"]],
      }),
    ]);

    const activities = [
      ...adminLogs.map((log) => ({
        type: "admin_balance_update",
        direction: Number(log.amount) >= 0 ? "credit" : "debit",
        amount: Math.abs(Number(log.amount) || 0),
        netChange: Number(log.amount) || 0,
        balanceBefore: Number(log.balanceBefore) || 0,
        balanceAfter: Number(log.balanceAfter) || 0,
        note: log.note,
        actor: log.admin
          ? {
              id: log.admin.id,
              name: log.admin.name,
              role: log.admin.role,
            }
          : null,
        createdAt: log.createdAt,
      })),
      ...sentTransfers.map((transfer) => ({
        type: "transfer_sent",
        direction: "debit",
        amount: Number(transfer.amount) || 0,
        fee: Number(transfer.fee) || 0,
        netChange: -(Number(transfer.amount) || 0),
        targetUser: transfer.Receiver
          ? {
              id: transfer.Receiver.id,
              name: transfer.Receiver.name,
              phone: transfer.Receiver.phone,
            }
          : null,
        createdAt: transfer.createdAt,
      })),
      ...receivedTransfers.map((transfer) => ({
        type: "transfer_received",
        direction: "credit",
        amount: Number(transfer.amount) || 0,
        fee: Number(transfer.fee) || 0,
        netChange: (Number(transfer.amount) || 0) - (Number(transfer.fee) || 0),
        sourceUser: transfer.Sender
          ? {
              id: transfer.Sender.id,
              name: transfer.Sender.name,
              phone: transfer.Sender.phone,
            }
          : null,
        createdAt: transfer.createdAt,
      })),
      ...withdrawals.map((withdrawal) => ({
        type: "withdrawal_request",
        direction: "debit",
        amount: Number(withdrawal.amount) || 0,
        netChange: -(Number(withdrawal.amount) || 0),
        status: withdrawal.status,
        method: withdrawal.method,
        accountNumber: withdrawal.accountNumber,
        createdAt: withdrawal.createdAt,
        updatedAt: withdrawal.updatedAt,
      })),
      ...productPurchases.map((purchase) => ({
        type: "digital_product_purchase",
        direction: "debit",
        amount: Number(purchase.price) || 0,
        netChange: -(Number(purchase.price) || 0),
        productId: purchase.productId,
        purchaseId: purchase.id,
        createdAt: purchase.createdAt,
      })),
      ...consumablePurchases.map((purchase) => ({
        type: "consumable_purchase",
        direction: "debit",
        amount: Number(purchase.totalPrice) || 0,
        netChange: -(Number(purchase.totalPrice) || 0),
        productId: purchase.productId,
        quantity: purchase.quantity,
        status: purchase.status,
        purchaseId: purchase.id,
        createdAt: purchase.createdAt,
      })),
      ...sentGifts.map((gift) => ({
        type: "gift_sent",
        direction: "debit",
        amount: Number(gift.item?.points) || 0,
        netChange: -(Number(gift.item?.points) || 0),
        giftId: gift.id,
        giftItem: gift.item
          ? {
              id: gift.item.id,
              name: gift.item.name,
              points: gift.item.points,
            }
          : null,
        targetUser: gift.user
          ? {
              id: gift.user.id,
              name: gift.user.name,
              phone: gift.user.phone,
            }
          : null,
        roomId: gift.roomId,
        createdAt: gift.createdAt,
      })),
      ...receivedGifts.map((gift) => ({
        type: "gift_received",
        direction: "credit",
        amount: Number(gift.item?.points) || 0,
        netChange: Number(gift.item?.points) || 0,
        note: "القيمة هنا تمثل نقاط الهدية الأساسية، وقد تختلف الحصة الصافية داخل الروم حسب نسب التوزيع.",
        giftId: gift.id,
        giftItem: gift.item
          ? {
              id: gift.item.id,
              name: gift.item.name,
              points: gift.item.points,
            }
          : null,
        sourceUser: gift.sender
          ? {
              id: gift.sender.id,
              name: gift.sender.name,
              phone: gift.sender.phone,
            }
          : null,
        roomId: gift.roomId,
        createdAt: gift.createdAt,
      })),
      ...createdRooms.map((room) => ({
        type: "room_creation",
        direction: "debit",
        amount: Number(room.cost) || 0,
        netChange: -(Number(room.cost) || 0),
        room: {
          id: room.id,
          name: room.name,
        },
        createdAt: room.createdAt,
      })),
      ...boughtCounters.map((counter) => ({
        type: counter.purchaseSource === "market" ? "counter_market_purchase" : "counter_purchase",
        direction: "debit",
        amount: Number(counter.price) || 0,
        netChange: -(Number(counter.price) || 0),
        counter: counter.Counter
          ? {
              id: counter.Counter.id,
              name: counter.Counter.name,
              type: counter.Counter.type,
              points: counter.Counter.points,
            }
          : null,
        purchaseSource: counter.purchaseSource,
        createdAt: counter.createdAt,
      })),
      ...soldCounters.map((sale) => ({
        type: "counter_sale",
        direction: "credit",
        amount: Number(sale.price) || 0,
        netChange: Number(sale.price) || 0,
        saleId: sale.id,
        originalPoints: sale.originalPoints,
        pointsAfterCut: sale.pointsAfterCut,
        createdAt: sale.updatedAt || sale.createdAt,
      })),
    ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return res.status(200).json({
      user,
      totalActivities: activities.length,
      coverageNotes: [
        "السجل يشمل التحويلات، السحب، تعديلات الأدمن، مشتريات المتاجر، الهدايا، شراء/بيع العدادات، وإنشاء الرومات.",
        "بعض العمليات القديمة أو العمليات التي لا تخزن ledger تفصيليًا قد لا تظهر بدقة كاملة.",
        "الهدايا المستلمة تُعرض بقيمة الهدية الأساسية، وقد تختلف الحصة الصافية داخل الرومات حسب نسب التوزيع وقت الإرسال.",
      ],
      activities,
    });
  } catch (err) {
    console.error("❌ Error fetching user sawa activity:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});


module.exports = router;
