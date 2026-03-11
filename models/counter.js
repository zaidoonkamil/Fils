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

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("Counters", "isVisible", {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeColumn("Counters", "isVisible");
  }
};