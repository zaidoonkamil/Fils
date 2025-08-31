const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");
const Counter = require("./counter");

const CounterShop = sequelize.define("CounterShop", {
  price: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  isAvailable: {
    type: DataTypes.BOOLEAN,
    defaultValue: true,
  }
});

CounterShop.belongsTo(Counter, { foreignKey: "counterId" });

module.exports = CounterShop;
