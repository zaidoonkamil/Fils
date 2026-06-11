const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

const CommunityPostLike = sequelize.define(
  "CommunityPostLike",
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    postId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = CommunityPostLike;
