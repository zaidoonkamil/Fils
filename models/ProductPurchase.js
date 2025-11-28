const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

const ProductPurchase = sequelize.define(
  "ProductPurchase",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      comment: "معرف المستخدم",
    },
    productId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      comment: "معرف المنتج",
    },
    cardCode: {
      type: DataTypes.TEXT,
      allowNull: false,
      comment: "كود البطاقة الذي تم توفيره",
    },
    price: {
      type: DataTypes.FLOAT,
      allowNull: false,
      comment: "السعر المدفوع",
    },
  },
  {
    tableName: "product_purchases",
    timestamps: true,
  }
);

module.exports = ProductPurchase;
