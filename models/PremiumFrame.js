const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

const PremiumFrame = sequelize.define(
  "PremiumFrame",
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    image: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    price: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    durationHours: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 24,
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

module.exports = PremiumFrame;
