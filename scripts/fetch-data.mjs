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

import { writeFile, mkdir, readFile } from 'node:fs/promises';

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

  if (DO_EVENTS) {
    const now = Date.now();
    const soon = [...store.values()]
      .filter(e => { const t = Date.parse(e.start); return t > now && t - now < WINDOW_H * 3600e3; })
      .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
      .slice(0, MAX_EVENTS);
    for (const e of soon) {
      if (creditsRemaining != null && creditsRemaining < RESERVE) {
        console.warn(`credit reserve hit (${creditsRemaining} left) - skipping remaining per-event calls`);
        break;
      }
      try {
        const ev = await oddsGet(`/sports/${SPORT}/events/${e.id}/odds`, { bookmakers: BOOKS.join(','), markets: EVENT_MARKETS });
        mergeEvent(store, ev);
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

await writeFile('data/odds.json', JSON.stringify({ generated_at: generatedAt, demo: false, events }));
await writeFile('data/injuries.json', JSON.stringify({ generated_at: generatedAt, injuries }));
await writeFile('data/meta.json', JSON.stringify({
  generated_at: generatedAt, demo: false, games: events.length,
  credits_used_this_run: creditsUsed, credits_remaining: creditsRemaining
}, null, 2));
console.log(`done: ${events.length} games, ${injuries.length} injury entries, ${creditsUsed} credits used, ${creditsRemaining} remaining`);
