const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

const GiftItem = sequelize.define("GiftItem", {
    name: {
        type: DataTypes.STRING,
        allowNull: false,
    },
    image: {
        type: DataTypes.STRING,
        allowNull: false,
    },
    points: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
    },
    isAvailable: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
    }
}, {
    timestamps: true,
});

module.exports = GiftItem;
