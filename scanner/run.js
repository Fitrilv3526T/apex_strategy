'use strict';
/* APEX Ensemble autopilot: GitHub Actions runs this every 5 minutes. No server,
   no API keys, paper trading only. Fetches public Binance data (data-api.binance.vision
   - the geo-safe mirror that works from GitHub runners and browsers), runs the
   8 engines under one shared risk overlay, maintains the paper account and writes
   docs/data/state.json (+ CSVs). The workflow commits changes.

   Honest-by-design: signals are evaluated on CLOSED bars only; fills happen at
   the live price the scanner actually sees (within ~5 min of the event), with
   taker fee + spread + impact charged per side. If the runner is late, you see
   the late fill in the log - the paper account measures what you would have
   experienced, not a perfect-world backtest. */

const fs = require('fs'), path = require('path');
const APEX = require('./core.js');
const { HOUR, DAY, TF_MS, DEFAULT_CONFIG, ENGINES, ENGINE_ORDER } = APEX;

const ROOT = path.join(__dirname, '..'), DATA = path.join(ROOT, 'docs', 'data');
const CFG_PATH = path.join(ROOT, 'config.json');
const API = 'https://data-api.binance.vision';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function jget(url, tries = 4) {
  for (let t = 0; t < tries; t++) {
    try {
      const r = await fetch(url);
      if (r.status === 429 || r.status === 418) { await sleep(2500 * (t + 1)); continue; }
      if (!r.ok) { const e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
      return await r.json();
    } catch (e) { if (t === tries - 1) throw e; await sleep(700 * (t + 1)); }
  }
}
async function pool(items, limit, fn) {
  let i = 0; const out = new Array(items.length);
  await Promise.all(Array.from({ length: limit }, async () => {
    while (i < items.length) { const k = i++; try { out[k] = await fn(items[k], k); } catch (e) { out[k] = null; } }
  }));
  return out;
}
const klines = (s, tf, n) => jget(`${API}/api/v3/klines?symbol=${s}&interval=${tf}&limit=${n}`).then(rows => {
  const b = { t: [], h: [], l: [], c: [], q: [] };
  for (const r of rows) { b.t.push(r[0]); b.h.push(+r[2]); b.l.push(+r[3]); b.c.push(+r[4]); b.q.push(+r[7]); }
  return b;
});
const csvEsc = (x) => /[",\n]/.test(String(x)) ? '"' + String(x).replace(/"/g, '""') + '"' : x;
const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/* ---------------- config ---------------- */
function loadConfig() {
  let user = {};
  try { user = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')); } catch (e) { log('config.json unreadable, using defaults:', e.message); }
  const cfg = Object.assign({}, DEFAULT_CONFIG, user);
  cfg.engines = {};
  const userEng = (user && user.engines) || {};
  for (const id of ENGINE_ORDER) {
    const base = ENGINES[id];
    const over = userEng[id] || {};
    cfg.engines[id] = {
      enabled: over.enabled !== false,
      symbols: Array.isArray(over.symbols) && over.symbols.length ? over.symbols : base.symbols.slice(),
      maxPos: Number.isFinite(over.maxPos) ? over.maxPos : 3
    };
  }
  return cfg;
}

/* ---------------- account helpers ---------------- */
function newPos(cfg, eng, sym, side, fill, plan, ctx, i, now) {
  const st = APEX.initialStop(eng, ctx, i, side, fill.price);
  return {
    id: `${eng.id}-${sym}-${now}`, eng: eng.id, sym, side,
    qty: plan.qty, entryPx: fill.price, entryNotional: +plan.notional.toFixed(6),
    entryFee: +fill.fee.toFixed(6), entryMs: now,
    stopPx: +st.stopPx.toFixed(8), atrEntry: +st.atrEntry.toFixed(8),
    bestPx: fill.price, targetPx: APEX.targetFor(eng, side, fill.price, st.atrEntry),
    exitDueMs: eng.timeStopBars ? now + eng.timeStopBars * TF_MS[eng.tf] : null,
    riskUsd: +plan.riskUsd.toFixed(4), lastPx: fill.price, lastFundingMs: now
  };
}
function closePos(S, p, fillPx, feeOut, reason, now) {
  const realized = p.side === 'long' ? p.qty * (fillPx - p.entryPx) : p.qty * (p.entryPx - fillPx);
  const pnl = realized - p.entryFee - feeOut;
  S.cash += p.entryNotional + realized - feeOut;
  const holdH = +((now - p.entryMs) / HOUR).toFixed(2);
  S.closed.push({
    id: p.id, eng: p.eng, sym: p.sym, side: p.side, qty: p.qty,
    entryPx: p.entryPx, exitPx: +fillPx.toFixed(8), entryMs: p.entryMs, exitMs: now, holdH,
    entryNotional: p.entryNotional, pnlUsd: +pnl.toFixed(4),
    pnlPct: +(pnl / p.entryNotional * 100).toFixed(3), riskUsd: p.riskUsd,
    rMultiple: p.riskUsd > 0 ? +(pnl / p.riskUsd).toFixed(2) : null,
    exitReason: reason
  });
  const es = S.engines[p.eng] = S.engines[p.eng] || { trades: 0, wins: 0, pnl: 0, grossWin: 0, grossLoss: 0, lastSigMs: 0 };
  es.trades++; es.pnl = +(es.pnl + pnl).toFixed(4);
  if (pnl >= 0) { es.wins++; es.grossWin = +(es.grossWin + pnl).toFixed(4); } else es.grossLoss = +(es.grossLoss - pnl).toFixed(4);
  if (S.closed.length > 900) S.closed = S.closed.slice(-900);
  return pnl;
}
const unrealized = (p, px) => (p.side === 'long' ? p.qty * (px - p.entryPx) : p.qty * (p.entryPx - px));
const markValue = (p, px) => p.entryNotional + unrealized(p, px);   // parked margin + uPnL
const equityOf = (S, live) => S.cash + S.positions.reduce((a, p) => a + markValue(p, live[p.sym] || p.lastPx || p.entryPx), 0);
const grossOf = (S, live) => S.positions.reduce((a, p) => a + p.qty * (live[p.sym] || p.lastPx || p.entryPx), 0);

/* ---------------- telegram ---------------- */
async function telegram(lines) {
  const tok = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!tok || !chat || !lines.length) return;
  const text = 'APEX Ensemble\n' + lines.slice(0, 12).join('\n');
  try {
    const r = await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true })
    });
    if (!r.ok) log('telegram failed:', r.status);
  } catch (e) { log('telegram error:', e.message); }
}

