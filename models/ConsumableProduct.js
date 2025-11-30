const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

const ConsumableProduct = sequelize.define(
  "ConsumableProduct",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    categoryId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      comment: "معرف الفئة",
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: "اسم المنتج",
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: "وصف المنتج",
    },
    price: {
      type: DataTypes.FLOAT,
      allowNull: false,
      comment: "سعر المنتج",
    },
    images: {
      type: DataTypes.JSON,
      allowNull: true,
      defaultValue: [],
      comment: "صور المنتج",
    },
    stock: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      comment: "عدد المخزون",
    },
    isActive: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
      comment: "هل المنتج مفعل",
    },
  },
  {
    tableName: "consumable_products",
    timestamps: true,
  }
);

module.exports = ConsumableProduct;
