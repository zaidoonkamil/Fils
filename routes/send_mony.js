const express = require('express');
const router = express.Router();
const multer = require("multer");
const {
  User,
  DailyAction,
  UserCounter,
  Counter,
  Settings,
  TransferHistory,
  WithdrawalRequest,
  Referrals,
  AdminBalanceLog,
} = require("../models");
const { Op } = require("sequelize");
const { sendNotificationToRole } = require("../services/notifications");
const { sendNotificationToUser } = require("../services/notifications");
const upload = require("../middlewares/uploads");
const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");
const { requireAdmin , authenticateTokenUser} = require("../middlewares/auth");

function getRequestIp(req) {
  return (
    req.headers["x-forwarded-for"]?.toString().split(",")[0].trim() ||
    req.ip ||
    null
  );
}

async function createAdminBalanceLog({
  transaction,
  adminId,
  targetUserId,
  balanceType,
  amount,
  balanceBefore,
  balanceAfter,
  note,
  req,
}) {
  return AdminBalanceLog.create(
    {
      adminId,
      targetUserId,
      balanceType,
      amount,
      balanceBefore,
      balanceAfter,
      actionType: amount >= 0 ? "add" : "subtract",
      note: note || null,
      ipAddress: getRequestIp(req),
      userAgent: req.headers["user-agent"] || null,
    },
    { transaction }
  );
}


router.post("/daily-action", authenticateTokenUser, upload.none(), async (req, res) => {
  const user_id = req.user.id;

  const t = await sequelize.transaction();

  try {
    const user = await User.findByPk(user_id, { transaction: t });
    if (!user) {
      await t.rollback();
      return res.status(404).json({ error: "المستخدم غير موجود" });
    }

    const now = new Date();

    let dailyAction = await DailyAction.findOne({
      where: { user_id },
      transaction: t
    });

    if (dailyAction) {
      const lastTime = new Date(dailyAction.lastActionTime);
      const diffInMs = now - lastTime;
      const diffInHours = diffInMs / (1000 * 60 * 60);

      if (diffInHours < 24) {
        await t.rollback();
        return res.status(400).json({
          error: `يمكنك المحاولة مجددًا بعد ${(24 - diffInHours).toFixed(2)} ساعة`,
        });
      }

      dailyAction.lastActionTime = now;
      await dailyAction.save({ transaction: t });
    } else {
      await DailyAction.create(
        {
          user_id,
          lastActionTime: now,
        },
        { transaction: t }
      );
    }

    const activeUserCounters = await UserCounter.findAll({
      where: {
        userId: user_id,
        endDate: {
          [Op.gt]: now
        }
      },
      include: [{ model: Counter }],
      transaction: t
    });

    let totalJewels = 30;
    let totalSawa = 0;

    activeUserCounters.forEach((userCounter) => {
      const counter = userCounter.Counter;
      if (!counter) return;

      if (counter.type === "gems") {
        totalJewels += counter.points;
      } else if (counter.type === "points") {
        totalSawa += counter.points;
      }
    });

    if (typeof user.Jewel === "number" && !isNaN(user.Jewel)) {
      user.Jewel += totalJewels;
    }

    if (typeof user.sawa === "number" && !isNaN(user.sawa)) {
      user.sawa += totalSawa;
    }

    let referralBonus = 0;
    let referrerUser = null;

    const referralRecord = await Referrals.findOne({
      where: { referredUserId: user.id },
      transaction: t
    });

    if (referralRecord && totalSawa > 0) {
      const referralRewardSetting = await Settings.findOne({
        where: { key: "referral_reward_percentage", isActive: true },
        transaction: t
      });

      const referralPercentage = referralRewardSetting
        ? parseFloat(referralRewardSetting.value)
        : 0;

      if (!isNaN(referralPercentage) && referralPercentage > 0) {
        referralBonus = (totalSawa * referralPercentage) / 100;

        referralBonus = Math.floor(referralBonus);

        if (referralBonus > 0) {
          referrerUser = await User.findByPk(referralRecord.referrerId, {
            transaction: t
          });

          if (
            referrerUser &&
            typeof referrerUser.sawa === "number" &&
            !isNaN(referrerUser.sawa)
          ) {
            referrerUser.sawa += referralBonus;
            await referrerUser.save({ transaction: t });
          }
        }
      }
    }

    await user.save({ transaction: t });
    await t.commit();

    if (referrerUser && referralBonus > 0) {
      try {
        await sendNotificationToUser(
          referrerUser.id,
          `حصلت على ${referralBonus} كاك كنسبة إحالة من نشاط المستخدم ${user.name}`,
          "مكافأة إحالة"
        );
      } catch (notifyErr) {
        console.warn("⚠️ فشل إرسال إشعار الإحالة:", notifyErr);
      }
    }

    res.json({
      success: true,
      message: "تم تنفيذ العملية بنجاح",
      jewelsAdded: totalJewels,
      sawaAdded: totalSawa,
      referralBonus,
      referrerId: referrerUser ? referrerUser.id : null,
      newJewelBalance: user.Jewel,
      newCardBalance: user.card,
      newSawaBalance: user.sawa
    });

  } catch (error) {
    await t.rollback();
    console.error(error);
    res.status(500).json({ error: "حدث خطأ أثناء تنفيذ العملية" });
  }
});

