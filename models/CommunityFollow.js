const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

const CommunityFollow = sequelize.define(
  "CommunityFollow",
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    followerId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    followingId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = CommunityFollow;
