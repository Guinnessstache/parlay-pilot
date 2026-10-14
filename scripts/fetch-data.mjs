// Pulls NFL odds (The Odds API) + injuries (ESPN) and writes compact JSON into /data.
// Runs inside GitHub Actions so the API key stays in repo secrets, never in the browser.
// Node 20+, no dependencies.
//
// Env:
//   ODDS_API_KEY          required
//   EVENT_WINDOW_HOURS    games starting within this many hours get alt lines + props (default 36)
//   MAX_EVENTS            cap on per-event calls per run (default 16)
//   EVENT_MARKETS         comma list for per-event calls (default below)
//   CREDIT_RESERVE        stop per-event calls if remaining credits drop below this (default 50)
//   INCLUDE_EVENT_MARKETS "false" to skip alt lines/props entirely (cheapest mode)
//   EVENT_IDS             comma list of Odds API event ids to pull alt lines + props for right now
//                         (ignores the window; used by the site's Sync button)
//   PROPS_FRESH_HOURS     skip games whose props were pulled less than this many hours ago (default 6)
//
// Alt lines / props pulled in an earlier run are carried forward until kickoff, so a game
// keeps its props between runs instead of losing them when it falls outside this run's picks.

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { fetchStats } from './fetch-stats.mjs';

const KEY = process.env.ODDS_API_KEY;
if (!KEY) { console.error('ODDS_API_KEY is not set'); process.exit(1); }

const SPORT = 'americanfootball_nfl';
const HOST = 'https://api.the-odds-api.com/v4';
// Up to 10 bookmakers counts as ONE region for billing. DK + FD are the targets;
// the rest are used only to build a consensus "fair" price (Pinnacle is the sharpest).
const BOOKS = ['draftkings', 'fanduel', 'pinnacle', 'betmgm', 'williamhill_us', 'espnbet', 'fanatics', 'betrivers', 'betonlineag', 'lowvig'];
const FEATURED = 'h2h,spreads,totals';
const EVENT_MARKETS = process.env.EVENT_MARKETS || [
  'alternate_spreads', 'alternate_totals',
  'player_anytime_td', 'player_pass_yds', 'player_rush_yds', 'player_reception_yds', 'player_receptions'
].join(',');
const WINDOW_H = Number(process.env.EVENT_WINDOW_HOURS || 36);
const MAX_EVENTS = Number(process.env.MAX_EVENTS || 16);
const RESERVE = Number(process.env.CREDIT_RESERVE || 50);
const DO_EVENTS = process.env.INCLUDE_EVENT_MARKETS !== 'false';
const EVENT_IDS = (process.env.EVENT_IDS || '').split(',').map(s => s.trim()).filter(s => /^[a-f0-9]{8,64}$/i.test(s)).slice(0, 4);
const FRESH_H = Number(process.env.PROPS_FRESH_HOURS || 6);
const GAME_MARKETS = new Set(FEATURED.split(','));

let creditsRemaining = null;
let creditsUsed = 0;

