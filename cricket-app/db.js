const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'cricket_app.db'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    wallet_balance INTEGER DEFAULT 1000,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS games (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_code TEXT UNIQUE NOT NULL,
    format TEXT NOT NULL CHECK(format IN ('test','odi','t20')),
    match_id TEXT,
    team_a_name TEXT DEFAULT 'Team A',
    team_b_name TEXT DEFAULT 'Team B',
    bet_amount INTEGER NOT NULL,
    status TEXT DEFAULT 'waiting' CHECK(status IN ('waiting','selecting','live','finished')),
    max_players INTEGER DEFAULT 5,
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS game_participants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id INTEGER NOT NULL REFERENCES games(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    join_order INTEGER NOT NULL,
    selected_positions TEXT DEFAULT NULL,
    total_runs INTEGER DEFAULT 0,
    is_ready INTEGER DEFAULT 0,
    UNIQUE(game_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS game_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id INTEGER NOT NULL REFERENCES games(id),
    winner_id INTEGER REFERENCES users(id),
    pot_amount INTEGER NOT NULL,
    finished_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

module.exports = db;
