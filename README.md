# 🏏 CricketBet — Fantasy Cricket Betting App

A full-stack web application where cricket fans can bet points on live batting positions from real matches.

## Features

- **User accounts** with persistent wallets (starts at 1,000 free points)
- **2–5 players** per game
- **Equal picks** for all players: 2p=5 each, 3p=3 each, 4p=2 each, 5p=2 each
- **Test / ODI / T20** format support
- **Live cricket scores** via CricAPI (with realistic mock data as fallback)
- **Room codes** — create a game and share the 6-char code with friends
- **Live scoreboard** that auto-refreshes every 15 seconds
- **Wallet system** — winner gets the full pot credited automatically

---

## Quick Start

### 1. Install Node.js
Download from https://nodejs.org (LTS version)

### 2. Set up the project
```bash
cd cricket-bet-app
npm install
```

### 3. Configure environment
```bash
cp .env.example .env
```
Edit `.env` and optionally add your CricAPI key (get it free at https://cricapi.com).
Without a key, the app uses realistic mock match data automatically.

### 4. Start the server
```bash
npm start
# or for auto-reload during development:
npm run dev
```

### 5. Open in browser
Visit: **http://localhost:3000**

---

## How to Play

1. **Register** — Create an account (you get 1,000 free points)
2. **Create a Game** — Pick a match, set bet amount (e.g. 100 pts), set max players
3. **Share the Room Code** — Send the 6-character code to friends
4. **Friends Join** — They enter the code on the dashboard
5. **Host Starts** — Once 2+ players have joined, host clicks "Start Game"
6. **Pick Positions** — Each player picks batting order positions:
   - Select from Team A (positions 1–5) and Team B (positions 1–5)
   - Each player gets equal picks from the 10 total slots
7. **Watch Live** — Scoreboard auto-refreshes with real cricket scores
8. **Winner Declared** — Most total runs wins the pot!

---

## Pick Allocation

| Players | Picks Each | Total Slots Used |
|---------|-----------|-----------------|
| 2       | 5         | 10 / 10         |
| 3       | 3         | 9 / 10          |
| 4       | 2         | 8 / 10          |
| 5       | 2         | 10 / 10         |

---

## Tech Stack

- **Backend**: Node.js + Express
- **Database**: SQLite (file-based, no setup needed)
- **Auth**: JWT tokens
- **Frontend**: Vanilla HTML/CSS/JavaScript
- **Cricket API**: CricAPI v1 (optional)
