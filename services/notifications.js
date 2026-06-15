const axios = require("axios");
const UserDevice = require("../models/user_device");
const User = require("../models/user");
const NotificationLog = require("../models/notification_log");

function normalizeNotificationMeta(options = {}) {
  return {
    category: String(options.category || "system").trim() || "system",
    subcategory: options.subcategory
      ? String(options.subcategory).trim()
      : null,
  };
}

async function createNotificationLog(payload) {
  const meta = normalizeNotificationMeta(payload);
  await NotificationLog.create({
    title: payload.title,
    message: payload.message,
    target_type: payload.target_type,
    target_value: payload.target_value,
    status: payload.status,
    category: meta.category,
    subcategory: meta.subcategory,
  });
}

async function postOneSignalNotification({ playerIds, message, title, includeAll = false }) {
  const url = "https://onesignal.com/api/v1/notifications";
  const headers = {
    Authorization: `Basic ${process.env.ONESIGNAL_API_KEY}`,
    "Content-Type": "application/json",
  };

  const data = {
    app_id: process.env.ONESIGNAL_APP_ID,
    contents: { en: message },
    headings: { en: title },
  };

  if (includeAll) {
    data.included_segments = ["All"];
  } else {
    data.include_player_ids = playerIds;
  }

  await axios.post(url, data, { headers });
}

const sendNotification = async (message, heading, options = {}) => {
  if (!message || typeof message !== "string" || message.trim() === "") {
    console.error("Notification message is required");
    return;
  }

  try {
    await postOneSignalNotification({
      includeAll: true,
      message,
      title: heading,
    });

    await createNotificationLog({
      title: heading,
      message,
      target_type: "all",
      status: "sent",
      ...options,
    });
  } catch (error) {
    console.error(
      "Error sending notification:",
      error.response ? error.response.data : error.message,
    );

    await createNotificationLog({
      title: heading,
      message,
      target_type: "all",
      status: "failed",
      ...options,
    });
  }
};

const sendNotificationToRole = async (
  role,
  message,
  title = "Notification",
  options = {},
) => {
  if (!message) throw new Error("message is required");
  if (!role) throw new Error("role is required");

  try {
    const devices = await UserDevice.findAll({
      include: [
        {
          model: User,
          as: "user",
          where: { role },
        },
      ],
    });

    const playerIds = [
      ...new Set(devices.map((device) => device.player_id).filter(Boolean)),
    ];

    if (playerIds.length === 0) {
      await createNotificationLog({
        title,
        message,
        target_type: "role",
        target_value: role,
        status: "failed",
        ...options,
      });

      return {
        success: false,
        message: `No devices found for role ${role}`,
      };
    }

    await postOneSignalNotification({
      playerIds,
      message,
      title,
    });

    await createNotificationLog({
      title,
      message,
      target_type: "role",
      target_value: role,
      status: "sent",
      ...options,
    });

    return { success: true };
  } catch (error) {
    console.error(
      `Error sending notification to role ${role}:`,
      error.response?.data || error.message,
    );

    await createNotificationLog({
      title,
      message,
      target_type: "role",
      target_value: role,
      status: "failed",
      ...options,
    });

    return { success: false, error: error.message };
  }
};

const sendNotificationToUser = async (
  id,
  message,
  title = "Notification",
  options = {},
) => {
  if (!message) throw new Error("message is required");
  if (!id) throw new Error("id is required");

  try {
    const devices = await UserDevice.findAll({
      where: { user_id: id },
    });

    const playerIds = [
      ...new Set(devices.map((device) => device.player_id).filter(Boolean)),
    ];

    if (playerIds.length === 0) {
      await createNotificationLog({
        title,
        message,
        target_type: "user",
        target_value: id.toString(),
        status: "failed",
        ...options,
      });

      return {
        success: false,
        message: `No devices found for user ${id}`,
      };
    }

    await postOneSignalNotification({
      playerIds,
      message,
      title,
    });

    await createNotificationLog({
      title,
      message,
      target_type: "user",
      target_value: id.toString(),
      status: "sent",
      ...options,
    });

    return { success: true };
  } catch (error) {
    console.error(
      `Error sending notification to id ${id}:`,
      error.response?.data || error.message,
    );

    await createNotificationLog({
      title,
      message,
      target_type: "user",
      target_value: id.toString(),
      status: "failed",
      ...options,
    });

    return { success: false, error: error.message };
  }
};

module.exports = {
  sendNotification,
  sendNotificationToRole,
  sendNotificationToUser,
};
