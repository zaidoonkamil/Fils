const TURN_SECONDS = 7;

// In-memory state (لاحقًا تقدر تنقله Redis)
const matches = new Map();
const timers = new Map();

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

  // اختيار من يبدأ: أعلى double إن وجد، وإلا أعلى مجموع
  const starter = chooseStarter(p1, hand1, p2, hand2);

  return {
    matchId,
    players: { p1, p2 },
    hands: { [p1]: hand1, [p2]: hand2 },
    boneyard,
    board: { chain: [], left: null, right: null }, // left/right values (numbers)
    turnUserId: starter,
    lastMoveAt: Date.now(),
    status: 'playing',
    winnerId: null,
    turn: { expiresAt: Date.now() + TURN_SECONDS * 1000 },
  };
}

function chooseStarter(p1, hand1, p2, hand2) {
  const best1 = bestOpeningTile(hand1);
  const best2 = bestOpeningTile(hand2);

  // compare: double first, then sum
  if (best1.isDouble && !best2.isDouble) return p1;
  if (!best1.isDouble && best2.isDouble) return p2;

  if (best1.sum > best2.sum) return p1;
  if (best2.sum > best1.sum) return p2;

  return p1; // tie
}

function bestOpeningTile(hand) {
  let best = null;
  for (const t of hand) {
    const sum = t[0] + t[1];
    const isDouble = t[0] === t[1];
    if (!best) best = { tile: t, sum, isDouble };
    else {
      // double preferred
      if (isDouble && !best.isDouble) best = { tile: t, sum, isDouble };
      else if (isDouble === best.isDouble && sum > best.sum) best = { tile: t, sum, isDouble };
    }
  }
  return best || { tile: null, sum: -1, isDouble: false };
}

function storeState(matchId, state) {
  matches.set(String(matchId), state);
}

function getState(matchId) {
  return matches.get(String(matchId));
}

function publicState(state, viewerId) {
  const { hands, ...rest } = state;
  const opponentId = state.players.p1 === viewerId ? state.players.p2 : state.players.p1;

  return {
    ...rest,
    hands: {
      [viewerId]: hands[viewerId],
      [opponentId]: { count: hands[opponentId].length },
    },
    boneyardCount: state.boneyard.length,
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
  // keep as [a,b]
  return [tile[0], tile[1]];
}

function canPlayOnLeft(state, tile) {
  if (!state.board.left && state.board.chain.length === 0) return true; // first move
  const leftVal = state.board.left;
  return tile[0] === leftVal || tile[1] === leftVal;
}

function canPlayOnRight(state, tile) {
  if (!state.board.right && state.board.chain.length === 0) return true; // first move
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
  // return tile arranged so tile[1] matches left end (so new left end becomes tile[0])
  // Example: leftVal=6, tile=[6,2] => place as [2,6] so left becomes 2
  const leftVal = state.board.left;
  const [a, b] = tile;
  if (a === leftVal) return [b, a];
  if (b === leftVal) return [a, b];
  return null;
}

function rotateToMatchRight(state, tile) {
  // return tile arranged so tile[0] matches right end (so new right end becomes tile[1])
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
  state.turn.expiresAt = Date.now() + TURN_SECONDS * 1000;
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

  if (move.type === 'play') {
    if (!Array.isArray(move.tile) || move.tile.length !== 2) return { ok: false, reason: 'invalid_tile' };
    if (move.side !== 'left' && move.side !== 'right') return { ok: false, reason: 'invalid_side' };

    const hand = state.hands[userId] || [];
    if (!hand.some((t) => tileEquals(t, move.tile))) return { ok: false, reason: 'tile_not_in_hand' };

    const tile = normalizeTile(move.tile);
    if (move.side === 'left' && !canPlayOnLeft(state, tile)) return { ok: false, reason: 'cannot_play_left' };
    if (move.side === 'right' && !canPlayOnRight(state, tile)) return { ok: false, reason: 'cannot_play_right' };

    return { ok: true };
  }

  if (move.type === 'draw') {
    if (state.boneyard.length === 0) return { ok: false, reason: 'boneyard_empty' };
    // draw allowed anytime, but you can enforce "draw only if no play"
    // we allow draw if no legal play:
    if (hasAnyLegalPlay(state, userId)) return { ok: false, reason: 'you_have_a_play' };
    return { ok: true };
  }

  if (move.type === 'pass') {
    // pass only when no plays AND boneyard empty
    if (state.boneyard.length > 0) return { ok: false, reason: 'must_draw' };
    if (hasAnyLegalPlay(state, userId)) return { ok: false, reason: 'you_have_a_play' };
    return { ok: true };
  }

  return { ok: false, reason: 'unknown_move_type' };
}

function applyMove(state, userId, move) {
  if (move.type === 'draw') {
    const drawn = state.boneyard.shift(); // take top
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

    // first move
    if (state.board.chain.length === 0) {
      state.board.chain.push(tile);
      state.board.left = tile[0];
      state.board.right = tile[1];
      return { ok: true, action: 'play', placed: tile, side: 'first' };
    }

    if (move.side === 'left') {
      const oriented = rotateToMatchLeft(state, tile);
      if (!oriented) return { ok: false, reason: 'cannot_play_left' };
      state.board.chain.unshift(oriented);
      state.board.left = oriented[0];
      return { ok: true, action: 'play', placed: oriented, side: 'left' };
    } else {
      const oriented = rotateToMatchRight(state, tile);
      if (!oriented) return { ok: false, reason: 'cannot_play_right' };
      state.board.chain.push(oriented);
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
      autoMove(io, matchId);
    }
  }, 250);

  timers.set(String(matchId), t);
}

