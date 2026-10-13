# Parlay Pilot

Type "I want to bet $10 and try to win $1000 on tonight's Monday Night Football game." It reads the current DraftKings / FanDuel lines and the NFL injury report, builds the parlay with the best real chance of paying that amount, and gives you a button that loads it into your bet slip, plus a share link for friends.

Static site on GitHub Pages. A scheduled GitHub Action pulls odds and injuries into `data/*.json`, so your API key stays in repo secrets and is never sent to visitors' browsers.

## Setup (about 10 minutes)

1. **Get an odds key**: https://the-odds-api.com, pick a plan (see Budget below).
2. **Create the repo and push** (Windows / WSL, from your GitHub folder):
   ```bash
   cd parlay-pilot
   gh repo create Guinnessstache/parlay-pilot --public --source=. --push
   ```
   (Or create an empty repo on github.com, then `git remote add origin … && git push -u origin main`.)
3. **Add the key**: repo → Settings → Secrets and variables → Actions → New repository secret → `ODDS_API_KEY`.
4. **Turn on Pages**: Settings → Pages → Source: **GitHub Actions**.
5. **First run**: Actions → "Refresh data & deploy site" → Run workflow. Your site goes live at `https://guinnessstache.github.io/parlay-pilot/`, and the DEMO banner disappears once real data lands.

Until step 5 runs, the site serves fake demo data (`scripts/make-demo-data.mjs`) so you can click around.

## How it picks legs

1. **Fair odds.** For every line, the bookmaker's margin is removed (both sides of a market are normalized to 100%). Those fair probabilities are then averaged across up to 10 books, with Pinnacle weighted 2×.
2. **Leg value.** Each leg pairs the DK or FD price with its fair probability. EV = fair p × price − 1. Almost every leg is slightly negative.
3. **Injuries.** Props on players listed Out, Doubtful, IR, or Suspended are dropped. Questionable players are dropped too unless you allow them. If a QB is out or questionable, the ticket shows a warning. Game lines are not adjusted, because the market already prices injuries in.
4. **Search.** A beam search looks for combinations of compatible legs that pay between 1.0× and 1.3× your target (with fallback to 0.85–1.8×). It ranks them by combined fair probability. "Compatible" means one side and one total per game, and one line per player-stat. For a fixed payout, the highest-probability ticket is the one that loses the least to vig.

What this means in numbers: at $10 → $1,000 (+9900), the best ticket in demo data hits about **0.9% (1 in 110)**, with a house edge of 6–9%. A tool can't change that; it can only stop you overpaying on top of it.

## Recent form (player + team stats)

Each refresh also pulls ESPN's public stats (free, no key): every team's results this season and the last 5 game logs for each player with a prop line. They feed two things:

- **"Why this ticket"**: one line per leg with the stats behind it, e.g. "averaging 71 rec yds over his last 5 (88, 54, 102, 47, 64), cleared 64.5 in 3 of 5", plus a verdict (form backs it / in line / against it) based on how unusual the recent hit rate is compared to the market's odds.
- **Pick ranking** (Fine-tune → "Factor in recent form", on by default): the recent hit rate is blended in heavily shrunk. 5 games moves a leg about 11% of the way, and never more than ±35% of its market chance. The betting market already prices in recent form, so this nudges ties rather than overriding the odds.

## Practice mode (games in progress)

Fine-tune → "Practice: include games in progress", or type "practice" or "live" in the box. This lets you build tickets on games that have already kicked off, using the last pre-kickoff prices. These tickets can't be placed: the sportsbook button is replaced with "Practice only". Every leg is graded live from ESPN's public scoreboard and box score (✓ won / ✗ lost / ▲ on track / ▼ behind), refreshing every 30 seconds while the game is on. It's a way to see how the picks would have done. It costs no Odds API credits.

## My tickets + screenshot import

My tickets (top right) keeps the tickets you track on this device and grades them live from ESPN, along with your record and net. To add bets placed directly in the DraftKings or FanDuel app, use "📷 Add from screenshot". Text recognition runs in the browser (tesseract.js 6.0.1 from jsDelivr, about 5 MB on first use), so the image is never uploaded. `assets/slipscan.js` turns the text into legs: spreads, moneylines, totals, anytime TDs, and over/under or "80+" yardage props. It matches them against this week's games and players, and you review everything before saving. You can also paste the slip text instead of uploading an image.

## Bet-slip links: test these first

| Book | Format used | Status |
|---|---|---|
| FanDuel single leg | `…/addToBetslip?marketId=X&selectionId=Y` (returned by the API) | Documented by The Odds API |
| FanDuel multi-leg | `…/addToBetslip?marketId[0]=X&selectionId[0]=Y&marketId[1]=…` | **Unverified**, built from community usage |
| DraftKings | `…/?outcomes=a%2Bb%2Bc` | Verified 2026-10-12 (`,` does not work) |

If a combined link doesn't load every leg, each leg also has its own "open leg" link. You can also change the host or format in `assets/config.js` and `betslipLink()` in `assets/engine.js`. Some states use state-specific subdomains.

**Same-game parlays.** DK and FD re-price correlated legs from the same game. The slip will show different odds than this site's estimate (usually lower when legs are positively correlated). The site warns you on every same-game ticket.

## Budget (Odds API credits)

Each refresh costs 3 credits for the main lines of all games, plus about 7 credits per game for alt lines and props on games starting within `EVENT_WINDOW_HOURS`.

| Plan | Suggested settings |
|---|---|
| Free, 500/mo | Repo variable `INCLUDE_EVENT_MARKETS=false`, and set cron to `7 13,21 * * 0,1,4` (2×/day on game days). Main lines only, about 80–120 credits/mo. |
| $30, 20K/mo | Defaults (every 2 h Thu–Mon, 36 h window). A Sunday with 13 games is about 100 credits/run, roughly 6–9K/mo. |

Repo variables (Settings → Variables): `EVENT_WINDOW_HOURS`, `MAX_EVENTS`, `INCLUDE_EVENT_MARKETS`. The script stops per-game calls when remaining credits fall below 50.

## Files

```
index.html               page
assets/app.js            UI, natural-language parsing, share links
assets/engine.js         de-vig, injury filter, parlay search, deep links (pure JS, testable in Node)
assets/config.js         sportsbook hosts, defaults
assets/style.css
scripts/fetch-data.mjs   Action job: Odds API + ESPN injuries → data/
scripts/make-demo-data.mjs
.github/workflows/update-data.yml   refresh on schedule + deploy Pages
```

Local preview: `python3 -m http.server` in the repo, then open http://localhost:8000.

## Caveats

- ESPN's injury feed is an unofficial endpoint. It can change, and it lags breaking news by minutes to hours.
- Odds are snapshots taken at refresh time. Lines move, and props get pulled, before kickoff.
- Shared links carry the legs and the prices at the time of sharing. The receiver sees current prices and a flag on any leg that moved or disappeared.
- For 21+ users in legal states. Problem gambling help: 1-800-GAMBLER.
