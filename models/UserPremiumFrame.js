const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

const UserPremiumFrame = sequelize.define(
  "UserPremiumFrame",
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    frameId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    activatedAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    expiresAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    isActive: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
  },
  {
    timestamps: true,
  },
);

module.exports = UserPremiumFrame;
