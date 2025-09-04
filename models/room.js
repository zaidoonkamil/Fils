const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

const Room = sequelize.define("Room", {
    id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
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
    category: {
        type: DataTypes.STRING,
        allowNull: true,
        defaultValue: 'general',
    },
}, {
    timestamps: true,
});

module.exports = Room;
