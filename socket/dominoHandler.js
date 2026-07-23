const matchmaking = require('../services/dominoMatchmaking');
const dominoService = require('../services/dominoService');
const dominoForfeit = require('../services/dominoForfeit');
const jwt = require('jsonwebtoken');

const { Op } = require('sequelize');
const { DominoQueue, DominoMatch, User, Settings } = require('../models');

const ADMIN_TOKEN_VALID_AFTER_IAT_KEY = 'admin_token_valid_after_iat';

function extractSocketToken(rawToken) {
  if (typeof rawToken !== 'string') return null;
  const normalized = rawToken.trim();
  if (!normalized) return null;
  return normalized.startsWith('Bearer ')
    ? normalized.split(' ')[1]
    : normalized;
}

async function resolveAccountBanMessage(user) {
  if (!user || user.accountBanActive !== true) {
    return null;
  }

  const now = new Date();
  const banUntil =
    user.accountBanUntil instanceof Date
      ? user.accountBanUntil
      : user.accountBanUntil
      ? new Date(user.accountBanUntil)
      : null;

  if (banUntil && banUntil <= now) {
    user.accountBanActive = false;
    user.accountBanReason = null;
    user.accountBanUntil = null;
    user.accountBanBy = null;
    await user.save();
    return null;
  }

  const reason =
    typeof user.accountBanReason === 'string' && user.accountBanReason.trim()
      ? user.accountBanReason.trim()
      : 'بدون سبب محدد';
  const untilText = banUntil
    ? `${banUntil.getFullYear()}/${String(banUntil.getMonth() + 1).padStart(
        2,
        '0'
      )}/${String(banUntil.getDate()).padStart(2, '0')}`
    : 'غير محدد';

  return `تم حظر حسابك مؤقتًا. السبب: ${reason}. ينتهي الحظر بتاريخ ${untilText}`;
}

async function getAdminTokenValidAfterIat() {
  const currentUnixSeconds = Math.floor(Date.now() / 1000);

  const [setting] = await Settings.findOrCreate({
    where: { key: ADMIN_TOKEN_VALID_AFTER_IAT_KEY },
    defaults: {
      value: String(currentUnixSeconds),
      description: 'Reject admin JWTs issued before this unix timestamp',
      isActive: true,
    },
  });

  const parsedValue = parseInt(String(setting.value || '').trim(), 10);
  if (Number.isNaN(parsedValue) || parsedValue <= 0) {
    setting.value = String(currentUnixSeconds);
    setting.isActive = true;
    await setting.save();
    return currentUnixSeconds;
  }

  return parsedValue;
}

async function enforceSocketTokenPolicy(decoded) {
  if (!decoded || decoded.role !== 'admin') {
    return true;
  }

  const decodedIat = Number(decoded.iat || 0);
  if (!decodedIat) {
    return false;
  }

  const validAfterIat = await getAdminTokenValidAfterIat();
  return decodedIat >= validAfterIat;
}

async function findAuthorizedMatch(matchId, userId) {
  const numericMatchId = Number(matchId);
  if (!numericMatchId) return null;

  return DominoMatch.findOne({
    where: {
      id: numericMatchId,
      [Op.or]: [{ player1Id: userId }, { player2Id: userId }],
    },
    attributes: ['id', 'status', 'player1Id', 'player2Id', 'winnerId', 'stateJson'],
  });
}

async function emitPendingMatchStateToUser(io, userId) {
  const playingMatch = await DominoMatch.findOne({
    where: {
      status: 'playing',
      [Op.or]: [{ player1Id: userId }, { player2Id: userId }],
    },
    order: [['updatedAt', 'DESC']],
    attributes: ['id', 'status', 'player1Id', 'player2Id', 'winnerId', 'stateJson'],
  });

  if (playingMatch) {
    const liveState = await dominoService.getOrRestoreState(playingMatch.id);
    if (liveState) {
      io.to(`user:${userId}`).emit('domino:match_found', {
        matchId: playingMatch.id,
        state: await dominoService.publicState(liveState, userId),
      });
      return true;
    }
  }

  const recentFinished = await getRecentFinishedMatchForUser(userId);
  if (recentFinished) {
    const finishedPayload =
      await dominoService.buildFinishedMatchPayloadFromRecord(recentFinished);
    if (finishedPayload) {
      io.to(`user:${userId}`).emit('domino:match_finished', finishedPayload);
      return true;
    }
  }

  return false;
}

