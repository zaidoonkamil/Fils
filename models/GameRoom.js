const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

const GameRoom = sequelize.define("GameRoom", {
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true,
  },
  status: {
    type: DataTypes.ENUM("waiting", "full", "finished"),
    allowNull: false,
    defaultValue: "waiting",
  },
}, {
  timestamps: true,
});

module.exports = GameRoom;
