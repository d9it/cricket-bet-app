require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/games', require('./routes/games'));
app.use('/api/cricket', require('./routes/cricket'));

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// All non-API routes serve the frontend SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🏏 Cricket Bet App running at http://localhost:${PORT}`);
  console.log(`   Open your browser and visit the URL above\n`);
});
