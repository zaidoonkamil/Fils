const matchmaking = require('../services/dominoMatchmaking');
const dominoService = require('../services/dominoService');
const dominoForfeit = require('../services/dominoForfeit');
const jwt = require('jsonwebtoken');

const { Op } = require('sequelize');
const { DominoQueue, DominoMatch, User } = require('../models');

function initDominoSocket(dominoNamespace) {
  dominoNamespace.on('connection', async (socket) => {
    try {
      const rawToken =
        socket.handshake.auth?.token || socket.handshake.query?.token;
      const token =
        typeof rawToken === 'string' && rawToken.startsWith('Bearer ')
          ? rawToken.split(' ')[1]
          : rawToken;

      if (!token) {
        socket.disconnect(true);
        return;
      }

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const userId = Number(decoded.id || decoded.userId);

      if (!userId) {
        socket.disconnect(true);
        return;
      }

      const user = await User.findByPk(userId, {
        attributes: ['id', 'isActive'],
      });
      if (!user || user.isActive === false) {
        socket.disconnect(true);
        return;
      }

      socket.userId = userId;
      registerDominoHandlers(dominoNamespace, socket);
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
      socket.join(`match:${matchId}`);
      socket.data.dominoMatches.add(String(matchId));

      dominoForfeit.clearForfeit(matchId, userId);

      const state = await dominoService.getOrRestoreState(matchId);
      if (!state) {
        const finishedPayload = await dominoService.buildFinishedMatchPayload(
          matchId
        );
        if (finishedPayload) {
          return cb?.({
            ok: true,
            status: 'finished',
            matchFinished: finishedPayload,
          });
        }

        return cb?.({ ok: false, reason: 'match_not_found' });
      }

      if (state.status === 'playing') {
        dominoService.startTurnTimer(io, matchId);
      }

      io.to(`match:${matchId}`).emit('domino:player_reconnected', {
        matchId,
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

      const match = await DominoMatch.findOne({
        where: {
          id: numericMatchId,
          [Op.or]: [{ player1Id: userId }, { player2Id: userId }],
        },
      });

      if (!match) {
        return cb?.({ ok: false, error: 'match_not_found' });
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
