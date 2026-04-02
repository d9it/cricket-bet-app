const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const fetch = require('node-fetch');

// ── API Configuration ────────────────────────────────────────────────────────
// Priority 1 (no key needed): Free unofficial Cricbuzz scraper API
//   https://cricbuzz-live.vercel.app  — works without any setup!
//
// Priority 2 (optional): Cricbuzz on RapidAPI — set RAPIDAPI_KEY in Railway
//   https://rapidapi.com/cricketapilive/api/cricbuzz-cricket
//
// Priority 3 (optional): cricketdata.org — set CRICAPI_KEY in Railway
//
// Fallback: Realistic mock data (always works)

const RAPIDAPI_KEY  = process.env.RAPIDAPI_KEY  || '';
const CRICAPI_KEY   = process.env.CRICAPI_KEY   || '';
const CRICBUZZ_HOST = 'cricbuzz-cricket.p.rapidapi.com';
const CRICBUZZ_BASE = `https://${CRICBUZZ_HOST}`;
const CRICAPI_BASE  = 'https://api.cricapi.com/v1';

// Free no-key API (unofficial Cricbuzz scraper)
const FREE_API_BASE = 'https://cricbuzz-live.vercel.app';

const CACHE_TTL = 2 * 60 * 1000; // 2 minutes
const cache = { matches: null, matchesAt: 0, scores: {}, scoresAt: {} };

function hasRapidKey() { return RAPIDAPI_KEY && RAPIDAPI_KEY.length > 10; }
function hasCricKey()  { return CRICAPI_KEY  && CRICAPI_KEY !== 'your_cricapi_key_here' && CRICAPI_KEY.length > 5; }

// ── Mock Data ────────────────────────────────────────────────────────────────

function today() { return new Date().toISOString().split('T')[0]; }

const MOCK_MATCHES = [
  { id:'mock_ind_aus', name:'India vs Australia - 3rd T20I',         status:'Live',     matchType:'t20',  teams:['India','Australia'],        date:today(), venue:'Wankhede Stadium, Mumbai' },
  { id:'mock_eng_pak', name:'England vs Pakistan - 2nd ODI',          status:'Live',     matchType:'odi',  teams:['England','Pakistan'],        date:today(), venue:"Lord's Cricket Ground, London" },
  { id:'mock_sa_nz',   name:'South Africa vs New Zealand - 1st Test', status:'Day 2',    matchType:'test', teams:['South Africa','New Zealand'], date:today(), venue:'Newlands, Cape Town' },
  { id:'mock_wi_sl',   name:'West Indies vs Sri Lanka - 3rd T20I',    status:'Upcoming', matchType:'t20',  teams:['West Indies','Sri Lanka'],    date:today(), venue:'Kensington Oval, Barbados' },
  { id:'mock_ban_afg', name:'Bangladesh vs Afghanistan - 1st ODI',    status:'Live',     matchType:'odi',  teams:['Bangladesh','Afghanistan'],  date:today(), venue:'Shere Bangla Stadium, Dhaka' }
];

const TEAM_BATSMEN = {
  'India':        ['Rohit Sharma','Shubman Gill','Virat Kohli','Shreyas Iyer','KL Rahul'],
  'Australia':    ['David Warner','Travis Head','Steve Smith','Marnus Labuschagne','Cameron Green'],
  'England':      ['Zak Crawley','Ben Duckett','Joe Root','Harry Brook','Jos Buttler'],
  'Pakistan':     ['Mohammad Rizwan','Babar Azam','Imam-ul-Haq','Abdullah Shafique','Salman Agha'],
  'South Africa': ['Tony de Zorzi','Aiden Markram','Rassie van der Dussen','Temba Bavuma','David Bedingham'],
  'New Zealand':  ['Tom Latham','Devon Conway','Kane Williamson','Daryl Mitchell','Tom Blundell'],
  'West Indies':  ['Brandon King','Evin Lewis','Nicholas Pooran','Shimron Hetmyer','Rovman Powell'],
  'Sri Lanka':    ['Pathum Nissanka','Kusal Mendis','Dhananjaya de Silva','Charith Asalanka','Sadeera Samarawickrama'],
  'Bangladesh':   ['Tamim Iqbal','Liton Das','Shakib Al Hasan','Mushfiqur Rahim','Towhid Hridoy'],
  'Afghanistan':  ['Rahmanullah Gurbaz','Ibrahim Zadran','Rahmat Shah','Hashmatullah Shahidi','Mohammad Nabi']
};

