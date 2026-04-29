const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

const AdminBalanceLog = sequelize.define(
  "AdminBalanceLog",
  {
    id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      autoIncrement: true,
      primaryKey: true,
    },
    adminId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    targetUserId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    balanceType: {
      type: DataTypes.ENUM("sawa", "jewel"),
      allowNull: false,
    },
    amount: {
      type: DataTypes.DOUBLE,
      allowNull: false,
    },
    balanceBefore: {
      type: DataTypes.DOUBLE,
      allowNull: false,
    },
    balanceAfter: {
      type: DataTypes.DOUBLE,
      allowNull: false,
    },
    actionType: {
      type: DataTypes.ENUM("add", "subtract"),
      allowNull: false,
    },
    note: {
      type: DataTypes.TEXT,
      allowNull: true,
      defaultValue: null,
    },
    ipAddress: {
      type: DataTypes.STRING,
      allowNull: true,
      defaultValue: null,
    },
    userAgent: {
      type: DataTypes.TEXT,
      allowNull: true,
      defaultValue: null,
    },
  },
  {
    tableName: "admin_balance_logs",
  }
);

module.exports = AdminBalanceLog;
