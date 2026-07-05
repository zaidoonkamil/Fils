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
            value: '1',
            description: 'نسبة تحويل السوا إلى الدولار',
            isActive: true
          });
          console.log('Default sawa_to_dollar_rate setting created successfully');
        } else {
          console.log('sawa_to_dollar_rate setting already exists');
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
      console.log('Default counter_duration_days setting created successfully');
    } else {
      console.log('counter_duration_days setting already exists');
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
      console.log('Default withdrawal_commission setting created successfully');
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
      console.log('Default withdrawal_min_amount setting created successfully');
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
      console.log('Default room_creation_cost setting created successfully');
    } else {
      console.log('room_creation_cost setting already exists');
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
      console.log('Default room_max_users setting created successfully');
    } else {
      console.log('room_max_users setting already exists');
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
      console.log('Default gift_buy_commission setting created successfully');
    } else {
      console.log('gift_buy_commission setting already exists');
    }

    const dominoEntryFeeSetting = await Settings.findOne({
      where: { key: 'domino_entry_fee' },
    });

    if (!dominoEntryFeeSetting) {
      await Settings.create({
        key: 'domino_entry_fee',
        value: '0',
        description: 'رسم دخول لعبة الدومينو (قيمة ثابتة)',
        isActive: true,
      });
      console.log('Default domino_entry_fee setting created successfully');
    } else {
      console.log('domino_entry_fee setting already exists');
    }

    const dominoWinFeeSetting = await Settings.findOne({
      where: { key: 'domino_win_fee' },
    });

    if (!dominoWinFeeSetting) {
      await Settings.create({
        key: 'domino_win_fee',
        value: '0',
        description: 'رسوم الفوز بلعبة الدومينو (مثلاً 0.05 = 5% من الجائزة)',
        isActive: true,
      });
      console.log('Default domino_win_fee setting created successfully');
    } else {
      console.log('domino_win_fee setting already exists');
    }

    const dominoClassicPackage1PrizeSetting = await Settings.findOne({
      where: { key: 'domino_classic_package_1_prize' },
    });

    if (!dominoClassicPackage1PrizeSetting) {
      await Settings.create({
        key: 'domino_classic_package_1_prize',
        value: '2000',
        description: 'عدد نقاط الجائزة للبــاقة الأولى في الدومينو',
        isActive: true,
      });
      console.log('Default domino_classic_package_1_prize setting created successfully');
    } else {
      console.log('domino_classic_package_1_prize setting already exists');
    }

    const dominoClassicPackage1EntrySetting = await Settings.findOne({
      where: { key: 'domino_classic_package_1_entry_fee' },
    });

    if (!dominoClassicPackage1EntrySetting) {
      await Settings.create({
        key: 'domino_classic_package_1_entry_fee',
        value: '6000',
        description: 'رسم الدخول للبــاقة الأولى في الدومينو',
        isActive: true,
      });
      console.log('Default domino_classic_package_1_entry_fee setting created successfully');
    } else {
      console.log('domino_classic_package_1_entry_fee setting already exists');
    }

    const dominoClassicPackage2PrizeSetting = await Settings.findOne({
      where: { key: 'domino_classic_package_2_prize' },
    });

    if (!dominoClassicPackage2PrizeSetting) {
      await Settings.create({
        key: 'domino_classic_package_2_prize',
        value: '1000',
        description: 'عدد نقاط الجائزة للبــاقة الثانية في الدومينو',
        isActive: true,
      });
      console.log('Default domino_classic_package_2_prize setting created successfully');
    } else {
      console.log('domino_classic_package_2_prize setting already exists');
    }

    const dominoClassicPackage2EntrySetting = await Settings.findOne({
      where: { key: 'domino_classic_package_2_entry_fee' },
    });

    if (!dominoClassicPackage2EntrySetting) {
      await Settings.create({
        key: 'domino_classic_package_2_entry_fee',
        value: '3000',
        description: 'رسم الدخول للبــاقة الثانية في الدومينو',
        isActive: true,
      });
      console.log('Default domino_classic_package_2_entry_fee setting created successfully');
    } else {
      console.log('domino_classic_package_2_entry_fee setting already exists');
    }

    const dominoClassicPackage3PrizeSetting = await Settings.findOne({
      where: { key: 'domino_classic_package_3_prize' },
    });

    if (!dominoClassicPackage3PrizeSetting) {
      await Settings.create({
        key: 'domino_classic_package_3_prize',
        value: '10000',
        description: 'عدد نقاط الجائزة للبــاقة الثالثة في الدومينو',
        isActive: true,
      });
      console.log('Default domino_classic_package_3_prize setting created successfully');
    } else {
      console.log('domino_classic_package_3_prize setting already exists');
    }

    const dominoClassicPackage3EntrySetting = await Settings.findOne({
      where: { key: 'domino_classic_package_3_entry_fee' },
    });

    if (!dominoClassicPackage3EntrySetting) {
      await Settings.create({
        key: 'domino_classic_package_3_entry_fee',
        value: '30000',
        description: 'رسم الدخول للبــاقة الثالثة في الدومينو',
        isActive: true,
      });
      console.log('Default domino_classic_package_3_entry_fee setting created successfully');
    } else {
      console.log('domino_classic_package_3_entry_fee setting already exists');
    }

    const dominoClassicPackage4PrizeSetting = await Settings.findOne({
      where: { key: 'domino_classic_package_4_prize' },
    });

    if (!dominoClassicPackage4PrizeSetting) {
      await Settings.create({
        key: 'domino_classic_package_4_prize',
        value: '5000',
        description: 'عدد نقاط الجائزة للبــاقة الرابعة في الدومينو',
        isActive: true,
      });
      console.log('Default domino_classic_package_4_prize setting created successfully');
    } else {
      console.log('domino_classic_package_4_prize setting already exists');
    }

    const dominoClassicPackage4EntrySetting = await Settings.findOne({
      where: { key: 'domino_classic_package_4_entry_fee' },
    });

    if (!dominoClassicPackage4EntrySetting) {
      await Settings.create({
        key: 'domino_classic_package_4_entry_fee',
        value: '15000',
        description: 'رسم الدخول للبــاقة الرابعة في الدومينو',
        isActive: true,
      });
      console.log('Default domino_classic_package_4_entry_fee setting created successfully');
    } else {
      console.log('domino_classic_package_4_entry_fee setting already exists');
    }

    const roomGiftOwnerCutSetting = await Settings.findOne({
      where: { key: 'room_gift_owner_cut' },
    });

    if (!roomGiftOwnerCutSetting) {
      await Settings.create({
        key: 'room_gift_owner_cut',
        value: '0.1',
        description: 'نسبة من قيمة الهدية تُخصم لصالح صاحب الغرفة (مثلاً 0.1 = 10%)',
        isActive: true,
      });
      console.log('Default room_gift_owner_cut setting created successfully');
    } else {
      console.log('room_gift_owner_cut setting already exists');
    }

    const roomGiftReceiverCutSetting = await Settings.findOne({
      where: { key: 'room_gift_receiver_cut' },
    });

    if (!roomGiftReceiverCutSetting) {
      await Settings.create({
        key: 'room_gift_receiver_cut',
        value: '0.5',
        description: 'نسبة من قيمة الهدية تذهب للمستلم عند إرسالها في غرفة (مثلاً 0.5 = 50%)',
        isActive: true,
      });
      console.log('Default room_gift_receiver_cut setting created successfully');
    }

    const roomGiftAdminCutSetting = await Settings.findOne({
      where: { key: 'room_gift_admin_cut' },
    });

    if (!roomGiftAdminCutSetting) {
      await Settings.create({
        key: 'room_gift_admin_cut',
        value: '0.4',
        description: 'نسبة من قيمة الهدية تخصم للإدارة (مثلاً 0.4 = 40%)',
        isActive: true,
      });
      console.log('Default room_gift_admin_cut setting created successfully');
    }


    const referralRewardSetting = await Settings.findOne({
      where: { key: 'referral_reward_percentage' },
    });

    if (!referralRewardSetting) {
      await Settings.create({
        key: 'referral_reward_percentage',
        value: '0',
        description: 'نسبة المبلغ الذي يحصل عليه صاحب رمز الإحالة عند تنفيذ المستخدم للإجراء اليومي',
        isActive: true,
      });
      console.log('Default referral_reward_percentage setting created successfully');
    } else {
      console.log('referral_reward_percentage setting already exists');
    }

    const roomBackgroundChangeCostSetting = await Settings.findOne({
      where: { key: 'room_background_change_cost' },
    });

    if (!roomBackgroundChangeCostSetting) {
      await Settings.create({
        key: 'room_background_change_cost',
        value: '0',
        description: 'Room background change cost',
        isActive: true,
      });
      console.log('Default room_background_change_cost setting created successfully');
    } else {
      console.log('room_background_change_cost setting already exists');
    }
    const profileUpdateCostSetting = await Settings.findOne({
      where: { key: 'profile_update_cost' },
    });

    if (!profileUpdateCostSetting) {
      await Settings.create({
        key: 'profile_update_cost',
        value: '0',
        description: 'تكلفة تعديل بيانات الحساب',
        isActive: true,
      });
      console.log('Default profile_update_cost setting created successfully');
    } else {
      console.log('profile_update_cost setting already exists');
    }

  } catch (error) {
    console.error('Error initializing settings:', error);
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

