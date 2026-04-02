const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const fetch = require('node-fetch');

const CRICAPI_KEY = process.env.CRICAPI_KEY || '';
const BASE_URL = 'https://api.cricapi.com/v1';
const CACHE_TTL = 2 * 60 * 1000; // 2 minutes

const cache = { matches: null, matchesAt: 0, scores: {}, scoresAt: {} };

// --- Mock Data ---

const MOCK_MATCHES = [
  { id: 'mock_ind_aus', name: 'India vs Australia - 3rd T20I', status: 'Live', matchType: 't20',   teams: ['India', 'Australia'], date: new Date().toISOString().split('T')[0], venue: 'Wankhede Stadium, Mumbai' },
  { id: 'mock_eng_pak', name: 'England vs Pakistan - 2nd ODI',  status: 'Live', matchType: 'odi',  teams: ['England', 'Pakistan'], date: new Date().toISOString().split('T')[0], venue: "Lord's Cricket Ground, London" },
  { id: 'mock_sa_nz',   name: 'South Africa vs New Zealand - 1st Test', status: 'Day 2', matchType: 'test', teams: ['South Africa', 'New Zealand'], date: new Date().toISOString().split('T')[0], venue: 'Newlands, Cape Town' },
  { id: 'mock_wi_sl',   name: 'West Indies vs Sri Lanka - 3rd T20I', status: 'Upcoming', matchType: 't20', teams: ['West Indies', 'Sri Lanka'], date: new Date().toISOString().split('T')[0], venue: 'Kensington Oval, Barbados' },
  { id: 'mock_ban_afg', name: 'Bangladesh vs Afghanistan - 1st ODI', status: 'Live', matchType: 'odi', teams: ['Bangladesh', 'Afghanistan'], date: new Date().toISOString().split('T')[0], venue: 'Shere Bangla Stadium, Dhaka' }
];

const TEAM_BATSMEN = {
  'India':        ['Rohit Sharma', 'Shubman Gill', 'Virat Kohli', 'Shreyas Iyer', 'KL Rahul'],
  'Australia':    ['David Warner', 'Travis Head', 'Steve Smith', 'Marnus Labuschagne', 'Cameron Green'],
  'England':      ['Zak Crawley', 'Ben Duckett', 'Joe Root', 'Harry Brook', 'Jos Buttler'],
  'Pakistan':     ['Mohammad Rizwan', 'Babar Azam', 'Imam-ul-Haq', 'Abdullah Shafique', 'Salman Agha'],
  'South Africa': ['Tony de Zorzi', 'Aiden Markram', 'Rassie van der Dussen', 'Temba Bavuma', 'David Bedingham'],
  'New Zealand':  ['Tom Latham', 'Devon Conway', 'Kane Williamson', 'Daryl Mitchell', 'Tom Blundell'],
  'West Indies':  ['Brandon King', 'Evin Lewis', 'Nicholas Pooran', 'Shimron Hetmyer', 'Rovman Powell'],
  'Sri Lanka':    ['Pathum Nissanka', 'Kusal Mendis', 'Dhananjaya de Silva', 'Charith Asalanka', 'Sadeera Samarawickrama'],
  'Bangladesh':   ['Tamim Iqbal', 'Liton Das', 'Shakib Al Hasan', 'Mushfiqur Rahim', 'Towhid Hridoy'],
  'Afghanistan':  ['Rahmanullah Gurbaz', 'Ibrahim Zadran', 'Rahmat Shah', 'Hashmatullah Shahidi', 'Mohammad Nabi']
};

const mockRunState = {};

function getMockScorecard(matchId) {
  const matchInfo = MOCK_MATCHES.find(m => m.id === matchId) || { name: 'Match', teams: ['Team A', 'Team B'] };

  if (!mockRunState[matchId]) {
    mockRunState[matchId] = {
      A: Array.from({ length: 5 }, () => Math.floor(Math.random() * 70) + 10),
      B: Array.from({ length: 5 }, () => Math.floor(Math.random() * 70) + 10),
      lastTick: Date.now()
    };
  }

  const state = mockRunState[matchId];
  const now = Date.now();
  // Simulate live scoring: add a few runs every ~8 seconds
  if (now - state.lastTick > 8000) {
    const team = Math.random() > 0.5 ? 'A' : 'B';
    const pos = Math.floor(Math.random() * 5);
    state[team][pos] += Math.floor(Math.random() * 7) + 1;
    state.lastTick = now;
  }

  const batsmenA = TEAM_BATSMEN[matchInfo.teams[0]] || ['Batsman 1', 'Batsman 2', 'Batsman 3', 'Batsman 4', 'Batsman 5'];
  const batsmenB = TEAM_BATSMEN[matchInfo.teams[1]] || ['Batsman 1', 'Batsman 2', 'Batsman 3', 'Batsman 4', 'Batsman 5'];

  return {
    matchId,
    name: matchInfo.name,
    status: 'Live',
    isFinished: false,
    teams: [
      {
        name: matchInfo.teams[0],
        batsmen: state.A.map((runs, i) => ({
          position: i + 1,
          name: batsmenA[i],
          runs,
          balls: Math.floor(runs * (1.1 + Math.random() * 0.4)),
          status: i === 0 ? 'batting' : (i < 3 ? 'c Smith b Jones 34' : 'yet to bat')
        }))
      },
      {
        name: matchInfo.teams[1],
        batsmen: state.B.map((runs, i) => ({
          position: i + 1,
          name: batsmenB[i],
          runs,
          balls: Math.floor(runs * (1.1 + Math.random() * 0.4)),
          status: i < 2 ? 'c Brown b Taylor 28' : 'yet to bat'
        }))
      }
    ]
  };
}

