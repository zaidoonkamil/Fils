const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

const ConsumablePurchase = sequelize.define(
  "ConsumablePurchase",
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
    quantity: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 1,
      comment: "الكمية المشتراة",
    },
    totalPrice: {
      type: DataTypes.FLOAT,
      allowNull: false,
      comment: "السعر الإجمالي",
    },
  },
  {
    tableName: "consumable_purchases",
    timestamps: true,
  }
);

module.exports = ConsumablePurchase;
