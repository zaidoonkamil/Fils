const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

const DeviceFingerprint = sequelize.define("DeviceFingerprint", {
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true,
  },
  install_id: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true,
  },
  is_banned: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  },
  banned_reason: {
    type: DataTypes.TEXT,
    allowNull: true,
    defaultValue: null,
  },
  banned_by: {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: null,
  },
  last_seen_at: {
    type: DataTypes.DATE,
    allowNull: true,
    defaultValue: null,
  },
}, {
  tableName: "device_fingerprints",
  timestamps: true,
});

module.exports = DeviceFingerprint;
