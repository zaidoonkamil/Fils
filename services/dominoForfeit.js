// services/dominoForfeit.js
const dominoService = require('./dominoService');

const forfeits = new Map(); // key: `${matchId}:${userId}` => timeoutId

function scheduleForfeit(io, matchId, userId, seconds = 30) {
  const key = `${matchId}:${userId}`;

  // لا تكرر تايمر
  if (forfeits.has(key)) return;

  const timeoutId = setTimeout(() => {
    const state = dominoService.getState(matchId);
    if (!state || state.status !== 'playing') {
      clearForfeit(matchId, userId);
      return;
    }

    // إذا اللاعب رجع قبل انتهاء الوقت، cancel راح يشيله
    const opponentId = state.players.p1 === userId ? state.players.p2 : state.players.p1;

    // أعلن فوز الخصم بسبب الانقطاع
    dominoService.finishByForfeit(io, matchId, opponentId, userId);

    clearForfeit(matchId, userId);
  }, seconds * 1000);

  forfeits.set(key, timeoutId);

  // إعلام الطرف الثاني أن خصمه فصل (اختياري)
  io.to(`match:${matchId}`).emit('domino:player_disconnected', {
    matchId,
    userId,
    forfeitInSeconds: seconds,
  });
}

function clearForfeit(matchId, userId) {
  const key = `${matchId}:${userId}`;
  const timeoutId = forfeits.get(key);
  if (timeoutId) clearTimeout(timeoutId);
  forfeits.delete(key);
}

function clearAllForMatch(matchId) {
  for (const key of forfeits.keys()) {
    if (key.startsWith(`${matchId}:`)) {
      const t = forfeits.get(key);
      if (t) clearTimeout(t);
      forfeits.delete(key);
    }
  }
}

module.exports = {
  scheduleForfeit,
  clearForfeit,
  clearAllForMatch,
};