const mockRunState = {};
function getMockScorecard(matchId) {
  const m = MOCK_MATCHES.find(x => x.id === matchId) || { name:'Match', teams:['Team A','Team B'] };
  if (!mockRunState[matchId]) {
    mockRunState[matchId] = {
      A: Array.from({length:5}, () => Math.floor(Math.random()*70)+10),
      B: Array.from({length:5}, () => Math.floor(Math.random()*70)+10),
      tick: Date.now()
    };
  }
  const s = mockRunState[matchId];
  if (Date.now() - s.tick > 8000) {
    const t = Math.random() > 0.5 ? 'A' : 'B';
    s[t][Math.floor(Math.random()*5)] += Math.floor(Math.random()*7)+1;
    s.tick = Date.now();
  }
  const bA = TEAM_BATSMEN[m.teams[0]] || ['Batsman 1','Batsman 2','Batsman 3','Batsman 4','Batsman 5'];
  const bB = TEAM_BATSMEN[m.teams[1]] || ['Batsman 1','Batsman 2','Batsman 3','Batsman 4','Batsman 5'];
  return {
    matchId, name: m.name, status:'Live', isFinished: false,
    teams: [
      { name: m.teams[0], batsmen: s.A.map((runs,i) => ({ position:i+1, name:bA[i], runs, balls:Math.floor(runs*1.2), status:i===0?'batting':i<3?'out':'yet to bat' })) },
      { name: m.teams[1], batsmen: s.B.map((runs,i) => ({ position:i+1, name:bB[i], runs, balls:Math.floor(runs*1.1), status:i<2?'out':'yet to bat' })) }
    ]
  };
}

// ── Free Cricbuzz Scraper API (no key needed) ────────────────────────────────

function detectMatchType(text) {
  const t = (text || '').toLowerCase();
  if (t.includes('test')) return 'test';
  if (t.includes(' odi') || t.includes('one day') || t.includes('50-over')) return 'odi';
  return 't20';
}

function parseFreeApiMatches(data, isLive) {
  try {
    const matches = data?.data?.matches || data?.matches || [];
    return matches
      .filter(m => m && m.id)
      .map(m => {
        const teams  = Array.isArray(m.teams) ? m.teams : [];
        const teamA  = teams[0]?.team || teams[0] || 'Team A';
        const teamB  = teams[1]?.team || teams[1] || 'Team B';
        const title  = m.title || `${teamA} vs ${teamB}`;
        const score  = teams.filter(t => t.run).map(t => `${t.team}: ${t.run}`).join(' | ');
        const date   = m.timeAndPlace?.date || today();
        const venue  = m.timeAndPlace?.place || '';

        return {
          id: String(m.id),
          name: title,
          status: isLive ? (score || 'Live') : (m.overview || (date ? `Scheduled: ${date}` : 'Upcoming')),
          matchType: detectMatchType(title),
          teams: [teamA, teamB],
          date,
          venue,
          isLive: !!isLive
        };
      })
      .filter(m => m.id && m.name && m.id !== 'undefined');
  } catch (e) {
    console.error('parseFreeApiMatches error:', e.message);
    return [];
  }
}

// ── Cricbuzz RapidAPI Parsers ────────────────────────────────────────────────

