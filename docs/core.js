'use strict';
/* ===== APEX Ensemble core: 8 engines + shared risk overlay =====
   Pure functions, no IO. Used by scanner/run.js (Node) AND docs/index.html
   (browser, for the 60-day signal preview) so both always agree on the rules.

   Engines (validated in the walk-forward study; long + short):
     dual_momentum     12h  trend   EMA21>EMA55 + close>SMA100 + ROC40>0 (and mirrored)
     golden_cross       1d  trend   SMA50>SMA200 + close>SMA50 (and mirrored)
     rsi_dip            4h  rever   RSI14 crosses <32 while close>SMA200, long only
     btc_breakout_follow 1d trend   BTC 1d Donchian(25) regime leads; BTC/ETH/SOL/BNB follow
     ao_zero_cross      1d  momentum AO(5,34) zero-line cross
     triple_screen     12h  Elder   1d-scale EMA42 bias + stoch pullback + breakout trigger
     band_walk          1d  momentum close beyond BB(20,2) with expanding bandwidth + trend filter
     supertrend_flip    1d  trend    Supertrend(10,3) direction + SMA100 filter; ST line is the stop

   Shared overlay: 0.6% equity risk per trade (size = risk / stop distance),
   chandelier ATR trailing stops, one net position per symbol across engines,
   shared caps (max open, per-engine slots, notional/gross caps),
   UTC daily loss limits (soft -3% = no new entries, hard -5% = flatten + halt),
   12h cooldown per symbol after a stop-out. Costs: taker fee + spread + impact
   per side (perp cost model; signals computed on spot bars). */