function parseLiveScorecard(data) {
  const teams = data.teams || ['Team A', 'Team B'];
  const result = {
    matchId: data.id,
    name: data.name,
    status: data.status,
    isFinished: data.matchEnded || false,
    teams: [
      { name: teams[0], batsmen: [] },
      { name: teams[1], batsmen: [] }
    ]
  };

  if (data.scorecard) {
    data.scorecard.forEach(innings => {
      const isTeamB = innings.inning?.toLowerCase().includes(teams[1]?.toLowerCase());
      const target = isTeamB ? result.teams[1] : result.teams[0];
      if (innings.batting) {
        innings.batting.slice(0, 5).forEach((b, i) => {
          if (target.batsmen.length < 5) {
            target.batsmen.push({
              position: i + 1,
              name: b.batsman || `Batsman ${i + 1}`,
              runs: parseInt(b.r) || 0,
              balls: parseInt(b.b) || 0,
              status: b.dismissal || (i === 0 ? 'batting' : 'yet to bat')
            });
          }
        });
      }
    });
  }

  // Pad to 5 positions
  for (const team of result.teams) {
    for (let i = team.batsmen.length + 1; i <= 5; i++) {
      team.batsmen.push({ position: i, name: `Batsman ${i}`, runs: 0, balls: 0, status: 'yet to bat' });
    }
  }

  return result;
}

// GET /api/cricket/matches
router.get('/matches', authMiddleware, async (req, res) => {
  try {
    if (!CRICAPI_KEY || CRICAPI_KEY === 'your_cricapi_key_here') {
      return res.json(MOCK_MATCHES);
    }
    const now = Date.now();
    if (cache.matches && now - cache.matchesAt < CACHE_TTL) return res.json(cache.matches);
    const resp = await fetch(`${BASE_URL}/matches?apikey=${CRICAPI_KEY}&offset=0`);
    const data = await resp.json();
    if (data.status !== 'success') return res.json(MOCK_MATCHES);
    const matches = data.data
      .filter(m => m.matchType && ['test', 'odi', 't20'].includes(m.matchType.toLowerCase()))
      .slice(0, 20)
      .map(m => ({
        id: m.id, name: m.name, status: m.status,
        matchType: m.matchType.toLowerCase(),
        teams: m.teams || [], date: m.date, venue: m.venue
      }));
    cache.matches = matches;
    cache.matchesAt = now;
    res.json(matches);
  } catch (err) {
    console.error('CricAPI error:', err.message);
    res.json(MOCK_MATCHES);
  }
});

// GET /api/cricket/scorecard/:matchId
router.get('/scorecard/:matchId', authMiddleware, async (req, res) => {
  try {
    const { matchId } = req.params;
    if (matchId.startsWith('mock_') || !CRICAPI_KEY || CRICAPI_KEY === 'your_cricapi_key_here') {
      return res.json(getMockScorecard(matchId));
    }
    const now = Date.now();
    if (cache.scores[matchId] && now - cache.scoresAt[matchId] < CACHE_TTL)
      return res.json(cache.scores[matchId]);
    const resp = await fetch(`${BASE_URL}/match_scorecard?apikey=${CRICAPI_KEY}&id=${matchId}`);
    const data = await resp.json();
    if (data.status !== 'success') return res.json(getMockScorecard(matchId));
    const scorecard = parseLiveScorecard(data.data);
    cache.scores[matchId] = scorecard;
    cache.scoresAt[matchId] = now;
    res.json(scorecard);
  } catch (err) {
    console.error('Scorecard error:', err.message);
    res.json(getMockScorecard(req.params.matchId));
  }
});

module.exports = router;
