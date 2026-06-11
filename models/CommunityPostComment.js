const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

const CommunityPostComment = sequelize.define(
  "CommunityPostComment",
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
    content: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = CommunityPostComment;
