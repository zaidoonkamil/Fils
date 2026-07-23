// services/dominoMatchmaking.js
const { DominoQueue, DominoMatch, Settings, User } = require('../models');
const dominoService = require('./dominoService');
const sequelize = require('../config/db');
const { Op } = require('sequelize');

async function getSetting(key, fallback = '0') {
  const setting = await Settings.findOne({ where: { key, isActive: true } });
  return setting ? setting.value : fallback;
}

async function loadClassicPackageConfig(packageKey) {
  const allowedIndexes = new Set(['1', '2', '3', '4']);
  const requestedIndex = String(packageKey || 'classic_1').replace(
    'classic_',
    ''
  );
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

  const entryFee = Number(
    await getSetting(
      `domino_classic_package_${index}_entry_fee`,
      defaultEntries[index]
    )
  );
  const prize = Number(
    await getSetting(
      `domino_classic_package_${index}_prize`,
      defaultPrizes[index]
    )
  );
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

  const existingQueue = await DominoQueue.findOne({ where: { userId } });
  if (existingQueue && existingQueue.status === 'searching') {
    return { status: 'already_searching' };
  }

  let createdMatch = null;
  let player1Id = null;
  let player2Id = null;
  let alreadyPlayingMatchId = null;

  await sequelize.transaction(async (transaction) => {
    const existingPlayingMatch = await DominoMatch.findOne({
      where: {
        status: 'playing',
        [Op.or]: [{ player1Id: userId }, { player2Id: userId }],
      },
      order: [['createdAt', 'DESC']],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });

    if (existingPlayingMatch) {
      alreadyPlayingMatchId = existingPlayingMatch.id;
      return;
    }

    const user = await User.findByPk(userId, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!user) {
      throw new Error('user_not_found');
    }

    const currentSawa = Number(user.sawa ?? 0);
    if (currentSawa < entryFee) {
      throw new Error('insufficient_sawa');
    }

    user.sawa = currentSawa - entryFee;
    await user.save({ transaction });

    await DominoQueue.upsert(
      { userId, entryFee, status: 'searching' },
      { transaction }
    );

    const opponent = await DominoQueue.findOne({
      where: {
        status: 'searching',
        userId: { [Op.ne]: userId },
        entryFee,
      },
      order: [['createdAt', 'ASC']],
      transaction,
      lock: transaction.LOCK.UPDATE,
      skipLocked: true,
    });

    if (!opponent) {
      return;
    }

    const [affectedRows] = await DominoQueue.update(
      { status: 'matched' },
      {
        where: {
          userId: { [Op.in]: [userId, opponent.userId] },
          status: 'searching',
        },
        transaction,
      }
    );

    if (affectedRows !== 2) {
      return;
    }

    createdMatch = await DominoMatch.create(
      {
        player1Id: opponent.userId,
        player2Id: userId,
        entryFee,
        winFee,
        status: 'playing',
      },
      { transaction }
    );

    player1Id = opponent.userId;
    player2Id = userId;
  });

  if (alreadyPlayingMatchId) {
    return {
      status: 'already_in_match',
      matchId: alreadyPlayingMatchId,
      packageKey: packageConfig.packageKey,
      prize,
      entryFee,
    };
  }

  if (!createdMatch) {
    return {
      status: 'waiting',
      packageKey: packageConfig.packageKey,
      prize,
      entryFee,
    };
  }

  const state = dominoService.createNewMatchState(
    createdMatch.id,
    player1Id,
    player2Id,
    {
      pricing: {
        entryFee,
        prizePerPlayer: prize,
        totalPrize: prize,
        commission: Math.max(0, entryFee * 2 - prize),
      },
    }
  );
  dominoService.storeState(createdMatch.id, state);
  await dominoService.persistRuntimeState(createdMatch.id, state);

  io.to(`user:${player1Id}`).emit('domino:match_found', {
    matchId: createdMatch.id,
    state: await dominoService.publicState(state, player1Id),
  });

  io.to(`user:${player2Id}`).emit('domino:match_found', {
    matchId: createdMatch.id,
    state: await dominoService.publicState(state, player2Id),
  });

  dominoService.startTurnTimer(io, createdMatch.id);

  return {
    status: 'matched',
    matchId: createdMatch.id,
    packageKey: packageConfig.packageKey,
    prize,
    entryFee,
  };
}

async function cancelSearch(userId) {
  let refunded = 0;

  await sequelize.transaction(async (transaction) => {
    const queueRecord = await DominoQueue.findOne({
      where: { userId, status: 'searching' },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });

    if (!queueRecord) {
      return;
    }

    await DominoQueue.update(
      { status: 'canceled' },
      {
        where: { userId, status: 'searching' },
        transaction,
      }
    );

    const user = await User.findByPk(userId, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!user) {
      throw new Error('user_not_found');
    }

    refunded = Number(queueRecord.entryFee ?? 0);
    user.sawa = Number(user.sawa ?? 0) + refunded;
    await user.save({ transaction });
  });

  return { status: 'canceled', refunded };
}

module.exports = { findOrCreateMatch, cancelSearch, loadClassicPackageConfig };
