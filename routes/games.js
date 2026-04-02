const express = require('express');
const router = express.Router();
const db = require('../db');
const auth = require('../middleware/auth');

// Picks per player by number of players in game
// Pool = 10 positions (5 per team, batting orders 1–5), no overlap
const PICK_ALLOCATION = {
  2: [5, 5],
  3: [3, 3, 3],
  4: [2, 2, 2, 2],
  5: [2, 2, 2, 2, 2]
};

function getRoomCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// Helper: get draft state for a game
function getDraftState(gameId) {
  const participants = db.prepare(
    'SELECT * FROM game_participants WHERE game_id = ? ORDER BY join_order'
  ).all(gameId);

  const numPlayers  = participants.length;
  const allocation  = PICK_ALLOCATION[numPlayers] || PICK_ALLOCATION[2];
  const totalNeeded = allocation.reduce((a, b) => a + b, 0);

  // Total picks made so far (across all players)
  const totalPicksMade = participants.reduce((sum, p) => {
    return sum + (p.selected_positions ? JSON.parse(p.selected_positions).length : 0);
  }, 0);

  // Whose turn is it? Round-robin by join_order
  const currentTurnIndex = totalPicksMade < totalNeeded
    ? totalPicksMade % numPlayers
    : -1; // draft complete

  const currentTurnPlayer = currentTurnIndex >= 0 ? participants[currentTurnIndex] : null;

  // All taken positions
  const takenPositions = [];
  participants.forEach(p => {
    if (p.selected_positions) {
      JSON.parse(p.selected_positions).forEach(pos => takenPositions.push(pos));
    }
  });

  const allDone = participants.every(p => p.is_ready === 1);

  return { participants, numPlayers, allocation, totalPicksMade, totalNeeded, currentTurnIndex, currentTurnPlayer, takenPositions, allDone };
}

// ── CREATE ───────────────────────────────────────────────────────────────────

