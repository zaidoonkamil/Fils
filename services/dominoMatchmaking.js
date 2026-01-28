// services/dominoMatchmaking.js
const { DominoQueue, DominoMatch, Settings, User } = require('../models');
const dominoService = require('./dominoService');
const sequelize = require("../config/db"); 
const { Op } = require('sequelize');

async function getSetting(key, fallback = '0') {
  const s = await Settings.findOne({ where: { key, isActive: true } });
  return s ? s.value : fallback;
}

async function findOrCreateMatch(io, userId) {
  const entryFee = Number(await getSetting('domino_entry_fee', '0'));
  const winFee = Number(await getSetting('domino_win_fee', '0'));

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
    return { status: 'waiting' };
  }

  // 7) بعد الـ commit: أنشئ state وبث للطرفين
  const state = dominoService.createNewMatchState(createdMatch.id, p1, p2);
  dominoService.storeState(createdMatch.id, state);

  io.to(`user:${p1}`).emit('domino:match_found', {
    matchId: createdMatch.id,
    state: dominoService.publicState(state, p1),
  });

  io.to(`user:${p2}`).emit('domino:match_found', {
    matchId: createdMatch.id,
    state: dominoService.publicState(state, p2),
  });

  dominoService.startTurnTimer(io, createdMatch.id);

  return { status: 'matched', matchId: createdMatch.id };
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
