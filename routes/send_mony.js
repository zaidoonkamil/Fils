const express = require('express');
const router = express.Router();
const multer = require("multer");
const upload = multer();
const { User, DailyAction, UserCounter, Counter } = require("../models");
const { Op } = require("sequelize");
const TransferHistory = require("../models/transferHistory");
const WithdrawalRequest = require("../models/withdrawalRequest");
const { sendNotificationToRole } = require("../services/notifications");
const { sendNotificationToUser } = require("../services/notifications");

router.post("/daily-action", upload.none(), async (req, res) => {
  const { user_id } = req.body;

  if (!user_id) {
    return res.status(400).json({ error: "user_id مطلوب" });
  }

  try {
    const user = await User.findByPk(user_id);
    if (!user) {
      return res.status(404).json({ error: "المستخدم غير موجود" });
    }

    const now = new Date();

    let dailyAction = await DailyAction.findOne({ where: { user_id } });

    if (dailyAction) {
      const lastTime = new Date(dailyAction.lastActionTime);
      const diffInMs = now - lastTime;
      const diffInHours = diffInMs / (1000 * 60 * 60);

      if (diffInHours < 24) {
        return res.status(400).json({
          error: `يمكنك المحاولة مجددًا بعد ${24 - diffInHours.toFixed(2)} ساعة`,
        });
      }

      dailyAction.lastActionTime = now;
      await dailyAction.save();
    } else {
      await DailyAction.create({
        user_id,
        lastActionTime: now,
      });
    }

    // جلب عدادات المستخدم الغير منتهية
    const activeUserCounters = await UserCounter.findAll({
      where: {
        userId: user_id,
        endDate: {
          [require("sequelize").Op.gt]: now
        }
      },
      include: [{ model: Counter }]
    });

    let totalJewels = 30; 
    let totalSawa = 0;

    activeUserCounters.forEach(userCounter => {
      const counter = userCounter.Counter;
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

    await user.save();


    res.json({
      success: true,
      message: "تم تنفيذ العملية بنجاح",
      jewelsAdded: totalJewels,
      sawaAdded: totalSawa,
      newJewelBalance: user.Jewel,
      newSawaBalance: user.sawa
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "حدث خطأ أثناء تنفيذ العملية" });
  }
});

router.get("/daily-action/:user_id", async (req, res) => {
  const { user_id } = req.params;

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

router.post("/sendmony", upload.none(), async (req, res) => {
  const { senderId, receiverId, amount } = req.body;

  try {
    const transferAmount = parseFloat(amount);
    const dailyLimit = 500;

    if (isNaN(transferAmount) || transferAmount <= 0) {
      return res.status(400).json({ error: "المبلغ غير صالح" });
    }

    if (transferAmount < 50) {
      return res.status(400).json({ error: "لا يمكن تحويل أقل من 50 سوا" });
    }

    const sender = await User.findByPk(senderId);
    if (!sender) {
      return res.status(404).json({ error: "المستخدم المرسل غير موجود" });
    }

    if (sender.sawa < transferAmount) {
      return res.status(400).json({ error: "رصيد المرسل غير كافي" });
    }

    const receiver = await User.findByPk(receiverId);
    if (!receiver) {
      return res.status(404).json({ error: "المستلم غير موجود" });
    }

    // تحقق من إجمالي تحويلات اليوم
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    const totalSentToday = await TransferHistory.sum("amount", {
      where: {
        senderId,
        createdAt: {
          [Op.between]: [todayStart, todayEnd],
        },
      },
    });

    if ((totalSentToday || 0) + transferAmount > dailyLimit) {
      return res.status(400).json({
        error: `لا يمكنك تحويل أكثر من ${dailyLimit} سوا في اليوم`,
      });
    }

    // حساب العمولة
    const fee = transferAmount * 0.1;
    const netAmount = transferAmount - fee;

if (typeof sender.sawa === "number" && !isNaN(sender.sawa)) {
  sender.sawa -= transferAmount;
}

if (typeof receiver.sawa === "number" && !isNaN(receiver.sawa)) {
  receiver.sawa += netAmount;
}

await sender.save();
await receiver.save();


// تسجيل العملية في سجل التحويلات
    await TransferHistory.create({
      senderId,
      receiverId,
      amount: transferAmount,
      fee,
    });

    res.status(200).json({
      message: `✅ تم تحويل ${netAmount} sawa من ${sender.name} إلى ${receiver.name}. العمولة: ${fee} sawa`,
      sender: {
        id: sender.id,
        name: sender.name,
        balance: sender.sawa,
      },
      receiver: {
        id: receiver.id,
        name: receiver.name,
        balance: receiver.sawa,
      },
    });

  } catch (err) {
    console.error("❌ خطأ أثناء التحويل:", err);
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

router.post("/sendmony-simple", upload.none(), async (req, res) => {
  const { senderId, receiverId, amount } = req.body;

  try {
    const transferAmount = parseFloat(amount);

    if (isNaN(transferAmount) || transferAmount <= 0) {
      return res.status(400).json({ error: "المبلغ غير صالح" });
    }

    const sender = await User.findByPk(senderId);
    if (!sender) {
      return res.status(404).json({ error: "المستخدم المرسل غير موجود" });
    }

    if (sender.sawa < transferAmount) {
      return res.status(400).json({ error: "رصيد المرسل غير كافي" });
    }

    const receiver = await User.findByPk(receiverId);
    if (!receiver) {
      return res.status(404).json({ error: "المستلم غير موجود" });
    }

    // خصم كامل المبلغ من المرسل وإضافته للمستلم بدون عمولة
    if (typeof sender.sawa === "number" && !isNaN(sender.sawa)) {
      sender.sawa -= transferAmount;
    }

    if (typeof receiver.sawa === "number" && !isNaN(receiver.sawa)) {
      receiver.sawa += transferAmount;
    }

    await sender.save();
    await receiver.save();

    // تسجيل العملية في سجل التحويلات بدون عمولة
    await TransferHistory.create({
      senderId,
      receiverId,
      amount: transferAmount,
      fee: 0,
    });

    res.status(200).json({
      message: `✅ تم تحويل ${transferAmount} sawa من ${sender.name} إلى ${receiver.name}. بدون عمولة.`,
      sender: {
        id: sender.id,
        name: sender.name,
        balance: sender.sawa,
      },
      receiver: {
        id: receiver.id,
        name: receiver.name,
        balance: receiver.sawa,
      },
    });

  } catch (err) {
    console.error("❌ خطأ أثناء التحويل:", err);
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

router.post("/deposit-jewel", upload.none(), async (req, res) => {
    const { userId, amount } = req.body;

    try {
        const depositAmount = parseInt(amount);

        if (isNaN(depositAmount) || depositAmount <= 0) {
            return res.status(400).json({ error: "Invalid deposit amount" });
        }

        // جلب المستخدم
        const user = await User.findOne({
            where:  { id: userId }
        });

        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }

        user.Jewel += depositAmount;

        await user.save();

        res.status(200).json({
            message: `Successfully added ${depositAmount} jewels to ${user.name}`,
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

router.post("/buy-counter", upload.none(), async (req, res) => {
    const { userId, counterId } = req.body;

    try {
        const user = await User.findByPk(userId);
        if (!user) return res.status(404).json({ error: "User not found" });

        const counter = await Counter.findByPk(counterId);
        if (!counter) return res.status(404).json({ error: "Counter not found" });

        if (user.sawa < counter.price) {
            return res.status(400).json({ error: "Insufficient sawa balance" });
        }

        // خصم السعر من sawa
if (typeof user.sawa === "number" && !isNaN(user.sawa)) {
  user.sawa -= counter.price;
}        await user.save();

        // حفظ العداد للمستخدم
        await UserCounter.create({
            userId: user.id,
            counterId: counter.id
        });

        res.status(200).json({
            message: `${counter.name} purchased successfully!`,
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

router.post("/deposit-sawa", upload.none(), async (req, res) => {
    const { userId, amount } = req.body;

    try {
        const depositAmount = parseFloat(amount);

        if (isNaN(depositAmount)) {
            return res.status(400).json({ error: "Deposit amount must be a valid number" });
        }

        if (depositAmount === 0) {
            return res.status(400).json({ error: "Deposit amount cannot be zero" });
        }

        // جلب المستخدم
        const user = await User.findOne({
            where: { id: userId }
        });

        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }


        if (typeof user.sawa === "number" && !isNaN(user.sawa)) {
          user.sawa += depositAmount;
        }

        await user.save();

        res.status(200).json({
            message: `Successfully updated sawa balance by ${depositAmount} for ${user.name}`,
            user: {
                id: user.id,
                name: user.name,
                newBalance: user.sawa
            }
        });

    } catch (err) {
        console.error("❌ Error during sawa deposit:", err);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

router.post("/withdrawalRequest", upload.none(), async (req, res) => {
  try {
    const commission = 0;
    const { userId, amount, method, accountNumber } = req.body;

    if (!userId || !amount || !method || !accountNumber) {
      return res.status(400).json({ message: "يرجى إدخال جميع الحقول" });
    }

    const withdrawalAmount = parseFloat(amount);

    if (isNaN(withdrawalAmount) || withdrawalAmount <= 0) {
      return res.status(400).json({ message: "المبلغ الذي تمتلكه غير كافي" });
    }

    const user = await User.findOne({ where: { id: userId } });
    if (!user) {
      return res.status(404).json({ message: "المستخدم غير موجود" });
    }

    if (user.sawa < withdrawalAmount) {
      return res.status(400).json({ message: "رصيدك غير كافٍ" });
    }

    const netAmount = withdrawalAmount - commission;

    if (netAmount < 6400) {
      return res.status(400).json({ message: "الحد الأدنى للمبلغ الصافي بعد خصم العمولة هو 6400" });
    }

    user.sawa -= withdrawalAmount;
    await user.save();

    const newRequest = await WithdrawalRequest.create({
      userId,
      amount: netAmount,  
      method,
      accountNumber
    });

    await sendNotificationToRole(
      "admin",
      `يوجد طلب سحب جديد بمبلغ ${netAmount} عبر ${method}`,
      "طلب سحب جديد"
    );

    res.status(201).json({
      message: `تم إرسال طلب السحب بنجاح وتم خصم ${withdrawalAmount} من رصيدك (بما يشمل العمولة)`,
      newBalance: user.sawa,
      request: newRequest
    });
  } catch (error) {
    console.error("❌ خطأ أثناء إنشاء طلب السحب:", error);
    res.status(500).json({ message: "حدث خطأ أثناء الطلب", error: error.message });
  }
});

router.get("/withdrawalRequest", async (req, res) => {
  try {
    const requests = await WithdrawalRequest.findAll({
      order: [["createdAt", "DESC"]],
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
    console.error("❌ خطأ أثناء جلب السجل:", error);
    res.status(500).json({ message: "حدث خطأ أثناء جلب السجل", error: error.message });
  }
});

router.delete("/withdrawalRequest/:id", async (req, res) => {
  try {
    const requestId = req.params.id;

    const request = await WithdrawalRequest.findOne({
      where: { id: requestId },
      include: [{ model: User, as: "user" }]
    });

    if (!request) {
      return res.status(404).json({ message: "طلب السحب غير موجود" });
    }

    const user = request.user;

    await request.destroy();

    await sendNotificationToUser(
      user.id,
      `تمت معالجة طلب السحب الخاص بك بمبلغ ${request.amount} عبر ${request.method}.`,
      "إشعار طلب سحب"
    );

    res.status(200).json({ message: "تم حذف طلب السحب وإبلاغ المستخدم" });

  } catch (error) {
    console.error("❌ خطأ أثناء حذف الطلب:", error);
    res.status(500).json({ message: "حدث خطأ أثناء حذف الطلب", error: error.message });
  }
});


module.exports = router;