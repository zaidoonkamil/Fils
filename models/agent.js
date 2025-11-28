const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

const Agent = sequelize.define("Agent", {
    id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
    },
    name: {
        type: DataTypes.STRING,
        allowNull: false,
    },
    phone: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true,
    },
    location: {
        type: DataTypes.STRING,
        allowNull: false,
    },
    description: {
        type: DataTypes.STRING,
        allowNull: true,
    },

}, {
    timestamps: true,
    tableName: 'agents' 
});


module.exports = Agent;