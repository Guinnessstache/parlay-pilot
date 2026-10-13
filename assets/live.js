// Live scores + leg grading for Practice mode, straight from ESPN's public API
// (it sends Access-Control-Allow-Origin: *, so the browser can call it directly).
import { normName } from './engine.js';

const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl';
let board = null, boardAt = 0;
const dated = new Map(); // YYYYMMDD -> { at, games }
const summaries = new Map(); // espnId -> { at, data }

function parseBoard(j) {
  return (j.events || []).map(e => {
    const c = e.competitions?.[0] || {};
    const team = side => c.competitors?.find(x => x.homeAway === side);
    const h = team('home'), a = team('away');
    return {
      espnId: e.id, start: e.date,
      state: e.status?.type?.state, detail: e.status?.type?.shortDetail || '', period: e.status?.period || 0, clock: e.status?.clock ?? 0,
      home: h?.team?.displayName, away: a?.team?.displayName,
      homeScore: +(h?.score || 0), awayScore: +(a?.score || 0),
      // ball position for the drive in progress: yardLine counts from the offense's own goal line
      sit: c.situation && Number.isFinite(c.situation.yardLine) && c.situation.possession
        ? { yl: c.situation.yardLine, down: c.situation.down || 1, dist: c.situation.distance || 10 } : null
    };
  });
}

// ESPN's scoreboard keyed by US-Eastern calendar date (that's how it groups games).
export function etDateKey(iso) {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const g = t => parts.find(p => p.type === t).value;
  return `${g('year')}${g('month')}${g('day')}`;
}

