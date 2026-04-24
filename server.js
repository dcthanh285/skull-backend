const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const PORT = process.env.PORT || 3000;

// ===== CONFIG =====
app.use(cors());
app.use(express.json());

// ===== DATABASE =====
const db = new sqlite3.Database('./subscriptions.db');

db.run(`CREATE TABLE IF NOT EXISTS users (
  wallet TEXT PRIMARY KEY,
  plan TEXT,
  expiry INTEGER
)`);

// ===== MEMORY DATA =====
let activeSignals = [];
let observe = [];
let breakout = [];

// ===== HEALTH CHECK =====
app.get('/', (req, res) => {
  res.send('✅ Skull VIP Backend Running');
});

// ===== CHECK SUBSCRIPTION =====
app.get('/api/subscription', (req, res) => {
  const { wallet } = req.query;

  if (!wallet) return res.json({ active: false });

  db.get(
    "SELECT * FROM users WHERE wallet = ? AND expiry > ?",
    [wallet, Date.now()],
    (err, row) => {
      res.json({
        active: !!row,
        plan: row ? row.plan : null
      });
    }
  );
});

// ===== MAIN API FOR MINI APP =====
app.get('/api/vip-signals', (req, res) => {
  const { wallet } = req.query;
  const walletSafe = wallet || "guest";

  db.get(
    "SELECT * FROM users WHERE wallet = ? AND expiry > ?",
    [walletSafe, Date.now()],
    (err, row) => {
      const isVIP = !!row;

      res.json({
        isVIP,
        signals: isVIP ? activeSignals : [],

        // FREE USER vẫn thấy
        observe: observe || [],
        breakout: breakout || []
      });
    }
  );
});

// ===== PUSH SIGNAL (FROM SCANNER) =====
app.post('/api/push-signal', (req, res) => {
  const signal = req.body;

  activeSignals.unshift(signal);

  if (activeSignals.length > 50) {
    activeSignals.pop();
  }

  console.log(`📡 SIGNAL: ${signal.symbol}`);

  res.json({ success: true });
});

// ===== PUSH OBSERVE =====
app.post('/api/push-observe', (req, res) => {
  observe = req.body || [];

  console.log(`👀 OBSERVE: ${observe.length}`);

  res.json({ success: true });
});

// ===== PUSH BREAKOUT =====
app.post('/api/push-breakout', (req, res) => {
  breakout = req.body || [];

  console.log(`🔥 BREAKOUT: ${breakout.length}`);

  res.json({ success: true });
});

// ===== DEBUG API =====
app.get('/api/debug', (req, res) => {
  res.json({
    signals: activeSignals.length,
    observe: observe.length,
    breakout: breakout.length
  });
});

// ===== CLEAR DATA (OPTIONAL) =====
app.post('/api/clear', (req, res) => {
  activeSignals = [];
  observe = [];
  breakout = [];
  res.json({ success: true });
});

// ===== START SERVER =====
app.listen(PORT, () => {
  console.log(`🚀 Backend running on port ${PORT}`);
});