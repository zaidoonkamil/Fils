const cron = require('node-cron');
const { UserCounter, User, Counter } = require('./models');
const { Op } = require('sequelize');

cron.schedule("0 0 * * *", async () => {
  console.log("⏰ Running daily rewards distribution...");

  try {
    const now = new Date();

    const userCounters = await UserCounter.findAll({
      where: {
        endDate: {
          [Op.gt]: now
        }
      },
      include: [
        { model: User },
        { model: Counter }
      ]
    });

    for (const uc of userCounters) {
      const user = uc.User;
      const counter = uc.Counter;

      if (user && counter) {
        // تحقق إن dailyReward موجود ورقم موجب
        const reward = parseFloat(counter.dailyReward);
        if (!isNaN(reward) && reward > 0) {
          // تحقق من نوع user.sawa
          if (typeof user.sawa === "number" && !isNaN(user.sawa)) {
            user.sawa += reward;
            await user.save();
            console.log(`✅ Added ${reward} sawa to user ${user.id}`);
          } else {
            console.warn(`⚠️ Invalid sawa value for user ${user.id}, skipping update`);
          }
        } else {
          console.log(`⚠️ Skipped user ${user.id} - no valid reward`);
        }
      }
    }

    console.log("✅ Rewards distributed successfully at", new Date().toLocaleString());
  } catch (err) {
    console.error("❌ Error distributing rewards:", err);
  }
});
