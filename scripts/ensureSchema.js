const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");
const User = require("../models/user");
const ChatMessage = require("../models/ChatMessage");

async function tableExists(queryInterface, tableName) {
  const tables = await queryInterface.showAllTables();
  const normalized = tables.map((t) => {
    if (typeof t === "string") return t.toLowerCase();
    if (t && t.tableName) return String(t.tableName).toLowerCase();
    if (t && t.name) return String(t.name).toLowerCase();
    return String(t).toLowerCase();
  });
  return normalized.includes(tableName.toLowerCase());
}

async function ensureTable(queryInterface, tableName, defineColumns) {
  const exists = await tableExists(queryInterface, tableName);
  if (!exists) {
    await queryInterface.createTable(tableName, defineColumns);
    return;
  }

  const columns = await queryInterface.describeTable(tableName);
  for (const [name, columnDef] of Object.entries(defineColumns)) {
    if (!columns[name]) {
      await queryInterface.addColumn(tableName, name, columnDef);
    }
  }
}

function resolveTableName(model) {
  const tableName = model.getTableName();
  if (typeof tableName === "string") return tableName;
  if (tableName && tableName.tableName) return tableName.tableName;
  return String(tableName);
}

async function ensureSchema() {
  const queryInterface = sequelize.getQueryInterface();
  const usersTable = resolveTableName(User);
  const chatMessagesTable = resolveTableName(ChatMessage);

  await ensureTable(queryInterface, "device_fingerprints", {
    id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      autoIncrement: true,
      primaryKey: true,
    },
    install_id: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },
    is_banned: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    banned_reason: {
      type: DataTypes.TEXT,
      allowNull: true,
      defaultValue: null,
    },
    banned_by: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: null,
    },
    last_seen_at: {
      type: DataTypes.DATE,
      allowNull: true,
      defaultValue: null,
    },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    updatedAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
  });

  await ensureTable(queryInterface, "device_fingerprint_users", {
    id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      autoIncrement: true,
      primaryKey: true,
    },
    device_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    user_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    last_seen_at: {
      type: DataTypes.DATE,
      allowNull: true,
      defaultValue: null,
    },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    updatedAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
  });

  await ensureTable(queryInterface, "Counters", {
    name: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    image: {
      type: DataTypes.JSON,
      allowNull: true,
      defaultValue: null,
    },
  });

  await ensureTable(queryInterface, usersTable, {
    isInternalVerified: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    internalVerifiedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      defaultValue: null,
    },
  });

  await ensureTable(queryInterface, "user_internal_verifications", {
    id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      autoIncrement: true,
      primaryKey: true,
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      unique: true,
    },
    fullName: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    motherName: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    birthDate: {
      type: DataTypes.DATEONLY,
      allowNull: false,
    },
    governorate: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    district: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    phone: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    email: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    acceptedResponsibility: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    verifiedAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    lastExtraPasswordResetAt: {
      type: DataTypes.DATE,
      allowNull: true,
      defaultValue: null,
    },
    extraPasswordResetCount: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    updatedAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
  });

  await ensureTable(queryInterface, chatMessagesTable, {
    messageType: {
      type: DataTypes.ENUM("text", "image"),
      allowNull: false,
      defaultValue: "text",
    },
    image: {
      type: DataTypes.STRING,
      allowNull: true,
      defaultValue: null,
    },
  });
}

module.exports = ensureSchema;
