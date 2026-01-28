const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

const DominoMatch = sequelize.define("DominoMatch", {
  player1Id: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },

  player2Id: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },

  entryFee: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
  },

  winFee: {
    type: DataTypes.FLOAT,
    allowNull: false,
    defaultValue: 0,
  },

  status: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: "playing",
  },

  winnerId: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },

  stateJson: {
    type: DataTypes.JSON,
    allowNull: true,
  },
});

module.exports = DominoMatch;