function parseCricbuzzMatches(data) {
  const matches = [];
  const types = data.typeMatches || [];
  for (const type of types) {
    for (const series of (type.seriesMatches || [])) {
      const wrapper = series.seriesAdWrapper || series;
      for (const match of (wrapper.matches || [])) {
        try {
          const info  = match.matchInfo  || {};
          const score = match.matchScore || {};
          const fmt   = (info.matchFormat || 'T20').toLowerCase();
          if (!['t20','odi','test'].includes(fmt)) continue;

          const status = info.status || 'Upcoming';
          const isLive = status.toLowerCase().includes('live') ||
                         status.toLowerCase().includes('innings') ||
                         status.toLowerCase().includes('day');

          let scoreStr = '';
          if (score.team1Score?.inngs1) {
            const i = score.team1Score.inngs1;
            scoreStr += `${info.team1?.teamSName} ${i.runs}/${i.wickets} (${i.overs})`;
          }
          if (score.team2Score?.inngs1) {
            const i = score.team2Score.inngs1;
            scoreStr += ` | ${info.team2?.teamSName} ${i.runs}/${i.wickets} (${i.overs})`;
          }

          matches.push({
            id: String(info.matchId),
            name: `${info.team1?.teamName} vs ${info.team2?.teamName} — ${info.matchDesc || ''}`.trim(),
            status: scoreStr || status,
            matchType: fmt,
            teams: [info.team1?.teamName || 'Team A', info.team2?.teamName || 'Team B'],
            date: info.startDate ? new Date(parseInt(info.startDate)).toISOString().split('T')[0] : today(),
            venue: info.venueInfo?.ground || '',
            isLive
          });
        } catch { /* skip malformed entry */ }
      }
    }
  }
  return matches;
}

function parseCricbuzzScorecard(data, matchId) {
  const scoreCards  = data.scoreCard || [];
  const matchHeader = data.matchHeader || {};
  const teamA = matchHeader.team1?.name || 'Team A';
  const teamB = matchHeader.team2?.name || 'Team B';

  const result = {
    matchId,
    name: `${teamA} vs ${teamB}`,
    status: matchHeader.status || 'Live',
    isFinished: matchHeader.state === 'Complete',
    teams: [
      { name: teamA, batsmen: [] },
      { name: teamB, batsmen: [] }
    ]
  };

  for (const innings of scoreCards) {
    const battingTeamName = innings.batTeamDetails?.batTeamName || '';
    const isTeamB = battingTeamName.toLowerCase() === teamB.toLowerCase();
    const target  = isTeamB ? result.teams[1] : result.teams[0];
    if (target.batsmen.length >= 5) continue;

    const batsmenData = innings.batTeamDetails?.batsmenData || {};
    const batsmenList = Object.values(batsmenData)
      .sort((a, b) => (a.batId || 0) - (b.batId || 0))
      .slice(0, 5);

    batsmenList.forEach((b, i) => {
      if (target.batsmen.length < 5) {
        target.batsmen.push({
          position: i + 1,
          name: b.batName || `Batsman ${i+1}`,
          runs: parseInt(b.runs) || 0,
          balls: parseInt(b.balls) || 0,
          status: b.isDismissed ? (b.outDesc || 'out') : (i === 0 ? 'batting' : 'yet to bat')
        });
      }
    });
  }

  for (const team of result.teams) {
    for (let i = team.batsmen.length + 1; i <= 5; i++) {
      team.batsmen.push({ position:i, name:`Batsman ${i}`, runs:0, balls:0, status:'yet to bat' });
    }
  }
  return result;
}

// ── CricketData.org Parsers ──────────────────────────────────────────────────

function parseCricApiMatches(data) {
  return (data || [])
    .filter(m => m.matchType && ['test','odi','t20'].includes(m.matchType.toLowerCase()))
    .map(m => ({
      id: m.id, name: m.name,
      status: m.status,
      matchType: m.matchType.toLowerCase(),
      teams: m.teams || [], date: m.date, venue: m.venue,
      isLive: (m.status || '').toLowerCase().includes('live')
    }));
}

