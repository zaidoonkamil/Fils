const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

const Room = sequelize.define("Room", {
    id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
    },
    images: {
        type: DataTypes.JSON,
        allowNull: false,
        defaultValue: []
    },
    name: {
        type: DataTypes.STRING,
        allowNull: false,
    },
    description: {
        type: DataTypes.TEXT,
        allowNull: true,
    },
    creatorId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'Users',
            key: 'id'
        }
    },
    cost: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
    },
    maxUsers: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 50,
    },
    currentUsers: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
    },
    isActive: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
    },
    backgroundImage: {
        type: DataTypes.STRING,
        allowNull: true,
        defaultValue: null,
    },
    category: {
        type: DataTypes.STRING,
        allowNull: true,
        defaultValue: 'general',
    },
    pinnedMessageId: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: {
            model: 'Messages',
            key: 'id'
        }
    },
    pinnedMessage: {
        type: DataTypes.JSON,
        allowNull: true,
        defaultValue: null,
    },
}, {
    timestamps: true,
});

module.exports = Room;
