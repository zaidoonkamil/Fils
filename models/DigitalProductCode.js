const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

const DigitalProductCode = sequelize.define(
  "DigitalProductCode",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    productId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    code: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },
    used: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    }
  },
  {
    tableName: "digital_product_codes",
    timestamps: true,
  }
);

module.exports = DigitalProductCode;
