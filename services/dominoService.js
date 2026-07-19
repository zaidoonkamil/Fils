const { DominoMatch, User, Settings } = require('../models');
const sequelize = require("../config/db");


const DEFAULT_TURN_SECONDS = 15;

let turnSecondsCache = DEFAULT_TURN_SECONDS;
let turnSecondsFetchedAt = 0;

function currentTurnSeconds() {
  const now = Date.now();
  if (now - turnSecondsFetchedAt > 60 * 1000) {
    turnSecondsFetchedAt = now;
    Settings.findOne({ where: { key: 'domino_turn_seconds', isActive: true } })
      .then((s) => {
        const v = Number(s?.value);
        if (Number.isFinite(v) && v >= 5 && v <= 120) {
          turnSecondsCache = Math.floor(v);
        }
      })
      .catch(() => {});
  }
  return turnSecondsCache;
}

// warm the cache at startup
currentTurnSeconds();

function stateTurnSeconds(state) {
  return Number(state?.turnSeconds) || DEFAULT_TURN_SECONDS;
}

const matches = new Map();
const timers = new Map();

function clearMatchState(matchId) {
  matches.delete(String(matchId));
}

async function persistFinish(matchId, winnerId, state) {
  await DominoMatch.update(
    {
      status: 'finished',
      winnerId,
      stateJson: state
        ? {
            scores: state.scores,
            roundWins: state.roundWins,
            rounds: state.round.number,
            winner: winnerId,
            lastRound: state.lastRound,
          }
        : null,
    },
    { where: { id: matchId } }
  );
}


