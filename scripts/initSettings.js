const Settings = require('../models/settings');
const sequelize = require('../config/db');

async function initializeSettings() {
  try {
    const existingSetting = await Settings.findOne({ 
      where: { key: 'sawa_to_dollar_rate' } 
    });

    if (!existingSetting) {
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
