const Settings = require('../models/settings');
const sequelize = require('../config/db');

async function initializeSettings() {
  try {
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

    
    const counterDurationSetting = await Settings.findOne({
      where: { key: 'counter_duration_days' },
    });

    if (!counterDurationSetting) {
      await Settings.create({
        key: 'counter_duration_days',
        value: '365',
        description: 'عدد الأيام التي يستمر فيها العداد بعد الشراء',
        isActive: true,
      });
      console.log('✅ Default counter_duration_days setting created successfully');
    } else {
      console.log('ℹ️ counter_duration_days setting already exists');
    }

    const withdrawalCommissionSetting = await Settings.findOne({
      where: { key: 'withdrawal_commission' },
    });

    if (!withdrawalCommissionSetting) {
      await Settings.create({
        key: 'withdrawal_commission',
        value: '0',
        description: 'نسبة العمولة المفروضة على السحب (مثلاً 0.05 = 5%)',
        isActive: true,
      });
      console.log('✅ Default withdrawal_commission setting created successfully');
    }

    const withdrawalMinAmountSetting = await Settings.findOne({
      where: { key: 'withdrawal_min_amount' },
    });
    if (!withdrawalMinAmountSetting) {
      await Settings.create({
        key: 'withdrawal_min_amount',
        value: '6400',
        description: 'الحد الأدنى للمبلغ الذي يمكن سحبه بعد خصم العمولة',
        isActive: true,
      });
      console.log('✅ Default withdrawal_min_amount setting created successfully');
    }
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

    const giftBuyCommissionSetting = await Settings.findOne({
      where: { key: 'gift_buy_commission' },
    });

    if (!giftBuyCommissionSetting) {
      await Settings.create({
        key: 'gift_buy_commission',
        value: '0',
        description: 'نسبة العمولة عند شراء هدية (مثلاً 0.05 = 5%)',
        isActive: true,
      });
      console.log('✅ Default gift_buy_commission setting created successfully');
    } else {
      console.log('ℹ️ gift_buy_commission setting already exists');
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
