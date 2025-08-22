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
    type: DataTypes.ENUM("ماستر كارد", "زين كاش"),
    allowNull: false,
  },
  accountNumber: {
    type: DataTypes.STRING,
    allowNull: false,
  }
}, {
  timestamps: true,
});

module.exports = WithdrawalRequest;
