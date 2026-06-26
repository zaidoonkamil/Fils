const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

const UserReport = sequelize.define(
  "UserReport",
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    reporterId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    reportedUserId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: null,
    },
    section: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: "general",
    },
    contextScope: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: "general_profile",
    },
    targetType: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: "user",
    },
    targetId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: null,
    },
    roomId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: null,
    },
    postId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: null,
    },
    messageId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: null,
    },
    reason: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    evidenceImage: {
      type: DataTypes.STRING,
      allowNull: true,
      defaultValue: null,
    },
    status: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: "pending",
    },
    adminNote: {
      type: DataTypes.TEXT,
      allowNull: true,
      defaultValue: null,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = UserReport;
