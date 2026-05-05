const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

const UserGift = sequelize.define("UserGift", {
    userId: {
        type: DataTypes.INTEGER,
        allowNull: false,
    },
    senderId: {
        type: DataTypes.INTEGER,
        allowNull: true,
    },
    giftItemId: {
        type: DataTypes.INTEGER,
        allowNull: false,
    },
    roomId: {
        type: DataTypes.INTEGER,
        allowNull: true,
    },
    roomOwnerId: {
        type: DataTypes.INTEGER,
        allowNull: true,
    },
    status: {
        type: DataTypes.ENUM("active", "converted"),
        allowNull: false,
        defaultValue: "active",
    },
    pointsSnapshot: {
        type: DataTypes.INTEGER,
        allowNull: true,
    },
    ownerShare: {
        type: DataTypes.INTEGER,
        allowNull: true,
    },
    receiverShare: {
        type: DataTypes.INTEGER,
        allowNull: true,
    },
    adminShare: {
        type: DataTypes.INTEGER,
        allowNull: true,
    }
}, {
    timestamps: true,
});

module.exports = UserGift;
