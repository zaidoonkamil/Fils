const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

const LoginAttempt = sequelize.define(
  "LoginAttempt",
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    scope: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: "user",
    },
    identifier: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: "",
    },
    ipAddress: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: "",
    },
    failCount: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    lockUntil: {
      type: DataTypes.DATE,
      allowNull: true,
      defaultValue: null,
    },
    lastFailedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      defaultValue: null,
    },
    lastSuccessAt: {
      type: DataTypes.DATE,
      allowNull: true,
      defaultValue: null,
    },
  },
  {
    tableName: "login_attempts",
    timestamps: true,
    indexes: [
      {
        unique: true,
        fields: ["scope", "identifier", "ipAddress"],
        name: "login_attempts_scope_identifier_ip_unique",
      },
    ],
  }
);

module.exports = LoginAttempt;
