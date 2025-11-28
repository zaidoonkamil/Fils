const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

const StoreCategory = sequelize.define(
  "StoreCategory",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: "اسم الفئة",
    },
    image: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: "صورة الفئة",
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: "وصف الفئة",
    },
    isActive: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
      comment: "هل الفئة مفعلة",
    },
  },
  {
    tableName: "store_categories",
    timestamps: true,
  }
);

module.exports = StoreCategory;