router.post('/create', auth, (req, res) => {
  try {
    const { format, matchId, teamAName, teamBName, betAmount, maxPlayers } = req.body;

    if (!format || !betAmount) return res.status(400).json({ error: 'Format and bet amount are required' });
    if (!['test', 'odi', 't20'].includes(format)) return res.status(400).json({ error: 'Invalid format' });
    const bet = parseInt(betAmount);
    if (isNaN(bet) || bet < 10) return res.status(400).json({ error: 'Minimum bet is 10 points' });

    const numPlayers = Math.min(Math.max(parseInt(maxPlayers) || 2, 2), 5);

    const user = db.prepare('SELECT wallet_balance FROM users WHERE id = ?').get(req.user.id);
    if (user.wallet_balance < bet) return res.status(400).json({ error: `Insufficient balance. You have ${user.wallet_balance} points.` });

    let roomCode, tries = 0;
    do { roomCode = getRoomCode(); tries++; }
    while (db.prepare('SELECT id FROM games WHERE room_code = ?').get(roomCode) && tries < 10);

    const game = db.prepare(`
      INSERT INTO games (room_code, format, match_id, team_a_name, team_b_name, bet_amount, max_players, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(roomCode, format, matchId || null, teamAName || 'Team A', teamBName || 'Team B', bet, numPlayers, req.user.id);

    db.prepare('INSERT INTO game_participants (game_id, user_id, join_order) VALUES (?, ?, 1)')
      .run(game.lastInsertRowid, req.user.id);

    db.prepare('UPDATE users SET wallet_balance = wallet_balance - ? WHERE id = ?').run(bet, req.user.id);

    res.json({ roomCode, gameId: game.lastInsertRowid, message: 'Game created! Share the room code.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── JOIN ─────────────────────────────────────────────────────────────────────

router.post('/join', auth, (req, res) => {
  try {
    const { roomCode } = req.body;
    if (!roomCode) return res.status(400).json({ error: 'Room code is required' });

    const game = db.prepare('SELECT * FROM games WHERE room_code = ?').get(roomCode.toUpperCase().trim());
    if (!game) return res.status(404).json({ error: 'Game not found. Check your room code.' });
    if (game.status !== 'waiting') return res.status(400).json({ error: 'This game has already started or finished.' });

    const existing = db.prepare('SELECT id FROM game_participants WHERE game_id = ? AND user_id = ?').get(game.id, req.user.id);
    if (existing) return res.json({ roomCode: game.room_code, gameId: game.id, alreadyJoined: true });

    const count = db.prepare('SELECT COUNT(*) as c FROM game_participants WHERE game_id = ?').get(game.id).c;
    if (count >= game.max_players) return res.status(400).json({ error: `Room is full (${game.max_players} players max).` });

    const user = db.prepare('SELECT wallet_balance FROM users WHERE id = ?').get(req.user.id);
    if (user.wallet_balance < game.bet_amount) return res.status(400).json({ error: `Need ${game.bet_amount} points to join. You have ${user.wallet_balance}.` });

    db.prepare('INSERT INTO game_participants (game_id, user_id, join_order) VALUES (?, ?, ?)').run(game.id, req.user.id, count + 1);
    db.prepare('UPDATE users SET wallet_balance = wallet_balance - ? WHERE id = ?').run(game.bet_amount, req.user.id);

    res.json({ roomCode: game.room_code, gameId: game.id, message: 'Joined successfully!' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── LOBBY ────────────────────────────────────────────────────────────────────

router.get('/:gameId/lobby', auth, (req, res) => {
  try {
    const game = db.prepare('SELECT * FROM games WHERE id = ?').get(req.params.gameId);
    if (!game) return res.status(404).json({ error: 'Game not found' });

    const draft = getDraftState(game.id);

    res.json({
      game: {
        id: game.id, roomCode: game.room_code, format: game.format,
        matchId: game.match_id, teamAName: game.team_a_name, teamBName: game.team_b_name,
        betAmount: game.bet_amount, status: game.status,
        maxPlayers: game.max_players, createdBy: game.created_by
      },
      participants: draft.participants.map((p, i) => ({
        userId: p.user_id, username: p.username ||
          db.prepare('SELECT username FROM users WHERE id = ?').get(p.user_id)?.username || 'Player',
        joinOrder: p.join_order,
        isReady: !!p.is_ready,
        picksAllowed: draft.allocation[i] ?? 0,
        picksMade: p.selected_positions ? JSON.parse(p.selected_positions).length : 0,
        selectedPositions: p.selected_positions ? JSON.parse(p.selected_positions) : []
      })),
      currentUserId: req.user.id,
      takenPositions: draft.takenPositions,
      pickAllocation: draft.allocation,
      draft: {
        currentTurnUserId: draft.currentTurnPlayer?.user_id ?? null,
        currentTurnUsername: draft.currentTurnPlayer
          ? (db.prepare('SELECT username FROM users WHERE id = ?').get(draft.currentTurnPlayer.user_id)?.username || 'Player')
          : null,
        totalPicksMade: draft.totalPicksMade,
        totalNeeded: draft.totalNeeded,
        allDone: draft.allDone
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── START ────────────────────────────────────────────────────────────────────

router.post('/:gameId/start', auth, (req, res) => {
  try {
    const game = db.prepare('SELECT * FROM games WHERE id = ?').get(req.params.gameId);
    if (!game) return res.status(404).json({ error: 'Game not found' });
    if (game.created_by !== req.user.id) return res.status(403).json({ error: 'Only the host can start the game' });
    if (game.status !== 'waiting') return res.status(400).json({ error: 'Game cannot be started now' });

    const count = db.prepare('SELECT COUNT(*) as c FROM game_participants WHERE game_id = ?').get(game.id).c;
    if (count < 2) return res.status(400).json({ error: 'Need at least 2 players to start' });

    db.prepare('UPDATE games SET status = ? WHERE id = ?').run('selecting', game.id);
    res.json({ message: 'Draft started! Player 1 picks first.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── PICK (turn-based, 1 pick at a time) ─────────────────────────────────────

router.post('/:gameId/pick', auth, (req, res) => {
  try {
    const { team, position } = req.body; // single pick: { team: 'A'|'B', position: 1-5 }

    const game = db.prepare('SELECT * FROM games WHERE id = ?').get(req.params.gameId);
    if (!game) return res.status(404).json({ error: 'Game not found' });
    if (game.status !== 'selecting') return res.status(400).json({ error: 'Game is not in draft phase' });

    // Validate pick values
    if (!['A', 'B'].includes(team) || !Number.isInteger(position) || position < 1 || position > 5) {
      return res.status(400).json({ error: 'Invalid pick. Choose Team A or B, position 1–5.' });
    }

    const draft = getDraftState(game.id);

    // Check it's this user's turn
    if (!draft.currentTurnPlayer || draft.currentTurnPlayer.user_id !== req.user.id) {
      const whose = draft.currentTurnPlayer
        ? db.prepare('SELECT username FROM users WHERE id = ?').get(draft.currentTurnPlayer.user_id)?.username || 'another player'
        : 'nobody';
      return res.status(403).json({ error: `It's not your turn. Waiting for ${whose} to pick.` });
    }

    // Check if position is already taken
    const isTaken = draft.takenPositions.some(p => p.team === team && p.position === position);
    if (isTaken) return res.status(400).json({ error: `Position ${team}${position} is already taken.` });

    // Get my current picks
    const myRecord = draft.participants.find(p => p.user_id === req.user.id);
    const myPicks  = myRecord?.selected_positions ? JSON.parse(myRecord.selected_positions) : [];
    const myIdx    = draft.participants.findIndex(p => p.user_id === req.user.id);
    const myMax    = draft.allocation[myIdx] ?? 0;

    if (myPicks.length >= myMax) {
      return res.status(400).json({ error: 'You have already made all your picks.' });
    }

    // Save the pick
    const newPicks = [...myPicks, { team, position }];
    const isReady  = newPicks.length >= myMax;

    db.prepare('UPDATE game_participants SET selected_positions = ?, is_ready = ? WHERE game_id = ? AND user_id = ?')
      .run(JSON.stringify(newPicks), isReady ? 1 : 0, game.id, req.user.id);

    // Check if ALL players are done with ALL picks
    const updatedDraft = getDraftState(game.id);
    if (updatedDraft.allDone) {
      db.prepare('UPDATE games SET status = ? WHERE id = ?').run('live', game.id);
    }

    // Calculate next turn
    const nextTurnPlayer = updatedDraft.currentTurnPlayer;
    const nextUsername   = nextTurnPlayer
      ? db.prepare('SELECT username FROM users WHERE id = ?').get(nextTurnPlayer.user_id)?.username || 'Next player'
      : null;

    res.json({
      message: `Picked ${team}${position} ✅`,
      allReady: updatedDraft.allDone,
      nextTurnUserId: nextTurnPlayer?.user_id ?? null,
      nextTurnUsername: nextUsername,
      totalPicksMade: updatedDraft.totalPicksMade,
      totalNeeded: updatedDraft.totalNeeded
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── SCORES ───────────────────────────────────────────────────────────────────

router.get('/:gameId/scores', auth, (req, res) => {
  try {
    const game = db.prepare('SELECT * FROM games WHERE id = ?').get(req.params.gameId);
    if (!game) return res.status(404).json({ error: 'Game not found' });

    const participants = db.prepare(`
      SELECT gp.user_id, gp.join_order, gp.total_runs, gp.selected_positions, gp.is_ready, u.username
      FROM game_participants gp JOIN users u ON u.id = gp.user_id
      WHERE gp.game_id = ? ORDER BY gp.join_order
    `).all(game.id);

    const result = db.prepare('SELECT * FROM game_results WHERE game_id = ?').get(game.id);

    res.json({
      game: {
        id: game.id, roomCode: game.room_code, format: game.format,
        matchId: game.match_id, teamAName: game.team_a_name, teamBName: game.team_b_name,
        betAmount: game.bet_amount, status: game.status, createdBy: game.created_by
      },
      participants: participants.map(p => ({
        userId: p.user_id, username: p.username,
        selectedPositions: p.selected_positions ? JSON.parse(p.selected_positions) : [],
        totalRuns: p.total_runs, isReady: !!p.is_ready
      })),
      result: result || null,
      currentUserId: req.user.id
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── UPDATE SCORES (called by client with latest scorecard) ───────────────────

router.post('/:gameId/update-scores', auth, (req, res) => {
  try {
    const { scorecard } = req.body;
    const game = db.prepare('SELECT * FROM games WHERE id = ?').get(req.params.gameId);
    if (!game || game.status !== 'live') return res.json({ message: 'Not live' });

    // ── Only update if match has actually started ──
    // If all runs are 0 and no batsman has started, skip score update
    const matchStarted = scorecard?.teams?.some(team =>
      team.batsmen?.some(b => b.runs > 0 || b.status === 'batting' || (b.status || '').toLowerCase().includes('out'))
    );

    if (!matchStarted) {
      return res.json({ message: 'Match not started yet — scores unchanged', matchStarted: false });
    }

    const participants = db.prepare('SELECT * FROM game_participants WHERE game_id = ?').all(game.id);

    // Build run lookup: { 'A1': 45, 'B3': 22, ... }
    const runs = {};
    if (scorecard?.teams) {
      scorecard.teams.forEach((team, idx) => {
        const key = idx === 0 ? 'A' : 'B';
        (team.batsmen || []).forEach(b => { runs[`${key}${b.position}`] = b.runs || 0; });
      });
    }

    for (const p of participants) {
      if (!p.selected_positions) continue;
      const total = JSON.parse(p.selected_positions).reduce((s, pos) => s + (runs[`${pos.team}${pos.position}`] || 0), 0);
      db.prepare('UPDATE game_participants SET total_runs = ? WHERE id = ?').run(total, p.id);
    }

    if (scorecard?.isFinished) {
      const final = finalizeGame(game.id);
      return res.json({ ...final, isFinished: true, matchStarted: true });
    }

    res.json({ message: 'Scores updated', runs, matchStarted: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── FINALIZE ─────────────────────────────────────────────────────────────────

router.post('/:gameId/finalize', auth, (req, res) => {
  try {
    const game = db.prepare('SELECT * FROM games WHERE id = ?').get(req.params.gameId);
    if (!game) return res.status(404).json({ error: 'Game not found' });
    if (game.status !== 'live') return res.status(400).json({ error: 'Game is not live' });
    res.json(finalizeGame(game.id));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

function finalizeGame(gameId) {
  const game = db.prepare('SELECT * FROM games WHERE id = ?').get(gameId);
  const participants = db.prepare(`
    SELECT gp.*, u.username FROM game_participants gp JOIN users u ON u.id = gp.user_id
    WHERE gp.game_id = ? ORDER BY gp.total_runs DESC
  `).all(gameId);

  if (!participants.length) return { message: 'No participants' };

  const topRuns  = participants[0].total_runs;
  const winners  = participants.filter(p => p.total_runs === topRuns);
  const pot      = game.bet_amount * participants.length;
  const share    = Math.floor(pot / winners.length);

  for (const w of winners) {
    db.prepare('UPDATE users SET wallet_balance = wallet_balance + ? WHERE id = ?').run(share, w.user_id);
  }

  db.prepare('INSERT INTO game_results (game_id, winner_id, pot_amount) VALUES (?, ?, ?)')
    .run(gameId, winners.length === 1 ? winners[0].user_id : null, pot);

  db.prepare('UPDATE games SET status = ? WHERE id = ?').run('finished', gameId);

  return {
    message: 'Game finished!',
    winners: winners.map(w => w.username),
    pot, share,
    leaderboard: participants.map(p => ({ username: p.username, totalRuns: p.total_runs }))
  };
}

// ── MY GAMES ─────────────────────────────────────────────────────────────────

router.get('/my-games', auth, (req, res) => {
  try {
    const games = db.prepare(`
      SELECT g.id, g.room_code, g.format, g.team_a_name, g.team_b_name,
             g.bet_amount, g.status, g.created_at,
             gp.total_runs, gp.selected_positions,
             gr.winner_id, gr.pot_amount,
             (SELECT u2.username FROM users u2 WHERE u2.id = gr.winner_id) as winner_username,
             (SELECT COUNT(*) FROM game_participants WHERE game_id = g.id) as player_count
      FROM games g
      JOIN game_participants gp ON gp.game_id = g.id AND gp.user_id = ?
      LEFT JOIN game_results gr ON gr.game_id = g.id
      ORDER BY g.created_at DESC LIMIT 30
    `).all(req.user.id);

    res.json(games.map(g => ({
      ...g,
      selectedPositions: g.selected_positions ? JSON.parse(g.selected_positions) : null
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