function clearTurnTimer(matchId) {
  const t = timers.get(String(matchId));
  if (t) clearInterval(t);
  timers.delete(String(matchId));
}

function broadcastState(io, state, reason, extra = {}) {
  const matchId = state.matchId;
  io.to(`match:${matchId}`).emit('domino:state', {
    matchId,
    reason,
    statePublicP1: publicState(state, state.players.p1),
    statePublicP2: publicState(state, state.players.p2),
    ...extra,
  });
}

function autoMove(io, matchId) {
  const state = getState(matchId);
  if (!state || state.status !== 'playing') return;

  const userId = state.turnUserId;

  // 1) حاول يلعب أول حركة ممكنة (left ثم right)
  const hand = state.hands[userId] || [];
  for (const tile of hand) {
    if (canPlayOnLeft(state, tile)) {
      const res = applyMove(state, userId, { type: 'play', tile, side: state.board.chain.length === 0 ? 'left' : 'left' });
      if (res.ok) {
        // check win
        if (state.hands[userId].length === 0) {
          finishMatch(state, userId);
          broadcastState(io, state, 'timeout_auto_play_win', { winnerId: userId });
          clearTurnTimer(matchId);
          return;
        }
        nextTurn(state);
        broadcastState(io, state, 'timeout_auto_play');
        return;
      }
    }
    if (canPlayOnRight(state, tile)) {
      const res = applyMove(state, userId, { type: 'play', tile, side: state.board.chain.length === 0 ? 'right' : 'right' });
      if (res.ok) {
        if (state.hands[userId].length === 0) {
          finishMatch(state, userId);
          broadcastState(io, state, 'timeout_auto_play_win', { winnerId: userId });
          clearTurnTimer(matchId);
          return;
        }
        nextTurn(state);
        broadcastState(io, state, 'timeout_auto_play');
        return;
      }
    }
  }

  // 2) إذا ما عنده لعب: اسحب إذا الباقي موجود
  if (state.boneyard.length > 0) {
    applyMove(state, userId, { type: 'draw' });
    // بعد السحب، نخلي الدور ينتقل (حتى ما نطوّل)
    nextTurn(state);
    broadcastState(io, state, 'timeout_auto_draw');
    return;
  }

  // 3) إذا ماكو بقايا: pass
  nextTurn(state);
  broadcastState(io, state, 'timeout_auto_pass');
}

function onPlayerMove(io, matchId, userId, move) {
  const state = getState(matchId);
  const valid = isValidMove(state, userId, move);
  if (!valid.ok) return valid;

  const applied = applyMove(state, userId, move);
  if (!applied.ok) return applied;

  // win check
  if (state.hands[userId].length === 0) {
    finishMatch(state, userId);
    broadcastState(io, state, 'player_win', { winnerId: userId });
    clearTurnTimer(matchId);
    return { ok: true, finished: true, winnerId: userId };
  }

  nextTurn(state);
  broadcastState(io, state, 'player_move', { lastAction: applied });

  return { ok: true };
}

function finishByForfeit(io, matchId, winnerId, loserId) {
  const state = getState(matchId);
  if (!state || state.status !== 'playing') return;

  state.status = 'finished';
  state.winnerId = winnerId;

  // وقف تايمر الدور
  clearTurnTimer(matchId);

  // بث للجميع
  io.to(`match:${matchId}`).emit('domino:match_finished', {
    matchId,
    winnerId,
    loserId,
    reason: 'forfeit_disconnect',
    statePublicP1: publicState(state, state.players.p1),
    statePublicP2: publicState(state, state.players.p2),
  });
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
};
