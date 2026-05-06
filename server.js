const express = require('express');
const ccxt = require('ccxt');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// ================= CONFIG =================
const OWNER_WALLETS = [
    "UQA6rsniXUm67jpX7OmUctetQmt_FrW4M2zO4qn9bTmWlIlX",
];

const ADMIN_PASS = '123456';
const TELEGRAM_TOKEN = '7852258417:AAGh122U7vtrDAC-eR1CqziOW7voTrl21Zk';
const TELEGRAM_CHAT_ID = '-1002156203382';

const isOwner = (wallet) => OWNER_WALLETS.some(o => o.toLowerCase() === (wallet || "").toLowerCase());

// ================= MIDDLEWARE =================
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(session({
  secret: 'bitget_squeeze_2026',
  resave: false,
  saveUninitialized: true,
  cookie: { maxAge: 3600000 }
}));

app.use(express.static(path.join(__dirname, 'public')));

// ================= CCXT & BIẾN CHUNG =================
const exchange = new ccxt.bitget({ 
  enableRateLimit: true, 
  rateLimit: 400 
});

let activeSignals = [];
let signalHistory = [];
let latestObserve = [];
let latestBreakout = [];
let latestSignals = [];
let lastScanTime = null;
let lastScanTF = "";
let currentScanning = null;

// ================= LOAD HISTORY (dùng Volume) =================
const HISTORY_PATH = '/app/data/history.json';

try {
  // Tạo thư mục data nếu chưa có
  if (!fs.existsSync('/app/data')) {
    fs.mkdirSync('/app/data', { recursive: true });
  }

  if (fs.existsSync(HISTORY_PATH)) {
    const data = fs.readFileSync(HISTORY_PATH, 'utf-8');
    signalHistory = JSON.parse(data);
    console.log("✅ Loaded history from Volume:", signalHistory.length);
  } else {
    console.log("📂 Chưa có file history, sẽ tạo mới...");
  }
} catch (err) {
  console.log("❌ Load history lỗi:", err.message);
}

// ================= TELEGRAM =================
async function sendTelegram(msg) {
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text: msg,
      parse_mode: "HTML"
    });
  } catch (err) {
    console.log("Telegram error", err.message);
  }
}

// Push functions
async function pushToMiniApp(signal) {
  console.log(`✅ Đẩy signal ${signal.symbol} lên Mini App`);
}

async function pushObserve(data) {
  latestObserve = [...data].slice(-150);
  console.log(`👀 Đẩy ${data.length} observe`);
}

async function pushBreakout(data) {
  latestBreakout = [...data].slice(-80);
  console.log(`🔥 Đẩy ${data.length} breakout`);
}

// ================= ROUTES =================

// Dashboard
app.get('/', (req, res) => {
  if (!req.session.loggedIn) {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
  } else {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
  }
});

