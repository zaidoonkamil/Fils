const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

const Ads = sequelize.define("ads", {
    images: {
        type: DataTypes.JSON,
        allowNull: false
      },
    title: {
        type: DataTypes.STRING,
        allowNull: false
    },
    description: {
        type: DataTypes.TEXT,
        allowNull: false
    },
}, {
    timestamps: true
});

module.exports = Ads;