async function payoutWinner(matchId, winnerId) {
  await sequelize.transaction(async (t) => {
    const match = await DominoMatch.findByPk(matchId, {
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!match) throw new Error('match_not_found');
    if (match.status === 'finished') return;
    if (match.prizeSawa != null) return;
    const entryFee = Number(match.entryFee ?? 0);
    const pot = entryFee * 2;

    const winFee = Number(match.winFee ?? 0);
    const commission = winFee > 0 && winFee < 1 ? pot * winFee : winFee;

    const prize = Math.max(0, Math.floor(pot - commission));

    const winner = await User.findByPk(winnerId, {
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!winner) throw new Error('winner_not_found');

    winner.sawa = Number(winner.sawa ?? 0) + prize;
    await winner.save({ transaction: t });

    await DominoMatch.update(
      { prizeSawa: prize, commissionSawa: Math.floor(commission) },
      { where: { id: matchId }, transaction: t }
    );
  });
}

async function buildMatchFinishSummary(matchId) {
  const match = await DominoMatch.findByPk(matchId, {
    attributes: ['id', 'entryFee', 'winFee', 'prizeSawa', 'commissionSawa'],
  });
  if (!match) return null;

  const entryFee = Number(match.entryFee ?? 0);
  const pot = entryFee * 2;
  const rawWinFee = Number(match.winFee ?? 0);
  const commission =
    rawWinFee > 0 && rawWinFee < 1 ? pot * rawWinFee : rawWinFee;
  const fallbackPrize = Math.max(0, Math.floor(pot - commission));

  return {
    entryFee,
    totalPot: pot,
    prizeSawa: Number(match.prizeSawa ?? fallbackPrize),
    commissionSawa: Number(match.commissionSawa ?? Math.floor(commission)),
  };
}

async function buildFinishedMatchPayloadFromRecord(match) {
  if (!match) return null;

  const player1Id = Number(match.player1Id);
  const player2Id = Number(match.player2Id);
  const winnerId = match.winnerId == null ? '' : String(match.winnerId);
  const loserId =
    winnerId && String(player1Id) === winnerId
      ? String(player2Id)
      : winnerId && String(player2Id) === winnerId
        ? String(player1Id)
        : '';

  const stateJson =
    match.stateJson && typeof match.stateJson === 'object'
      ? match.stateJson
      : {};
  const scores =
    stateJson.scores && typeof stateJson.scores === 'object'
      ? stateJson.scores
      : {};
  const roundWins =
    stateJson.roundWins && typeof stateJson.roundWins === 'object'
      ? stateJson.roundWins
      : {};
  const lastRound =
    stateJson.lastRound && typeof stateJson.lastRound === 'object'
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

  const finishSummary = await buildMatchFinishSummary(match.id);

  const publicState = {
    matchId: String(match.id),
    players: {
      p1: String(player1Id),
      p2: String(player2Id),
    },
    playersInfo,
    scores,
    roundWins,
    winnerId,
    status: 'finished',
    reason: lastRound.reason || 'finished',
  };

  return {
    matchId: String(match.id),
    winnerId,
    loserId,
    reason: lastRound.reason || 'finished',
    finishSummary,
    statePublicP1: publicState,
    statePublicP2: publicState,
  };
}

async function buildFinishedMatchPayload(matchId) {
  const match = await DominoMatch.findByPk(matchId, {
    attributes: [
      'id',
      'player1Id',
      'player2Id',
      'winnerId',
      'status',
      'stateJson',
      'entryFee',
      'winFee',
      'prizeSawa',
      'commissionSawa',
      'updatedAt',
      'createdAt',
    ],
  });

  if (!match || match.status !== 'finished') return null;
  return buildFinishedMatchPayloadFromRecord(match);
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function generateTiles() {
  const tiles = [];
  for (let a = 0; a <= 6; a++) {
    for (let b = a; b <= 6; b++) tiles.push([a, b]);
  }
  return shuffle(tiles);
}

function createNewMatchState(matchId, p1, p2) {
  const tiles = generateTiles();
  const hand1 = tiles.splice(0, 7);
  const hand2 = tiles.splice(0, 7);
  const boneyard = tiles;

  const starter = chooseStarter(p1, hand1, p2, hand2);
  const starterHand = starter === p1 ? hand1 : hand2;
  const turnSeconds = currentTurnSeconds();

  return {
    matchId,
    players: { p1, p2 },
    hands: { [p1]: hand1, [p2]: hand2 },
    boneyard,
    board: {
      center: null,
      leftChain: [],
      rightChain: [],
      left: null,
      right: null,
    },
    turnUserId: starter,
    lastMoveAt: Date.now(),
    status: 'playing',
    winnerId: null,
    turnSeconds,
    turn: { expiresAt: Date.now() + turnSeconds * 1000 },
    scores: { [p1]: 0, [p2]: 0 },
    roundWins: { [p1]: 0, [p2]: 0 },
    matchTargetScore: 101,
    round: {
      number: 1,
      starterUserId: starter,
      ended: false,
      mustOpenWith: mandatoryOpeningDouble(starterHand),
    },
    lastRound: null,
  };
}

// بالدومينو الحقيقي: اللي يبدي الجولة لازم يفتتح بأعلى دبل عنده (إذا عنده دبل)
function mandatoryOpeningDouble(hand) {
  for (let d = 6; d >= 0; d--) {
    if (hand.some((t) => t[0] === d && t[1] === d)) return [d, d];
  }
  return null;
}

function chooseStarter(p1, hand1, p2, hand2) {
  const best1 = bestOpeningTile(hand1);
  const best2 = bestOpeningTile(hand2);

  if (best1.isDouble && !best2.isDouble) return p1;
  if (!best1.isDouble && best2.isDouble) return p2;

  if (best1.sum > best2.sum) return p1;
  if (best2.sum > best1.sum) return p2;

  return p1;
}

function bestOpeningTile(hand) {
  for (let d = 6; d >= 0; d--) {
    if (hand.some(t => t[0] === d && t[1] === d)) {
      return { tile: [d, d], isDouble: true, sum: d + d };
    }
  }

  let best = null;
  for (const t of hand) {
    const sum = t[0] + t[1];
    if (!best || sum > best.sum) best = { tile: t, sum, isDouble: false };
  }
  return best || { tile: null, sum: -1, isDouble: false };
}

function sumHandPips(hand) {
  return hand.reduce((sum, tile) => sum + tile[0] + tile[1], 0);
}

function computeRoundPointsOnEmptyHand(winnerId, loserId, state) {
  const loserHand = state.hands[loserId] || [];
  const points = sumHandPips(loserHand);
  return points;
}


function isRoundBlocked(state) {
  if (state.boneyard.length > 0) return false;

  const p1 = state.players.p1;
  const p2 = state.players.p2;

  const p1CanPlay = hasAnyLegalPlay(state, p1);
  const p2CanPlay = hasAnyLegalPlay(state, p2);

  return !p1CanPlay && !p2CanPlay;
}

function blockedWinnerAndPoints(state) {
  if (!isRoundBlocked(state)) return null;

  const p1 = state.players.p1;
  const p2 = state.players.p2;
  const p1Score = sumHandPips(state.hands[p1] || []);
  const p2Score = sumHandPips(state.hands[p2] || []);

  if (p1Score === p2Score) {
    // Tie: no one wins, no points awarded
    return { winnerId: null, points: 0, isTie: true };
  }

  if (p1Score < p2Score) {
    // p1 has lower score, wins
    return { winnerId: p1, points: p2Score - p1Score, isTie: false };
  } else {
    // p2 has lower score, wins
    return { winnerId: p2, points: p1Score - p2Score, isTie: false };
  }
}


function startNewRound(matchId, state) {
  const tiles = generateTiles();
  const hand1 = tiles.splice(0, 7);
  const hand2 = tiles.splice(0, 7);
  const boneyard = tiles;

  const p1 = state.players.p1;
  const p2 = state.players.p2;

  state.hands[p1] = hand1;
  state.hands[p2] = hand2;
  state.boneyard = boneyard;

  state.board = {
    center: null,
    leftChain: [],
    rightChain: [],
    left: null,
    right: null,
  };

  let starter = null;

  if (state.lastRound && state.lastRound.winnerId) {
    starter = state.lastRound.winnerId;
  } else {
    starter = chooseStarter(p1, hand1, p2, hand2);
  }

  const starterHand = state.hands[starter] || [];

  state.round.number++;
  state.round.starterUserId = starter;
  state.round.ended = false;
  state.round.mustOpenWith = mandatoryOpeningDouble(starterHand);

  state.turnUserId = starter;
  state.lastMoveAt = Date.now();
  state.turnSeconds = currentTurnSeconds();
  state.turn.expiresAt = Date.now() + stateTurnSeconds(state) * 1000;
}

function storeState(matchId, state) {
  matches.set(String(matchId), state);
}

function getState(matchId) {
  return matches.get(String(matchId));
}

async function publicState(state, viewerId) {
  const { hands, boneyard, ...rest } = state;

  const opponentId =
    state.players.p1 === viewerId
      ? state.players.p2
      : state.players.p1;

  const players = await User.findAll({
    where: {
      id: [state.players.p1, state.players.p2],
    },
    attributes: ['id', 'name', 'images'],
  });

  const playersInfo = {};
  for (const p of players) {
    let image = '';
    if (Array.isArray(p.images) && p.images.length > 0 && p.images[0] != null) {
      image = String(p.images[0]);
    }
    playersInfo[p.id] = {
      name: p.name,
      image,
    };
  }

  return {
    ...rest,
    playersInfo,

    hands: {
      [viewerId]: hands[viewerId],
      [opponentId]: { count: hands[opponentId].length },
    },

    boneyardCount: boneyard.length,
    scores: state.scores,
    round: state.round,
    matchTargetScore: state.matchTargetScore,
  };
}

function otherPlayer(state, userId) {
  return state.players.p1 === userId ? state.players.p2 : state.players.p1;
}

function tileEquals(t1, t2) {
  return (t1[0] === t2[0] && t1[1] === t2[1]) || (t1[0] === t2[1] && t1[1] === t2[0]);
}

function removeTileFromHand(hand, tile) {
  const idx = hand.findIndex((t) => tileEquals(t, tile));
  if (idx === -1) return false;
  hand.splice(idx, 1);
  return true;
}

function normalizeTile(tile) {
  return [tile[0], tile[1]];
}

function canPlayOnLeft(state, tile) {
  if (state.board.center == null) return true;
  const leftVal = state.board.left;
  return tile[0] === leftVal || tile[1] === leftVal;
}

function canPlayOnRight(state, tile) {
  if (state.board.center == null) return true;
  const rightVal = state.board.right;
  return tile[0] === rightVal || tile[1] === rightVal;
}

function hasAnyLegalPlay(state, userId) {
  const hand = state.hands[userId] || [];
  for (const tile of hand) {
    if (canPlayOnLeft(state, tile) || canPlayOnRight(state, tile)) return true;
  }
  return false;
}

function rotateToMatchLeft(state, tile) {
  const leftVal = state.board.left;
  const [a, b] = tile;
  if (a === leftVal) return [b, a];
  if (b === leftVal) return [a, b];
  return null;
}

function rotateToMatchRight(state, tile) {
  const rightVal = state.board.right;
  const [a, b] = tile;
  if (a === rightVal) return [a, b];
  if (b === rightVal) return [b, a];
  return null;
}

function nextTurn(state) {
  const { p1, p2 } = state.players;
  state.turnUserId = state.turnUserId === p1 ? p2 : p1;
  state.lastMoveAt = Date.now();
  state.turn.expiresAt = Date.now() + stateTurnSeconds(state) * 1000;
}

function finishMatch(state, winnerId) {
  state.status = 'finished';
  state.winnerId = winnerId;
}

function isValidMove(state, userId, move) {
  if (!state) return { ok: false, reason: 'match_not_found' };
  if (state.status !== 'playing') return { ok: false, reason: 'match_finished' };
  if (state.turnUserId !== userId) return { ok: false, reason: 'not_your_turn' };
  if (!move || !move.type) return { ok: false, reason: 'invalid_move' };

  if (move.type === 'draw_until_playable') {
    if (state.boneyard.length === 0) return { ok: false, reason: 'boneyard_empty' };
    if (hasAnyLegalPlay(state, userId)) return { ok: false, reason: 'you_have_a_play' };
    return { ok: true };
  }

  if (move.type === 'play') {
    if (!Array.isArray(move.tile) || move.tile.length !== 2) return { ok: false, reason: 'invalid_tile' };
    if (move.side !== 'left' && move.side !== 'right') return { ok: false, reason: 'invalid_side' };

    const hand = state.hands[userId] || [];
    if (!hand.some((t) => tileEquals(t, move.tile))) return { ok: false, reason: 'tile_not_in_hand' };

    const tile = normalizeTile(move.tile);

    // فرض قاعدة الافتتاح: أول قطعة بالجولة لازم تكون أعلى دبل عند اللاعب المفتتح
    if (state.board.center == null) {
      const must = state.round?.mustOpenWith;
      if (must && !tileEquals(tile, must)) {
        return { ok: false, reason: 'must_open_with_double' };
      }
      return { ok: true };
    }

    if (move.side === 'left' && !canPlayOnLeft(state, tile)) return { ok: false, reason: 'cannot_play_left' };
    if (move.side === 'right' && !canPlayOnRight(state, tile)) return { ok: false, reason: 'cannot_play_right' };

    return { ok: true };
  }

  if (move.type === 'draw') {
    if (state.boneyard.length === 0) return { ok: false, reason: 'boneyard_empty' };
    if (hasAnyLegalPlay(state, userId)) return { ok: false, reason: 'you_have_a_play' };
    return { ok: true };
  }

  if (move.type === 'pass') {
    if (state.boneyard.length > 0) return { ok: false, reason: 'must_draw' };
    if (hasAnyLegalPlay(state, userId)) return { ok: false, reason: 'you_have_a_play' };
    return { ok: true };
  }

  return { ok: false, reason: 'unknown_move_type' };
}

function applyMove(state, userId, move) {
  if (move.type === 'draw_until_playable') {
    const drawnTiles = [];

    while (state.boneyard.length > 0 && !hasAnyLegalPlay(state, userId)) {
      const drawn = state.boneyard.shift();
      state.hands[userId].push(drawn);
      drawnTiles.push(drawn);
    }

    return { ok: true, action: 'draw_until_playable', drawnTiles };
  }

  if (move.type === 'draw') {
    const drawn = state.boneyard.shift();
    state.hands[userId].push(drawn);
    return { ok: true, action: 'draw', drawn };
  }

  if (move.type === 'pass') {
    return { ok: true, action: 'pass' };
  }

  if (move.type === 'play') {
    const tile = normalizeTile(move.tile);
    const hand = state.hands[userId];

    // remove from hand
    const removed = removeTileFromHand(hand, tile);
    if (!removed) return { ok: false, reason: 'tile_not_in_hand' };

    if (!state.board.center) {
      state.board.center = tile;
      state.board.left = tile[0];
      state.board.right = tile[1];
      state.board.leftChain = [];
      state.board.rightChain = [];
      return { ok: true, action: 'play', placed: tile, side: 'first' };
    }

    if (move.side === 'left') {
      const oriented = rotateToMatchLeft(state, tile);
      if (!oriented) return { ok: false, reason: 'cannot_play_left' };

      // نخزنها بطرف اليسار (الأبعد عن السنتر يصير أول)
      state.board.leftChain.unshift(oriented);
      state.board.left = oriented[0];

      return { ok: true, action: 'play', placed: oriented, side: 'left' };
    } else {
      const oriented = rotateToMatchRight(state, tile);
      if (!oriented) return { ok: false, reason: 'cannot_play_right' };

      // نخزنها بطرف اليمين
      state.board.rightChain.push(oriented);
      state.board.right = oriented[1];

      return { ok: true, action: 'play', placed: oriented, side: 'right' };
    }
  }

  return { ok: false, reason: 'invalid_move' };
}

function startTurnTimer(io, matchId) {
  clearTurnTimer(matchId);

  const t = setInterval(() => {
    const state = getState(matchId);
    if (!state || state.status !== 'playing') return;

    if (Date.now() >= state.turn.expiresAt) {
      void autoMove(io, matchId);
    }
  }, 250);

  timers.set(String(matchId), t);
}

function clearTurnTimer(matchId) {
  const t = timers.get(String(matchId));
  if (t) clearInterval(t);
  timers.delete(String(matchId));
}

// ينهي الجولة (يوزع النقاط، يبث النتيجة)، وإذا وصل أحد للهدف ينهي المباراة، وإلا يبدي جولة جديدة
// يرجع 'match_finished' أو 'new_round'
async function finishRound(io, matchId, state, { winnerId, points, reason, isTie = false }) {
  state.round.ended = true;
  state.lastRound = {
    winnerId,
    pointsAwarded: points,
    reason,
    isTie,
  };

  if (!isTie && winnerId) {
    state.scores[winnerId] += points;
    if (!state.roundWins) state.roundWins = {};
    state.roundWins[winnerId] = (state.roundWins[winnerId] || 0) + 1;
  }

  io.to(`match:${matchId}`).emit('domino:round_finished', {
    matchId,
    roundNumber: state.round.number,
    roundWinnerId: winnerId,
    pointsAwarded: points,
    scores: state.scores,
    roundWins: state.roundWins,
    reason,
    isTie,
  });

  if (winnerId && state.scores[winnerId] >= state.matchTargetScore) {
    state.status = 'finished';
    state.winnerId = winnerId;
    clearTurnTimer(matchId);

    await payoutWinner(matchId, winnerId);
    await persistFinish(matchId, winnerId, state);
    const finishSummary = await buildMatchFinishSummary(matchId);

    const payload = {
      matchId,
      winnerId,
      loserId:
        String(state.players.p1) === String(winnerId)
          ? String(state.players.p2)
          : String(state.players.p1),
      finalScores: state.scores,
      reason: 'reached_target_score',
      finishSummary,
      statePublicP1: await publicState(state, state.players.p1),
      statePublicP2: await publicState(state, state.players.p2),
    };
    io.to(`match:${matchId}`).emit('domino:match_finished', payload);
    io.to(`user:${state.players.p1}`).emit('domino:match_finished', payload);
    io.to(`user:${state.players.p2}`).emit('domino:match_finished', payload);
    clearMatchState(matchId);
    return 'match_finished';
  }

  startNewRound(matchId, state);
  io.to(`match:${matchId}`).emit('domino:new_round_started', {
    matchId,
    roundNumber: state.round.number,
    scores: state.scores,
    statePublicP1: await publicState(state, state.players.p1),
    statePublicP2: await publicState(state, state.players.p2),
  });

  startTurnTimer(io, matchId);
  return 'new_round';
}

// بعد أي حركة: يفحص تفريغ اليد ثم الانسداد. يرجع null إذا الجولة مستمرة.
async function settleAfterMove(io, matchId, state, userId) {
  if ((state.hands[userId] || []).length === 0) {
    const opponentId = otherPlayer(state, userId);
    const points = computeRoundPointsOnEmptyHand(userId, opponentId, state);
    return finishRound(io, matchId, state, {
      winnerId: userId,
      points,
      reason: 'hand_empty',
    });
  }

  if (isRoundBlocked(state)) {
    const blocked = blockedWinnerAndPoints(state);
    return finishRound(io, matchId, state, {
      winnerId: blocked.winnerId,
      points: blocked.points,
      reason: 'blocked',
      isTie: blocked.isTie,
    });
  }

  return null;
}

async function handleBlockedIfAny(io, matchId, state) {
  if (!isRoundBlocked(state)) return false;

  const blocked = blockedWinnerAndPoints(state);
  await finishRound(io, matchId, state, {
    winnerId: blocked.winnerId,
    points: blocked.points,
    reason: 'blocked',
    isTie: blocked.isTie,
  });
  return true;
}

async function broadcastState(io, state, reason, extra = {}) {
  const matchId = state.matchId;
  io.to(`match:${matchId}`).emit('domino:state', {
    matchId,
    reason,
    statePublicP1: await publicState(state, state.players.p1),
    statePublicP2: await publicState(state, state.players.p2),
    ...extra,
  });
}

async function autoMove(io, matchId) {
  const state = getState(matchId);
  if (!state || state.status !== 'playing') return;

  const userId = state.turnUserId;
  const hand = state.hands[userId] || [];

  // افتتاح الجولة عند انتهاء الوقت: يلتزم بقاعدة أعلى دبل
  if (state.board.center == null) {
    const opening =
      (state.round && state.round.mustOpenWith) ||
      bestOpeningTile(hand).tile;

    if (opening) {
      const res = applyMove(state, userId, { type: 'play', tile: opening, side: 'right' });
      if (res.ok) {
        const settled = await settleAfterMove(io, matchId, state, userId);
        if (settled) return;

        nextTurn(state);
        await broadcastState(io, state, 'timeout_auto_play', { lastAction: res });
        return;
      }
    }
  }

  for (const tile of hand) {
    const side = canPlayOnLeft(state, tile)
      ? 'left'
      : canPlayOnRight(state, tile)
        ? 'right'
        : null;
    if (!side) continue;

    const res = applyMove(state, userId, { type: 'play', tile, side });
    if (!res.ok) continue;

    const settled = await settleAfterMove(io, matchId, state, userId);
    if (settled) return;

    nextTurn(state);
    await broadcastState(io, state, 'timeout_auto_play', { lastAction: res });
    return;
  }

  if (state.boneyard.length > 0 && !hasAnyLegalPlay(state, userId)) {
    const res = applyMove(state, userId, { type: 'draw_until_playable' });

    if (hasAnyLegalPlay(state, userId)) {
      state.lastMoveAt = Date.now();
      state.turn.expiresAt = Date.now() + stateTurnSeconds(state) * 1000;
      await broadcastState(io, state, 'timeout_auto_draw_until_playable', { lastAction: res });
      return;
    }

    if (await handleBlockedIfAny(io, matchId, state)) return;

    nextTurn(state);
    await broadcastState(io, state, 'timeout_auto_draw_until_playable_no_play', { lastAction: res });
    return;
  }

  if (await handleBlockedIfAny(io, matchId, state)) return;

  if (state.boneyard.length === 0 && !hasAnyLegalPlay(state, userId)) {
    nextTurn(state);
    await broadcastState(io, state, 'timeout_auto_pass', {
      lastAction: { ok: true, action: 'pass' },
    });
    return;
  }

}


async function onPlayerMove(io, matchId, userId, move) {
  const state = getState(matchId);
  const valid = isValidMove(state, userId, move);
  if (!valid.ok) return valid;

  const applied = applyMove(state, userId, move);
  if (!applied.ok) return applied;

  const settled = await settleAfterMove(io, matchId, state, userId);
  if (settled === 'match_finished') {
    return { ok: true, finished: true, winnerId: state.winnerId };
  }
  if (settled === 'new_round') {
    return { ok: true, roundEnded: true, newRound: true };
  }

  // إذا سحب كل البانك وبعده ما عنده لعبة، ينحسب عليه تمرير تلقائي
  const drewAndStillStuck =
    (move.type === 'draw' || move.type === 'draw_until_playable') &&
    state.boneyard.length === 0 &&
    !hasAnyLegalPlay(state, userId);

  const isTurnEndingMove =
    move.type === 'play' || move.type === 'pass' || drewAndStillStuck;

  if (isTurnEndingMove) {
    nextTurn(state);
  } else {
    state.lastMoveAt = Date.now();
    state.turn.expiresAt = Date.now() + stateTurnSeconds(state) * 1000;
  }

  await broadcastState(io, state, 'player_move', { lastAction: applied });
  return { ok: true };
}


async function finishByForfeit(io, matchId, winnerId, loserId) {
  const state = getState(matchId);
  if (!state || state.status !== 'playing') return;

  // Finish match immediately on forfeit (don't continue with rounds)
  state.status = 'finished';
  state.winnerId = winnerId;

  clearTurnTimer(matchId);

  // Record forfeit in state and persist
  state.lastRound = {
    winnerId: winnerId,
    pointsAwarded: 0,
    reason: 'forfeit_disconnect',
  };

  await payoutWinner(matchId, winnerId);
  await persistFinish(matchId, winnerId, state);
  const finishSummary = await buildMatchFinishSummary(matchId);

  const payload = {
    matchId,
    winnerId,
    loserId,
    finalScores: state.scores,
    reason: 'forfeit_disconnect',
    finishSummary,
    statePublicP1: await publicState(state, state.players.p1),
    statePublicP2: await publicState(state, state.players.p2),
  };
  io.to(`match:${matchId}`).emit('domino:match_finished', payload);
  io.to(`user:${state.players.p1}`).emit('domino:match_finished', payload);
  io.to(`user:${state.players.p2}`).emit('domino:match_finished', payload);
  clearMatchState(matchId);
}

module.exports = {
  createNewMatchState,
  storeState,
  getState,
  publicState,
  startTurnTimer,
  clearTurnTimer,
  onPlayerMove,
  finishByForfeit,
  autoMove,
  broadcastState,
  payoutWinner,
  sumHandPips,
  computeRoundPointsOnEmptyHand,
  isRoundBlocked,
  blockedWinnerAndPoints,
  startNewRound,
  buildMatchFinishSummary,
  buildFinishedMatchPayload,
  buildFinishedMatchPayloadFromRecord,
};
