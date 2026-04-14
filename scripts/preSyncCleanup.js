const sequelize = require("../config/db");

async function runPreSyncCleanup() {
  try {
    await sequelize.query(
      "DELETE r FROM Referrals r LEFT JOIN Users u ON u.id = r.referrerId WHERE u.id IS NULL"
    );
    await sequelize.query(
      "DELETE r FROM Referrals r LEFT JOIN Users u ON u.id = r.referredUserId WHERE u.id IS NULL"
    );
  } catch (err) {
    console.error("❌ Pre-sync cleanup failed:", err);
  }
}

module.exports = runPreSyncCleanup;