router.get("/daily-action", authenticateTokenUser, async (req, res) => {
  const user_id = req.user.id;

  if (!user_id) {
    return res.status(400).json({ error: "user_id مطلوب في الرابط" });
  }

  try {
    const dailyAction = await DailyAction.findOne({ where: { user_id } });

    if (!dailyAction) {
      return res.json({ 
        canDoAction: true, 
        remainingTime: "00:00", 
        message: "يمكنك تنفيذ العملية الآن" 
      });
    }

    const now = new Date();
    const lastTime = new Date(dailyAction.lastActionTime);
    const diffInMs = now - lastTime;
    const diffInHours = diffInMs / (1000 * 60 * 60);

    if (diffInHours >= 24) {
      return res.json({ 
        canDoAction: true, 
        remainingTime: "00:00", 
        message: "يمكنك تنفيذ العملية الآن" 
      });
    } else {
      const remainingMs = 24 * 60 * 60 * 1000 - diffInMs;
      const remainingMinutesTotal = Math.floor(remainingMs / (1000 * 60));
      const hours = Math.floor(remainingMinutesTotal / 60);
      const minutes = remainingMinutesTotal % 60;

      const formattedTime = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;

      return res.json({ 
        canDoAction: false, 
        remainingTime: formattedTime, 
        message: `يمكنك المحاولة مجددًا بعد ${formattedTime} ساعة` 
      });
    }

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "حدث خطأ أثناء جلب الوقت المتبقي" });
  }
});

