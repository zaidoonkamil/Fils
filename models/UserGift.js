const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

const UserGift = sequelize.define("UserGift", {
    userId: {
        type: DataTypes.INTEGER,
        allowNull: false, // The current owner
    },
    senderId: {
        type: DataTypes.INTEGER,
        allowNull: true, // Null if self-bought, otherwise the user who sent it
    },
    giftItemId: {
        type: DataTypes.INTEGER,
        allowNull: false,
    },
    status: {
        type: DataTypes.ENUM("active", "converted"),
        allowNull: false,
        defaultValue: "active",
    }
}, {
    timestamps: true,
});

module.exports = UserGift;
