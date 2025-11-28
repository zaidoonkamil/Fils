const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

const DigitalProduct = sequelize.define(
  "DigitalProduct",
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
    title: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: "عنوان المنتج",
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
    tableName: "digital_products",
    timestamps: true,
  }
);

module.exports = DigitalProduct;
