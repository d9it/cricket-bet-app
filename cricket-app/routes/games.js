const express = require('express');
const router = express.Router();
const db = require('../db');
const auth = require('../middleware/auth');

// Picks allocation per number of players
// Total pool: 10 positions (5 Team A + 5 Team B), no overlap
// Picks per player. Pool = 10 positions (5 per team, batting orders 1-5).
// Unused slots simply don't score — no effect on the game.
const PICK_ALLOCATION = {
  2: [5, 5],       // 10/10 used
  3: [3, 3, 3],   // 9/10 used
  4: [2, 2, 2, 2], // 8/10 used
  5: [2, 2, 2, 2, 2] // 10/10 used
};

function getRoomCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// POST /api/games/create
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

// POST /api/games/join
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

// GET /api/games/:gameId/lobby
router.get('/:gameId/lobby', auth, (req, res) => {
  try {
    const game = db.prepare('SELECT * FROM games WHERE id = ?').get(req.params.gameId);
    if (!game) return res.status(404).json({ error: 'Game not found' });

    const participants = db.prepare(`
      SELECT gp.id, gp.user_id, gp.join_order, gp.is_ready, gp.selected_positions, gp.total_runs, u.username
      FROM game_participants gp JOIN users u ON u.id = gp.user_id
      WHERE gp.game_id = ? ORDER BY gp.join_order
    `).all(game.id);

    const numPlayers = participants.length;
    const allocation = PICK_ALLOCATION[numPlayers] || PICK_ALLOCATION[2];

    // Which positions are taken
    const takenPositions = [];
    for (const p of participants) {
      if (p.selected_positions) {
        JSON.parse(p.selected_positions).forEach(pos => takenPositions.push(pos));
      }
    }

    res.json({
      game: {
        id: game.id, roomCode: game.room_code, format: game.format,
        matchId: game.match_id, teamAName: game.team_a_name, teamBName: game.team_b_name,
        betAmount: game.bet_amount, status: game.status,
        maxPlayers: game.max_players, createdBy: game.created_by
      },
      participants: participants.map((p, i) => ({
        userId: p.user_id, username: p.username, joinOrder: p.join_order,
        isReady: !!p.is_ready, totalRuns: p.total_runs,
        picksAllowed: allocation[i] ?? 0,
        selectedPositions: p.selected_positions ? JSON.parse(p.selected_positions) : null
      })),
      currentUserId: req.user.id,
      takenPositions,
      pickAllocation: allocation
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/games/:gameId/start
router.post('/:gameId/start', auth, (req, res) => {
  try {
    const game = db.prepare('SELECT * FROM games WHERE id = ?').get(req.params.gameId);
    if (!game) return res.status(404).json({ error: 'Game not found' });
    if (game.created_by !== req.user.id) return res.status(403).json({ error: 'Only the host can start the game' });
    if (game.status !== 'waiting') return res.status(400).json({ error: 'Game cannot be started now' });

    const count = db.prepare('SELECT COUNT(*) as c FROM game_participants WHERE game_id = ?').get(game.id).c;
    if (count < 2) return res.status(400).json({ error: 'Need at least 2 players to start' });

    db.prepare('UPDATE games SET status = ? WHERE id = ?').run('selecting', game.id);
    res.json({ message: 'Game started! Everyone can now select their batting positions.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/games/:gameId/select-positions
router.post('/:gameId/select-positions', auth, (req, res) => {
  try {
    const { positions } = req.body; // [{team:'A'|'B', position:1-5}, ...]

    const game = db.prepare('SELECT * FROM games WHERE id = ?').get(req.params.gameId);
    if (!game) return res.status(404).json({ error: 'Game not found' });
    if (game.status !== 'selecting') return res.status(400).json({ error: 'Not in selection phase' });

    const allParticipants = db.prepare(
      'SELECT * FROM game_participants WHERE game_id = ? ORDER BY join_order'
    ).all(game.id);

    const myRecord = allParticipants.find(p => p.user_id === req.user.id);
    if (!myRecord) return res.status(403).json({ error: 'You are not in this game' });
    if (myRecord.is_ready) return res.status(400).json({ error: 'You have already submitted your picks' });

    const numPlayers = allParticipants.length;
    const allocation = PICK_ALLOCATION[numPlayers] || PICK_ALLOCATION[2];
    const myIndex = allParticipants.findIndex(p => p.user_id === req.user.id);
    const required = allocation[myIndex];

    if (!positions || positions.length !== required)
      return res.status(400).json({ error: `You must select exactly ${required} position(s)` });

    // Validate each pick
    for (const pos of positions) {
      if (!['A', 'B'].includes(pos.team) || pos.position < 1 || pos.position > 5)
        return res.status(400).json({ error: `Invalid position: ${pos.team}${pos.position}` });
    }

    // No duplicate picks in own selection
    const keys = positions.map(p => `${p.team}${p.position}`);
    if (new Set(keys).size !== keys.length)
      return res.status(400).json({ error: 'Duplicate positions in your selection' });

    // No overlap with others' picks
    const taken = [];
    for (const p of allParticipants) {
      if (p.selected_positions && p.user_id !== req.user.id) {
        JSON.parse(p.selected_positions).forEach(sp => taken.push(`${sp.team}${sp.position}`));
      }
    }
    for (const key of keys) {
      if (taken.includes(key))
        return res.status(400).json({ error: `Position ${key} is already taken by another player` });
    }

    db.prepare('UPDATE game_participants SET selected_positions = ?, is_ready = 1 WHERE game_id = ? AND user_id = ?')
      .run(JSON.stringify(positions), game.id, req.user.id);

    const readyCount = db.prepare('SELECT COUNT(*) as c FROM game_participants WHERE game_id = ? AND is_ready = 1').get(game.id).c;

    if (readyCount === allParticipants.length) {
      db.prepare('UPDATE games SET status = ? WHERE id = ?').run('live', game.id);
      return res.json({ message: 'All players ready! Match is now LIVE 🏏', allReady: true });
    }

    res.json({ message: 'Picks saved! Waiting for other players.', allReady: false, readyCount, total: allParticipants.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/games/:gameId/scores
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
        betAmount: game.bet_amount, status: game.status
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

// POST /api/games/:gameId/update-scores  (called by each client with latest scorecard)
router.post('/:gameId/update-scores', auth, (req, res) => {
  try {
    const { scorecard } = req.body;
    const game = db.prepare('SELECT * FROM games WHERE id = ?').get(req.params.gameId);
    if (!game || game.status !== 'live') return res.json({ message: 'Not live' });

    const participants = db.prepare('SELECT * FROM game_participants WHERE game_id = ?').all(game.id);

    // Build run lookup: { 'A1': 45, 'B3': 22, ... }
    const runs = {};
    if (scorecard?.teams) {
      scorecard.teams.forEach((team, idx) => {
        const key = idx === 0 ? 'A' : 'B';
        (team.batsmen || []).forEach(b => { runs[`${key}${b.position}`] = b.runs; });
      });
    }

    for (const p of participants) {
      if (!p.selected_positions) continue;
      const total = JSON.parse(p.selected_positions).reduce((s, pos) => s + (runs[`${pos.team}${pos.position}`] || 0), 0);
      db.prepare('UPDATE game_participants SET total_runs = ? WHERE id = ?').run(total, p.id);
    }

    if (scorecard?.isFinished) {
      const final = finalizeGame(game.id);
      return res.json({ ...final, isFinished: true });
    }

    res.json({ message: 'Scores updated', runs });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/games/:gameId/finalize  (manual finish by host)
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

  const topRuns = participants[0].total_runs;
  const winners = participants.filter(p => p.total_runs === topRuns);
  const pot = game.bet_amount * participants.length;
  const share = Math.floor(pot / winners.length);

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

// GET /api/games/my-games
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
