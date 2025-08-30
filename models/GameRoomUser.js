const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");
const GameRoom = require("./GameRoom");
const User = require("./user");

const GameRoomUser = sequelize.define("GameRoomUser", {
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
  userId: {
    type: DataTypes.INTEGER,
    references: { model: User, key: "id" },
    allowNull: false,
  },
}, {
  timestamps: true,
});

GameRoom.hasMany(GameRoomUser, { foreignKey: "roomId", onDelete: "CASCADE" });
GameRoomUser.belongsTo(GameRoom, { foreignKey: "roomId" });

User.hasMany(GameRoomUser, { foreignKey: "userId", onDelete: "CASCADE" });
GameRoomUser.belongsTo(User, { foreignKey: "userId" });

module.exports = GameRoomUser;
