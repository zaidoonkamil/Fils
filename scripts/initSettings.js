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
            description: 'Ù†Ø³Ø¨Ø© ØªØ­ÙˆÙŠÙ„ Ø§Ù„Ø³ÙˆØ§ Ø¥Ù„Ù‰ Ø§Ù„Ø¯ÙˆÙ„Ø§Ø±',
            isActive: true
          });
          console.log('âœ… Default sawa_to_dollar_rate setting created successfully');
        } else {
          console.log('â„¹ï¸ sawa_to_dollar_rate setting already exists');
        }

    
    const counterDurationSetting = await Settings.findOne({
      where: { key: 'counter_duration_days' },
    });

    if (!counterDurationSetting) {
      await Settings.create({
        key: 'counter_duration_days',
        value: '365',
        description: 'Ø¹Ø¯Ø¯ Ø§Ù„Ø£ÙŠØ§Ù… Ø§Ù„ØªÙŠ ÙŠØ³ØªÙ…Ø± ÙÙŠÙ‡Ø§ Ø§Ù„Ø¹Ø¯Ø§Ø¯ Ø¨Ø¹Ø¯ Ø§Ù„Ø´Ø±Ø§Ø¡',
        isActive: true,
      });
      console.log('âœ… Default counter_duration_days setting created successfully');
    } else {
      console.log('â„¹ï¸ counter_duration_days setting already exists');
    }

    const withdrawalCommissionSetting = await Settings.findOne({
      where: { key: 'withdrawal_commission' },
    });

    if (!withdrawalCommissionSetting) {
      await Settings.create({
        key: 'withdrawal_commission',
        value: '0',
        description: 'Ù†Ø³Ø¨Ø© Ø§Ù„Ø¹Ù…ÙˆÙ„Ø© Ø§Ù„Ù…ÙØ±ÙˆØ¶Ø© Ø¹Ù„Ù‰ Ø§Ù„Ø³Ø­Ø¨ (Ù…Ø«Ù„Ø§Ù‹ 0.05 = 5%)',
        isActive: true,
      });
      console.log('âœ… Default withdrawal_commission setting created successfully');
    }

    const withdrawalMinAmountSetting = await Settings.findOne({
      where: { key: 'withdrawal_min_amount' },
    });
    if (!withdrawalMinAmountSetting) {
      await Settings.create({
        key: 'withdrawal_min_amount',
        value: '6400',
        description: 'Ø§Ù„Ø­Ø¯ Ø§Ù„Ø£Ø¯Ù†Ù‰ Ù„Ù„Ù…Ø¨Ù„Øº Ø§Ù„Ø°ÙŠ ÙŠÙ…ÙƒÙ† Ø³Ø­Ø¨Ù‡ Ø¨Ø¹Ø¯ Ø®ØµÙ… Ø§Ù„Ø¹Ù…ÙˆÙ„Ø©',
        isActive: true,
      });
      console.log('âœ… Default withdrawal_min_amount setting created successfully');
    }
    const roomCostSetting = await Settings.findOne({ 
      where: { key: 'room_creation_cost' } 
    });

    if (!roomCostSetting) {
      await Settings.create({
        key: 'room_creation_cost',
        value: '10',
        description: 'ØªÙƒÙ„ÙØ© Ø¥Ù†Ø´Ø§Ø¡ ØºØ±ÙØ© Ø¬Ø¯ÙŠØ¯Ø©',
        isActive: true
      });
      console.log('âœ… Default room_creation_cost setting created successfully');
    } else {
      console.log('â„¹ï¸ room_creation_cost setting already exists');
    }

    const roomMaxUsersSetting = await Settings.findOne({ 
      where: { key: 'room_max_users' } 
    });

    if (!roomMaxUsersSetting) {
      await Settings.create({
        key: 'room_max_users',
        value: '50',
        description: 'Ø§Ù„Ø­Ø¯ Ø§Ù„Ø£Ù‚ØµÙ‰ Ù„Ù„Ù…Ø³ØªØ®Ø¯Ù…ÙŠÙ† ÙÙŠ Ø§Ù„ØºØ±ÙØ©',
        isActive: true
      });
      console.log('âœ… Default room_max_users setting created successfully');
    } else {
      console.log('â„¹ï¸ room_max_users setting already exists');
    }

    const giftBuyCommissionSetting = await Settings.findOne({
      where: { key: 'gift_buy_commission' },
    });

    if (!giftBuyCommissionSetting) {
      await Settings.create({
        key: 'gift_buy_commission',
        value: '0',
        description: 'Ù†Ø³Ø¨Ø© Ø§Ù„Ø¹Ù…ÙˆÙ„Ø© Ø¹Ù†Ø¯ Ø´Ø±Ø§Ø¡ Ù‡Ø¯ÙŠØ© (Ù…Ø«Ù„Ø§Ù‹ 0.05 = 5%)',
        isActive: true,
      });
      console.log('âœ… Default gift_buy_commission setting created successfully');
    } else {
      console.log('â„¹ï¸ gift_buy_commission setting already exists');
    }

    const dominoEntryFeeSetting = await Settings.findOne({
      where: { key: 'domino_entry_fee' },
    });

    if (!dominoEntryFeeSetting) {
      await Settings.create({
        key: 'domino_entry_fee',
        value: '0',
        description: 'Ø±Ø³Ù… Ø¯Ø®ÙˆÙ„ Ù„Ø¹Ø¨Ø© Ø§Ù„Ø¯ÙˆÙ…ÙŠÙ†Ùˆ (Ù‚ÙŠÙ…Ø© Ø«Ø§Ø¨ØªØ©)',
        isActive: true,
      });
      console.log('âœ… Default domino_entry_fee setting created successfully');
    } else {
      console.log('â„¹ï¸ domino_entry_fee setting already exists');
    }

    const dominoWinFeeSetting = await Settings.findOne({
      where: { key: 'domino_win_fee' },
    });

    if (!dominoWinFeeSetting) {
      await Settings.create({
        key: 'domino_win_fee',
        value: '0',
        description: 'Ø±Ø³ÙˆÙ… Ø§Ù„ÙÙˆØ² Ø¨Ù„Ø¹Ø¨Ø© Ø§Ù„Ø¯ÙˆÙ…ÙŠÙ†Ùˆ (Ù…Ø«Ù„Ø§Ù‹ 0.05 = 5% Ù…Ù† Ø§Ù„Ø¬Ø§Ø¦Ø²Ø©)',
        isActive: true,
      });
      console.log('âœ… Default domino_win_fee setting created successfully');
    } else {
      console.log('â„¹ï¸ domino_win_fee setting already exists');
    }

    const roomGiftOwnerCutSetting = await Settings.findOne({
      where: { key: 'room_gift_owner_cut' },
    });

    if (!roomGiftOwnerCutSetting) {
      await Settings.create({
        key: 'room_gift_owner_cut',
        value: '0.1',
        description: 'Ù†Ø³Ø¨Ø© Ù…Ù† Ù‚ÙŠÙ…Ø© Ø§Ù„Ù‡Ø¯ÙŠØ© ØªÙØ®ØµÙ… Ù„ØµØ§Ù„Ø­ ØµØ§Ø­Ø¨ Ø§Ù„ØºØ±ÙØ© (Ù…Ø«Ù„Ø§Ù‹ 0.1 = 10%)',
        isActive: true,
      });
      console.log('âœ… Default room_gift_owner_cut setting created successfully');
    } else {
      console.log('â„¹ï¸ room_gift_owner_cut setting already exists');
    }

    const roomGiftReceiverCutSetting = await Settings.findOne({
      where: { key: 'room_gift_receiver_cut' },
    });

    if (!roomGiftReceiverCutSetting) {
      await Settings.create({
        key: 'room_gift_receiver_cut',
        value: '0.5',
        description: 'Ù†Ø³Ø¨Ø© Ù…Ù† Ù‚ÙŠÙ…Ø© Ø§Ù„Ù‡Ø¯ÙŠØ© ØªØ°Ù‡Ø¨ Ù„Ù„Ù…Ø³ØªÙ„Ù… Ø¹Ù†Ø¯ Ø¥Ø±Ø³Ø§Ù„Ù‡Ø§ ÙÙŠ ØºØ±ÙØ© (Ù…Ø«Ù„Ø§Ù‹ 0.5 = 50%)',
        isActive: true,
      });
      console.log('âœ… Default room_gift_receiver_cut setting created successfully');
    }

    const roomGiftAdminCutSetting = await Settings.findOne({
      where: { key: 'room_gift_admin_cut' },
    });

    if (!roomGiftAdminCutSetting) {
      await Settings.create({
        key: 'room_gift_admin_cut',
        value: '0.4',
        description: 'Ù†Ø³Ø¨Ø© Ù…Ù† Ù‚ÙŠÙ…Ø© Ø§Ù„Ù‡Ø¯ÙŠØ© ØªØ®ØµÙ… Ù„Ù„Ø¥Ø¯Ø§Ø±Ø© (Ù…Ø«Ù„Ø§Ù‹ 0.4 = 40%)',
        isActive: true,
      });
      console.log('âœ… Default room_gift_admin_cut setting created successfully');
    }


    const referralRewardSetting = await Settings.findOne({
      where: { key: 'referral_reward_percentage' },
    });

    if (!referralRewardSetting) {
      await Settings.create({
        key: 'referral_reward_percentage',
        value: '0',
        description: 'Ù†Ø³Ø¨Ø© Ø§Ù„Ù…Ø¨Ù„Øº Ø§Ù„Ø°ÙŠ ÙŠØ­ØµÙ„ Ø¹Ù„ÙŠÙ‡ ØµØ§Ø­Ø¨ Ø±Ù…Ø² Ø§Ù„Ø¥Ø­Ø§Ù„Ø© Ø¹Ù†Ø¯ ØªÙ†ÙÙŠØ° Ø§Ù„Ù…Ø³ØªØ®Ø¯Ù… Ù„Ù„Ø¥Ø¬Ø±Ø§Ø¡ Ø§Ù„ÙŠÙˆÙ…ÙŠ',
        isActive: true,
      });
      console.log('âœ… Default referral_reward_percentage setting created successfully');
    } else {
      console.log('â„¹ï¸ referral_reward_percentage setting already exists');
    }

    const roomBackgroundChangeCostSetting = await Settings.findOne({
      where: { key: 'room_background_change_cost' },
    });

    if (!roomBackgroundChangeCostSetting) {
      await Settings.create({
        key: 'room_background_change_cost',
        value: '0',
        description: 'تكلفة تغيير خلفية الغرفة',
        isActive: true,
      });
      console.log('✅ Default room_background_change_cost setting created successfully');
    } else {
      console.log('ℹ️ room_background_change_cost setting already exists');
    }
    const profileUpdateCostSetting = await Settings.findOne({
      where: { key: 'profile_update_cost' },
    });

    if (!profileUpdateCostSetting) {
      await Settings.create({
        key: 'profile_update_cost',
        value: '0',
        description: 'ØªÙƒÙ„ÙØ© ØªØ¹Ø¯ÙŠÙ„ Ø¨ÙŠØ§Ù†Ø§Øª Ø§Ù„Ø­Ø³Ø§Ø¨',
        isActive: true,
      });
      console.log('âœ… Default profile_update_cost setting created successfully');
    } else {
      console.log('â„¹ï¸ profile_update_cost setting already exists');
    }

  } catch (error) {
    console.error('âŒ Error initializing settings:', error);
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

