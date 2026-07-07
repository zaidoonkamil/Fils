const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

const DominoPrivateRoom = sequelize.define("DominoPrivateRoom", {
  code: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true,
  },
  hostUserId: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  guestUserId: {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: null,
  },
  packageKey: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: "classic_1",
  },
  entryFee: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
  },
  prize: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
  },
  status: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: "waiting",
  },
  matchId: {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: null,
  },
  expiresAt: {
    type: DataTypes.DATE,
    allowNull: true,
    defaultValue: null,
  },
});

module.exports = DominoPrivateRoom;
