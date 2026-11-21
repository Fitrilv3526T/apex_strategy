# APEX Ensemble paper trader

The 8 deploy-grade engines from the winning ensemble, running together on GitHub every
5 minutes under one shared risk overlay. No server, no API keys, no browser needed.
Paper trading only - it never places real orders - until you have funds for the live bot.

**The 8 engines** (long + short, each with its own timeframe):

| Engine | TF | Style | Rule |
|---|---|---|---|
| dual_momentum | 12h | trend | EMA21 > EMA55 and close > SMA100 and 40-bar ROC > 0 (mirrored short) |
| golden_cross | 1d | trend | SMA50 > SMA200 and close > SMA50 (mirrored short) |
| rsi_dip | 4h | mean-reversion | LONG only: RSI14 crosses under 32 while close > SMA200 |
| btc_breakout_follow | 1d | regime | BTC 1d close breaks its 25-day Donchian channel -> BTC/ETH/SOL/BNB all trade that direction |
| ao_zero_cross | 1d | momentum | Awesome Oscillator (5/34) crosses the zero line |
| triple_screen | 12h | Elder | EMA42 trend bias + slow-stoch pullback + break of prior bar high/low |
| band_walk | 1d | momentum | Close beyond Bollinger(20,2) with expanding bandwidth + SMA50 trend filter |
| supertrend_flip | 1d | trend | Supertrend(10, 3.0) direction with SMA100 filter; the ST line is the stop |

**The shared risk overlay** (one position per symbol across engines, all caps shared):

- **0.6% equity risk per trade** - size = risk / stop distance, so every engine risks
  the same fraction no matter how wide its stop is
- **Trailing stops**: chandelier ATR stops per engine (1.8x to 3.5x), supertrend rides
  its own line; stops ratchet, never loosen
- **Caps**: max 8 open positions total, 3 per engine, 30% of equity per position,
  2x equity gross exposure
- **Daily loss limits (UTC)**: -3% blocks new entries, -5% flattens everything and
  halts for the rest of the day
- **Cooldown**: a symbol that stop-outs is frozen 12h for all engines
- **Costs**: 5 bps taker fee + 2 bps spread + 2 bps impact per side (18 bps round
  trip) - the perp cost model, charged on every paper fill

## Set up (about 10 minutes, once)

1. On github.com click **New repository**. Name it `apex` (or anything), choose
   **Public**, click Create.
2. Click **uploading an existing file** and drag in everything from this folder
   (`.github`, `docs`, `scanner`, `config.json`, `README.md`), then **Commit changes**.
   - If the hidden `.github` folder does not upload: click **Add file > Create new
     file**, type `.github/workflows/apex.yml` as the name and paste that file's content.
3. **Settings > Pages**: Source = *Deploy from a branch*, Branch = `main`,
   folder = `/docs`, Save. Your page address appears after a minute or two.
4. **Actions** tab: if GitHub asks, click *I understand my workflows, enable them*.
   Open **APEX scan** and click **Run workflow**. The first run takes 1-2 minutes and
   creates `docs/data/state.json` (the first commit by the bot).
5. Open your Pages address. Bookmark it. That is all - it updates by itself.

The 60-day signal preview on the dashboard works even before the first scan: the page
pulls Binance data directly in your browser and runs the same engine code locally.

## Settings

Edit `config.json` on GitHub (pencil icon). The next scan picks it up.

| key | default | meaning |
|---|---|---|
| `startEquity` | 1000 | starting cash of the paper account |
| `riskPct` | 0.6 | % of equity risked per trade (stop-distance sizing) |
| `feeBpsSide` | 5 | taker fee per side, basis points |
| `spreadBpsSide` | 2 | half-spread paid per fill |
| `impactBpsSide` | 2 | market impact per fill (conservative) |
| `fundingBpsPer8h` | 0 | optional funding drag while holding (set ~1 to be conservative) |
| `maxOpen` | 8 | shared cap: total open positions |
| `perEngineMax` | 3 | shared cap: slots per engine |
| `maxNotionalPct` | 30 | max single position notional, % of equity |
| `grossCapX` | 2.0 | max gross notional, multiple of equity |
| `daySoftLossPct` | -3 | UTC day loss that blocks new entries |
| `dayHardLossPct` | -5 | UTC day loss that flattens all + halts for the day |
| `cooldownH` | 12 | hours a symbol is frozen after a stop-out |
| `engines.NAME.enabled` | true | turn an engine off (open positions are still managed to exit) |
| `engines.NAME.symbols` | per engine | override an engine's symbol list |
| `engines.NAME.maxPos` | 3 | override an engine's slot count |

To restart the account from zero: delete `docs/data/state.json` and run the workflow once.

## Optional Telegram alerts

1. Create a bot with **@BotFather**, send it any message, get your chat id from
   **@userinfobot** (or similar).
2. In the repo: **Settings > Secrets and variables > Actions** > add
   `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.

You will get a push for every ENTER / EXIT / HALT event.

## Things to know

- **Signal timing is honest.** Engines evaluate CLOSED bars only. Fills happen at the
  live price the scanner sees within ~5 minutes of the event, costs included. If the
  GitHub runner is late, the log shows the late fill - that is the point: it measures
  the strategy as you would actually experience it.
- **Spot bars, perp costs.** Signals and marks use Binance spot data
  (data-api.binance.vision - the mirror that works from GitHub runners and restricted
  networks), while costs use the USD-M perp fee model you will trade live. On the
  majors here the two price series are nearly identical; funding is not charged by
  default (`fundingBpsPer8h` adds a conservative drag if you want it).
- **Commits stay small.** The bot only commits when something happened (a trade, a
  signal, a halt, a cooldown) or every 3 hours. If the dashboard says data is older
  than ~30 minutes, GitHub probably paused the cron after 60 days of repo inactivity -
  the bot's own commits normally prevent this. Open the Actions tab to re-enable.
- **What to expect.** These are 4h-1d engines: expect a handful of entries per week in
  total, not per day. The fastest engine (rsi_dip, 4h) trades most; the 1d trend
  engines can sit flat for weeks - that is the design, not a bug. Judge the ensemble
  on 50+ closed trades, not the first fortnight.
- The dashboard re-reads state every 60 s and re-marks open positions with live
  prices in your browser, so numbers move between scans.

Research tool. Paper trading only. Walk-forward results are not a promise of future
performance; this is not financial advice.
