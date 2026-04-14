const sequelize = require("../config/db");
const Referral = require("../models/referrals");
const User = require("../models/user");

function resolveTableName(model) {
  const tableName = model.getTableName();
  if (typeof tableName === "string") return tableName;
  if (tableName && tableName.tableName) return tableName.tableName;
  return String(tableName);
}

async function runPreSyncCleanup() {
  try {
    const referralsTable = resolveTableName(Referral);
    const usersTable = resolveTableName(User);

    const [referrerResult] = await sequelize.query(
      `DELETE FROM \`${referralsTable}\`
       WHERE referrerId IS NULL
          OR referrerId = 0
          OR referrerId NOT IN (SELECT id FROM \`${usersTable}\`)`
    );

    const [referredResult] = await sequelize.query(
      `DELETE FROM \`${referralsTable}\`
       WHERE referredUserId IS NULL
          OR referredUserId = 0
          OR referredUserId NOT IN (SELECT id FROM \`${usersTable}\`)`
    );

    const referrerDeleted = typeof referrerResult?.affectedRows === "number" ? referrerResult.affectedRows : 0;
    const referredDeleted = typeof referredResult?.affectedRows === "number" ? referredResult.affectedRows : 0;
    if (referrerDeleted > 0 || referredDeleted > 0) {
      console.log(`Pre-sync cleanup: deleted ${referrerDeleted + referredDeleted} referral rows`);
    }
  } catch (err) {
    console.error("❌ Pre-sync cleanup failed:", err);
  }
}

module.exports = runPreSyncCleanup;
