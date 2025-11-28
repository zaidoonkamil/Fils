const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

const TransferHistory = sequelize.define("TransferHistory", {
  senderId: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  receiverId: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  amount: {
    type: DataTypes.FLOAT,
    allowNull: false,
  },
  fee: {
    type: DataTypes.FLOAT,
    allowNull: false,
  },
}, {
  timestamps: true, 
});

module.exports = TransferHistory;
