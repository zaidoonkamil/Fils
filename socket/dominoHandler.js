const matchmaking = require('../services/dominoMatchmaking');
const dominoService = require('../services/dominoService');
const dominoForfeit = require('../services/dominoForfeit');
const jwt = require('jsonwebtoken');

const { Op } = require('sequelize');
const { DominoQueue, DominoMatch, User } = require('../models');

function initDominoSocket(dominoNamespace) {
  dominoNamespace.on('connection', async (socket) => {
    try {
      const rawToken = socket.handshake.auth?.token || socket.handshake.query?.token;
      const token = typeof rawToken === "string" && rawToken.startsWith("Bearer ")
        ? rawToken.split(" ")[1]
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

      const user = await User.findByPk(userId, { attributes: ["id", "isActive"] });
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

function registerDominoHandlers(io, socket) {
  const userId = socket.userId;

  socket.join(`user:${userId}`);
  socket.data.dominoMatches = new Set();

  socket.on('domino:find_match', async (payload = {}, cb) => {
    try {
      const packageKey = typeof payload?.packageKey === 'string' ? payload.packageKey : 'classic_1';
      const res = await matchmaking.findOrCreateMatch(io, userId, packageKey);
      cb?.({ ok: true, ...res });
    } catch (e) {
      cb?.({ ok: false, error: e.message });
    }
  });

  socket.on('domino:cancel_search', async (_, cb) => {
    try {
      const res = await matchmaking.cancelSearch(userId);
      io.to(`user:${userId}`).emit('domino:cancel_search_result', { ok: true, ...res });
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

      const match = await DominoMatch.findOne({
        where: {
          status: 'playing',
          [Op.or]: [{ player1Id: userId }, { player2Id: userId }],
        },
        order: [['createdAt', 'DESC']],
      });

      if (!match) {
        return cb?.({ ok: true, mode: 'idle' });
      }

      const matchId = match.id;

      const state = dominoService.getState(matchId);

      if (!state) {
        await DominoMatch.update(
          { status: 'finished', winnerId: null },
          { where: { id: matchId } }
        );
        return cb?.({ ok: false, reason: 'state_missing_server_restart' });
      }

      socket.join(`match:${matchId}`);
      socket.data.dominoMatches.add(String(matchId));

      dominoForfeit.clearForfeit(matchId, userId);

      io.to(`match:${matchId}`).emit('domino:player_reconnected', { matchId, userId });

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
    socket.join(`match:${matchId}`);
    socket.data.dominoMatches.add(String(matchId));

    dominoForfeit.clearForfeit(matchId, userId);

    const state = dominoService.getState(matchId);
    if (!state) return cb?.({ ok: false, reason: 'match_not_found' });

    io.to(`match:${matchId}`).emit('domino:player_reconnected', { matchId, userId });

    cb?.({ ok: true, state: await dominoService.publicState(state, userId) });
  });

  socket.on('domino:move', async ({ matchId, move }, cb) => {
    const res = await dominoService.onPlayerMove(io, matchId, userId, move);
    cb?.(res);
  });

  socket.on('domino:get_match_result', async ({ matchId }, cb) => {
    try {
      const numericMatchId = Number(matchId);
      if (!numericMatchId) {
        return cb?.({ ok: false, error: 'invalid_match_id' });
      }

      const liveState = dominoService.getState(numericMatchId);
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

      if (match.status !== 'finished') {
        return cb?.({ ok: true, status: match.status || 'unknown' });
      }

      const player1Id = Number(match.player1Id);
      const player2Id = Number(match.player2Id);
      const winnerId = match.winnerId == null ? '' : String(match.winnerId);
      const loserId =
        winnerId && String(player1Id) === winnerId
          ? String(player2Id)
          : winnerId && String(player2Id) === winnerId
            ? String(player1Id)
            : '';
      const stateJson = match.stateJson && typeof match.stateJson === 'object'
        ? match.stateJson
        : {};
      const scores = stateJson.scores && typeof stateJson.scores === 'object'
        ? stateJson.scores
        : {};
      const lastRound = stateJson.lastRound && typeof stateJson.lastRound === 'object'
        ? stateJson.lastRound
        : {};

      const players = await User.findAll({
        where: { id: [player1Id, player2Id] },
        attributes: ['id', 'name', 'images'],
      });

      const playersInfo = {};
      for (const player of players) {
        playersInfo[String(player.id)] = {
          id: player.id,
          name: player.name || `لاعب ${player.id}`,
          image: player.images || '',
        };
      }

      const finishSummary = await dominoService.buildMatchFinishSummary(numericMatchId);

      const statePublicBase = {
        matchId: String(numericMatchId),
        players: {
          p1: String(player1Id),
          p2: String(player2Id),
        },
        playersInfo,
        scores,
        winnerId,
        status: 'finished',
        reason: lastRound.reason || 'finished',
      };

      return cb?.({
        ok: true,
        status: 'finished',
        matchFinished: {
          matchId: String(numericMatchId),
          winnerId,
          loserId,
          reason: lastRound.reason || 'finished',
          finishSummary,
          statePublicP1: statePublicBase,
          statePublicP2: statePublicBase,
        },
      });
    } catch (e) {
      return cb?.({ ok: false, error: e.message || 'get_match_result_failed' });
    }
  });

  socket.on('disconnect', async () => {
    const joinedMatches = socket.data.dominoMatches || new Set();

    for (const matchId of joinedMatches) {
      const state = dominoService.getState(matchId);
      if (!state || state.status !== 'playing') continue;

      if (state.players.p1 === userId || state.players.p2 === userId) {
        dominoForfeit.scheduleForfeit(io, matchId, userId, 30);
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
          dominoForfeit.scheduleForfeit(io, matchId, userId, 30);
        }
      }
    } catch (e) {
      console.log('[DOMINO] disconnect fallback error:', e?.message || e);
    }
  });
}

module.exports = { initDominoSocket };
