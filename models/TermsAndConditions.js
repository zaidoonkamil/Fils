const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

const Tearms = sequelize.define("tearms", {
    description: {
        type: DataTypes.TEXT,
        allowNull: false
    },
}, {
    timestamps: true
});

module.exports = Tearms;