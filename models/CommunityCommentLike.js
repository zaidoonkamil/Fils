const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

const CommunityCommentLike = sequelize.define(
  "CommunityCommentLike",
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    commentId: {
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

module.exports = CommunityCommentLike;
