const matchmaking = require('../services/dominoMatchmaking');
const dominoService = require('../services/dominoService');
const dominoForfeit = require('../services/dominoForfeit');


function initDominoSocket(dominoNamespace) {
  dominoNamespace.on("connection", (socket) => {
    const userId = Number(socket.handshake.query.userId);

    if (!userId) {
      socket.disconnect(true);
      return;
    }

    socket.userId = userId;

    registerDominoHandlers(dominoNamespace, socket);
  });
}

function registerDominoHandlers(io, socket) {
  const userId = socket.userId;

  socket.join(`user:${userId}`);

  // نخزن matchIds اللي دخلها هذا السوكت
  socket.data.dominoMatches = new Set();

  socket.on('domino:find_match', async (_, cb) => {
    try {
      const res = await matchmaking.findOrCreateMatch(io, userId);
      cb?.({ ok: true, ...res });
    } catch (e) {
      cb?.({ ok: false, error: e.message });
    }
  });

  socket.on('domino:cancel_search', async (_, cb) => {
    try {
      const res = await matchmaking.cancelSearch(userId);
      cb?.({ ok: true, ...res });
    } catch (e) {
      cb?.({ ok: false, error: e.message });
    }
  });

  socket.on('domino:join_match', async ({ matchId }, cb) => {
    socket.join(`match:${matchId}`);
    socket.data.dominoMatches.add(String(matchId));

    // إذا كان عليه فورفيت (كان مفصول) نلغيه
    dominoForfeit.clearForfeit(matchId, userId);

    const state = dominoService.getState(matchId);
    if (!state) return cb?.({ ok: false, reason: 'match_not_found' });

    // إعلام الطرفين أنه رجع (اختياري)
    io.to(`match:${matchId}`).emit('domino:player_reconnected', { matchId, userId });

    cb?.({ ok: true, state: dominoService.publicState(state, userId) });
  });

  socket.on('domino:move', ({ matchId, move }, cb) => {
    const res = dominoService.onPlayerMove(io, matchId, userId, move);
    cb?.(res);
  });

  // ✅ لما السوكت يفصل: شغّل فورفيت بعد 30 ثانية لكل ماتش داخلها
  socket.on('disconnect', () => {
    const matches = socket.data.dominoMatches || new Set();
    for (const matchId of matches) {
      const state = dominoService.getState(matchId);
      if (!state || state.status !== 'playing') continue;

      // فقط إذا هو لاعب فعلاً بالماتش
      if (state.players.p1 === userId || state.players.p2 === userId) {
        dominoForfeit.scheduleForfeit(io, matchId, userId, 30);
      }
    }
  });
}

module.exports = { initDominoSocket };