function initDominoSocket(dominoNamespace) {
  dominoNamespace.on('connection', async (socket) => {
    try {
      const rawToken =
        socket.handshake.auth?.token || socket.handshake.query?.token;
      const token = extractSocketToken(rawToken);

      if (!token) {
        socket.disconnect(true);
        return;
      }

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const policyAllowed = await enforceSocketTokenPolicy(decoded);
      if (!policyAllowed) {
        socket.disconnect(true);
        return;
      }

      const userId = Number(decoded.id || decoded.userId);

      if (!userId) {
        socket.disconnect(true);
        return;
      }

      const user = await User.findByPk(userId, {
        attributes: [
          'id',
          'isActive',
          'role',
          'accountBanActive',
          'accountBanReason',
          'accountBanUntil',
          'accountBanBy',
        ],
      });
      if (!user || user.isActive === false) {
        socket.disconnect(true);
        return;
      }

      const accountBanMessage = await resolveAccountBanMessage(user);
      if (accountBanMessage) {
        socket.emit('domino:error', { error: accountBanMessage });
        socket.disconnect(true);
        return;
      }

      socket.userId = userId;
      registerDominoHandlers(dominoNamespace, socket);
      await emitPendingMatchStateToUser(dominoNamespace, userId);
    } catch (_) {
      socket.disconnect(true);
    }
  });
}

async function getRecentFinishedMatchForUser(userId) {
  // فقط المباريات المنتهية بآخر 10 دقايق — الأقدم ما تهم اللاعب
  const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);

  const match = await DominoMatch.findOne({
    where: {
      status: 'finished',
      updatedAt: { [Op.gte]: tenMinutesAgo },
      [Op.or]: [{ player1Id: userId }, { player2Id: userId }],
    },
    order: [['updatedAt', 'DESC']],
  });

  if (!match) return null;

  // إذا اللاعب شاف النتيجة من قبل (ضغط OK بالديالوج) ما نعيد عرضها
  const stateJson =
    match.stateJson && typeof match.stateJson === 'object'
      ? match.stateJson
      : {};
  const resultSeen =
    stateJson.resultSeen && typeof stateJson.resultSeen === 'object'
      ? stateJson.resultSeen
      : {};
  if (resultSeen[String(userId)]) return null;

  return match;
}

