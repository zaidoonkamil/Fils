const Settings = require('../models/settings');
const sequelize = require('../config/db');

async function initializeSettings() {
  try {
    // إعدادات التحويل من السوا إلى الدولار
    const dollarRateSetting = await Settings.findOne({ 
      where: { key: 'sawa_to_dollar_rate' } 
    });

    if (!dollarRateSetting) {
      await Settings.create({
        key: 'sawa_to_dollar_rate',
        value: '1.25',
        description: 'نسبة تحويل السوا إلى الدولار',
        isActive: true
      });
      console.log('✅ Default sawa_to_dollar_rate setting created successfully');
    } else {
      console.log('ℹ️ sawa_to_dollar_rate setting already exists');
    }

    // إعدادات إنشاء الغرف
    const roomCostSetting = await Settings.findOne({ 
      where: { key: 'room_creation_cost' } 
    });

    if (!roomCostSetting) {
      await Settings.create({
        key: 'room_creation_cost',
        value: '10',
        description: 'تكلفة إنشاء غرفة جديدة',
        isActive: true
      });
      console.log('✅ Default room_creation_cost setting created successfully');
    } else {
      console.log('ℹ️ room_creation_cost setting already exists');
    }

    const roomMaxUsersSetting = await Settings.findOne({ 
      where: { key: 'room_max_users' } 
    });

    if (!roomMaxUsersSetting) {
      await Settings.create({
        key: 'room_max_users',
        value: '50',
        description: 'الحد الأقصى للمستخدمين في الغرفة',
        isActive: true
      });
      console.log('✅ Default room_max_users setting created successfully');
    } else {
      console.log('ℹ️ room_max_users setting already exists');
    }
  } catch (error) {
    console.error('❌ Error initializing settings:', error);
  }
}

if (require.main === module) {
  initializeSettings()
    .then(() => {
      console.log('Settings initialization completed');
      process.exit(0);
    })
    .catch((error) => {
      console.error('Settings initialization failed:', error);
      process.exit(1);
    });
}

module.exports = initializeSettings;
