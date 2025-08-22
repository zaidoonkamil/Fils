const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

const UserCounter = sequelize.define("UserCounter", {
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true,
  },
  userId: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  counterId: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  points: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  type: {
    type: DataTypes.ENUM("points", "gems"),
    allowNull: false,
    defaultValue: "points"
  },
  price: {
    type: DataTypes.DOUBLE,
    allowNull: false,
  },
  startDate: {
    type: DataTypes.DATE,
    allowNull: false,
  },
  endDate: {
    type: DataTypes.DATE,
    allowNull: false,
  },
  isForSale: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
  }
}, {
  timestamps: true,
});

module.exports = UserCounter;
