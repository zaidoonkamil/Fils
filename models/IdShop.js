const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

const IdShop = sequelize.define("IdShop", {
  idForSale: {
    type: DataTypes.INTEGER,
    allowNull: false,
    unique: true,
  },
  price: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  isAvailable: {
    type: DataTypes.BOOLEAN,
    defaultValue: true,
  }
});


module.exports = IdShop;
