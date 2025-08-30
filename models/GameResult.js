const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");
const GameRoom = require("./GameRoom");
const User = require("./user");

const GameResult = sequelize.define("GameResult", {
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true,
  },
  roomId: {
    type: DataTypes.INTEGER,
    references: { model: GameRoom, key: "id" },
    allowNull: false,
  },
  winnerId: {
    type: DataTypes.INTEGER,
    references: { model: User, key: "id" },
    allowNull: false,
  },
  rewardGems: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 50,
  },
}, {
  timestamps: true,
});

GameRoom.hasOne(GameResult, { foreignKey: "roomId", onDelete: "CASCADE" });
GameResult.belongsTo(GameRoom, { foreignKey: "roomId" });

User.hasMany(GameResult, { foreignKey: "winnerId", onDelete: "CASCADE" });
GameResult.belongsTo(User, { foreignKey: "winnerId" });

module.exports = GameResult;