function parseCricApiScorecard(data) {
  const teams = data.teams || ['Team A', 'Team B'];
  const result = {
    matchId: data.id, name: data.name, status: data.status,
    isFinished: data.matchEnded || false,
    teams: [{ name: teams[0], batsmen: [] }, { name: teams[1], batsmen: [] }]
  };
  if (data.scorecard) {
    data.scorecard.forEach(innings => {
      const isTeamB = (innings.inning || '').toLowerCase().includes((teams[1] || '').toLowerCase());
      const target  = isTeamB ? result.teams[1] : result.teams[0];
      (innings.batting || []).slice(0, 5).forEach((b, i) => {
        if (target.batsmen.length < 5) {
          target.batsmen.push({
            position: i+1, name: b.batsman || `Batsman ${i+1}`,
            runs: parseInt(b.r) || 0, balls: parseInt(b.b) || 0,
            status: b.dismissal || (i===0 ? 'batting' : 'yet to bat')
          });
        }
      });
    });
  }
  for (const team of result.teams) {
    for (let i = team.batsmen.length+1; i <= 5; i++) {
      team.batsmen.push({ position:i, name:`Batsman ${i}`, runs:0, balls:0, status:'yet to bat' });
    }
  }
  return result;
}

// ── Helper: safe fetch with timeout ─────────────────────────────────────────
async function safeFetch(url, opts = {}, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    clearTimeout(timer);
    return res;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

// ── Routes ───────────────────────────────────────────────────────────────────

// GET /api/cricket/status  — debug endpoint (no auth needed)
router.get('/status', async (req, res) => {
  res.json({
    freeApi: FREE_API_BASE,
    hasRapidKey: hasRapidKey(),
    hasCricKey: hasCricKey(),
    cacheAge: cache.matchesAt ? Math.round((Date.now() - cache.matchesAt) / 1000) + 's ago' : 'empty',
    cachedMatches: cache.matches?.length || 0
  });
});

// GET /api/cricket/matches
router.get('/matches', authMiddleware, async (req, res) => {
  try {
    const now = Date.now();
    if (cache.matches && Array.isArray(cache.matches) && cache.matches.length && now - cache.matchesAt < CACHE_TTL) {
      return res.json(cache.matches);
    }

    let matches = [];
    let source  = '';

    // ── Priority 1: RapidAPI Cricbuzz (if key is configured) ──
    if (hasRapidKey()) {
      try {
        const [liveRes, upcomingRes, recentRes] = await Promise.all([
          safeFetch(`${CRICBUZZ_BASE}/matches/v1/live`,     { headers:{ 'X-RapidAPI-Key': RAPIDAPI_KEY, 'X-RapidAPI-Host': CRICBUZZ_HOST } }),
          safeFetch(`${CRICBUZZ_BASE}/matches/v1/upcoming`, { headers:{ 'X-RapidAPI-Key': RAPIDAPI_KEY, 'X-RapidAPI-Host': CRICBUZZ_HOST } }),
          safeFetch(`${CRICBUZZ_BASE}/matches/v1/recent`,   { headers:{ 'X-RapidAPI-Key': RAPIDAPI_KEY, 'X-RapidAPI-Host': CRICBUZZ_HOST } })
        ]);

        const live     = liveRes.ok     ? parseCricbuzzMatches(await liveRes.json())     : [];
        const upcoming = upcomingRes.ok ? parseCricbuzzMatches(await upcomingRes.json()) : [];
        const recent   = recentRes.ok   ? parseCricbuzzMatches(await recentRes.json())   : [];

        const seen = new Set();
        for (const m of [...live, ...upcoming, ...recent]) {
          if (!seen.has(m.id)) { seen.add(m.id); matches.push(m); }
        }
        if (matches.length) { source = 'RapidAPI Cricbuzz'; }
        console.log(`RapidAPI: ${matches.length} matches`);
      } catch (err) {
        console.error('RapidAPI error:', err.message);
      }
    }

    // ── Priority 2: Free unofficial Cricbuzz API (no key needed) ──
    if (!matches.length) {
      try {
        const [liveRes, upcomingRes] = await Promise.all([
          safeFetch(`${FREE_API_BASE}/v1/matches/live`),
          safeFetch(`${FREE_API_BASE}/v1/matches/upcoming`)
        ]);

        const liveData     = liveRes.ok     ? await liveRes.json()     : null;
        const upcomingData = upcomingRes.ok ? await upcomingRes.json() : null;

        const live     = liveData     ? parseFreeApiMatches(liveData, true)     : [];
        const upcoming = upcomingData ? parseFreeApiMatches(upcomingData, false) : [];

        const seen = new Set(live.map(m => m.id));
        matches = [...live, ...upcoming.filter(m => !seen.has(m.id))];
        if (matches.length) { source = 'Free Cricbuzz API'; }
        console.log(`Free Cricbuzz API: ${matches.length} matches`);
      } catch (err) {
        console.error('Free API error:', err.message);
      }
    }

    // ── Priority 3: CricketData.org (if key configured) ──
    if (!matches.length && hasCricKey()) {
      try {
        const [curRes, allRes] = await Promise.all([
          safeFetch(`${CRICAPI_BASE}/currentMatches?apikey=${CRICAPI_KEY}&offset=0`),
          safeFetch(`${CRICAPI_BASE}/matches?apikey=${CRICAPI_KEY}&offset=0`)
        ]);
        const curData = await curRes.json();
        const allData = await allRes.json();
        const live    = curData.status === 'success' ? parseCricApiMatches(curData.data || []) : [];
        const all     = allData.status === 'success' ? parseCricApiMatches(allData.data || []) : [];
        const seen    = new Set(live.map(m => m.id));
        matches = [...live, ...all.filter(m => !seen.has(m.id)).slice(0, 15)];
        if (matches.length) { source = 'CricketData.org'; }
        console.log(`CricAPI: ${matches.length} matches`);
      } catch (err) {
        console.error('CricketData API error:', err.message);
      }
    }

    // ── Fallback: Mock data (always works) ──
    if (!matches.length) {
      console.log('Using mock match data');
      return res.json(MOCK_MATCHES);
    }

    console.log(`Serving ${matches.length} matches from: ${source}`);
    cache.matches   = matches;
    cache.matchesAt = now;
    res.json(matches);
  } catch (err) {
    console.error('Matches route error:', err.message);
    res.json(MOCK_MATCHES);
  }
});

// GET /api/cricket/scorecard/:matchId
router.get('/scorecard/:matchId', authMiddleware, async (req, res) => {
  try {
    const { matchId } = req.params;
    if (matchId.startsWith('mock_')) return res.json(getMockScorecard(matchId));

    const now = Date.now();
    if (cache.scores[matchId] && now - cache.scoresAt[matchId] < CACHE_TTL)
      return res.json(cache.scores[matchId]);

    let scorecard = null;

    // ── RapidAPI Cricbuzz ──
    if (hasRapidKey()) {
      try {
        const resp = await safeFetch(`${CRICBUZZ_BASE}/mcenter/v1/${matchId}/scard`, {
          headers: { 'X-RapidAPI-Key': RAPIDAPI_KEY, 'X-RapidAPI-Host': CRICBUZZ_HOST }
        });
        if (resp.ok) {
          const data = await resp.json();
          if (data.scoreCard) scorecard = parseCricbuzzScorecard(data, matchId);
        }
      } catch (err) {
        console.error('RapidAPI scorecard error:', err.message);
      }
    }

    // ── CricketData.org ──
    if (!scorecard && hasCricKey()) {
      try {
        const resp = await safeFetch(`${CRICAPI_BASE}/match_scorecard?apikey=${CRICAPI_KEY}&id=${matchId}`);
        const data = await resp.json();
        if (data.status === 'success' && data.data) scorecard = parseCricApiScorecard(data.data);
      } catch (err) {
        console.error('CricAPI scorecard error:', err.message);
      }
    }

    if (!scorecard) return res.json(getMockScorecard(matchId));

    cache.scores[matchId]   = scorecard;
    cache.scoresAt[matchId] = now;
    res.json(scorecard);
  } catch (err) {
    console.error('Scorecard error:', err.message);
    res.json(getMockScorecard(req.params.matchId));
  }
});

module.exports = router;
