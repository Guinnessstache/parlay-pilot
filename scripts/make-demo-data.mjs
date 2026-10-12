// Generates FAKE sample data so the site works before an Odds API key is configured.
// Prices are synthetic and player names are invented. The site shows a DEMO banner
// whenever data/odds.json has "demo": true. Real runs of fetch-data.mjs overwrite this.
import { writeFile, mkdir } from 'node:fs/promises';

let seed = 42;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const randn = () => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const erf = x => { const t = 1 / (1 + 0.3275911 * Math.abs(x)); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; };
const cdf = (x, m, s) => 0.5 * (1 + erf((x - m) / (s * Math.SQRT2)));

const BOOKS = { draftkings: 0.048, fanduel: 0.05, pinnacle: 0.025, betmgm: 0.055 };
let sidCounter = 100000;

function price(p, vig, noise = 0.01) {
  const q = Math.min(0.97, Math.max(0.03, p * (1 + vig / 2) + randn() * noise * p));
  return Math.round((1 / q) * 100) / 100;
}

function outcome(book, evSid, name, p, vig, extra = {}) {
  const o = { n: name, p: price(p, vig), ...extra };
  const sid = String(++sidCounter);
  o.sid = sid;
  if (book === 'draftkings') o.link = `https://sportsbook.draftkings.com/event/${evSid}?outcomes=${sid}`;
  if (book === 'fanduel') o.link = `https://sportsbook.fanduel.com/addToBetslip?marketId=42.${evSid}${(sidCounter % 97)}&selectionId=${sid}`;
  return o;
}

function makeGame(id, home, away, start, spread, total, players) {
  // spread = home margin expectation (positive = home favored)
  const books = {};
  for (const [bk, vig] of Object.entries(BOOKS)) {
    const evSid = String(30000000 + Math.floor(rnd() * 999999));
    const m = {};
    const pHome = 1 - cdf(0, spread, 13.5);
    m.h2h = { o: [outcome(bk, evSid, home, pHome, vig), outcome(bk, evSid, away, 1 - pHome, vig)] };
    const line = Math.round(spread * 2) / 2;
    const pCover = 1 - cdf(line, spread, 13.5);
    m.spreads = { o: [outcome(bk, evSid, home, pCover, vig, { pt: -line }), outcome(bk, evSid, away, 1 - pCover, vig, { pt: line })] };
    const tl = Math.round(total * 2) / 2;
    const pOver = 1 - cdf(tl, total, 10);
    m.totals = { o: [outcome(bk, evSid, 'Over', pOver, vig, { pt: tl }), outcome(bk, evSid, 'Under', 1 - pOver, vig, { pt: tl })] };
    if (bk !== 'pinnacle' || rnd() > 0.3) {
      const alts = [], altT = [];
      for (let k = -17.5; k <= 17.5; k += 3) {
        const pc = 1 - cdf(k, spread, 13.5);
        alts.push(outcome(bk, evSid, home, pc, vig * 1.4, { pt: -k }), outcome(bk, evSid, away, 1 - pc, vig * 1.4, { pt: k }));
      }
      for (let k = tl - 14; k <= tl + 14; k += 3.5) {
        const po = 1 - cdf(k, total, 10);
        altT.push(outcome(bk, evSid, 'Over', po, vig * 1.4, { pt: k }), outcome(bk, evSid, 'Under', 1 - po, vig * 1.4, { pt: k }));
      }
      m.alternate_spreads = { o: alts };
      m.alternate_totals = { o: altT };
    }
    const td = [], ry = [], rcy = [], py = [];
    for (const pl of players) {
      if (pl.td) td.push(outcome(bk, evSid, 'Yes', pl.td, vig * 2.2, { d: pl.name }));
      if (pl.rush) { const L = Math.round(pl.rush) + 0.5, po = 1 - cdf(L, pl.rush, pl.rush * 0.4); ry.push(outcome(bk, evSid, 'Over', po, vig * 1.3, { d: pl.name, pt: L }), outcome(bk, evSid, 'Under', 1 - po, vig * 1.3, { d: pl.name, pt: L })); }
      if (pl.rec) { const L = Math.round(pl.rec) + 0.5, po = 1 - cdf(L, pl.rec, pl.rec * 0.45); rcy.push(outcome(bk, evSid, 'Over', po, vig * 1.3, { d: pl.name, pt: L }), outcome(bk, evSid, 'Under', 1 - po, vig * 1.3, { d: pl.name, pt: L })); }
      if (pl.pass) { const L = Math.round(pl.pass) + 0.5, po = 1 - cdf(L, pl.pass, 55); py.push(outcome(bk, evSid, 'Over', po, vig * 1.3, { d: pl.name, pt: L }), outcome(bk, evSid, 'Under', 1 - po, vig * 1.3, { d: pl.name, pt: L })); }
    }
    m.player_anytime_td = { o: td };
    m.player_rush_yds = { o: ry };
    m.player_reception_yds = { o: rcy };
    m.player_pass_yds = { o: py };
    books[bk] = { sid: evSid, link: bk === 'draftkings' ? `https://sportsbook.draftkings.com/event/${evSid}` : null, m };
  }
  return { id, home, away, start, books };
}