async function oddsGet(path, params) {
  const qs = new URLSearchParams({ apiKey: KEY, oddsFormat: 'decimal', includeLinks: 'true', includeSids: 'true', ...params });
  const res = await fetch(`${HOST}${path}?${qs}`);
  const rem = res.headers.get('x-requests-remaining');
  const last = res.headers.get('x-requests-last');
  if (rem != null) creditsRemaining = Number(rem);
  if (last != null) creditsUsed += Number(last);
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

// Compact a bookmaker market into what the site needs.
function compactMarket(m) {
  return {
    u: m.last_update || null,
    link: m.link || null,
    sid: m.sid || null,
    o: (m.outcomes || []).map(o => {
      const r = { n: o.name, p: o.price };
      if (o.description != null) r.d = o.description;
      if (o.point != null) r.pt = o.point;
      if (o.link) r.link = o.link;
      if (o.sid) r.sid = o.sid;
      return r;
    })
  };
}

function mergeEvent(store, ev) {
  const e = store.get(ev.id) || {
    id: ev.id, home: ev.home_team, away: ev.away_team, start: ev.commence_time, books: {}
  };
  for (const b of ev.bookmakers || []) {
    const book = e.books[b.key] || (e.books[b.key] = { link: b.link || null, sid: b.sid || null, m: {} });
    if (b.link && !book.link) book.link = b.link;
    if (b.sid && !book.sid) book.sid = b.sid;
    for (const m of b.markets || []) book.m[m.key] = compactMarket(m);
  }
  store.set(ev.id, e);
}

async function fetchOdds() {
  const store = new Map();
  const featured = await oddsGet(`/sports/${SPORT}/odds`, { bookmakers: BOOKS.join(','), markets: FEATURED });
  featured.forEach(ev => mergeEvent(store, ev));
  console.log(`featured: ${featured.length} games`);
  const now = Date.now();

  // carry forward alt lines / props from the last snapshot for games that haven't started
  const prev = await readPrevious('data/odds.json');
  for (const old of prev?.events || []) {
    const e = store.get(old.id);
    if (!e || Date.parse(e.start) <= now - 4 * 3600e3 || !old.props_at) continue;
    e.props_at = old.props_at;
    for (const [bk, ob] of Object.entries(old.books || {})) {
      const book = e.books[bk] || (e.books[bk] = { link: ob.link || null, sid: ob.sid || null, m: {} });
      for (const [mk, m] of Object.entries(ob.m || {})) if (!GAME_MARKETS.has(mk) && !book.m[mk]) book.m[mk] = m;
    }
  }

  if (DO_EVENTS) {
    const fresh = e => e.props_at && now - Date.parse(e.props_at) < FRESH_H * 3600e3;
    const soon = EVENT_IDS.length
      ? EVENT_IDS.map(id => store.get(id)).filter(Boolean)
      : [...store.values()]
        .filter(e => { const t = Date.parse(e.start); return t > now && t - now < WINDOW_H * 3600e3 && !fresh(e); })
        .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
        .slice(0, MAX_EVENTS);
    if (EVENT_IDS.length && !soon.length) console.warn(`none of EVENT_IDS matched a listed game: ${EVENT_IDS.join(',')}`);
    for (const e of soon) {
      if (creditsRemaining != null && creditsRemaining < RESERVE) {
        console.warn(`credit reserve hit (${creditsRemaining} left) - skipping remaining per-event calls`);
        break;
      }
      try {
        const ev = await oddsGet(`/sports/${SPORT}/events/${e.id}/odds`, { bookmakers: BOOKS.join(','), markets: EVENT_MARKETS });
        // a fresh pull replaces any carried-forward alt/prop markets for this game
        for (const b of Object.values(e.books)) for (const mk of Object.keys(b.m)) if (!GAME_MARKETS.has(mk)) delete b.m[mk];
        mergeEvent(store, ev);
        e.props_at = new Date().toISOString();
        console.log(`event markets: ${e.away} @ ${e.home}`);
      } catch (err) {
        console.warn(`event ${e.id} failed: ${err.message}`);
      }
    }
  }
  return [...store.values()].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
}

async function fetchInjuries() {
  const res = await fetch('https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries');
  if (!res.ok) throw new Error(`ESPN injuries HTTP ${res.status}`);
  const j = await res.json();
  const out = [];
  for (const team of j.injuries || []) {
    for (const inj of team.injuries || []) {
      const status = inj.status || inj.type?.description || '';
      if (/^active$/i.test(status)) continue; // practice-squad / cleared entries
      out.push({
        team: team.displayName,
        player: inj.athlete?.displayName,
        pos: inj.athlete?.position?.abbreviation || '',
        status,
        detail: inj.details?.type || '',
        note: inj.shortComment || '',
        date: inj.date || null
      });
    }
  }
  return out;
}

async function readPrevious(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; }
}

const generatedAt = new Date().toISOString();
await mkdir('data', { recursive: true });

let events;
try {
  events = await fetchOdds();
} catch (err) {
  console.error(`odds fetch failed: ${err.message}`);
  process.exit(1);
}

let injuries;
try {
  injuries = await fetchInjuries();
} catch (err) {
  console.warn(`injury fetch failed, keeping previous file: ${err.message}`);
  injuries = (await readPrevious('data/injuries.json'))?.injuries || [];
}

let stats = null;
try {
  stats = await fetchStats(events);
} catch (err) {
  console.warn(`stats fetch failed, keeping previous file: ${err.message}`);
}
if (stats) await writeFile('data/stats.json', JSON.stringify({ generated_at: generatedAt, ...stats }));

await writeFile('data/odds.json', JSON.stringify({ generated_at: generatedAt, demo: false, events }));
await writeFile('data/injuries.json', JSON.stringify({ generated_at: generatedAt, injuries }));
await writeFile('data/meta.json', JSON.stringify({
  generated_at: generatedAt, demo: false, games: events.length,
  credits_used_this_run: creditsUsed, credits_remaining: creditsRemaining
}, null, 2));
console.log(`done: ${events.length} games, ${injuries.length} injury entries, ${creditsUsed} credits used, ${creditsRemaining} remaining`);