app.post('/login', (req, res) => {
  if (req.body.password === ADMIN_PASS) {
    req.session.loggedIn = true;
    res.json({ success: true });
  } else {
    res.json({ success: false });
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

// ================= MINI APP APIs =================
app.get('/api/vip-signals', async (req, res) => {
  try {
    const wallet = req.headers.wallet;
    const isVIP = isOwner(wallet);

    // Update realtime price
    for (let signal of activeSignals) {
      try {
        const ticker = await exchange.fetchTicker(signal.fullSymbol);
        const price = ticker.last;
        signal.currentPrice = price;
        signal.pnlPercent = signal.direction === 'LONG' 
          ? ((price - signal.entry) / signal.entry * 100)
          : ((signal.entry - price) / signal.entry * 100);
      } catch (e) {}
    }

    res.json({
      isVIP,
      isOwner: isOwner(wallet),
      signals: isVIP ? activeSignals : activeSignals.slice(0, 3),
      observe: latestObserve,
      breakout: latestBreakout
    });
  } catch (err) {
    res.json({ isVIP: false, signals: [] });
  }
});

app.get('/api/observe', (req, res) => res.json({ observe: latestObserve }));
app.get('/api/breakout', (req, res) => res.json({ breakout: latestBreakout }));

app.post('/api/verify-payment', (req, res) => {
  res.json({ success: true, message: "VIP activated for 30 days" });
});

// ================= SCANNER ROUTES =================
app.get('/api/signals', (req, res) => {
  res.json({ active: activeSignals, history: signalHistory });
});

app.get('/api/scan-status', (req, res) => {
  res.json({
    status: "running",
    lastScan: lastScanTime || "Chưa có",
    lastTF: lastScanTF,
    currentScan: currentScanning,
    observeCount: latestObserve.length,
    breakoutCount: latestBreakout.length
  });
});

app.get('/api/latest-data', (req, res) => {
  res.json({ observe: latestObserve, breakout: latestBreakout, signals: latestSignals });
});

// ================= UPDATE SIGNALS =================
app.get('/api/update-signals', async (req, res) => {
  try {
    for (let signal of activeSignals) {
      try {
        const ticker = await exchange.fetchTicker(signal.fullSymbol);
        const price = ticker.last;
        signal.currentPrice = price;

        const isLong = signal.direction === 'LONG';

        if (isLong) {
          if (price >= signal.tp1 && !signal.hitTP1) { signal.hitTP1 = true; signal.sl = signal.entry; }
          if (price >= signal.tp2 && !signal.hitTP2) { signal.hitTP2 = true; signal.sl = signal.tp1; signal.trailing = true; }
          if (price >= signal.tp3 && !signal.hitTP3) { signal.hitTP3 = true; }
          if (price <= signal.sl) { signal.hitSL = true; }
          signal.pnlPercent = ((price - signal.entry) / signal.entry * 100);
          if (signal.trailing) {
            const newSL = price * 0.98;
            if (newSL > signal.sl) signal.sl = newSL;
          }
        } else {
          if (price <= signal.tp1 && !signal.hitTP1) { signal.hitTP1 = true; signal.sl = signal.entry; }
          if (price <= signal.tp2 && !signal.hitTP2) { signal.hitTP2 = true; signal.sl = signal.tp1; signal.trailing = true; }
          if (price <= signal.tp3 && !signal.hitTP3) { signal.hitTP3 = true; }
          if (price >= signal.sl) { signal.hitSL = true; }
          signal.pnlPercent = ((signal.entry - price) / signal.entry * 100);
          if (signal.trailing) {
            const newSL = price * 1.02;
            if (newSL < signal.sl) signal.sl = newSL;
          }
        }

        if (signal.hitSL) {
          signal.status = signal.hitTP3 ? 'TP3 TRAILING WIN' : signal.hitTP2 ? 'PROFIT LOCKED' : signal.hitTP1 ? 'BREAKEVEN' : 'STOP LOSS';
          signalHistory.unshift({ ...signal });
          if (signalHistory.length > 200) signalHistory.pop();
          fs.writeFileSync(HISTORY_PATH, JSON.stringify(signalHistory, null, 2));
          signal._closed = true;
        }
      } catch (err) {
        console.log("Update error:", signal.symbol);
      }
    }
    activeSignals = activeSignals.filter(s => !s._closed);
    res.json({ success: true });
  } catch (err) {
    console.error("Update Signals Error:", err);
    res.json({ error: true });
  }
});

// ================= SCAN =================
app.get('/api/scan', async (req, res) => {
  const timeframe = req.query.timeframe || '1h';
  const start = parseInt(req.query.start) || 0;
  const batchSize = parseInt(req.query.batch) || 20;

  const observe = [];
  const breakout = [];
  const newSignals = [];

  try {
    const markets = await exchange.loadMarkets();
    const symbols = Object.keys(markets).filter(s => s.endsWith('/USDT:USDT'));
    const end = Math.min(start + batchSize, symbols.length);

    for (let i = start; i < end; i++) {
      const symbol = symbols[i];
      const clean = symbol.replace('/USDT:USDT', '');

      try {
        await new Promise(r => setTimeout(r, 450));

        const ohlcv = await exchange.fetchOHLCV(symbol, timeframe, undefined, 100);
        if (ohlcv.length < 50) continue;

        const closes = ohlcv.map(c => c[4]);
        const volumes = ohlcv.map(c => c[5]);
        const last = ohlcv.at(-1);
        const prev = ohlcv.at(-2);

        // BB
        const sma = closes.slice(-20).reduce((a,b)=>a+b,0)/20;
        const std = Math.sqrt(closes.slice(-20).reduce((a,b)=>a+(b-sma)**2,0)/20);
        const upper = sma + 2*std;
        const lower = sma - 2*std;
        const bandwidth = (upper - lower)/sma;

        const breakoutLong = prev[4] <= upper && last[4] > upper;
        const breakoutShort = prev[4] >= lower && last[4] < lower;

        // Volume
        const volumeAvg = volumes.slice(-20).reduce((a,b)=>a+b,0)/20;
        const volumeCondition = last[5] > volumeAvg * 1.5;

        // Strong Candle
        const body = Math.abs(last[4] - last[1]);
        const range = last[2] - last[3];
        const strongCandle = range > 0 ? (body / range) > 0.6 : false;

        // RSI
        let gains = 0, losses = 0;
        for (let j = closes.length - 14; j < closes.length; j++) {
          const diff = closes[j] - closes[j-1];
          if (diff > 0) gains += diff;
          else losses -= diff;
        }
        const rs = gains / (losses || 1);
        const rsi = 100 - (100 / (1 + rs));

        const rsiLong = rsi > 55 && rsi < 75;
        const rsiShort = rsi < 45 && rsi > 25;

        // MACD
        const ema12 = closes.slice(-12).reduce((a,b)=>a+b,0)/12;
        const ema26 = closes.slice(-26).reduce((a,b)=>a+b,0)/26;
        const macdLine = ema12 - ema26;
        const macdSignal = macdLine * 0.8;

        const macdLong = macdLine > macdSignal;
        const macdShort = macdLine < macdSignal;

        // Squeeze
        const bbWidthPercent = (upper - lower)/sma * 100;
        const squeeze = bbWidthPercent < 2.5;

        let squeezeCount = 0;
        for (let k = ohlcv.length - 20; k < ohlcv.length; k++) {
          const cCloses = ohlcv.slice(k-20, k).map(c => c[4]);
          if (cCloses.length < 20) continue;
          const s = cCloses.reduce((a,b)=>a+b,0)/20;
          const sd = Math.sqrt(cCloses.reduce((a,b)=>a+(b-s)**2,0)/20);
          const u = s + 2*sd;
          const l = s - 2*sd;
          const w = (u - l)/s * 100;
          if (w < 2.5) squeezeCount++;
        }
        const squeezeCondition = squeezeCount >= 5;

        // Trend
        const ema50 = closes.slice(-50).reduce((a,b)=>a+b,0)/50;
        const trendUp = last[4] > ema50;
        const trendDown = last[4] < ema50;

        const isLong = breakoutLong;

        // Higher TF Bias
        let higherBiasLong = true;
        let higherBiasShort = true;
        if (Math.random() < 0.7) {
          const higherTFs = ['15m', '1h'];
          for (let ht of higherTFs) {
            try {
              const hOHLCV = await exchange.fetchOHLCV(symbol, ht, undefined, 50);
              if (hOHLCV.length < 30) continue;
              const hLast = hOHLCV.at(-1);
              const hEMA50 = hOHLCV.slice(-50).reduce((a,b)=>a+b[4],0)/50;
              const hTrendUp = hLast[4] > hEMA50;
              if (!hTrendUp) higherBiasLong = false;
              if (hTrendUp) higherBiasShort = false;
            } catch(e) {}
          }
        }

        const currentPrice = last[4];
        const earlyBreakoutLong = currentPrice > upper * 0.998 && prev[4] <= upper;
        const earlyBreakoutShort = currentPrice < lower * 1.002 && prev[4] >= lower;

        const pullbackLong = currentPrice > upper * 0.97 && currentPrice < upper * 1.015;
        const pullbackShort = currentPrice < lower * 1.03 && currentPrice > lower * 0.985;

        const momentumLong = rsi > 58 && macdLine > macdSignal * 1.2 && volumeCondition;
        const momentumShort = rsi < 42 && macdLine < macdSignal * 0.8 && volumeCondition;

        const conditions = {
          breakout: breakoutLong || breakoutShort,
          squeeze,
          volume: volumeCondition,
          strongCandle,
          rsi: isLong ? rsiLong : rsiShort,
          macd: isLong ? macdLong : macdShort,
          dailyTrend: isLong ? trendUp : trendDown,
          squeezeCount: squeezeCondition,
          earlyBreakout: earlyBreakoutLong || earlyBreakoutShort,
          pullback: isLong ? pullbackLong : pullbackShort,
          momentum: isLong ? momentumLong : momentumShort,
          higherTF: isLong ? higherBiasLong : higherBiasShort
        };

        let score = 0;
        if (conditions.breakout) score += 1.0;
        if (conditions.earlyBreakout) score += 1.5;
        if (conditions.pullback) score += 2.0;
        if (conditions.momentum) score += 1.8;
        if (conditions.higherTF) score += 2.0;
        if (conditions.squeeze) score += 1.2;
        if (conditions.squeezeCount) score += 0.8;
        if (conditions.strongCandle) score += 0.8;
        if (conditions.rsi) score += 0.8;
        if (conditions.macd) score += 0.8;
        if (conditions.dailyTrend) score += 1.0;
        if (conditions.volume) score += 1.2;

        let rank = "WEAK";
        if (score >= 10.5) rank = "VIP";
        else if (score >= 8.0) rank = "GOOD";

        const finalCondition = conditions.higherTF && (conditions.pullback || conditions.earlyBreakout) && (conditions.breakout || conditions.earlyBreakout);

        if (score >= 5) {
          observe.push({
            symbol: clean,
            price: last[4].toFixed(6),
            bandwidth: (bandwidth*100).toFixed(2),
            squeezeCandles: squeezeCount,
            score: score.toFixed(1)
          });
        }

        if ((breakoutLong || breakoutShort) && finalCondition) {
          breakout.push({
            symbol: clean,
            direction: isLong ? 'LONG' : 'SHORT',
            price: last[4].toFixed(6),
            bandwidth: (bandwidth*100).toFixed(2),
            score: score.toFixed(1),
            rank,
            conditions
          });

          const exists = activeSignals.some(s => s.symbol === clean);
          if (!exists) {
            const entry = isLong ? pullbackLong ? currentPrice : last[4] : last[4];
            const signal = {
              trailing: false,
              score: score.toFixed(1),
              rank,
              id: Date.now() + Math.random(),
              symbol: clean,
              fullSymbol: symbol,
              direction: isLong ? 'LONG' : 'SHORT',
              entry,
              tp1: isLong ? entry * 1.04 : entry * 0.96,
              tp2: isLong ? entry * 1.08 : entry * 0.92,
              tp3: isLong ? entry * 1.13 : entry * 0.87,
              sl: isLong ? entry * 0.96 : entry * 1.04,
              timestamp: new Date().toLocaleString('vi-VN'),
              hitTP1: false,
              hitTP2: false,
              hitTP3: false,
              hitSL: false,
              currentPrice: entry,
              pnlPercent: 0
            };

            activeSignals.push(signal);
            newSignals.push(signal);
            pushToMiniApp(signal);

            sendTelegram(`
🚨 <b>${signal.rank} SIGNAL</b>
💎 <b>${signal.symbol}</b>
${signal.direction === 'LONG' ? '🟢 LONG' : '🔴 SHORT'}
💰 Entry: <b>${signal.entry.toFixed(6)}</b>
🎯 TP1: ${signal.tp1.toFixed(6)}
🎯 TP2: ${signal.tp2.toFixed(6)}
🎯 TP3: ${signal.tp3.toFixed(6)}
🛑 SL: ${signal.sl.toFixed(6)}
🔥 Score: ${signal.score}
`);
          }
        }
      } catch (err) {
        console.log(`Scan error: ${symbol}`);
        continue;
      }
    }

    await pushObserve(observe);
    await pushBreakout(breakout);

    res.json({
      observe,
      breakout,
      newSignals,
      isComplete: end >= symbols.length,
      scanned: end,
      total: symbols.length
    });

  } catch (err) {
    console.error("Scan error:", err);
    res.json({ error: true });
  }
});

// ================= STATS =================
function parseVietTimestamp(ts) {
  if (!ts) return new Date(0);
  const datePart = ts.split(',')[0].trim(); 
  const [day, month, year] = datePart.split('/').map(Number);
  return new Date(year, month - 1, day);
}

function calculateStats(history, period = 'all') {
  let filtered = [...history];
  const now = new Date();

  if (period === 'today') {
    const todayStr = now.toLocaleDateString('vi-VN').split(',')[0].trim();
    filtered = filtered.filter(h => h.timestamp && h.timestamp.includes(todayStr));
  } else if (period === 'thisweek') {
    const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    filtered = filtered.filter(h => {
      const d = parseVietTimestamp(h.timestamp);
      return d >= oneWeekAgo;
    });
  } else if (period === 'thismonth') {
    filtered = filtered.filter(h => {
      const d = parseVietTimestamp(h.timestamp);
      return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
    });
  } else if (period === 'thisyear') {
    filtered = filtered.filter(h => {
      const d = parseVietTimestamp(h.timestamp);
      return d.getFullYear() === now.getFullYear();
    });
  }

  let total = filtered.length;
  let wins = 0;
  let totalPNL = 0;
  let totalTP3 = 0;
  let vipTrades = 0, vipWins = 0;
  let goodTrades = 0, goodWins = 0;

  const dailyBreakdown = {};

  filtered.forEach(h => {
    const isWin = !!(h.hitTP1 || h.hitTP2 || h.hitTP3);
    if (isWin) wins++;

    if (h.rank === 'VIP') { vipTrades++; if (isWin) vipWins++; }
    else if (h.rank === 'GOOD') { goodTrades++; if (isWin) goodWins++; }

    totalPNL += (h.pnlPercent || 0);
    if (h.hitTP3) totalTP3++;

    if (h.timestamp) {
      const dateKey = h.timestamp.split(',')[0].trim();
      if (!dailyBreakdown[dateKey]) dailyBreakdown[dateKey] = { total: 0, wins: 0, pnl: 0 };
      dailyBreakdown[dateKey].total++;
      if (isWin) dailyBreakdown[dateKey].wins++;
      dailyBreakdown[dateKey].pnl += (h.pnlPercent || 0);
    }
  });

  return {
    period,
    total,
    wins,
    losses: total - wins,
    winRate: total ? ((wins / total) * 100).toFixed(1) : '0',
    vipTrades,
    vipWinRate: vipTrades ? ((vipWins / vipTrades) * 100).toFixed(1) : '0',
    goodTrades,
    goodWinRate: goodTrades ? ((goodWins / goodTrades) * 100).toFixed(1) : '0',
    avgPNL: total ? (totalPNL / total).toFixed(2) : '0',
    tp3Rate: total ? ((totalTP3 / total) * 100).toFixed(1) : '0',
    dailyBreakdown: Object.entries(dailyBreakdown)
      .sort((a, b) => new Date(b[0].split('/').reverse().join('-')) - new Date(a[0].split('/').reverse().join('-')))
      .slice(0, 14)
      .map(([date, data]) => ({
        date,
        ...data,
        winRate: data.total ? ((data.wins / data.total) * 100).toFixed(1) : '0'
      }))
  };
}

app.get('/api/stats', (req, res) => {
  try {
    const period = req.query.period || 'all';
    res.json(calculateStats(signalHistory, period));
  } catch (err) {
    res.json({ total: 0, winRate: 0 });
  }
});

// ================= AUTO SCAN =================
async function autoScan(timeframe) {
  console.log(`[AUTO] 🚀 ========== BẮT ĐẦU QUÉT ${timeframe.toUpperCase()} ==========`);

  currentScanning = { timeframe, scanned: 0, total: 541 };
  lastScanTime = new Date().toLocaleString('vi-VN');
  lastScanTF = timeframe;

  const batchSize = 25;
  let start = 0;
  let totalProcessed = 0;

  try {
    while (true) {
      console.log(`[AUTO] ${timeframe} → Batch ${Math.floor(start/batchSize)+1}`);

      const res = await axios.get(`http://localhost:${PORT}/api/scan?timeframe=${timeframe}&start=${start}&batch=${batchSize}`);
      const data = res.data;

      totalProcessed += (data.scanned || batchSize);
      currentScanning.scanned = Math.min(totalProcessed, 541);

      latestObserve = [...latestObserve, ...(data.observe || [])].slice(-150);
      latestBreakout = [...latestBreakout, ...(data.breakout || [])].slice(-80);
      latestSignals = [...latestSignals, ...(data.newSignals || [])].slice(-50);

      if (data.isComplete || totalProcessed >= 540) {
        console.log(`[AUTO] ✅ HOÀN TẤT QUÉT ${timeframe.toUpperCase()}!`);
        break;
      }
      start += batchSize;
      await new Promise(r => setTimeout(r, 600));
    }

    let msg = `📊 <b>AUTO SCAN ${timeframe.toUpperCase()} HOÀN TẤT</b>\n\n`;
    if (latestObserve.length > 0) msg += `📋 Quan sát: ${latestObserve.length} coin\n`;
    if (latestBreakout.length > 0) msg += `🔥 Breakout: ${latestBreakout.length} coin\n`;
    await sendTelegram(msg);

  } catch (err) {
    console.log(`[AUTO] ❌ LỖI ${timeframe}:`, err.message);
  } finally {
    currentScanning = null;
  }
}

async function dailyD1Scan() {
  const now = new Date();
  if (now.getHours() === 6 && now.getMinutes() < 15) {
    console.log("[AUTO D1] 🕕 Bắt đầu quét D1 lúc 6h sáng...");
    await autoScan('1d');
  }
}

function startAutoScan() {
  console.log("⏰ AUTO SCAN ĐÃ BẬT - SINGLE PORT MODE");

  setTimeout(() => autoScan('5m'), 10000);

  setInterval(() => {
    autoScan('5m');
    setTimeout(() => autoScan('15m'), 40000);
    setTimeout(() => autoScan('1h'), 80000);
  }, 120 * 60 * 1000);

  setInterval(dailyD1Scan, 300000);
}

// ================= START SERVER =================
app.listen(PORT, () => {
  console.log(`🚀 SERVER ĐÃ GỘP - Chạy tại port ${PORT}`);
  startAutoScan();
});