// Scoreboard for the day a game was played (finished days are cached for good).
export async function getBoardFor(iso, maxAgeMs = 25000) {
  const key = etDateKey(iso);
  const c = dated.get(key);
  if (c && (c.final || Date.now() - c.at < maxAgeMs)) return c.games;
  try {
    const r = await fetch(`${ESPN}/scoreboard?dates=${key}`, { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status);
    const games = parseBoard(await r.json());
    dated.set(key, { at: Date.now(), games, final: games.length && games.every(g => g.state === 'post') });
    return games;
  } catch { return c?.games || []; }
}

export async function getScoreboard(maxAgeMs = 25000) {
  if (board && Date.now() - boardAt < maxAgeMs) return board;
  try {
    const r = await fetch(`${ESPN}/scoreboard`, { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status);
    board = parseBoard(await r.json());
    boardAt = Date.now();
  } catch { /* offline or blocked: practice mode still works, just without grading */ }
  return board || [];
}

// match an odds-feed game to the ESPN scoreboard by team names (+ start within 12h)
export function matchGame(ev, sb) {
  return (sb || []).find(g => g.home === ev.home && g.away === ev.away && Math.abs(Date.parse(g.start) - Date.parse(ev.start)) < 12 * 3600e3) || null;
}

export async function getSummary(espnId, maxAgeMs = 25000) {
  const c = summaries.get(espnId);
  if (c && Date.now() - c.at < maxAgeMs) return c.data;
  try {
    const r = await fetch(`${ESPN}/summary?event=${espnId}`, { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status);
    const j = await r.json();
    // flatten box score: normName -> { py, ptd, ry, rtd, rec, recy, rectd }
    const players = {};
    for (const team of j.boxscore?.players || []) {
      for (const cat of team.statistics || []) {
        const keys = cat.keys || [];
        for (const a of cat.athletes || []) {
          const k = normName(a.athlete?.displayName);
          const p = players[k] || (players[k] = { py: 0, ptd: 0, ry: 0, rtd: 0, rec: 0, recy: 0, rectd: 0 });
          const v = n => { const i = keys.indexOf(n); return i >= 0 ? parseFloat(a.stats[i]) || 0 : 0; };
          if (cat.name === 'passing') { p.py = v('passingYards'); p.ptd = v('passingTouchdowns'); }
          if (cat.name === 'rushing') { p.ry = v('rushingYards'); p.rtd = v('rushingTouchdowns'); }
          if (cat.name === 'receiving') { p.rec = v('receptions'); p.recy = v('receivingYards'); p.rectd = v('receivingTouchdowns'); }
        }
      }
    }
    const wp = (j.winprobability || []).at(-1)?.homeWinPercentage;
    const pc = (j.pickcenter || [])[0] || {};
    const data = { players, homeWP: Number.isFinite(wp) ? wp : null, homeSpread: Number.isFinite(pc.spread) ? pc.spread : null, total: Number.isFinite(pc.overUnder) ? pc.overUnder : null };
    summaries.set(espnId, { at: Date.now(), data });
    return data;
  } catch { return null; }
}

const STAT = { player_pass_yds: ['py', 'pass yds'], player_rush_yds: ['ry', 'rush yds'], player_reception_yds: ['recy', 'rec yds'], player_receptions: ['rec', 'catches'], player_pass_tds: ['ptd', 'pass TDs'] };

// status: won | lost | ahead | behind | pending ; text: short human detail
export async function gradeLeg(leg, ev, sb) {
  const g = matchGame(ev, sb);
  if (!g || g.state === 'pre') return { status: 'pending', text: 'Not started' };
  const final = g.state === 'post';
  const m = leg.market;
  const tot = g.homeScore + g.awayScore;
  const isHome = leg.name === g.home;
  const margin = isHome ? g.homeScore - g.awayScore : g.awayScore - g.homeScore;

  if (m === 'h2h') {
    if (final) return margin > 0 ? { status: 'won', text: `Won by ${margin}` } : { status: 'lost', text: margin === 0 ? 'Tie' : `Lost by ${-margin}` };
    return margin > 0 ? { status: 'ahead', text: `Leading by ${margin}` } : margin < 0 ? { status: 'behind', text: `Trailing by ${-margin}` } : { status: 'behind', text: 'Tied' };
  }
  if (/spreads/.test(m)) {
    const cover = margin + leg.point;
    const txt = `${margin >= 0 ? 'Up' : 'Down'} ${Math.abs(margin)}, needs ${leg.point < 0 ? `to win by ${Math.ceil(-leg.point)}+` : `to lose by ${Math.floor(leg.point)} or less`}`;
    if (final) return cover > 0 ? { status: 'won', text: `Covered (${margin >= 0 ? '+' : ''}${margin})` } : { status: 'lost', text: `Didn't cover (${margin >= 0 ? '+' : ''}${margin})` };
    return { status: cover > 0 ? 'ahead' : 'behind', text: txt };
  }
  if (/totals/.test(m)) {
    if (leg.name === 'Over') {
      if (tot > leg.point) return { status: 'won', text: `${tot} pts — already over` };
      if (final) return { status: 'lost', text: `Finished at ${tot}` };
      return { status: 'behind', text: `${tot} pts so far, needs ${Math.floor(leg.point - tot) + 1} more` };
    }
    if (tot > leg.point) return { status: 'lost', text: `${tot} pts — already over ${leg.point}` };
    if (final) return { status: 'won', text: `Finished at ${tot}` };
    return { status: 'ahead', text: `${tot} pts so far, ${Math.ceil(leg.point - tot) - 1 >= 0 ? `room for ${Math.floor(leg.point - tot)} more` : ''}` };
  }
  if (m.startsWith('player_')) {
    const s = await getSummary(g.espnId);
    const p = s?.players?.[normName(leg.desc)];
    if (m === 'player_anytime_td') {
      const td = p ? p.rtd + p.rectd : 0;
      if (td > 0) return { status: 'won', text: `Scored (${td} TD)` };
      if (final) return { status: 'lost', text: 'No touchdown' };
      return { status: 'pending', text: p ? 'No TD yet' : 'No stats yet' };
    }
    const st = STAT[m];
    if (!st) return { status: 'pending', text: '' };
    const val = p ? p[st[0]] : 0;
    if (leg.name === 'Over') {
      if (val > leg.point) return { status: 'won', text: `${val} ${st[1]} — over` };
      if (final) return { status: 'lost', text: `Finished with ${val}` };
      return { status: 'behind', text: `${val} ${st[1]} so far, needs ${Math.floor(leg.point - val) + 1} more` };
    }
    if (val > leg.point) return { status: 'lost', text: `${val} ${st[1]} — over ${leg.point}` };
    if (final) return { status: 'won', text: `Finished with ${val}` };
    return { status: 'ahead', text: `${val} ${st[1]} so far` };
  }
  return { status: 'pending', text: '' };
}


// ---------- live chance of a leg hitting ----------
// Normal CDF + inverse (Acklam) - enough precision for a display percentage.
const Phi = x => { const t = 1 / (1 + 0.2316419 * Math.abs(x)); const d = 0.3989423 * Math.exp(-x * x / 2); const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x > 0 ? 1 - p : p; };
function PhiInv(p) {
  p = Math.min(0.9999, Math.max(0.0001, p));
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const q = Math.min(p, 1 - p);
  let x;
  if (q < 0.02425) { const r = Math.sqrt(-2 * Math.log(q)); x = (((((c[0] * r + c[1]) * r + c[2]) * r + c[3]) * r + c[4]) * r + c[5]) / ((((d[0] * r + d[1]) * r + d[2]) * r + d[3]) * r + 1); }
  else { const r = q - 0.5, r2 = r * r; x = (((((a[0] * r2 + a[1]) * r2 + a[2]) * r2 + a[3]) * r2 + a[4]) * r2 + a[5]) * r / (((((b[0] * r2 + b[1]) * r2 + b[2]) * r2 + b[3]) * r2 + b[4]) * r2 + 1); }
  return p < 0.5 ? (q === p ? x : -x) : (q === p ? -x : x);
}
const SIG_MARGIN = 13.5, SIG_TOTAL = 11;   // NFL full-game standard deviations (margin, combined points)

// ---- drive-by-drive model for points still to come ----
// Points arrive in lumps (3s and 7s), so "one more score" is far less certain than a bell curve says.
// League baseline per drive: ~22% TD, ~15% FG, ~0.5% safety  ->  ~2 pts/drive, ~22 drives a game.
const DRIVES_PER_GAME = 22, DRIVE_SEC = 3600 / DRIVES_PER_GAME, BASE_TD = 0.22, BASE_FG = 0.15, BASE_PPD = 0.22 * 6.97 + 0.15 * 3 + 0.005 * 2;
// drive in progress: [yards to the end zone, P(TD), P(FG)] from league drive outcomes by field position
const FIELD = [[1, 0.82, 0.15], [5, 0.66, 0.28], [10, 0.56, 0.33], [20, 0.47, 0.36], [30, 0.40, 0.35], [40, 0.33, 0.28], [50, 0.28, 0.20], [65, 0.23, 0.15], [80, 0.19, 0.12], [99, 0.15, 0.10]];
function fieldOdds(toGo) {
  for (let i = 1; i < FIELD.length; i++) if (toGo <= FIELD[i][0]) {
    const [a, ta, fa] = FIELD[i - 1], [b, tb, fb] = FIELD[i], w = (toGo - a) / (b - a);
    return [ta + (tb - ta) * Math.max(0, w), fa + (fb - fa) * Math.max(0, w)];
  }
  return [FIELD.at(-1)[1], FIELD.at(-1)[2]];
}
// one drive's points as a sparse distribution
const driveDist = (pTD, pFG) => { const pS = 0.005; return [[0, 1 - pTD - pFG - pS], [2, pS], [3, pFG], [6, pTD * 0.04], [7, pTD * 0.93], [8, pTD * 0.03]]; };
function convolve(a, d) {
  const out = new Array(a.length + 8).fill(0);
  a.forEach((pa, i) => { if (pa) for (const [pts, pd] of d) out[i + pts] += pa * pd; });
  return out;
}
// distribution of combined points still to come: index = points
export function pointsToCome(g, total) {
  const secLeft = g.state === 'post' ? 0 : g.period > 4 ? Math.max(60, g.clock || 0) : Math.max(0, (4 - g.period) * 900 + (g.clock || 0));
  const k = Math.min(1.6, Math.max(0.6, (total ?? 45) / DRIVES_PER_GAME / BASE_PPD)); // this game's scoring level vs league average
  let dist = [1], rest = secLeft;
  if (g.sit && secLeft > 0) {
    let [td, fg] = fieldOdds(100 - g.sit.yl);
    if (g.sit.down >= 3 && g.sit.dist >= 8) { td *= 0.8; fg *= 0.9; }               // 3rd/4th & long
    if (secLeft < 40) { td *= Math.min(1, secLeft / 40 + 0.3); }                        // little time to finish the drive
    const sk = Math.sqrt(k);
    dist = convolve(dist, driveDist(Math.min(0.9, td * sk), Math.min(0.9 - Math.min(0.9, td * sk), fg * sk)));
    rest = Math.max(0, secLeft - Math.min(secLeft, DRIVE_SEC * 0.6));                   // the current drive uses up some clock
  }
  const n = rest / DRIVE_SEC, lo = Math.floor(n), frac = n - lo;
  const gen = driveDist(Math.min(0.6, BASE_TD * k), Math.min(0.35, BASE_FG * k));
  for (let i = 0; i < lo; i++) dist = convolve(dist, gen);
  if (frac > 0.01) { const extra = convolve(dist, gen); dist = extra.map((p, i) => (1 - frac) * (dist[i] || 0) + frac * p); }
  return dist;
}
const probMoreThan = (dist, x) => dist.reduce((a, p, i) => a + (i > x ? p : 0), 0);

// fraction of regulation left (0..1); overtime counts as a sliver
function timeLeft(g) {
  if (!g || g.state === 'pre') return 1;
  if (g.state === 'post') return 0;
  if (g.period > 4) return Math.max(0.01, (g.clock || 0) / 3600);
  return Math.max(0.003, ((4 - g.period) * 900 + (g.clock || 0)) / 3600);
}

// pPre: the leg's pre-game chance if we know it (used for player props and before kickoff)
export async function legChance(leg, ev, sb, pPre = null) {
  const g = matchGame(ev, sb);
  if (!g) return pPre;
  if (g.state === 'pre' && pPre != null) return pPre;
  const r = await gradeLeg(leg, ev, sb);
  if (r.status === 'won') return 1;
  if (r.status === 'lost') return 0;
  const f = timeLeft(g);
  const m = leg.market;
  const s = g.espnId ? await getSummary(g.espnId) : null;
  if (m === 'h2h' || /spreads/.test(m)) {
    const isHome = leg.name === g.home;
    const cur = isHome ? g.homeScore - g.awayScore : g.awayScore - g.homeScore;
    const sd = SIG_MARGIN * Math.sqrt(f);
    const teamSpread = s?.homeSpread == null ? null : (isHome ? s.homeSpread : -s.homeSpread);
    let mu; // expected margin over the rest of the game, from this team's side
    const wp = s?.homeWP == null ? null : (isHome ? s.homeWP : 1 - s.homeWP);
    if (wp != null && g.state === 'in') mu = sd * PhiInv(wp) - cur;           // agrees with ESPN's live win probability
    else mu = teamSpread != null ? -teamSpread * f : 0;
    if (m === 'h2h') return wp != null && g.state === 'in' ? wp : Phi((cur + mu) / sd);
    return Phi((cur + mu + leg.point) / sd);
  }
  if (/totals/.test(m)) {
    const tot = g.homeScore + g.awayScore;
    const pOver = probMoreThan(pointsToCome(g, s?.total), leg.point - tot);
    return leg.name === 'Over' ? pOver : 1 - pOver;
  }
  if (m === 'player_anytime_td') {
    const p0 = pPre ?? 0.3;
    return 1 - Math.pow(1 - p0, f);  // scoring chance left scales with time left
  }
  if (m.startsWith('player_')) {
    const p = s?.players?.[normName(leg.desc)];
    const key = { player_pass_yds: 'py', player_rush_yds: 'ry', player_reception_yds: 'recy', player_receptions: 'rec', player_pass_tds: 'ptd' }[m];
    const val = p && key ? p[key] : 0;
    const mean = leg.point * f, sd = Math.max(1, 0.45 * leg.point * Math.sqrt(f));
    const pOver = 1 - Phi((leg.point - val - mean) / sd);
    return leg.name === 'Over' ? pOver : 1 - pOver;
  }
  return pPre;
}
