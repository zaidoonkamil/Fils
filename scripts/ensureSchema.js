const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");
const User = require("../models/user");
const Room = require("../models/room");
const ChatMessage = require("../models/ChatMessage");
const Settings = require("../models/settings");

const ADMIN_TOKEN_VALID_AFTER_IAT_KEY = "admin_token_valid_after_iat";

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

async function ensureChatMessagesSchema(queryInterface, tableName) {
  await ensureTable(queryInterface, tableName, {
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

  const columns = await queryInterface.describeTable(tableName);

  if (columns.message && columns.message.allowNull === false) {
    await queryInterface.changeColumn(tableName, "message", {
      type: DataTypes.TEXT,
      allowNull: true,
    });
  }
}

async function ensureSchema() {
  const queryInterface = sequelize.getQueryInterface();
  const usersTable = resolveTableName(User);
  const roomsTable = resolveTableName(Room);
  const chatMessagesTable = resolveTableName(ChatMessage);

  if (await tableExists(queryInterface, "digital_product_codes")) {
    const digitalProductCodeIndexes = await queryInterface.showIndex("digital_product_codes");
    for (const index of digitalProductCodeIndexes) {
      const fields = (index.fields || []).map((field) => field.attribute || field.name);
      const isSingleCodeUniqueIndex =
        index.unique === true &&
        fields.length === 1 &&
        fields[0] === "code";

      if (isSingleCodeUniqueIndex && index.name && index.name !== "PRIMARY") {
        await queryInterface.removeIndex("digital_product_codes", index.name);
      }
    }
  }

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

  await ensureTable(queryInterface, "RoomJoinSubscriptions", {
    id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      autoIncrement: true,
      primaryKey: true,
    },
    roomId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
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

  await ensureTable(queryInterface, "PremiumFrames", {
    id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      autoIncrement: true,
      primaryKey: true,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    image: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    price: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    durationHours: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 24,
    },
    isActive: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
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

  await ensureTable(queryInterface, "UserPremiumFrames", {
    id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      autoIncrement: true,
      primaryKey: true,
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    frameId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    activatedAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    expiresAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    isActive: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
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

  await ensureTable(queryInterface, "CommunityPosts", {
    id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      autoIncrement: true,
      primaryKey: true,
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    content: {
      type: DataTypes.TEXT,
      allowNull: true,
      defaultValue: null,
    },
    image: {
      type: DataTypes.STRING,
      allowNull: true,
      defaultValue: null,
    },
    video: {
      type: DataTypes.STRING,
      allowNull: true,
      defaultValue: null,
    },
    commentsEnabled: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
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

  await ensureTable(queryInterface, "CommunityPostLikes", {
    id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      autoIncrement: true,
      primaryKey: true,
    },
    postId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
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

  await ensureTable(queryInterface, "CommunityPostComments", {
    id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      autoIncrement: true,
      primaryKey: true,
    },
    postId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    parentCommentId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: null,
    },
    content: {
      type: DataTypes.TEXT,
      allowNull: false,
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

  await ensureTable(queryInterface, "CommunityCommentLikes", {
    id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      autoIncrement: true,
      primaryKey: true,
    },
    commentId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
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

  await ensureTable(queryInterface, "ads", {
    id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      autoIncrement: true,
      primaryKey: true,
    },
    images: {
      type: DataTypes.JSON,
      allowNull: false,
    },
    title: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    placement: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: "home",
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

  await queryInterface.changeColumn("ads", "placement", {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: "home",
  });

  await ensureTable(queryInterface, "NotificationLogs", {
    id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      autoIncrement: true,
      primaryKey: true,
    },
    title: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    message: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    target_type: {
      type: DataTypes.ENUM("all", "role", "user"),
      allowNull: false,
    },
    target_value: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    status: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: "sent",
    },
    category: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: "system",
    },
    subcategory: {
      type: DataTypes.STRING,
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

  await ensureTable(queryInterface, "NotificationReads", {
    id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      autoIncrement: true,
      primaryKey: true,
    },
    notificationId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    readAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
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

  await ensureTable(queryInterface, "CommunityFollows", {
    id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      autoIncrement: true,
      primaryKey: true,
    },
    followerId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    followingId: {
      type: DataTypes.INTEGER,
      allowNull: false,
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

  const userPremiumFrameIndexes = await queryInterface.showIndex("UserPremiumFrames");
  const hasUserFrameIndex = userPremiumFrameIndexes.some((index) => {
    const fields = (index.fields || []).map((field) => field.attribute || field.name);
    return index.unique === false &&
      fields.length === 2 &&
      fields.includes("userId") &&
      fields.includes("isActive");
  });

  if (!hasUserFrameIndex) {
    await queryInterface.addIndex("UserPremiumFrames", ["userId", "isActive"], {
      name: "user_premium_frames_user_active_idx",
    });
  }

  const roomJoinIndexes = await queryInterface.showIndex("RoomJoinSubscriptions");
  const hasRoomUserUniqueIndex = roomJoinIndexes.some((index) => {
    const fields = (index.fields || []).map((field) => field.attribute || field.name);
    return index.unique === true &&
      fields.length === 2 &&
      fields.includes("roomId") &&
      fields.includes("userId");
  });

  if (!hasRoomUserUniqueIndex) {
    await queryInterface.addIndex("RoomJoinSubscriptions", ["roomId", "userId"], {
      unique: true,
      name: "room_join_subscriptions_room_user_unique",
    });
  }

  const communityPostsIndexes = await queryInterface.showIndex("CommunityPosts");
  const hasCommunityPostsCreatedAtIndex = communityPostsIndexes.some((index) => {
    const fields = (index.fields || []).map((field) => field.attribute || field.name);
    return index.name === "community_posts_created_at_idx" || (
      fields.length === 1 && fields[0] === "createdAt"
    );
  });

  if (!hasCommunityPostsCreatedAtIndex) {
    await queryInterface.addIndex("CommunityPosts", ["createdAt"], {
      name: "community_posts_created_at_idx",
    });
  }

  const communityLikesIndexes = await queryInterface.showIndex("CommunityPostLikes");
  const hasCommunityLikesUniqueIndex = communityLikesIndexes.some((index) => {
    const fields = (index.fields || []).map((field) => field.attribute || field.name);
    return index.unique === true &&
      fields.length === 2 &&
      fields.includes("postId") &&
      fields.includes("userId");
  });

  if (!hasCommunityLikesUniqueIndex) {
    await queryInterface.addIndex("CommunityPostLikes", ["postId", "userId"], {
      unique: true,
      name: "community_post_likes_post_user_unique",
    });
  }

  const communityCommentsIndexes = await queryInterface.showIndex("CommunityPostComments");
  const hasCommunityCommentsPostIndex = communityCommentsIndexes.some((index) => {
    const fields = (index.fields || []).map((field) => field.attribute || field.name);
    return index.name === "community_comments_post_created_idx" || (
      fields.length === 2 &&
      fields[0] === "postId" &&
      fields[1] === "createdAt"
    );
  });

  if (!hasCommunityCommentsPostIndex) {
    await queryInterface.addIndex("CommunityPostComments", ["postId", "createdAt"], {
      name: "community_comments_post_created_idx",
    });
  }

  const hasCommunityCommentsParentIndex = communityCommentsIndexes.some((index) => {
    const fields = (index.fields || []).map((field) => field.attribute || field.name);
    return index.name === "community_comments_parent_idx" || (
      fields.length === 1 && fields[0] === "parentCommentId"
    );
  });

  if (!hasCommunityCommentsParentIndex) {
    await queryInterface.addIndex("CommunityPostComments", ["parentCommentId"], {
      name: "community_comments_parent_idx",
    });
  }

  const communityCommentLikesIndexes = await queryInterface.showIndex("CommunityCommentLikes");
  const hasCommunityCommentLikesUniqueIndex = communityCommentLikesIndexes.some((index) => {
    const fields = (index.fields || []).map((field) => field.attribute || field.name);
    return index.unique === true &&
      fields.length === 2 &&
      fields.includes("commentId") &&
      fields.includes("userId");
  });

  if (!hasCommunityCommentLikesUniqueIndex) {
    await queryInterface.addIndex("CommunityCommentLikes", ["commentId", "userId"], {
      unique: true,
      name: "community_comment_likes_comment_user_unique",
    });
  }

  const communityFollowsIndexes = await queryInterface.showIndex("CommunityFollows");
  const hasCommunityFollowUniqueIndex = communityFollowsIndexes.some((index) => {
    const fields = (index.fields || []).map((field) => field.attribute || field.name);
    return index.unique === true &&
      fields.length === 2 &&
      fields.includes("followerId") &&
      fields.includes("followingId");
  });

  if (!hasCommunityFollowUniqueIndex) {
    await queryInterface.addIndex("CommunityFollows", ["followerId", "followingId"], {
      unique: true,
      name: "community_follows_follower_following_unique",
    });
  }

  const hasCommunityFollowingIndex = communityFollowsIndexes.some((index) => {
    const fields = (index.fields || []).map((field) => field.attribute || field.name);
    return index.name === "community_follows_following_idx" ||
      (fields.length === 1 && fields[0] === "followingId");
  });

  if (!hasCommunityFollowingIndex) {
    await queryInterface.addIndex("CommunityFollows", ["followingId"], {
      name: "community_follows_following_idx",
    });
  }

  const notificationReadsIndexes = await queryInterface.showIndex("NotificationReads");
  const hasNotificationReadUniqueIndex = notificationReadsIndexes.some((index) => {
    const fields = (index.fields || []).map((field) => field.attribute || field.name);
    return index.unique === true &&
      fields.length === 2 &&
      fields.includes("notificationId") &&
      fields.includes("userId");
  });

  if (!hasNotificationReadUniqueIndex) {
    await queryInterface.addIndex("NotificationReads", ["notificationId", "userId"], {
      unique: true,
      name: "notification_reads_notification_user_unique",
    });
  }

  const hasNotificationReadUserIndex = notificationReadsIndexes.some((index) => {
    const fields = (index.fields || []).map((field) => field.attribute || field.name);
    return index.name === "notification_reads_user_idx" ||
      (fields.length === 1 && fields[0] === "userId");
  });

  if (!hasNotificationReadUserIndex) {
    await queryInterface.addIndex("NotificationReads", ["userId"], {
      name: "notification_reads_user_idx",
    });
  }

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
    agentPrivateChatEnabled: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
  });

  await ensureTable(queryInterface, roomsTable, {
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
    roomChallengeState: {
      type: DataTypes.JSON,
      allowNull: true,
      defaultValue: null,
    },
    supervisorSlots: {
      type: DataTypes.JSON,
      allowNull: false,
      defaultValue: {
        gold: null,
        silver: null,
        bronze: null,
        standard: null,
      },
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

  await ensureTable(queryInterface, "admin_balance_logs", {
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
    targetUserId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    balanceType: {
      type: DataTypes.ENUM("sawa", "jewel"),
      allowNull: false,
    },
    amount: {
      type: DataTypes.DOUBLE,
      allowNull: false,
    },
    balanceBefore: {
      type: DataTypes.DOUBLE,
      allowNull: false,
    },
    balanceAfter: {
      type: DataTypes.DOUBLE,
      allowNull: false,
    },
    actionType: {
      type: DataTypes.ENUM("add", "subtract"),
      allowNull: false,
    },
    note: {
      type: DataTypes.TEXT,
      allowNull: true,
      defaultValue: null,
    },
    ipAddress: {
      type: DataTypes.STRING,
      allowNull: true,
      defaultValue: null,
    },
    userAgent: {
      type: DataTypes.TEXT,
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

  await ensureChatMessagesSchema(queryInterface, chatMessagesTable);

  await Settings.findOrCreate({
    where: { key: ADMIN_TOKEN_VALID_AFTER_IAT_KEY },
    defaults: {
      value: String(Math.floor(Date.now() / 1000)),
      description: "Reject admin JWTs issued before this unix timestamp",
      isActive: true,
    },
  });
}

module.exports = ensureSchema;

