const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

const DeviceFingerprintUser = sequelize.define("DeviceFingerprintUser", {
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true,
  },
  device_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  user_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  last_seen_at: {
    type: DataTypes.DATE,
    allowNull: true,
    defaultValue: null,
  },
}, {
  tableName: "device_fingerprint_users",
  timestamps: true,
});

module.exports = DeviceFingerprintUser;
