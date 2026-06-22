const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

const CommunityHighlightItem = sequelize.define(
  "CommunityHighlightItem",
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    highlightId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    image: {
      type: DataTypes.STRING,
      allowNull: false,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = CommunityHighlightItem;
