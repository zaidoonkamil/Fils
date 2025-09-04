const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

const Message = sequelize.define("Message", {
    id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
    },
    roomId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'Rooms',
            key: 'id'
        }
    },
    userId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'Users',
            key: 'id'
        }
    },
    content: {
        type: DataTypes.TEXT,
        allowNull: false,
    },
    messageType: {
        type: DataTypes.ENUM('text', 'image', 'file'),
        allowNull: false,
        defaultValue: 'text',
    },
    isDeleted: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
    },
}, {
    timestamps: true,
});

module.exports = Message;