(function (root, factory) {
  const APEX = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = APEX;
  else root.APEX = APEX;
})(typeof self !== 'undefined' ? self : this, function () {

  const HOUR = 3600000, DAY = 86400000;
  const TF_MS = { '4h': 4 * HOUR, '12h': 12 * HOUR, '1d': DAY };

  const DEFAULT_CONFIG = {
    startEquity: 1000,
    riskPct: 0.6,              // % of equity risked per trade (stop distance based)
    feeBpsSide: 5,             // USD-M perp taker fee per side
    spreadBpsSide: 2,          // half-spread paid on a taker fill (majors)
    impactBpsSide: 2,          // small-order market impact, conservative
    fundingBpsPer8h: 0,        // optional conservative funding drag while holding (0 = off)
    maxOpen: 8,                // shared cap: total open positions
    perEngineMax: 3,           // shared cap: slots per engine
    maxNotionalPct: 30,        // cap: single position notional as % of equity
    grossCapX: 2.0,            // cap: gross notional as multiple of equity
    daySoftLossPct: -3,        // UTC day loss that blocks NEW entries
    dayHardLossPct: -5,        // UTC day loss that flattens everything + halts for the day
    cooldownH: 12,             // hours a symbol is frozen after a stop-out
    minNotionalUsd: 5,         // skip entries smaller than this
    telegram: true             // send ENTER/EXIT/HALT alerts if secrets exist
  };

  /* ---------------- indicators (NaN-safe, chronological arrays) ---------------- */

  function sma(a, n) {
    const out = new Array(a.length).fill(NaN);
    let s = 0, cnt = 0;
    for (let i = 0; i < a.length; i++) {
      if (Number.isFinite(a[i])) { s += a[i]; cnt++; }
      if (i >= n && Number.isFinite(a[i - n])) { s -= a[i - n]; cnt--; }
      if (cnt === n) out[i] = s / n;
    }
    return out;
  }

  function ema(a, n) {
    const out = new Array(a.length).fill(NaN);
    const k = 2 / (n + 1);
    let e = NaN, started = false, s = 0;
    for (let i = 0; i < a.length; i++) {
      if (!started) {
        if (Number.isFinite(a[i])) { s += a[i]; if (i >= n - 1) { e = s / n; started = true; out[i] = e; } }
      } else if (Number.isFinite(a[i])) { e = a[i] * k + e * (1 - k); out[i] = e; }
    }
    return out;
  }

  function rsiW(c, n) { // Wilder RSI
    const out = new Array(c.length).fill(NaN);
    let g = 0, l = 0, started = false;
    for (let i = 1; i < c.length; i++) {
      const d = c[i] - c[i - 1], up = Math.max(d, 0), dn = Math.max(-d, 0);
      if (!started) {
        g += up; l += dn;
        if (i === n) { g /= n; l /= n; started = true; out[i] = 100 - 100 / (1 + (l === 0 ? 1e9 : g / l)); }
      } else {
        g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n;
        out[i] = 100 - 100 / (1 + (l === 0 ? 1e9 : g / l));
      }
    }
    return out;
  }

  function atrW(b, n) { // Wilder ATR(14) on {t,h,l,c}; gap-inclusive true range
    const len = b.c.length, out = new Array(len).fill(NaN);
    let a = NaN, started = false, s = 0;
    for (let i = 0; i < len; i++) {
      const tr = i === 0 ? b.h[0] - b.l[0]
        : Math.max(b.h[i] - b.l[i], Math.abs(b.h[i] - b.c[i - 1]), Math.abs(b.l[i] - b.c[i - 1]));
      if (!started) { s += tr; if (i === n - 1) { a = s / n; started = true; out[i] = a; } }
      else { a = (a * (n - 1) + tr) / n; out[i] = a; }
    }
    return out;
  }

  function stochSlowK(b, n, smooth) { // raw %K(n) then SMA(smooth) = slow %K
    const len = b.c.length, raw = new Array(len).fill(NaN);
    for (let i = n - 1; i < len; i++) {
      let hh = -Infinity, ll = Infinity;
      for (let j = i - n + 1; j <= i; j++) { if (b.h[j] > hh) hh = b.h[j]; if (b.l[j] < ll) ll = b.l[j]; }
      raw[i] = hh === ll ? 50 : (b.c[i] - ll) / (hh - ll) * 100;
    }
    return sma(raw, smooth);
  }

  function bollinger(c, n, mult) {
    const len = c.length, mid = sma(c, n), up = new Array(len).fill(NaN), lo = new Array(len).fill(NaN), bw = new Array(len).fill(NaN);
    for (let i = n - 1; i < len; i++) {
      if (!Number.isFinite(mid[i])) continue;
      let s = 0;
      for (let j = i - n + 1; j <= i; j++) s += (c[j] - mid[i]) * (c[j] - mid[i]);
      const sd = Math.sqrt(s / n);
      up[i] = mid[i] + mult * sd; lo[i] = mid[i] - mult * sd;
      bw[i] = (up[i] - lo[i]) / mid[i];
    }
    return { mid, up, lo, bw };
  }

  function supertrend(b, n, mult) { // returns {line[], dir[]}: dir +1 bullish (line = support), -1 bearish
    const len = b.c.length, a = atrW(b, n);
    const line = new Array(len).fill(NaN), dir = new Array(len).fill(0);
    let fu = NaN, fl = NaN, d = 1, started = false;
    for (let i = 0; i < len; i++) {
      if (!Number.isFinite(a[i])) continue;
      const hl2 = (b.h[i] + b.l[i]) / 2;
      const bu = hl2 + mult * a[i], bl = hl2 - mult * a[i];
      if (!started) { fu = bu; fl = bl; d = b.c[i] >= hl2 ? 1 : -1; started = true; }
      else {
        fu = (bu < fu || b.c[i - 1] > fu) ? bu : fu;
        fl = (bl > fl || b.c[i - 1] < fl) ? bl : fl;
        d = d > 0 ? (b.c[i] < fl ? -1 : 1) : (b.c[i] > fu ? 1 : -1);
      }
      dir[i] = d; line[i] = d > 0 ? fl : fu;
    }
    return { line, dir };
  }

  function donchianRegime(b, n) { // leader regime: close breaks the prior-n-bar channel; carries forward
    const len = b.c.length, out = new Array(len).fill(null);
    let cur = null;
    for (let i = 0; i < len; i++) {
      if (i >= n) {
        let hh = -Infinity, ll = Infinity;
        for (let j = i - n; j < i; j++) { if (b.h[j] > hh) hh = b.h[j]; if (b.l[j] < ll) ll = b.l[j]; }
        if (b.c[i] > hh) cur = 'UP'; else if (b.c[i] < ll) cur = 'DOWN';
      }
      out[i] = cur;
    }
    return out;
  }

  const fin = (...xs) => xs.every(Number.isFinite);

  /* ---------------- engines ---------------- */
  /* Each engine:
       tf, symbols, stopK (chandelier multiplier), kind 'state'|'event', minBars
       prepare(bars, leaderBars?) -> ctx object of indicator arrays
       stateOf(ctx, i)  -> 'long' | 'short' | null   (persistent regime, state engines)
       eventOf(ctx, i)  -> 'long' | 'short' | null   (fires only on the trigger bar, event engines)
       exitOf(pos, ctx, i) -> reason string | null   (signal exit on the last closed bar)
     Trailing stops are generic chandeliers from stopK, except supertrend_flip
     which rides its own line. */

  const ENGINES = {

    dual_momentum: {
      id: 'dual_momentum', title: 'Dual Momentum', tf: '12h', kind: 'state', stopK: 3.0, minBars: 110,
      symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'AVAXUSDT', 'LINKUSDT'],
      desc: 'EMA21 > EMA55 and close > SMA100 and 40-bar ROC > 0 (mirrored for shorts)',
      prepare(b) {
        const c = b.c, roc = new Array(c.length).fill(NaN);
        for (let i = 40; i < c.length; i++) if (fin(c[i], c[i - 40])) roc[i] = c[i] / c[i - 40] - 1;
        return { c, ema21: ema(c, 21), ema55: ema(c, 55), sma100: sma(c, 100), roc, atr14: atrW(b, 14) };
      },
      stateOf(x, i) {
        if (!fin(x.ema21[i], x.ema55[i], x.sma100[i], x.roc[i], x.c[i])) return null;
        if (x.ema21[i] > x.ema55[i] && x.c[i] > x.sma100[i] && x.roc[i] > 0) return 'long';
        if (x.ema21[i] < x.ema55[i] && x.c[i] < x.sma100[i] && x.roc[i] < 0) return 'short';
        return null;
      },
      exitOf(p, x, i) {
        if (!fin(x.ema21[i], x.ema55[i], x.c[i])) return null;
        const s = this.stateOf(x, i);
        return s === p.side ? null : 'SIGNAL';
      }
    },

    golden_cross: {
      id: 'golden_cross', title: 'Golden Cross', tf: '1d', kind: 'state', stopK: 3.5, minBars: 215,
      symbols: ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT'],
      desc: 'SMA50 > SMA200 and close > SMA50 (death-cross side mirrored); the close<SMA50 leg is the drawdown cut',
      prepare(b) {
        const c = b.c;
        return { c, sma50: sma(c, 50), sma200: sma(c, 200), atr14: atrW(b, 14) };
      },
      stateOf(x, i) {
        if (!fin(x.sma50[i], x.sma200[i], x.c[i])) return null;
        if (x.sma50[i] > x.sma200[i] && x.c[i] > x.sma50[i]) return 'long';
        if (x.sma50[i] < x.sma200[i] && x.c[i] < x.sma50[i]) return 'short';
        return null;
      },
      exitOf(p, x, i) {
        if (!fin(x.sma50[i], x.sma200[i], x.c[i])) return null;
        const s = this.stateOf(x, i);
        return s === p.side ? null : 'SIGNAL';
      }
    },

    rsi_dip: {
      id: 'rsi_dip', title: 'RSI Dip', tf: '4h', kind: 'event', stopK: 1.8, targetK: 2.0, timeStopBars: 42, minBars: 215,
      symbols: ['SOLUSDT', 'DOGEUSDT', 'AVAXUSDT', 'LINKUSDT', 'ADAUSDT', 'ATOMUSDT'],
      desc: 'LONG ONLY: RSI14 crosses below 32 while price is above the 4h SMA200 trend filter',
      prepare(b) {
        const c = b.c;
        return { c, rsi: rsiW(c, 14), sma200: sma(c, 200), atr14: atrW(b, 14) };
      },
      stateOf() { return null; },
      eventOf(x, i) {
        if (i < 1 || !fin(x.rsi[i], x.rsi[i - 1], x.sma200[i], x.c[i])) return null;
        if (x.rsi[i] < 32 && x.rsi[i - 1] >= 32 && x.c[i] > x.sma200[i]) return 'long';
        return null;
      },
      exitOf(p, x, i) {
        if (fin(x.rsi[i]) && x.rsi[i] > 55) return 'RSI 55';
        return null;
      }
    },

    btc_breakout_follow: {
      id: 'btc_breakout_follow', title: 'BTC Breakout Follow', tf: '1d', kind: 'state', stopK: 2.8, minBars: 30,
      leader: 'BTCUSDT', leaderNeed: 30, leaderChannel: 25,
      symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT'],
      desc: 'BTC 1d close breaks its 25-day Donchian channel -> regime UP/DOWN; the whole list trades in that direction',
      prepare(b, L) {
        const reg = donchianRegime(L, this.leaderChannel);
        const byTime = {};
        for (let i = 0; i < L.t.length; i++) byTime[L.t[i]] = reg[i];
        return { c: b.c, regime: b.t.map(t => byTime[t] || null), atr14: atrW(b, 14) };
      },
      stateOf(x, i) { return x.regime[i] === 'UP' ? 'long' : x.regime[i] === 'DOWN' ? 'short' : null; },
      exitOf(p, x, i) {
        const s = this.stateOf(x, i);
        if (s === null) return null;           // leader data missing: hold, do not force-exit
        return s === p.side ? null : 'BTC FLIP';
      }
    },

    ao_zero_cross: {
      id: 'ao_zero_cross', title: 'AO Zero Cross', tf: '1d', kind: 'event', stopK: 2.5, minBars: 45,
      symbols: ['BTCUSDT', 'ETHUSDT', 'XRPUSDT', 'LTCUSDT', 'DOTUSDT'],
      desc: 'Awesome Oscillator SMA(hl2,5) - SMA(hl2,34) crosses the zero line',
      prepare(b) {
        const hl2 = b.h.map((h, i) => (h + b.l[i]) / 2);
        const ao = new Array(b.c.length).fill(NaN);
        const f = sma(hl2, 5), s = sma(hl2, 34);
        for (let i = 0; i < ao.length; i++) if (fin(f[i], s[i])) ao[i] = f[i] - s[i];
        return { c: b.c, ao, atr14: atrW(b, 14) };
      },
      stateOf() { return null; },
      eventOf(x, i) {
        if (i < 1 || !fin(x.ao[i], x.ao[i - 1])) return null;
        if (x.ao[i] >= 0 && x.ao[i - 1] < 0) return 'long';
        if (x.ao[i] <= 0 && x.ao[i - 1] > 0) return 'short';
        return null;
      },
      exitOf(p, x, i) {
        if (!fin(x.ao[i])) return null;
        if (p.side === 'long' && x.ao[i] < 0) return 'AO FLIP';
        if (p.side === 'short' && x.ao[i] > 0) return 'AO FLIP';
        return null;
      }
    },

    triple_screen: {
      id: 'triple_screen', title: 'Triple Screen', tf: '12h', kind: 'event', stopK: 2.2, minBars: 60,
      symbols: ['SOLUSDT', 'AVAXUSDT', 'LINKUSDT', 'DOGEUSDT', 'NEARUSDT'],
      desc: 'Elder: EMA42 trend bias + slow stoch(14,3) pullback (<35 turning up / >65 turning down) + break of prior bar high/low',
      prepare(b) {
        const c = b.c;
        return { c, h: b.h, l: b.l, ema42: ema(c, 42), k: stochSlowK(b, 14, 3), atr14: atrW(b, 14) };
      },
      biasOf(x, i) {
        if (!fin(x.ema42[i], x.c[i])) return null;
        return x.c[i] > x.ema42[i] ? 'long' : 'short';
      },
      stateOf() { return null; },
      eventOf(x, i) {
        if (i < 1 || !fin(x.k[i], x.k[i - 1], x.ema42[i], x.c[i], x.h[i - 1], x.l[i - 1])) return null;
        const bias = this.biasOf(x, i);
        if (bias === 'long' && x.k[i] < 35 && x.k[i] > x.k[i - 1] && x.c[i] > x.h[i - 1]) return 'long';
        if (bias === 'short' && x.k[i] > 65 && x.k[i] < x.k[i - 1] && x.c[i] < x.l[i - 1]) return 'short';
        return null;
      },
      exitOf(p, x, i) {
        const bias = this.biasOf(x, i);
        if (bias === null) return null;
        return bias === p.side ? null : 'BIAS FLIP';
      }
    },

    band_walk: {
      id: 'band_walk', title: 'Band Walk', tf: '1d', kind: 'event', stopK: 2.5, minBars: 60,
      symbols: ['BTCUSDT', 'SOLUSDT', 'DOGEUSDT', 'AVAXUSDT', 'LINKUSDT'],
      desc: 'Close beyond BB(20,2) with expanding bandwidth in the direction of SMA50; exit back through the mid-band',
      prepare(b) {
        const c = b.c, bb = bollinger(c, 20, 2);
        return { c, bbUp: bb.up, bbLo: bb.lo, bbMid: bb.mid, bw: bb.bw, sma50: sma(c, 50), atr14: atrW(b, 14) };
      },
      stateOf() { return null; },
      eventOf(x, i) {
        if (i < 1 || !fin(x.c[i], x.bbUp[i], x.bbLo[i], x.bw[i], x.bw[i - 1], x.sma50[i])) return null;
        if (x.bw[i] <= x.bw[i - 1]) return null;
        if (x.c[i] > x.bbUp[i] && x.c[i] > x.sma50[i]) return 'long';
        if (x.c[i] < x.bbLo[i] && x.c[i] < x.sma50[i]) return 'short';
        return null;
      },
      exitOf(p, x, i) {
        if (!fin(x.c[i], x.bbMid[i])) return null;
        if (p.side === 'long' && x.c[i] < x.bbMid[i]) return 'MIDBAND';
        if (p.side === 'short' && x.c[i] > x.bbMid[i]) return 'MIDBAND';
        return null;
      }
    },

    supertrend_flip: {
      id: 'supertrend_flip', title: 'Supertrend Flip', tf: '1d', kind: 'state', stopK: 0, minBars: 115,
      symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT'],
      desc: 'Supertrend(10, 3.0) direction with SMA100 filter; the supertrend line itself is the trailing stop',
      prepare(b) {
        const c = b.c, st = supertrend(b, 10, 3);
        return { c, stLine: st.line, stDir: st.dir, sma100: sma(c, 100), atr14: atrW(b, 14) };
      },
      stateOf(x, i) {
        if (!fin(x.stDir[i], x.sma100[i], x.c[i]) || x.stDir[i] === 0) return null;
        if (x.stDir[i] > 0 && x.c[i] > x.sma100[i]) return 'long';
        if (x.stDir[i] < 0 && x.c[i] < x.sma100[i]) return 'short';
        return null;
      },
      exitOf(p, x, i) {
        if (!fin(x.stDir[i], x.sma100[i], x.c[i])) return null;
        const s = this.stateOf(x, i);
        return s === p.side ? null : 'ST FLIP';
      }
    }
  };

  const ENGINE_ORDER = ['dual_momentum', 'golden_cross', 'rsi_dip', 'btc_breakout_follow',
    'ao_zero_cross', 'triple_screen', 'band_walk', 'supertrend_flip'];

  /* ---------------- trailing stop + target management ---------------- */

  function updateTrail(eng, pos, ctx, i, livePx) {
    // Chandelier from the best price since entry; supertrend rides its own line.
    const px = Number.isFinite(livePx) ? livePx : pos.lastPx || pos.entryPx;
    pos.lastPx = px;
    if (pos.side === 'long') {
      pos.bestPx = Math.max(pos.bestPx || pos.entryPx, ctx.c[i] || 0, px);
      let stop;
      if (eng.id === 'supertrend_flip' && Number.isFinite(ctx.stLine[i])) stop = ctx.stLine[i];
      else stop = pos.bestPx - eng.stopK * pos.atrEntry;
      pos.stopPx = Math.max(pos.stopPx, stop);          // ratchet only
      pos.riskNowPct = (px - pos.stopPx) / px * 100;
    } else {
      pos.bestPx = Math.min(pos.bestPx || pos.entryPx, ctx.c[i] || Infinity, px);
      let stop;
      if (eng.id === 'supertrend_flip' && Number.isFinite(ctx.stLine[i])) stop = ctx.stLine[i];
      else stop = pos.bestPx + eng.stopK * pos.atrEntry;
      pos.stopPx = Math.min(pos.stopPx, stop);
      pos.riskNowPct = (pos.stopPx - px) / px * 100;
    }
  }

  function initialStop(eng, ctx, i, side, entryPx) {
    // Stop distance used for sizing AND the initial stop price.
    const atrNow = ctx.atr14[i];
    if (eng.id === 'supertrend_flip' && Number.isFinite(ctx.stLine[i])) {
      const d = side === 'long' ? entryPx - ctx.stLine[i] : ctx.stLine[i] - entryPx;
      return { stopPx: ctx.stLine[i], stopDist: Math.max(d, entryPx * 0.005), atrEntry: Number.isFinite(atrNow) ? atrNow : d };
    }
    const dist = eng.stopK * atrNow;
    return { stopPx: side === 'long' ? entryPx - dist : entryPx + dist, stopDist: dist, atrEntry: atrNow };
  }

  function targetFor(eng, side, entryPx, atrEntry) {
    if (!eng.targetK) return null;
    return side === 'long' ? entryPx + eng.targetK * atrEntry : entryPx - eng.targetK * atrEntry;
  }

  /* ---------------- position sizing (shared overlay) ---------------- */

  function planEntry(o) {
    // o: {equity, cash, grossNow, riskPct, maxNotionalPct, grossCapX, entryPx, stopDist,
    //     feeRateSide, minNotionalUsd}
    const riskUsd = o.equity * o.riskPct / 100;
    if (!(o.stopDist > 0)) return { ok: false, reason: 'BAD_STOP' };
    const stopPct = o.stopDist / o.entryPx;
    if (stopPct < 0.004 || stopPct > 0.6) return { ok: false, reason: 'STOP_RANGE' };
    let qty = riskUsd / o.stopDist;
    let notional = qty * o.entryPx;
    if (notional < o.minNotionalUsd) return { ok: false, reason: 'MIN_ORDER', notional };
    const capNotional = o.equity * o.maxNotionalPct / 100;
    const capGross = Math.max(0, o.equity * o.grossCapX - o.grossNow);
    const capCash = Math.max(0, o.cash / (1 + o.feeRateSide));
    const cap = Math.min(capNotional, capGross, capCash);
    if (notional > cap) {
      if (cap < o.minNotionalUsd) return { ok: false, reason: 'NO_CASH', notional: cap };
      if (cap < 0.2 * notional) return { ok: false, reason: 'CAP_SHRINK', notional: cap };
      notional = cap; qty = notional / o.entryPx;
    }
    return { ok: true, qty: Math.floor(qty * 1e6) / 1e6, notional, riskUsd: Math.min(riskUsd, qty * o.stopDist) };
  }

  /* ---------------- bar helpers ---------------- */

  function closedBars(b, tfMs, nowMs) {
    // keep only fully closed bars (t = open time)
    let n = 0;
    for (let i = b.t.length - 1; i >= 0; i--) { if (b.t[i] + tfMs <= nowMs) { n = i + 1; break; } }
    return {
      t: b.t.slice(0, n), h: b.h.slice(0, n), l: b.l.slice(0, n),
      c: b.c.slice(0, n), q: b.q.slice(0, n)
    };
  }

  /* ---------------- 60-day preview (browser + tests) ---------------- */

  function previewEngine(eng, bars, leaderBars, lookbackMs) {
    const ctx = eng.prepare(bars, leaderBars);
    const n = bars.c.length;
    const flips = [];
    let cur = null, since = null;
    const from = n - 1 - Math.ceil(lookbackMs / TF_MS[eng.tf]);
    for (let i = Math.max(1, from); i < n; i++) {
      const s = eng.kind === 'state' ? eng.stateOf(ctx, i) : eng.eventOf(ctx, i);
      if (eng.kind === 'event') {
        if (s) flips.push({ t: bars.t[i], side: s });
      } else if (s !== cur) {
        if (s || cur) flips.push({ t: bars.t[i], side: s, from: cur });
        cur = s; since = bars.t[i];
      }
    }
    const last = flips.length ? flips[flips.length - 1] : null;
    return {
      engine: eng.id, tf: eng.tf, kind: eng.kind,
      state: eng.kind === 'state' ? cur : null,
      since: eng.kind === 'state' ? since : null,
      lastEvent: last, nEvents: flips.length,
      recentEvents: flips.slice(-8),
      ok: n >= eng.minBars && (leaderBars ? leaderBars.c.length >= (eng.leaderNeed || 0) : true)
    };
  }

  return {
    HOUR, DAY, TF_MS, DEFAULT_CONFIG, ENGINES, ENGINE_ORDER,
    sma, ema, rsiW, atrW, stochSlowK, bollinger, supertrend, donchianRegime,
    updateTrail, initialStop, targetFor, planEntry, closedBars, previewEngine
  };
});
