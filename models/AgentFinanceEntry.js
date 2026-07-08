const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

const AgentFinanceEntry = sequelize.define(
  "AgentFinanceEntry",
  {
    id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      autoIncrement: true,
      primaryKey: true,
    },
    adminId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    agentId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    entryType: {
      type: DataTypes.ENUM("outgoing", "incoming"),
      allowNull: false,
    },
    sourceType: {
      type: DataTypes.ENUM("transfer", "manual_settlement"),
      allowNull: false,
    },
    amount: {
      type: DataTypes.DOUBLE,
      allowNull: false,
      defaultValue: 0,
    },
    debtImpact: {
      type: DataTypes.DOUBLE,
      allowNull: false,
      defaultValue: 0,
    },
    transferHistoryId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: null,
    },
    note: {
      type: DataTypes.TEXT,
      allowNull: true,
      defaultValue: null,
    },
  },
  {
    tableName: "agent_finance_entries",
  }
);

module.exports = AgentFinanceEntry;
