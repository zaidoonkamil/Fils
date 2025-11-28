const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

const User = sequelize.define("User", {
    id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
    },
    name: {
        type: DataTypes.STRING,
        allowNull: false,
    },
    email: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true,
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
    password: {
        type: DataTypes.STRING,
        allowNull: false,
    },
    role: {
        type: DataTypes.ENUM("user", "admin", "agent"), 
        allowNull: false,
        defaultValue: "user",
    },
    Jewel: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
    },
    sawa: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
    },   
    card: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
    },
    dolar: {
        type: DataTypes.DOUBLE,
        allowNull: false,
        defaultValue: 0,
    },
    isVerified: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
    },
    isLoggedIn: {  
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
    },
    note: {
        type: DataTypes.TEXT,
        allowNull: true,
    },
    url: {
        type: DataTypes.TEXT,
        allowNull: true,
    },
    isActive: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
    },

}, {
    initialAutoIncrement: 10000,
    timestamps: true,
});


module.exports = User;