const P = (name, o) => ({ name, ...o });
const now = new Date();
const at = (daysAhead, hourUTC, minute = 15) => { const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysAhead, hourUTC, minute)); return d.toISOString(); };

const events = [
  makeGame('demo-mnf', 'Kansas City Chiefs', 'Buffalo Bills', at(1, 0, 15), 2.5, 48.5, [
    P('Demo QB Alpha', { pass: 262, td: 0.12 }), P('Demo RB Bravo', { rush: 71, rec: 18, td: 0.45 }),
    P('Demo WR Charlie', { rec: 74, td: 0.38 }), P('Demo TE Delta', { rec: 52, td: 0.31 }),
    P('Demo QB Echo', { pass: 248, rush: 31, td: 0.22 }), P('Demo RB Foxtrot', { rush: 64, td: 0.40 }),
    P('Demo WR Golf', { rec: 68, td: 0.35 }), P('Demo WR Hotel', { rec: 41, td: 0.22 })
  ]),
  makeGame('demo-tnf', 'Philadelphia Eagles', 'Dallas Cowboys', at(4, 0, 15), 4.5, 45.5, [
    P('Demo QB India', { pass: 231, rush: 28, td: 0.20 }), P('Demo RB Juliet', { rush: 88, td: 0.55 }),
    P('Demo WR Kilo', { rec: 81, td: 0.40 }), P('Demo QB Lima', { pass: 255, td: 0.08 }),
    P('Demo WR Mike', { rec: 77, td: 0.39 })
  ]),
  makeGame('demo-sun1', 'Detroit Lions', 'Green Bay Packers', at(6, 17, 0), 3.5, 50.5, [
    P('Demo RB November', { rush: 76, td: 0.52 }), P('Demo WR Oscar', { rec: 79, td: 0.41 }),
    P('Demo QB Papa', { pass: 244, td: 0.10 }), P('Demo TE Quebec', { rec: 44, td: 0.27 })
  ]),
  makeGame('demo-sun2', 'Baltimore Ravens', 'Cincinnati Bengals', at(6, 17, 0), 3, 51.5, [
    P('Demo QB Romeo', { pass: 228, rush: 52, td: 0.30 }), P('Demo RB Sierra', { rush: 81, td: 0.55 }),
    P('Demo WR Tango', { rec: 88, td: 0.45 }), P('Demo WR Uniform', { rec: 63, td: 0.33 })
  ]),
  makeGame('demo-sun3', 'San Francisco 49ers', 'Seattle Seahawks', at(6, 20, 25), 5.5, 44.5, [
    P('Demo RB Victor', { rush: 84, rec: 31, td: 0.58 }), P('Demo WR Whiskey', { rec: 66, td: 0.33 })
  ])
];

const injuries = [
  { team: 'Buffalo Bills', player: 'Demo WR Hotel', pos: 'WR', status: 'Questionable', detail: 'Hamstring', note: 'Limited in practice (demo).' },
  { team: 'Kansas City Chiefs', player: 'Demo TE Delta', pos: 'TE', status: 'Out', detail: 'Ankle', note: 'Ruled out (demo).' },
  { team: 'Dallas Cowboys', player: 'Demo LT Xray', pos: 'OT', status: 'Injured Reserve', detail: 'Knee', note: 'Placed on IR (demo).' },
  { team: 'Philadelphia Eagles', player: 'Demo WR Kilo', pos: 'WR', status: 'Questionable', detail: 'Shoulder', note: 'Game-time decision (demo).' }
];

const generated_at = new Date().toISOString();
await mkdir('data', { recursive: true });
await writeFile('data/odds.json', JSON.stringify({ generated_at, demo: true, events }));
await writeFile('data/injuries.json', JSON.stringify({ generated_at, demo: true, injuries }));
await writeFile('data/meta.json', JSON.stringify({ generated_at, demo: true, games: events.length }, null, 2));
console.log('demo data written');
