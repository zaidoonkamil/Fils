const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

const DailyAction = sequelize.define("DailyAction", {
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true,
  },
  user_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  lastActionTime: {
    type: DataTypes.DATE,
    allowNull: false,
  },
}, {
  timestamps: true,
});

module.exports = DailyAction;
