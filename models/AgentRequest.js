const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');
const { User } = require('../models');

const AgentRequest = sequelize.define('AgentRequest', {
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true,
  },
  userId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: User,
      key: 'id',
    },
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

User.hasOne(AgentRequest, { foreignKey: 'userId', onDelete: 'CASCADE' });
AgentRequest.belongsTo(User, { foreignKey: 'userId' });

module.exports = AgentRequest;
