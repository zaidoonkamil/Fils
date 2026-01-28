const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

const DominoQueue = sequelize.define("DominoQueue", {
  userId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    unique: true,
  },

  entryFee: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
  },

  status: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: "searching",
  },
});

module.exports = DominoQueue;