/* ---------------- main scan ---------------- */
async function main() {
  fs.mkdirSync(DATA, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'core.js'), path.join(ROOT, 'docs', 'core.js')); // keep browser copy in sync
  const cfg = loadConfig();
  const feeRate = (cfg.feeBpsSide + cfg.spreadBpsSide + cfg.impactBpsSide) / 10000;
  const now = Date.now();

  const SP = path.join(DATA, 'state.json');
  let S = null;
  try { S = JSON.parse(fs.readFileSync(SP, 'utf8')); } catch (e) {}
  if (!S || S.v !== 2) {
    S = {
      v: 2, startMs: now, cash: cfg.startEquity, positions: [], closed: [], equity: [{ t: now, eq: cfg.startEquity }],
      log: [], engines: {}, cooldown: {}, lastEval: {}, noDataLog: {},
      dayKey: utcDay(now), dayStartEq: cfg.startEquity, softHalt: false, hardHaltUntil: 0,
      cfg: null, updatedMs: 0, lastCommitMs: 0, equityNow: cfg.startEquity
    };
    log(`new paper account: $${cfg.startEquity} start, ${cfg.riskPct}% risk per trade`);
  }
  const before = JSON.stringify([
    S.positions.map(p => [p.id, p.side, p.qty]),
    S.closed.length, S.softHalt, S.hardHaltUntil, S.dayKey,
    Object.keys(S.cooldown).length
  ]);

  /* ---------- 1. tickers (live prices + 24h volume for priority) ---------- */
  const tickers = await jget(`${API}/api/v3/ticker/24hr`);
  const live = {}, qv24 = {};
  for (const t of tickers) { live[t.symbol] = +t.lastPrice; qv24[t.symbol] = +t.quoteVolume; }

  /* ---------- 2. bar sets needed: enabled engines' symbols + open positions ---------- */
  const need = new Map(); // "sym|tf" -> {sym, tf}
  const addNeed = (sym, tf) => need.set(`${sym}|${tf}`, { sym, tf });
  for (const id of ENGINE_ORDER) {
    const ec = cfg.engines[id];
    if (!ec.enabled) continue;
    for (const sym of ec.symbols) addNeed(sym, ENGINES[id].tf);
    if (ENGINES[id].leader) addNeed(ENGINES[id].leader, ENGINES[id].tf);
  }
  for (const p of S.positions) addNeed(p.sym, ENGINES[p.eng].tf); // keep managing even if engine disabled
  log(`bars: ${need.size} symbol/timeframe sets`);
  const fetched = await pool([...need.values()], 6, x => klines(x.sym, x.tf, 300));
  const bars = {}; // "sym|tf" -> closed bars
  need.forEach((x, k) => {
    const raw = fetched[[...need.keys()].indexOf(k)];
    if (raw && raw.c.length) bars[k] = APEX.closedBars(raw, TF_MS[x.tf], now);
  });
  const getBars = (sym, tf) => bars[`${sym}|${tf}`];

  const evLines = []; // telegram events this scan
  let logTouched = false; // a meaningful (non-SKIP) log entry was added -> worth committing
  const pushLog = (eng, sym, action, note) => {
    if (action.startsWith('SKIP')) {
      // do not spam the log with the same skip every 5 minutes
      const last = S.log[0];
      if (last && last.eng === eng && last.sym === sym && last.action === action && now - last.ms < HOUR) return;
    } else logTouched = true;
    S.log.unshift({ ms: now, eng, sym, action, note: note || '' });
    if (S.log.length > 900) S.log = S.log.slice(0, 900);
  };

  /* ---------- 3. UTC day rollover + reset daily halts ---------- */
  const dk = utcDay(now);
  if (dk !== S.dayKey) {
    S.dayKey = dk;
    S.dayStartEq = +equityOf(S, live).toFixed(4);
    S.softHalt = false; S.hardHaltUntil = 0;
    pushLog('-', '-', 'DAY_ROLL', `new UTC day, baseline $${S.dayStartEq.toFixed(2)}`);
    log(`day rollover: baseline $${S.dayStartEq.toFixed(2)}`);
  }

  /* ---------- 4. funding drag (optional, conservative) ---------- */
  if (cfg.fundingBpsPer8h > 0) {
    for (const p of S.positions) {
      const cross = Math.floor(now / (8 * HOUR)) - Math.floor(p.lastFundingMs / (8 * HOUR));
      if (cross > 0) {
        const cost = p.qty * (p.lastPx || p.entryPx) * (cfg.fundingBpsPer8h / 1e4) * cross;
        S.cash -= cost; p.lastFundingMs = now;
      }
    }
  }

  /* ---------- 5. exits (stops first, then targets, time, signal) ---------- */
  const stillOpen = [];
  for (const p of S.positions) {
    const eng = ENGINES[p.eng];
    const b = getBars(p.sym, eng.tf);
    const px = live[p.sym] || p.lastPx || p.entryPx;
    if (!b || b.c.length < 2) { p.lastPx = px; stillOpen.push(p); continue; } // no data: hold
    const ctx = eng.prepare(b, eng.leader ? getBars(eng.leader, eng.tf) : undefined);
    const i = b.c.length - 1;
    APEX.updateTrail(eng, p, ctx, i, px);

    let exit = null, fillPx = px;
    if (p.side === 'long' ? px <= p.stopPx : px >= p.stopPx) {
      exit = 'STOP'; fillPx = p.side === 'long' ? Math.min(p.stopPx, px) : Math.max(p.stopPx, px);
    } else if (p.targetPx && (p.side === 'long' ? px >= p.targetPx : px <= p.targetPx)) {
      exit = 'TARGET'; fillPx = p.side === 'long' ? Math.max(p.targetPx, px) : Math.min(p.targetPx, px);
    } else if (p.exitDueMs && now >= p.exitDueMs) exit = 'TIME';
    else { const r = eng.exitOf(p, ctx, i); if (r) exit = 'SIG ' + r; }

    if (!exit) { stillOpen.push(p); continue; }
    const feeOut = p.qty * fillPx * feeRate;
    const pnl = closePos(S, p, fillPx, feeOut, exit, now);
    pushLog(p.eng, p.sym, 'EXIT', `${exit} ${p.side} @ ${fillPx.toPrecision(6)} -> ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${(pnl / p.entryNotional * 100).toFixed(2)}%)`);
    evLines.push(`${pnl >= 0 ? '🟢' : '🔴'} EXIT ${p.sym} ${p.side} ${exit} ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`);
    log(`EXIT ${p.eng} ${p.sym} ${p.side} ${exit} pnl ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`);
    if (exit === 'STOP') {
      S.cooldown[p.sym] = now + cfg.cooldownH * HOUR;
      pushLog(p.eng, p.sym, 'COOLDOWN', `${p.sym} frozen ${cfg.cooldownH}h (stop-out)`);
    }
  }
  S.positions = stillOpen;

  /* ---------- 6. daily loss overlay (soft = no new entries, hard = flatten + halt) ---------- */
  const eqNow = equityOf(S, live);
  const dayPct = (eqNow / S.dayStartEq - 1) * 100;
  if (!S.hardHaltUntil && dayPct <= cfg.dayHardLossPct) {
    for (const p of S.positions) {
      const px = live[p.sym] || p.lastPx || p.entryPx;
      const feeOut = p.qty * px * feeRate;
      const pnl = closePos(S, p, px, feeOut, 'DAY HALT', now);
      pushLog(p.eng, p.sym, 'FLATTEN', `day loss ${dayPct.toFixed(2)}% <= ${cfg.dayHardLossPct}%: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`);
      evLines.push(`🔴 HALT flatten ${p.sym} ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`);
    }
    S.positions = [];
    S.hardHaltUntil = now + DAY;
    pushLog('-', '-', 'HALT_HARD', `all flat, no entries for the rest of the UTC day (${dayPct.toFixed(2)}%)`);
    evLines.push(`⛔ HARD HALT: day ${dayPct.toFixed(2)}%`);
    log(`HARD HALT at ${dayPct.toFixed(2)}% day P&L`);
  } else if (!S.softHalt && dayPct <= cfg.daySoftLossPct) {
    S.softHalt = true;
    pushLog('-', '-', 'HALT_SOFT', `day loss ${dayPct.toFixed(2)}% <= ${cfg.daySoftLossPct}%: new entries blocked`);
    evLines.push(`⚠️ soft halt: day ${dayPct.toFixed(2)}%, no new entries`);
    log(`SOFT HALT at ${dayPct.toFixed(2)}% day P&L`);
  }
  const halted = now < S.hardHaltUntil;

  /* ---------- 7. entries (engine priority order, most liquid symbol first) ---------- */
  const feeIn = (px, notional) => notional * feeRate;
  for (const id of ENGINE_ORDER) {
    const eng = ENGINES[id], ec = cfg.engines[id];
    if (!ec.enabled) continue;
    const leaderBars = eng.leader ? getBars(eng.leader, eng.tf) : undefined;
    if (eng.leader && (!leaderBars || leaderBars.c.length < eng.leaderNeed)) continue;

    const syms = ec.symbols.slice().sort((a, b2) => (qv24[b2] || 0) - (qv24[a] || 0));
    for (const sym of syms) {
      const b = getBars(sym, eng.tf);
      if (!b || b.c.length < eng.minBars) {
        const k = `${id}|${sym}`;
        if (!S.noDataLog[k] || now - S.noDataLog[k] > 6 * HOUR) { S.noDataLog[k] = now; pushLog(id, sym, 'SKIP_NO_DATA', `need ${eng.minBars} closed ${eng.tf} bars`); }
        continue;
      }
      const ctx = eng.prepare(b, leaderBars);
      const i = b.c.length - 1;

      // candidate signal: persistent state, or trigger on the last two closed bars (late-entry window)
      let side = null, sigBarT = b.t[i];
      if (eng.kind === 'state') side = eng.stateOf(ctx, i);
      else {
        for (const j of [i, i - 1]) {
          if (j < 1) continue;
          const s = eng.eventOf(ctx, j);
          if (s && (S.lastEval[`${id}|${sym}`] || 0) < b.t[j]) { side = s; sigBarT = b.t[j]; break; }
        }
      }
      if (!side) continue;
      S.engines[id] = S.engines[id] || { trades: 0, wins: 0, pnl: 0, grossWin: 0, grossLoss: 0, lastSigMs: 0 };
      S.engines[id].lastSigMs = now;

      // shared overlay gates
      if (S.positions.some(p => p.sym === sym)) { pushLog(id, sym, 'SKIP_SYMBOL_BUSY', 'one net position per symbol across engines'); continue; }
      if (halted) { pushLog(id, sym, 'SKIP_HARD_HALT', 'daily hard halt active'); continue; }
      if (S.softHalt) { pushLog(id, sym, 'SKIP_SOFT_HALT', `day ${dayPct.toFixed(2)}% <= ${cfg.daySoftLossPct}%`); continue; }
      if (S.positions.length >= cfg.maxOpen) { pushLog(id, sym, 'SKIP_MAX_OPEN', `${S.positions.length}/${cfg.maxOpen} positions`); continue; }
      if (S.positions.filter(p => p.eng === id).length >= ec.maxPos) { pushLog(id, sym, 'SKIP_ENGINE_MAX', `${ec.maxPos} slots for ${id}`); continue; }
      const cd = S.cooldown[sym] || 0;
      if (cd > now) { pushLog(id, sym, 'SKIP_COOLDOWN', `${Math.ceil((cd - now) / HOUR)}h left after stop-out`); continue; }

      const px = live[sym];
      if (!Number.isFinite(px) || px <= 0) { pushLog(id, sym, 'SKIP_NO_PRICE'); continue; }
      const st = APEX.initialStop(eng, ctx, i, side, px);
      const plan = APEX.planEntry({
        equity: eqNow, cash: S.cash, grossNow: grossOf(S, live),
        riskPct: cfg.riskPct, maxNotionalPct: cfg.maxNotionalPct, grossCapX: cfg.grossCapX,
        entryPx: px, stopDist: st.stopDist, feeRateSide: feeRate, minNotionalUsd: cfg.minNotionalUsd
      });
      if (!plan.ok) { pushLog(id, sym, 'SKIP_' + plan.reason, plan.notional ? `sized $${plan.notional.toFixed(2)}` : ''); continue; }

      const fee = feeIn(px, plan.notional);
      S.cash -= plan.notional + fee;
      const pos = newPos(cfg, eng, sym, side, { price: px, fee }, plan, ctx, i, now);
      S.positions.push(pos);
      if (eng.kind === 'event') S.lastEval[`${id}|${sym}`] = sigBarT;
      const distPct = (st.stopDist / px * 100).toFixed(2);
      pushLog(id, sym, side === 'long' ? 'ENTER_LONG' : 'ENTER_SHORT',
        `$${plan.notional.toFixed(0)} @ ${px.toPrecision(6)}, stop ${pos.stopPx.toPrecision(6)} (-${distPct}%, risk $${plan.riskUsd.toFixed(2)})`);
      evLines.push(`🟣 ENTER ${side === 'long' ? 'LONG' : 'SHORT'} ${sym} $${plan.notional.toFixed(0)} [${id}] stop -${distPct}%`);
      log(`ENTER ${id} ${sym} ${side} $${plan.notional.toFixed(2)} @ ${px.toPrecision(6)}`);
    }
  }
  for (const k of Object.keys(S.cooldown)) if (S.cooldown[k] <= now) delete S.cooldown[k];

  /* ---------- 8. marks + equity curve ---------- */
  for (const p of S.positions) if (live[p.sym]) p.lastPx = live[p.sym];
  const eq = equityOf(S, live);
  S.equityNow = +eq.toFixed(4);
  const lastEq = S.equity[S.equity.length - 1];
  if (!lastEq || now - lastEq.t > HOUR || Math.abs(eq - lastEq.eq) > Math.max(0.05, lastEq.eq * 0.001))
    S.equity.push({ t: now, eq: +eq.toFixed(4) });
  if (S.equity.length > 4000) S.equity = [S.equity[0]].concat(S.equity.slice(S.equity.length - 3999));

  /* ---------- 9. write policy: meaningful changes or a 3h heartbeat ----------
     Marks and trailing-stop drift update the state file but do not trigger a commit;
     commits happen for trades, halts, cooldowns, day rolls and signal-log events.
     Between commits the dashboard re-marks open positions with live prices in the browser. */
  const after = JSON.stringify([
    S.positions.map(p => [p.id, p.side, p.qty]),
    S.closed.length, S.softHalt, S.hardHaltUntil, S.dayKey,
    Object.keys(S.cooldown).length
  ]);
  const changed = after !== before || logTouched;
  const heartbeat = now - (S.lastCommitMs || 0) > 3 * HOUR;
  if (changed || heartbeat || !fs.existsSync(SP)) {
    S.cfg = {
      startMs: S.startMs, startEquity: cfg.startEquity, riskPct: cfg.riskPct,
      feeBpsSide: cfg.feeBpsSide, spreadBpsSide: cfg.spreadBpsSide, impactBpsSide: cfg.impactBpsSide,
      fundingBpsPer8h: cfg.fundingBpsPer8h, maxOpen: cfg.maxOpen, perEngineMax: cfg.perEngineMax,
      maxNotionalPct: cfg.maxNotionalPct, grossCapX: cfg.grossCapX,
      daySoftLossPct: cfg.daySoftLossPct, dayHardLossPct: cfg.dayHardLossPct,
      cooldownH: cfg.cooldownH, minNotionalUsd: cfg.minNotionalUsd,
      engines: ENGINE_ORDER.map(id => ({ id, title: ENGINES[id].title, tf: ENGINES[id].tf, enabled: cfg.engines[id].enabled, symbols: cfg.engines[id].symbols, maxPos: cfg.engines[id].maxPos }))
    };
    S.lastCommitMs = now;      // set BEFORE serializing, or the written state keeps the stale value
    S.updatedMs = now;
    fs.writeFileSync(SP, JSON.stringify(S));
    fs.writeFileSync(path.join(DATA, 'trades.csv'),
      'exit_utc,entry_utc,engine,coin,side,qty,entry,exit,hold_h,notional_usd,pnl_usd,pnl_pct,r_multiple,exit_reason\n' +
      S.closed.map(t => [new Date(t.exitMs).toISOString().replace('T', ' ').slice(0, 16), new Date(t.entryMs).toISOString().replace('T', ' ').slice(0, 16),
        t.eng, t.sym, t.side, t.qty, t.entryPx, t.exitPx, t.holdH, t.entryNotional, t.pnlUsd, t.pnlPct, t.rMultiple, t.exitReason].map(csvEsc).join(',')).join('\n') + '\n');
    fs.writeFileSync(path.join(DATA, 'signals.csv'),
      'time_utc,engine,coin,action,note\n' +
      S.log.slice(0, 400).map(l => [new Date(l.ms).toISOString().replace('T', ' ').slice(0, 16), l.eng, l.sym, l.action, csvEsc(l.note || '')].join(',')).join('\n') + '\n');
    log(`state written: equity $${eq.toFixed(2)} (${changed ? 'changed' : 'heartbeat'}), ${S.positions.length} open, ${S.closed.length} closed, day ${dayPct.toFixed(2)}%`);
  } else {
    log(`no change (equity $${eq.toFixed(2)}, day ${dayPct.toFixed(2)}%), state not rewritten`);
  }

  if (cfg.telegram) await telegram(evLines);
}

main().catch(e => { console.error('FAILED:', e); process.exit(1); });
