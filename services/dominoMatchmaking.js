// services/dominoMatchmaking.js
const { DominoQueue, DominoMatch, Settings, User } = require('../models');
const dominoService = require('./dominoService');
const sequelize = require("../config/db"); 
const { Op } = require('sequelize');

async function getSetting(key, fallback = '0') {
  const s = await Settings.findOne({ where: { key, isActive: true } });
  return s ? s.value : fallback;
}

async function loadClassicPackageConfig(packageKey) {
  const allowedIndexes = new Set(['1', '2', '3', '4']);
  const requestedIndex = String(packageKey || 'classic_1').replace('classic_', '');
  const index = allowedIndexes.has(requestedIndex) ? requestedIndex : '1';
  const normalizedKey = `classic_${index}`;
  const defaultEntries = {
    '1': '6000',
    '2': '3000',
    '3': '30000',
    '4': '15000',
  };
  const defaultPrizes = {
    '1': '2000',
    '2': '1000',
    '3': '10000',
    '4': '5000',
  };
  const entryFee = Number(await getSetting(`domino_classic_package_${index}_entry_fee`, defaultEntries[index]));
  const prize = Number(await getSetting(`domino_classic_package_${index}_prize`, defaultPrizes[index]));
  const winFee = Number(await getSetting('domino_win_fee', '0'));
  return {
    packageKey: normalizedKey,
    entryFee,
    prize,
    winFee,
  };
}

async function findOrCreateMatch(io, userId, packageKey = 'classic_1') {
  const packageConfig = await loadClassicPackageConfig(packageKey);
  const entryFee = Number(packageConfig.entryFee || 0);
  const prize = Number(packageConfig.prize || 0);
  const winFee = Number(packageConfig.winFee || 0);

  // 1) إذا هو أصلًا searching لا تعيد
  const existing = await DominoQueue.findOne({ where: { userId } });
  if (existing && existing.status === 'searching') return { status: 'already_searching' };

  let createdMatch = null;
  let p1 = null;
  let p2 = null;

  await sequelize.transaction(async (t) => {
    // 2) اقفل المستخدم وخصم الرسم بأمان
    const user = await User.findByPk(userId, {
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!user) throw new Error('user_not_found');

    const sawa = Number(user.sawa ?? 0);
    if (sawa < entryFee) throw new Error('insufficient_sawa');

    user.sawa = sawa - entryFee;
    await user.save({ transaction: t });


    // 3) دخله الطابور (searching)
    await DominoQueue.upsert(
      { userId, entryFee, status: 'searching' },
      { transaction: t }
    );

    // 4) دور على خصم غيره + اقفل صف الخصم
    const opponent = await DominoQueue.findOne({
      where: {
        status: 'searching',
        userId: { [Op.ne]: userId },
        entryFee,
      },
      order: [['createdAt', 'ASC']],
      transaction: t,
      lock: t.LOCK.UPDATE,
      skipLocked: true, // Postgres: ممتاز حتى ما تنتظر صف مقفول
    });

    if (!opponent) {
      // ماكو خصم بعد
      return;
    }

    // 5) حدّث الاثنين matched بشرط بعدهم searching (حتى ما يصير سباق)
    const [affected] = await DominoQueue.update(
      { status: 'matched' },
      {
        where: {
          userId: { [Op.in]: [userId, opponent.userId] },
          status: 'searching',
        },
        transaction: t,
      }
    );

    // لازم يحدّث صفّين. إذا أقل => واحد من عدهم سبق وانطابق
    if (affected !== 2) {
      // نخلي المستخدم searching (يبقى بالطابور) أو ترجع waiting
      // هنا نرجع بدون إنشاء ماتش
      return;
    }

    // 6) أنشئ المباراة داخل نفس الترانزاكشن
    createdMatch = await DominoMatch.create(
      {
        player1Id: opponent.userId,
        player2Id: userId,
        entryFee,
        winFee,
        status: 'playing',
      },
      { transaction: t }
    );

    p1 = opponent.userId;
    p2 = userId;
  });

  // إذا ما انخلق ماتش => user صار waiting
  if (!createdMatch) {
    return { status: 'waiting', packageKey: packageConfig.packageKey, prize, entryFee };
  }

  // 7) بعد الـ commit: أنشئ state وبث للطرفين
  const state = dominoService.createNewMatchState(createdMatch.id, p1, p2);
  dominoService.storeState(createdMatch.id, state);

  io.to(`user:${p1}`).emit('domino:match_found', {
    matchId: createdMatch.id,
    state: await dominoService.publicState(state, p1),
  });

  io.to(`user:${p2}`).emit('domino:match_found', {
    matchId: createdMatch.id,
    state: await dominoService.publicState(state, p2),
  });

  dominoService.startTurnTimer(io, createdMatch.id);

  return { status: 'matched', matchId: createdMatch.id, packageKey: packageConfig.packageKey, prize, entryFee };
}

async function cancelSearch(userId) {
  let refunded = 0;

  await sequelize.transaction(async (t) => {
    const q = await DominoQueue.findOne({
      where: { userId, status: 'searching' },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });

    if (!q) return;

    await DominoQueue.update(
      { status: 'canceled' },
      { where: { userId, status: 'searching' }, transaction: t }
    );

    const user = await User.findByPk(userId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!user) throw new Error('user_not_found');

    refunded = Number(q.entryFee ?? 0);
    user.sawa = Number(user.sawa ?? 0) + refunded;
    await user.save({ transaction: t });
  });

  return { status: 'canceled', refunded };
}


module.exports = { findOrCreateMatch, cancelSearch };
