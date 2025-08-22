const axios = require('axios');
const UserDevice = require("../models/user_device");
const User = require("../models/user");
const NotificationLog = require("../models/notification_log");

const sendNotification = async (message, heading) => {
  if (!message || typeof message !== 'string' || message.trim() === '') {
      console.error('❌ message مطلوب ويجب أن يكون نصًا غير فارغ');
      return;
  }

  const url = 'https://onesignal.com/api/v1/notifications';
  const headers = {
      'Authorization': `Basic ${process.env.ONESIGNAL_API_KEY}`,
      'Content-Type': 'application/json',
  };

  const data = {
      app_id: process.env.ONESIGNAL_APP_ID,
      included_segments: ['All'],
      contents: {
          en: message,
      },
      headings: {
          en: heading,
      },
  };

  try {
    await axios.post(url, data, { headers });
    await NotificationLog.create({
      title: heading,
      message: message,
      target_type: "all",
    });
    console.log("✅ Notification sent and logged");
  } catch (error) {
    console.error('❌ Error sending notification:', error.response ? error.response.data : error.message);
    await NotificationLog.create({
      title: heading,
      message: message,
      target_type: "all",
      status: "failed"
    });
  }
};

const sendNotificationToRole = async (role, message, title = "Notification") => {
  if (!message) throw new Error("message مطلوب");
  if (!role) throw new Error("role مطلوب");

  try {
    const devices = await UserDevice.findAll({
      include: [{
        model: User,
        as: 'user',
        where: { role }
      }]
    });

    const playerIds = devices.map(device => device.player_id);

    if (playerIds.length === 0) {
      await NotificationLog.create({
        title,
        message,
        target_type: "role",
        target_value: role,
        status: "failed"
      });
      return { success: false, message: `لا توجد أجهزة للمستخدمين برول ${role}` };
    }

    const url = 'https://onesignal.com/api/v1/notifications';
    const headers = {
      'Authorization': `Basic ${process.env.ONESIGNAL_API_KEY}`,
      'Content-Type': 'application/json',
    };
    const data = {
      app_id: process.env.ONESIGNAL_APP_ID,
      include_player_ids: playerIds,
      contents: { en: message },
      headings: { en: title },
    };

    await axios.post(url, data, { headers });

    await NotificationLog.create({
      title,
      message,
      target_type: "role",
      target_value: role,
      status: "sent"
    });

    return { success: true };

  } catch (error) {
    console.error(`❌ Error sending notification to role ${role}:`, error.response ? error.response.data : error.message);
    await NotificationLog.create({
      title,
      message,
      target_type: "role",
      target_value: role,
      status: "failed"
    });
    return { success: false, error: error.message };
  }
};

const sendNotificationToUser = async (userId, message, title = "Notification") => {
  if (!message) throw new Error("message مطلوب");
  if (!userId) throw new Error("userId مطلوب");

  try {
    const devices = await UserDevice.findAll({
      where: { user_id: userId }
    });

    const playerIds = devices.map(device => device.player_id);

    if (playerIds.length === 0) {
      return { success: false, message: `لا توجد أجهزة للمستخدم ${userId}` };
    }

    const url = 'https://onesignal.com/api/v1/notifications';
    const headers = {
      'Authorization': `Basic ${process.env.ONESIGNAL_API_KEY}`,
      'Content-Type': 'application/json',
    };
    const data = {
      app_id: process.env.ONESIGNAL_APP_ID,
      include_player_ids: playerIds,
      contents: { en: message },
      headings: { en: title },
    };

    await axios.post(url, data, { headers });

    return { success: true };

  } catch (error) {
    console.error(`❌ Error sending notification to user ${userId}:`, error.response ? error.response.data : error.message);
    return { success: false, error: error.message };
  }
};

module.exports = {
  sendNotification,
  sendNotificationToRole,
  sendNotificationToUser,
};
