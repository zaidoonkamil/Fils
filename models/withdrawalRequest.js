const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

const WithdrawalRequest = sequelize.define("WithdrawalRequest", {
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true,
  },
  userId: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  amount: {
    type: DataTypes.DOUBLE,
    allowNull: false,
  },
  method: {
    type: DataTypes.ENUM("ماستر كارد", "زين كاش", "USDT"),
    allowNull: false,
  },
  accountNumber: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  status: {
    type: DataTypes.ENUM("قيد الانتظار", "مكتمل", "مرفوض"),
    defaultValue: "قيد الانتظار",
  },
}, {
  timestamps: true,
});

module.exports = WithdrawalRequest;
