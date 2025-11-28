const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');

const AgentRequest = sequelize.define('AgentRequest', {
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true,
  },
  userId: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  status: {
    type: DataTypes.ENUM('قيد الانتظار', 'مكتمل', 'مرفوض'),
    defaultValue: 'قيد الانتظار',
  },
  url: {
    type: DataTypes.TEXT,
    allowNull: false,
  },
});

module.exports = AgentRequest;
