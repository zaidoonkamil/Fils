const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

const NotificationLog = sequelize.define("NotificationLog", {
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true,
  },
  title: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  message: {
    type: DataTypes.TEXT,
    allowNull: false,
  },
  target_type: {
    type: DataTypes.ENUM("all", "role", "user"),
    allowNull: false,
  },
  target_value: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  status: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: "sent"
  }
}, {
  timestamps: true,
});

module.exports = NotificationLog;
