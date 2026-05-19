const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

const Room = sequelize.define("Room", {
    id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
    },
    images: {
        type: DataTypes.JSON,
        allowNull: false,
        defaultValue: []
    },
    name: {
        type: DataTypes.STRING,
        allowNull: false,
    },
    description: {
        type: DataTypes.TEXT,
        allowNull: true,
    },
    creatorId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: 'Users',
            key: 'id'
        }
    },
    cost: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
    },
    maxUsers: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 50,
    },
    currentUsers: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
    },
    isActive: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
    },
    backgroundImage: {
        type: DataTypes.STRING,
        allowNull: true,
        defaultValue: null,
    },
    category: {
        type: DataTypes.STRING,
        allowNull: true,
        defaultValue: 'general',
    },
    pinnedMessageId: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: {
            model: 'Messages',
            key: 'id'
        }
    },
    pinnedMessage: {
        type: DataTypes.JSON,
        allowNull: true,
        defaultValue: null,
    },
    voiceMicCount: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
    },
    voicePackageExpiresAt: {
        type: DataTypes.DATE,
        allowNull: true,
        defaultValue: null,
    },
    voiceActiveSpeakerIds: {
        type: DataTypes.JSON,
        allowNull: false,
        defaultValue: [],
    },
    voicePendingRequestIds: {
        type: DataTypes.JSON,
        allowNull: false,
        defaultValue: [],
    },
    supportAgentUserId: {
        type: DataTypes.INTEGER,
        allowNull: true,
        defaultValue: null,
        references: {
            model: 'Users',
            key: 'id'
        }
    },
    supportAgentExpiresAt: {
        type: DataTypes.DATE,
        allowNull: true,
        defaultValue: null,
    },
    roomAudioExpiresAt: {
        type: DataTypes.DATE,
        allowNull: true,
        defaultValue: null,
    },
    roomAudioFiles: {
        type: DataTypes.JSON,
        allowNull: false,
        defaultValue: [],
    },
    roomAudioCurrentTrackId: {
        type: DataTypes.STRING,
        allowNull: true,
        defaultValue: null,
    },
    roomAudioPlaybackStartedAt: {
        type: DataTypes.DATE,
        allowNull: true,
        defaultValue: null,
    },
}, {
    timestamps: true,
});

module.exports = Room;
