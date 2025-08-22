const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

const CounterSale = sequelize.define("CounterSale", {
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true,
  },
  userId: {    
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  userCounterId: { 
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  originalPoints: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  pointsAfterCut: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  price: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  isSold: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
  },
}, {
  timestamps: true,
});

module.exports = CounterSale;