router.post("/sendmony", authenticateTokenUser, upload.none(), async (req, res) => {
  const { receiverId, amount } = req.body;
  const senderId = req.user.id;

  const t = await sequelize.transaction();
  try {
    const transferAmount = parseFloat(amount);
    const dailyLimit = 500;

    if (isNaN(transferAmount) || transferAmount <= 0) {
      await t.rollback();
      return res.status(400).json({ error: "المبلغ غير صالح" });
    }

    if (transferAmount < 50) {
      await t.rollback();
      return res.status(400).json({ error: "لا يمكن تحويل أقل من 50 كاك" });
    }

    if (String(senderId) === String(receiverId)) {
      await t.rollback();
      return res.status(400).json({ error: "لا يمكن تحويل رصيد لنفسك" });
    }

    const sender = await User.findByPk(senderId, { transaction: t, lock: t.LOCK.UPDATE });
    if (sender && !["agent", "admin"].includes(sender.role)) {
      await t.rollback();
      return res.status(403).json({ error: "هذا التحويل متاح فقط للوكلاء والإدارة" });
    }
    if (!sender) {
      await t.rollback();
      return res.status(404).json({ error: "المرسل غير موجود" });
    }

    if (sender.sawa < transferAmount) {
      await t.rollback();
      return res.status(400).json({ error: "رصيد المرسل غير كافي" });
    }

    const receiver = await User.findByPk(receiverId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!receiver) {
      await t.rollback();
      return res.status(404).json({ error: "المستلم غير موجود" });
    }

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    const totalSentToday = await TransferHistory.sum("amount", {
      where: { senderId, createdAt: { [Op.between]: [todayStart, todayEnd] } },
      transaction: t
    });

    if ((totalSentToday || 0) + transferAmount > dailyLimit) {
      await t.rollback();
      return res.status(400).json({ error: `لا يمكنك تحويل أكثر من ${dailyLimit} كاك في اليوم` });
    }

    const fee = transferAmount * 0.1;
    const netAmount = transferAmount - fee;

    sender.sawa -= transferAmount;
    receiver.sawa += netAmount;

    await sender.save({ transaction: t });
    await receiver.save({ transaction: t });

    await TransferHistory.create({ senderId, receiverId, amount: transferAmount, fee }, { transaction: t });

    await t.commit();

    // الإشعارات بعد الـ commit
    try { await sendNotificationToUser(sender.id, `تم تحويل ${netAmount} كاك إلى ${receiver.name}`, "تحويل رصيد"); } catch {}
    try { await sendNotificationToUser(receiver.id, `استلمت ${netAmount} كاك من ${sender.name}`, "استلام رصيد"); } catch {}

    res.status(200).json({ message: `✅ تم تحويل ${netAmount} كاك. العمولة: ${fee} كاك` });

  } catch (err) {
    await t.rollback();
    console.error("❌ خطأ أثناء التحويل:", err);
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

router.post("/sendmony-simple", authenticateTokenUser, upload.none(), async (req, res) => {
  const { receiverId, amount } = req.body;
  const senderId = req.user.id;

  const t = await sequelize.transaction();
  try {
    const transferAmount = parseFloat(amount);

    if (isNaN(transferAmount) || transferAmount <= 0) {
      await t.rollback();
      return res.status(400).json({ error: "المبلغ غير صالح" });
    }

    if (String(senderId) === String(receiverId)) {
      await t.rollback();
      return res.status(400).json({ error: "لا يمكن تحويل رصيد لنفسك" });
    }

    const sender = await User.findByPk(senderId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!sender) { await t.rollback(); return res.status(404).json({ error: "المرسل غير موجود" }); }

    if (!["agent", "admin"].includes(sender.role)) {
      await t.rollback();
      return res.status(403).json({ error: "هذا التحويل متاح فقط للوكلاء والإدارة" });
    }

    if (sender.sawa < transferAmount) { await t.rollback(); return res.status(400).json({ error: "رصيد المرسل غير كافي" }); }

    const receiver = await User.findByPk(receiverId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!receiver) { await t.rollback(); return res.status(404).json({ error: "المستلم غير موجود" }); }

    if (sender.role === "agent" && receiver.role === "agent") {
      await t.rollback();
      return res.status(400).json({ error: "لا يمكن التحويل بين الوكلاء فقط" });
    }

    sender.sawa -= transferAmount;
    receiver.sawa += transferAmount;

    await sender.save({ transaction: t });
    await receiver.save({ transaction: t });

    await TransferHistory.create({ senderId, receiverId, amount: transferAmount, fee: 0 }, { transaction: t });

    await t.commit();

    try { await sendNotificationToUser(sender.id, `تم تحويل ${transferAmount} كاك إلى ${receiver.name}`, "تحويل رصيد"); } catch {}
    try { await sendNotificationToUser(receiver.id, `استلمت ${transferAmount} كاك من ${sender.name}`, "استلام رصيد"); } catch {}

    res.status(200).json({ message: `✅ تم تحويل ${transferAmount} كاك من ${sender.name} إلى ${receiver.name}. بدون عمولة.` });

  } catch (err) {
    await t.rollback();
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

router.post("/deposit-jewel", requireAdmin, upload.none(), async (req, res) => {
  const { userId, amount, note } = req.body;
  const t = await sequelize.transaction();

  try {
    const depositAmount = Number(amount);

    if (!Number.isFinite(depositAmount) || depositAmount === 0) {
      await t.rollback();
      return res.status(400).json({ error: "Invalid deposit amount" });
    }

    const user = await User.findOne({
      where: { id: userId },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });

    if (!user) {
      await t.rollback();
      return res.status(404).json({ error: "User not found" });
    }

    const balanceBefore = Number(user.Jewel || 0);
    const balanceAfter = balanceBefore + depositAmount;

    user.Jewel = balanceAfter;
    await user.save({ transaction: t });

    await createAdminBalanceLog({
      transaction: t,
      adminId: req.user.id,
      targetUserId: user.id,
      balanceType: "jewel",
      amount: depositAmount,
      balanceBefore,
      balanceAfter,
      note,
      req,
    });

    await t.commit();

    return res.status(200).json({
      message: `Successfully ${depositAmount > 0 ? "added" : "removed"} ${Math.abs(depositAmount)} jewels ${depositAmount > 0 ? "to" : "from"} ${user.name}`,
      user: {
        id: user.id,
        name: user.name,
        newBalance: user.Jewel,
      },
    });
  } catch (err) {
    await t.rollback();
    console.error("❌ Error during secure jewel deposit:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/deposit-sawa", requireAdmin, upload.none(), async (req, res) => {
  const { userId, amount, note } = req.body;
  const t = await sequelize.transaction();

  try {
    const depositAmount = Number(amount);

    if (!Number.isFinite(depositAmount) || depositAmount === 0) {
      await t.rollback();
      return res.status(400).json({
        error: "Amount must be a valid number and cannot be zero",
      });
    }

    const user = await User.findOne({
      where: { id: userId },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });

    if (!user) {
      await t.rollback();
      return res.status(404).json({ error: "User not found" });
    }

    const balanceBefore = Number(user.sawa || 0);
    const balanceAfter = balanceBefore + depositAmount;

    user.sawa = balanceAfter;
    await user.save({ transaction: t });

    await createAdminBalanceLog({
      transaction: t,
      adminId: req.user.id,
      targetUserId: user.id,
      balanceType: "sawa",
      amount: depositAmount,
      balanceBefore,
      balanceAfter,
      note,
      req,
    });

    await t.commit();

    return res.status(200).json({
      message: `Successfully updated كاك balance by ${depositAmount} for ${user.name}`,
      user: {
        id: user.id,
        name: user.name,
        newBalance: user.sawa,
      },
    });
  } catch (err) {
    await t.rollback();
    console.error("❌ Error during secure كاك deposit:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.get("/admin/balance-logs", requireAdmin, async (req, res) => {
  try {
    const page = Math.max(Number.parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 20, 1), 100);
    const offset = (page - 1) * limit;

    const where = {};
    if (req.query.balanceType) where.balanceType = req.query.balanceType;
    if (req.query.adminId) where.adminId = Number(req.query.adminId);
    if (req.query.targetUserId) where.targetUserId = Number(req.query.targetUserId);

    const { count, rows } = await AdminBalanceLog.findAndCountAll({
      where,
      include: [
        {
          model: User,
          as: "admin",
          attributes: ["id", "name", "role"],
        },
        {
          model: User,
          as: "targetUser",
          attributes: ["id", "name", "phone", "role"],
        },
      ],
      order: [["createdAt", "DESC"]],
      limit,
      offset,
    });

    return res.status(200).json({
      total: count,
      page,
      totalPages: Math.ceil(count / limit),
      logs: rows,
    });
  } catch (err) {
    console.error("❌ Error loading admin balance logs:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/admin/users/:userId/sawa-balance-adjustment", requireAdmin, upload.none(), async (req, res) => {
  const { userId } = req.params;
  const { amount, note } = req.body;
  const t = await sequelize.transaction();

  try {
    const depositAmount = Number(amount);

    if (!Number.isFinite(depositAmount) || depositAmount === 0) {
      await t.rollback();
      return res.status(400).json({
        error: "Amount must be a valid number and cannot be zero",
      });
    }

    const user = await User.findOne({
      where: { id: userId },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });

    if (!user) {
      await t.rollback();
      return res.status(404).json({ error: "User not found" });
    }

    const balanceBefore = Number(user.sawa || 0);
    const balanceAfter = balanceBefore + depositAmount;

    user.sawa = balanceAfter;
    await user.save({ transaction: t });

    await createAdminBalanceLog({
      transaction: t,
      adminId: req.user.id,
      targetUserId: user.id,
      balanceType: "sawa",
      amount: depositAmount,
      balanceBefore,
      balanceAfter,
      note,
      req,
    });

    await t.commit();

    return res.status(200).json({
      message: `Successfully updated كاك balance by ${depositAmount} for ${user.name}`,
      user: {
        id: user.id,
        name: user.name,
        newBalance: user.sawa,
      },
    });
  } catch (err) {
    await t.rollback();
    console.error("❌ Error during admin كاك balance adjustment:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/deposit-jewel", requireAdmin, upload.none(), async (req, res) => {
    const { userId, amount } = req.body;

    try {
        const depositAmount = parseInt(amount);

        if (isNaN(depositAmount) || depositAmount === 0) {
            return res.status(400).json({ error: "Invalid deposit amount" });
        }

        const user = await User.findOne({ where: { id: userId } });
        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }

        user.Jewel += depositAmount;
        await user.save();

        res.status(200).json({
            message: `Successfully ${depositAmount > 0 ? "added" : "removed"} ${Math.abs(depositAmount)} jewels ${depositAmount > 0 ? "to" : "from"} ${user.name}`,
            user: {
                id: user.id,
                name: user.name,
                newBalance: user.Jewel
            }
        });

    } catch (err) {
        console.error("❌ Error during jewel deposit:", err);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

router.post("/buy-counter", authenticateTokenUser, upload.none(), async (req, res) => {
    const { counterId } = req.body;
    const userId = req.user.id;

    try {
        const user = await User.findByPk(userId);
        if (!user) return res.status(404).json({ error: "User not found" });

        const counter = await Counter.findByPk(counterId);
        if (!counter) return res.status(404).json({ error: "Counter not found" });

        if (user.sawa < counter.price) {
            return res.status(400).json({ error: "Insufficient كاك balance" });
        }

        if (typeof user.sawa === "number" && !isNaN(user.sawa)) {
          user.sawa -= counter.price;
        }        await user.save();

        await UserCounter.create({
            userId: user.id,
            counterId: counter.id
        });

        const counterLabel = counter.name && String(counter.name).trim().length > 0
          ? counter.name
          : "Counter";

        res.status(200).json({
            message: `${counterLabel} purchased successfully!`,
            user: {
                id: user.id,
                newSawaBalance: user.sawa
            }
        });

    } catch (err) {
        console.error("❌ Error buying counter:", err);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

router.post("/deposit-sawa", requireAdmin, upload.none(), async (req, res) => {
  const { userId, amount } = req.body;

  try {
    const depositAmount = Number(amount);

    if (!Number.isFinite(depositAmount)) {
      return res.status(400).json({
        error: "Amount must be a valid number"
      });
    }
    const user = await User.findOne({
      where: { id: userId }
    });

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    user.sawa += depositAmount;
    await user.save();

    res.status(200).json({
      message: `Successfully updated كاك balance by ${depositAmount} for ${user.name}`,
      user: {
        id: user.id,
        name: user.name,
        newBalance: user.sawa
      }
    });

  } catch (err) {
    console.error("❌ Error during كاك deposit:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/withdrawalRequest", authenticateTokenUser, upload.array("images", 5), async (req, res) => {
  try {
    const { amount, method, accountNumber, cardOfName} = req.body;
    const userId = req.user.id;

    if (!userId || !amount || !method || !accountNumber || !cardOfName) {
      return res.status(400).json({ message: "يرجى إدخال جميع الحقول" });
    }

    const withdrawalAmount = parseFloat(amount);
    if (isNaN(withdrawalAmount) || withdrawalAmount <= 0) {
      return res.status(400).json({ message: "المبلغ غير صالح" });
    }

    const commissionSetting = await Settings.findOne({ where: { key: "withdrawal_commission" } });
    const minAmountSetting = await Settings.findOne({ where: { key: "withdrawal_min_amount" } });

    const commissionRate = commissionSetting ? parseFloat(commissionSetting.value.trim()) / 100 : 0;
    const minAmount = minAmountSetting ? parseFloat(minAmountSetting.value.trim()) : 6400;

    console.log("commissionRate:", commissionRate, "minAmount:", minAmount, "withdrawalAmount:", withdrawalAmount);

    const user = await User.findOne({ where: { id: userId } });
    if (!user) return res.status(404).json({ message: "المستخدم غير موجود" });
    if (user.sawa < withdrawalAmount) {
      return res.status(400).json({ message: "رصيدك غير كافٍ" });
    }

    const commission = withdrawalAmount * commissionRate;
    const netAmount = withdrawalAmount - commission;

    console.log("commission:", commission, "netAmount:", netAmount);

    if (netAmount < minAmount) {
      return res.status(400).json({
        message: `الحد الأدنى للسحب هو ${minAmount} بعد خصم العمولة`,
      });
    }

    user.sawa -= withdrawalAmount;
    await user.save();

    let images = [];

    if (req.files && req.files.length > 0) {
      images = req.files.map(file => file.filename);
    } else {
      images = ["default-withdrawal.png"];
    }


    const newRequest = await WithdrawalRequest.create({
      userId,
      amount: netAmount,
      method,
      cardOfName,
      accountNumber,
      images,
      status: "قيد الانتظار",
    });

    await sendNotificationToRole(
      "admin",
      `يوجد طلب سحب جديد بمبلغ ${netAmount} عبر ${method}`,
      "طلب سحب جديد"
    );

    res.status(201).json({
      message: `تم إرسال طلب السحب بنجاح. تم خصم ${withdrawalAmount} من رصيدك (بما يشمل العمولة ${commission.toFixed(2)})`,
      newBalance: user.sawa,
      request: newRequest,
    });

  } catch (error) {
    console.error("❌ خطأ أثناء إنشاء طلب السحب:", error);
    res.status(500).json({ message: "حدث خطأ أثناء الطلب" });
  }
});

router.get("/withdrawalRequest/pending", requireAdmin, async (req, res) => {
  try {
    const requests = await WithdrawalRequest.findAll({
      where: { status: "قيد الانتظار" },
      order: [["createdAt", "DESC"]],
      attributes: ["id", "amount", "method", "accountNumber", "status", "cardOfName","images", "createdAt"],
      include: [
        {
          model: User,
          as: "user",
          attributes: ["id", "name", "phone", "location", "role"],
        },
      ],
    });

    res.status(200).json({ requests });
  } catch (error) {
    console.error("❌ خطأ أثناء جلب الطلبات قيد الانتظار:", error);
    res.status(500).json({ message: "حدث خطأ أثناء جلب الطلبات" });
  }
});

router.get("/withdrawalRequest/accepted", requireAdmin, async (req, res) => {
  try {
    const requests = await WithdrawalRequest.findAll({
      where: { status: "مكتمل" },
      order: [["createdAt", "DESC"]],
      attributes: ["id", "amount", "method", "accountNumber", "status", "cardOfName","images", "createdAt"],
      include: [
        {
          model: User,
          as: "user",
          attributes: ["id", "name", "phone", "location", "role"],
        },
      ],
    });

    res.status(200).json({ requests });
  } catch (error) {
    console.error("خطأ أثناء جلب الطلبات المكتملة:", error);
    res.status(500).json({ message: "حدث خطأ أثناء جلب الطلبات" });
  }
});

router.get("/withdrawalRequest/processed", authenticateTokenUser, async (req, res) => {
  try {
    const userId = req.query.userId;
    if (!userId) {
      return res.status(400).json({ message: "يجب تحديد userId" });
    }

    if (req.user.role !== "admin" && String(req.user.id) !== String(userId)) {
      return res.status(403).json({ error: "غير مسموح لك بعرض طلبات سحب مستخدم آخر" });
    }

    const page = parseInt(req.query.page) || 1; 
    const limit = parseInt(req.query.limit) || 30; 
    const offset = (page - 1) * limit;

    const { count, rows: requests } = await WithdrawalRequest.findAndCountAll({
      where: { 
        status: ["مكتمل", "مرفوض","قيد الانتظار"],
        userId: userId
      },
      order: [["createdAt", "DESC"]],
      limit,
      offset,
      attributes: ["id", "amount", "method", "accountNumber", "cardOfName", "status", "images", "createdAt"],
      include: [
        {
          model: User,
          as: "user",
          attributes: ["id", "name", "phone", "location", "role"],
        },
      ],
    });

    res.status(200).json({
      requests,
      pagination: {
        total: count,        
        page,               
        limit,                
        totalPages: Math.ceil(count / limit),
      },
    });
  } catch (error) {
    console.error("❌ خطأ أثناء جلب الطلبات المكتملة أو المرفوضة للمستخدم:", error);
    res.status(500).json({ message: "حدث خطأ أثناء جلب الطلبات" });
  }
});

router.post("/withdrawalRequest/:id/status", requireAdmin, async (req, res) => {
  try {
    const requestId = req.params.id;
    const { status } = req.body;

    if (!["مكتمل", "مرفوض"].includes(status)) {
      return res.status(400).json({ message: "قيمة الحالة غير صحيحة" });
    }

    const request = await WithdrawalRequest.findOne({
      where: { id: requestId },
      include: [{ model: User, as: "user" }]
    });

    if (!request) {
      return res.status(404).json({ message: "طلب السحب غير موجود" });
    }

    request.status = status;
    await request.save();

    const user = request.user;

    if (user) {
      if (status === "مكتمل") {
        await sendNotificationToUser(
          user.id,
          `تمت معالجة طلب السحب الخاص بك بمبلغ ${request.amount} عبر ${request.method}`,
          "إشعار طلب سحب"
        );
      } else {
        user.sawa += request.amount;
        await user.save();

        await sendNotificationToUser(
          user.id,
          `تم رفض طلب السحب الخاص بك بمبلغ ${request.amount} وتمت إعادة المبلغ إلى رصيدك`,
          "إشعار طلب سحب"
        );
      }
    }

    res.status(200).json({
      message: `تم تحديث حالة الطلب إلى ${status}`,
      request
    });

  } catch (error) {
    console.error("❌ خطأ أثناء تحديث حالة الطلب:", error);
    res.status(500).json({ message: "حدث خطأ أثناء تحديث الحالة" });
  }
});

router.delete("/withdrawalRequest/:id", requireAdmin, async (req, res) => {
  try {
    const requestId = req.params.id;

    const request = await WithdrawalRequest.findOne({
      where: { id: requestId }
    });

    if (!request) {
      return res.status(404).json({ message: "طلب السحب غير موجود" });
    }

    await request.destroy();

    res.status(200).json({ message: "تم حذف طلب السحب بنجاح" });
  } catch (error) {
    console.error("❌ خطأ أثناء حذف طلب السحب:", error);
    res.status(500).json({ message: "حدث خطأ أثناء حذف الطلب" });
  }
});


module.exports = router;