function registerDominoHandlers(io, socket) {
  const userId = socket.userId;

  socket.join(`user:${userId}`);
  socket.data.dominoMatches = new Set();

  socket.on('domino:find_match', async (payload = {}, cb) => {
    try {
      const packageKey =
        typeof payload?.packageKey === 'string'
          ? payload.packageKey
          : 'classic_1';
      const res = await matchmaking.findOrCreateMatch(io, userId, packageKey);
      cb?.({ ok: true, ...res });
    } catch (e) {
      cb?.({ ok: false, error: e.message });
    }
  });

  socket.on('domino:cancel_search', async (_, cb) => {
    try {
      const res = await matchmaking.cancelSearch(userId);
      io.to(`user:${userId}`).emit('domino:cancel_search_result', {
        ok: true,
        ...res,
      });
      cb?.({ ok: true, ...res });
    } catch (e) {
      cb?.({ ok: false, error: e.message });
    }
  });

  socket.on('domino:resume', async (_, cb) => {
    try {
      console.log('[DOMINO] resume from user:', userId);

      const q = await DominoQueue.findOne({ where: { userId } });
      if (q && q.status === 'searching') {
        return cb?.({ ok: true, mode: 'searching' });
      }

      const playingMatch = await DominoMatch.findOne({
        where: {
          status: 'playing',
          [Op.or]: [{ player1Id: userId }, { player2Id: userId }],
        },
        order: [['createdAt', 'DESC']],
      });

      if (!playingMatch) {
        const recentFinished = await getRecentFinishedMatchForUser(userId);
        if (recentFinished) {
          const payload =
            await dominoService.buildFinishedMatchPayloadFromRecord(
              recentFinished
            );
          if (payload) {
            return cb?.({ ok: true, mode: 'finished', matchFinished: payload });
          }
        }
        return cb?.({ ok: true, mode: 'idle' });
      }

      const matchId = playingMatch.id;
      const state = await dominoService.getOrRestoreState(matchId);

      if (!state) {
        const finishedPayload = await dominoService.buildFinishedMatchPayload(
          matchId
        );
        if (finishedPayload) {
          return cb?.({
            ok: true,
            mode: 'finished',
            matchFinished: finishedPayload,
          });
        }

        await DominoMatch.update(
          { status: 'finished', winnerId: null },
          { where: { id: matchId } }
        );
        return cb?.({ ok: false, reason: 'state_missing_server_restart' });
      }

      socket.join(`match:${matchId}`);
      socket.data.dominoMatches.add(String(matchId));
      dominoService.startTurnTimer(io, matchId);

      dominoForfeit.clearForfeit(matchId, userId);
      io.to(`match:${matchId}`).emit('domino:player_reconnected', {
        matchId,
        userId,
      });

      return cb?.({
        ok: true,
        mode: 'matched',
        matchId,
        state: await dominoService.publicState(state, userId),
      });
    } catch (e) {
      console.log('[DOMINO] resume error:', e);
      return cb?.({ ok: false, error: e.message });
    }
  });

  socket.on('domino:join_match', async ({ matchId }, cb) => {
    try {
      const numericMatchId = Number(matchId);
      if (!numericMatchId) {
        return cb?.({ ok: false, reason: 'invalid_match_id' });
      }

      const match = await findAuthorizedMatch(numericMatchId, userId);
      if (!match) {
        return cb?.({ ok: false, reason: 'match_not_found' });
      }

      dominoForfeit.clearForfeit(numericMatchId, userId);

      const state = await dominoService.getOrRestoreState(numericMatchId);
      if (!state) {
        const finishedPayload =
          match.status === 'finished'
            ? await dominoService.buildFinishedMatchPayload(numericMatchId)
            : null;
        if (finishedPayload) {
          return cb?.({
            ok: true,
            status: 'finished',
            matchFinished: finishedPayload,
          });
        }

        return cb?.({ ok: false, reason: 'match_not_found' });
      }

      socket.join(`match:${numericMatchId}`);
      socket.data.dominoMatches.add(String(numericMatchId));

      if (state.status === 'playing') {
        dominoService.startTurnTimer(io, numericMatchId);
      }

      io.to(`match:${numericMatchId}`).emit('domino:player_reconnected', {
        matchId: numericMatchId,
        userId,
      });

      cb?.({ ok: true, state: await dominoService.publicState(state, userId) });
    } catch (e) {
      cb?.({ ok: false, error: e.message || 'join_failed' });
    }
  });

  // انسحاب صريح: ينهي المباراة فوراً بدون انتظار مهلة الانقطاع
  socket.on('domino:leave_match', async ({ matchId } = {}, cb) => {
    try {
      const state = await dominoService.getOrRestoreState(matchId);
      if (!state || state.status !== 'playing') {
        return cb?.({ ok: true, status: 'not_playing' });
      }

      const p1 = String(state.players.p1);
      const p2 = String(state.players.p2);
      if (p1 !== String(userId) && p2 !== String(userId)) {
        return cb?.({ ok: false, error: 'not_in_match' });
      }

      const winnerId =
        p1 === String(userId) ? state.players.p2 : state.players.p1;
      await dominoService.finishByForfeit(io, matchId, winnerId, userId);
      return cb?.({ ok: true, status: 'finished' });
    } catch (e) {
      return cb?.({ ok: false, error: e.message || 'leave_failed' });
    }
  });

  socket.on('domino:move', async ({ matchId, move }, cb) => {
    try {
      const res = await dominoService.onPlayerMove(io, matchId, userId, move);
      cb?.(res);
    } catch (e) {
      console.error('[DOMINO] move error:', e?.message || e);
      cb?.({ ok: false, error: e?.message || 'move_failed' });
    }
  });

  // اللاعب أكد مشاهدة نتيجة المباراة — لا تنعرض عليه مرة ثانية
  socket.on('domino:ack_result', async ({ matchId } = {}, cb) => {
    try {
      const numericMatchId = Number(matchId);
      if (!numericMatchId) return cb?.({ ok: false, error: 'invalid_match_id' });

      const match = await DominoMatch.findOne({
        where: {
          id: numericMatchId,
          [Op.or]: [{ player1Id: userId }, { player2Id: userId }],
        },
      });
      if (!match) return cb?.({ ok: false, error: 'match_not_found' });

      const stateJson =
        match.stateJson && typeof match.stateJson === 'object'
          ? { ...match.stateJson }
          : {};
      const resultSeen =
        stateJson.resultSeen && typeof stateJson.resultSeen === 'object'
          ? { ...stateJson.resultSeen }
          : {};
      resultSeen[String(userId)] = true;
      stateJson.resultSeen = resultSeen;

      await DominoMatch.update(
        { stateJson },
        { where: { id: numericMatchId } }
      );
      return cb?.({ ok: true });
    } catch (e) {
      return cb?.({ ok: false, error: e.message || 'ack_failed' });
    }
  });

  socket.on('domino:get_match_result', async ({ matchId }, cb) => {
    try {
      const numericMatchId = Number(matchId);
      if (!numericMatchId) {
        return cb?.({ ok: false, error: 'invalid_match_id' });
      }

      const match = await findAuthorizedMatch(numericMatchId, userId);
      if (!match) {
        return cb?.({ ok: false, error: 'match_not_found' });
      }

      const finishedPayload = await dominoService.buildFinishedMatchPayload(
        numericMatchId
      );
      if (finishedPayload) {
        return cb?.({
          ok: true,
          status: 'finished',
          matchFinished: finishedPayload,
        });
      }

      const liveState = await dominoService.getOrRestoreState(numericMatchId);
      if (liveState && liveState.status === 'playing') {
        return cb?.({
          ok: true,
          status: 'playing',
          state: await dominoService.publicState(liveState, userId),
        });
      }

      return cb?.({ ok: true, status: match.status || 'unknown' });
    } catch (e) {
      return cb?.({ ok: false, error: e.message || 'get_match_result_failed' });
    }
  });

  socket.on('disconnect', async () => {
    const joinedMatches = socket.data.dominoMatches || new Set();

    for (const matchId of joinedMatches) {
      const state = await dominoService.getOrRestoreState(matchId);
      if (!state || state.status !== 'playing') continue;

      if (state.players.p1 === userId || state.players.p2 === userId) {
        dominoForfeit.scheduleForfeit(io, matchId, userId, 15);
      }
    }

    try {
      const match = await DominoMatch.findOne({
        where: {
          status: 'playing',
          [Op.or]: [{ player1Id: userId }, { player2Id: userId }],
        },
        order: [['createdAt', 'DESC']],
      });

      if (match) {
        const matchId = String(match.id);
        const state = dominoService.getState(matchId);
        if (state && state.status === 'playing') {
          dominoForfeit.scheduleForfeit(io, matchId, userId, 15);
        }
      }
    } catch (e) {
      console.log('[DOMINO] disconnect fallback error:', e?.message || e);
    }
  });
}

module.exports = { initDominoSocket };
