const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

const GiftItem = sequelize.define("GiftItem", {
    name: {
        type: DataTypes.STRING,
        allowNull: false,
    },
    image: {
        type: DataTypes.STRING,
        allowNull: true,
    },
    video: {
    type: DataTypes.STRING,
    allowNull: true,
    },
    points: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
    },
    tier: {
        type: DataTypes.ENUM("normal", "premium", "vip"),
        allowNull: false,
        defaultValue: "premium",
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
