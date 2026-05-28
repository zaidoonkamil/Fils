const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

const RoomJoinSubscription = sequelize.define("RoomJoinSubscription", {
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true,
  },
  roomId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: "Rooms",
      key: "id",
    },
  },
  userId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: "Users",
      key: "id",
    },
  },
}, {
  timestamps: true,
});

module.exports = RoomJoinSubscription;
