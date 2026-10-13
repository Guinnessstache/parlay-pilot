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
      state: e.status?.type?.state, detail: e.status?.type?.shortDetail || '', period: e.status?.period || 0,
      home: h?.team?.displayName, away: a?.team?.displayName,
      homeScore: +(h?.score || 0), awayScore: +(a?.score || 0)
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

async function getSummary(espnId, maxAgeMs = 25000) {
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
    summaries.set(espnId, { at: Date.now(), data: { players } });
    return { players };
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
