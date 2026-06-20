const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

const CommunityPost = sequelize.define(
  "CommunityPost",
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    content: {
      type: DataTypes.TEXT,
      allowNull: true,
      defaultValue: null,
    },
    image: {
      type: DataTypes.STRING,
      allowNull: true,
      defaultValue: null,
    },
    video: {
      type: DataTypes.STRING,
      allowNull: true,
      defaultValue: null,
    },
    commentsEnabled: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = CommunityPost;

