const { DominoMatch, User } = require('../models');
const sequelize = require("../config/db");


const TURN_SECONDS = 7;

const matches = new Map();
const timers = new Map();

async function persistFinish(matchId, winnerId, state) {
  await DominoMatch.update(
    {
      status: 'finished',
      winnerId,
      stateJson: state
        ? {
            scores: state.scores,
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
    turn: { expiresAt: Date.now() + TURN_SECONDS * 1000 },
    scores: { [p1]: 0, [p2]: 0 },
    matchTargetScore: 101,
    round: { number: 1, starterUserId: starter, ended: false },
    lastRound: null,
  };
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
  let best = null;
  for (const t of hand) {
    const sum = t[0] + t[1];
    const isDouble = t[0] === t[1];
    if (!best) best = { tile: t, sum, isDouble };
    else {
      if (isDouble && !best.isDouble) best = { tile: t, sum, isDouble };
      else if (isDouble === best.isDouble && sum > best.sum) best = { tile: t, sum, isDouble };
    }
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

/**
 * Initialize a new round with fresh tiles
 */
function startNewRound(matchId, state) {
  const tiles = generateTiles();
  const hand1 = tiles.splice(0, 7);
  const hand2 = tiles.splice(0, 7);
  const boneyard = tiles;
  
  const p1 = state.players.p1;
  const p2 = state.players.p2;
  
  // Update hands and boneyard
  state.hands[p1] = hand1;
  state.hands[p2] = hand2;
  state.boneyard = boneyard;
  
  // Reset board
  state.board = {
    center: null,
    leftChain: [],
    rightChain: [],
    left: null,
    right: null,
  };
  
  const starter = chooseStarter(p1, hand1, p2, hand2);
  
  state.round.number++;
  state.round.starterUserId = starter;
  state.round.ended = false;
  
  state.turnUserId = starter;
  state.lastMoveAt = Date.now();
  state.turn.expiresAt = Date.now() + TURN_SECONDS * 1000;
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
    attributes: ['id', 'name'],
  });

  const playersInfo = {};
  for (const p of players) {
    playersInfo[p.id] = {
      name: p.name,
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

        // ✅ نخزنها بطرف اليسار
        state.board.leftChain.unshift(oriented); // الأقرب للسنتر يصير أول
        state.board.left = oriented[0];

        return { ok: true, action: 'play', placed: oriented, side: 'left' };
      } else {
        const oriented = rotateToMatchRight(state, tile);
        if (!oriented) return { ok: false, reason: 'cannot_play_right' };

        // ✅ نخزنها بطرف اليمين
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

async function handleBlockedIfAny(io, matchId, state) {
  if (!isRoundBlocked(state)) return false;

  const blocked = blockedWinnerAndPoints(state);

  state.round.ended = true;
  state.lastRound = {
    winnerId: blocked.winnerId,
    pointsAwarded: blocked.points,
    reason: 'blocked',
    isTie: blocked.isTie,
  };

  if (!blocked.isTie && blocked.winnerId) {
    state.scores[blocked.winnerId] += blocked.points;
  }

  io.to(`match:${matchId}`).emit('domino:round_finished', {
    matchId,
    roundNumber: state.round.number,
    roundWinnerId: blocked.winnerId,
    pointsAwarded: blocked.points,
    scores: state.scores,
    reason: 'blocked',
    isTie: blocked.isTie,
  });

  if (blocked.winnerId && state.scores[blocked.winnerId] >= state.matchTargetScore) {
    state.status = 'finished';
    state.winnerId = blocked.winnerId;
    clearTurnTimer(matchId);

    await payoutWinner(matchId, blocked.winnerId);
    await persistFinish(matchId, blocked.winnerId, state);

    io.to(`match:${matchId}`).emit('domino:match_finished', {
      matchId,
      winnerId: blocked.winnerId,
      finalScores: state.scores,
      reason: 'reached_target_score',
      statePublicP1: await  publicState(state, state.players.p1),
      statePublicP2: await publicState(state, state.players.p2),
    });
    return true;
  }

  startNewRound(matchId, state);
  io.to(`match:${matchId}`).emit('domino:new_round_started', {
    matchId,
    roundNumber: state.round.number,
    scores: state.scores,
    statePublicP1: await  publicState(state, state.players.p1),
    statePublicP2: await  publicState(state, state.players.p2),
  });

  startTurnTimer(io, matchId);
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

  for (const tile of hand) {
    if (canPlayOnLeft(state, tile)) {
      const res = applyMove(state, userId, { type: 'play', tile, side: 'left' });
      if (res.ok) {
        if (state.hands[userId].length === 0) {
          const opponentId = otherPlayer(state, userId);
          const pointsAwarded = computeRoundPointsOnEmptyHand(userId, opponentId, state);
          state.scores[userId] += pointsAwarded;
          
          state.round.ended = true;
          state.lastRound = {
            winnerId: userId,
            pointsAwarded,
            reason: 'hand_empty',
          };
          
          io.to(`match:${matchId}`).emit('domino:round_finished', {
            matchId,
            roundNumber: state.round.number,
            roundWinnerId: userId,
            pointsAwarded,
            scores: state.scores,
            reason: 'hand_empty',
          });
          
          if (state.scores[userId] >= state.matchTargetScore) {
            state.status = 'finished';
            state.winnerId = userId;
            clearTurnTimer(matchId);
            
            await payoutWinner(matchId, userId);
            await persistFinish(matchId, userId, state);
            
            io.to(`match:${matchId}`).emit('domino:match_finished', {
              matchId,
              winnerId: userId,
              finalScores: state.scores,
              reason: 'reached_target_score',
              statePublicP1: await publicState(state, state.players.p1),
              statePublicP2: await publicState(state, state.players.p2),
            });
            return;
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
            return;
        }
        nextTurn(state);
        broadcastState(io, state, 'timeout_auto_play');
        return;
      }
    }

    if (canPlayOnRight(state, tile)) {
      const res = applyMove(state, userId, { type: 'play', tile, side: 'right' });
      if (res.ok) {
        if (state.hands[userId].length === 0) {
          const opponentId = otherPlayer(state, userId);
          const pointsAwarded = computeRoundPointsOnEmptyHand(userId, opponentId, state);
          state.scores[userId] += pointsAwarded;
          
          state.round.ended = true;
          state.lastRound = {
            winnerId: userId,
            pointsAwarded,
            reason: 'hand_empty',
          };
          
          io.to(`match:${matchId}`).emit('domino:round_finished', {
            matchId,
            roundNumber: state.round.number,
            roundWinnerId: userId,
            pointsAwarded,
            scores: state.scores,
            reason: 'hand_empty',
          });
          
          if (state.scores[userId] >= state.matchTargetScore) {
            state.status = 'finished';
            state.winnerId = userId;
            clearTurnTimer(matchId);

            await payoutWinner(matchId, userId);
            await persistFinish(matchId, userId, state);
            
            io.to(`match:${matchId}`).emit('domino:match_finished', {
              matchId,
              winnerId: userId,
              finalScores: state.scores,
              reason: 'reached_target_score',
              statePublicP1: await publicState(state, state.players.p1),
              statePublicP2: publicState(state, state.players.p2),
            });
            return;
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
          return;
        }
        
        if (isRoundBlocked(state)) {
          const blocked = blockedWinnerAndPoints(state);
          state.round.ended = true;
          state.lastRound = {
            winnerId: blocked.winnerId,
            pointsAwarded: blocked.points,
            reason: 'blocked',
            isTie: blocked.isTie,
          };
          
          if (!blocked.isTie && blocked.winnerId) {
            state.scores[blocked.winnerId] += blocked.points;
          }
          
          io.to(`match:${matchId}`).emit('domino:round_finished', {
            matchId,
            roundNumber: state.round.number,
            roundWinnerId: blocked.winnerId,
            pointsAwarded: blocked.points,
            scores: state.scores,
            reason: 'blocked',
            isTie: blocked.isTie,
          });
          
          if (blocked.winnerId && state.scores[blocked.winnerId] >= state.matchTargetScore) {
            state.status = 'finished';
            state.winnerId = blocked.winnerId;
            clearTurnTimer(matchId);

            await payoutWinner(matchId, blocked.winnerId);
            await persistFinish(matchId, blocked.winnerId, state);
            
            io.to(`match:${matchId}`).emit('domino:match_finished', {
              matchId,
              winnerId: blocked.winnerId,
              finalScores: state.scores,
              reason: 'reached_target_score',
              statePublicP1: await publicState(state, state.players.p1),
              statePublicP2: await publicState(state, state.players.p2),
            });
            return;
          }
          
          startNewRound(matchId, state);
          io.to(`match:${matchId}`).emit('domino:new_round_started', {
            matchId,
            roundNumber: state.round.number,
            scores: state.scores,
            statePublicP1: await publicState(state, state.players.p1),
            statePublicP2: await publicState(state, state.players.p2),
          });
          return;
        }
        
        nextTurn(state);
        broadcastState(io, state, 'timeout_auto_play');
        return;
      }
    }
  }

    if (state.boneyard.length > 0) {
      applyMove(state, userId, { type: 'draw' });

      if (await handleBlockedIfAny(io, matchId, state)) return;

      nextTurn(state);
      broadcastState(io, state, 'timeout_auto_draw');
      return;
    }

    nextTurn(state);

    if (await handleBlockedIfAny(io, matchId, state)) return;

    broadcastState(io, state, 'timeout_auto_pass');
    return;

}


async function onPlayerMove(io, matchId, userId, move) {
  const state = getState(matchId);
  const valid = isValidMove(state, userId, move);
  if (!valid.ok) return valid;

  const applied = applyMove(state, userId, move);
  if (!applied.ok) return applied;

  // Check if this move empties the player's hand -> round ends
  if (state.hands[userId].length === 0) {
    const opponentId = otherPlayer(state, userId);
    const pointsAwarded = computeRoundPointsOnEmptyHand(userId, opponentId, state);
    state.scores[userId] += pointsAwarded;
    
    // Mark round as ended and save result
    state.round.ended = true;
    state.lastRound = {
      winnerId: userId,
      pointsAwarded,
      reason: 'hand_empty',
    };
    
    // Broadcast round finished
    io.to(`match:${matchId}`).emit('domino:round_finished', {
      matchId,
      roundNumber: state.round.number,
      roundWinnerId: userId,
      pointsAwarded,
      scores: state.scores,
      reason: 'hand_empty',
    });
    
    // Check if match is won (score >= 101)
    if (state.scores[userId] >= state.matchTargetScore) {
      state.status = 'finished';
      state.winnerId = userId;
      clearTurnTimer(matchId);

      await payoutWinner(matchId, userId);
      await persistFinish(matchId, userId, state);
      
      io.to(`match:${matchId}`).emit('domino:match_finished', {
        matchId,
        winnerId: userId,
        finalScores: state.scores,
        reason: 'reached_target_score',
        statePublicP1: await publicState(state, state.players.p1),
        statePublicP2: await publicState(state, state.players.p2),
      });
      return { ok: true, finished: true, winnerId: userId };
    }
    
    // Start next round
    startNewRound(matchId, state);
    
    io.to(`match:${matchId}`).emit('domino:new_round_started', {
      matchId,
      roundNumber: state.round.number,
      scores: state.scores,
      statePublicP1: await publicState(state, state.players.p1),
      statePublicP2: await publicState(state, state.players.p2),
    });
    
    startTurnTimer(io, matchId);
    return { ok: true, roundEnded: true, newRound: true };
  }

  // Check if round is blocked
  if (isRoundBlocked(state)) {
    const blocked = blockedWinnerAndPoints(state);
    
    state.round.ended = true;
    state.lastRound = {
      winnerId: blocked.winnerId,
      pointsAwarded: blocked.points,
      reason: 'blocked',
      isTie: blocked.isTie,
    };
    
    // Award points if not a tie
    if (!blocked.isTie && blocked.winnerId) {
      state.scores[blocked.winnerId] += blocked.points;
    }
    
    // Broadcast round finished
    io.to(`match:${matchId}`).emit('domino:round_finished', {
      matchId,
      roundNumber: state.round.number,
      roundWinnerId: blocked.winnerId,
      pointsAwarded: blocked.points,
      scores: state.scores,
      reason: 'blocked',
      isTie: blocked.isTie,
    });
    
    // Check if match is won
    if (blocked.winnerId && state.scores[blocked.winnerId] >= state.matchTargetScore) {
      state.status = 'finished';
      state.winnerId = blocked.winnerId;
      clearTurnTimer(matchId);

      await payoutWinner(matchId, blocked.winnerId);
      await persistFinish(matchId, blocked.winnerId, state);
      
      io.to(`match:${matchId}`).emit('domino:match_finished', {
        matchId,
        winnerId: blocked.winnerId,
        finalScores: state.scores,
        reason: 'reached_target_score',
        statePublicP1: await publicState(state, state.players.p1),
        statePublicP2: await publicState(state, state.players.p2),
      });
      return { ok: true, finished: true, winnerId: blocked.winnerId };
    }
    
    // Start next round
    startNewRound(matchId, state);
    
    io.to(`match:${matchId}`).emit('domino:new_round_started', {
      matchId,
      roundNumber: state.round.number,
      scores: state.scores,
      statePublicP1: await publicState(state, state.players.p1),
      statePublicP2: await publicState(state, state.players.p2),
    });
    
    startTurnTimer(io, matchId);
    return { ok: true, roundEnded: true, newRound: true };
  }

  // Normal turn progression
  nextTurn(state);
  broadcastState(io, state, 'player_move', { lastAction: applied });
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

  io.to(`match:${matchId}`).emit('domino:match_finished', {
    matchId,
    winnerId,
    loserId,
    finalScores: state.scores,
    reason: 'forfeit_disconnect',
    statePublicP1: await publicState(state, state.players.p1),
    statePublicP2: await publicState(state, state.players.p2),
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
  autoMove,
  broadcastState,
  payoutWinner,
  sumHandPips,
  computeRoundPointsOnEmptyHand,
  isRoundBlocked,
  blockedWinnerAndPoints,
  startNewRound,
};
