require('dotenv').config();
const express = require('express');
const router = express.Router();
const { sendNotification } = require('../services/notifications');
const multer = require("multer");
const upload = multer();
const { User, UserDevice} = require('../models'); 
const axios = require('axios');
const NotificationLog = require("../models/notification_log");
const { Op } = require("sequelize");


router.post("/register-device", async (req, res) => {
    const { user_id, player_id } = req.body;

    if (!user_id || !player_id) {
        return res.status(400).json({ error: "user_id و player_id مطلوبان" });
    }

    try {
        let device = await UserDevice.findOne({ where: { player_id } });

        if (device) {
            device.user_id = user_id;
            await device.save();
        } else {
            await UserDevice.create({ user_id, player_id });
        }

        res.json({ success: true, message: "تم تسجيل الجهاز بنجاح" });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "حدث خطأ أثناء تسجيل الجهاز" });
    }
});

router.post('/send-notification', upload.none(), (req, res) => {
    const { title, message } = req.body;

    if (!message) {
        return res.status(400).json({ error: 'message مطلوب' });
    }

    sendNotification(message, title);

    res.json({ success: true, message: '✅ Notification sent to all devices!' });
});

router.post('/send-notification-to-role', upload.none(), async (req, res) => {
  const { title, message, role } = req.body;

  if (!message) {
    return res.status(400).json({ error: 'message مطلوب' });
  }

  if (!role) {
    return res.status(400).json({ error: 'role مطلوب' });
  }

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
        title: title || "Notification",
        message,
        target_type: "role",
        target_value: role,
        status: "failed"
      });
      return res.status(404).json({ error: `لا توجد أجهزة للمستخدمين برول ${role}` });
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
      headings: { en: title || "Notification" },
    };

    await axios.post(url, data, { headers });

    await NotificationLog.create({
      title: title || "Notification",
      message,
      target_type: "role",
      target_value: role,
      status: "sent"
    });

    return res.json({ success: true, message: `تم إرسال الإشعار لجميع المستخدمين برول ${role}` });

  } catch (error) {
    console.error(`❌ Error sending notification to role ${role}:`, error.response ? error.response.data : error.message);
    
    await NotificationLog.create({
      title: title || "Notification",
      message,
      target_type: "role",
      target_value: role,
      status: "failed"
    });

    return res.status(500).json({ error: 'حدث خطأ أثناء إرسال الإشعار' });
  }
});

router.get("/notifications-log", async (req, res) => {
  const { role, page = 1, limit = 10 } = req.query;

  try {
    const whereCondition = {
      [Op.or]: [
        { target_type: 'all' },
      ]
    };

    if (role) {
      whereCondition[Op.or].push({ target_type: 'role', target_value: role });
    }

    const offset = (page - 1) * limit;

    const { count, rows: logs } = await NotificationLog.findAndCountAll({
      where: whereCondition,
      order: [['createdAt', 'DESC']],
      limit: parseInt(limit),
      offset: parseInt(offset),
    });

    res.json({
      total: count,
      page: parseInt(page),
      totalPages: Math.ceil(count / limit),
      logs
    });

  } catch (err) {
    console.error("❌ Error fetching notification logs:", err);
    res.status(500).json({ error: "خطأ أثناء جلب السجل" });
  }
});


module.exports = router;