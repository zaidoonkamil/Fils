const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

const Counter = sequelize.define("Counter", {
    id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
    },
    points: {
        type: DataTypes.INTEGER,
        allowNull: false,
    },
    type: {
        type: DataTypes.ENUM("points", "gems"),
        allowNull: false,
          defaultValue: "points"
    },
    durationDays: {
        type: DataTypes.INTEGER,
        allowNull: true,
    },
    name: {
        type: DataTypes.STRING,
        allowNull: true,
        defaultValue: null,
    },
    image: {
        type: DataTypes.JSON,
        allowNull: true,
        defaultValue: null,
    },
    price: {
        type: DataTypes.DOUBLE,
        allowNull: false,
    },
    isActive: { 
        type: DataTypes.BOOLEAN,
         allowNull: false,
          defaultValue: true ,
        } ,
    isVisible: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
    },
}, {
    timestamps: true,
});

module.exports = Counter;
