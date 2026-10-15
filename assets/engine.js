// Parlay engine: pure functions, works in the browser and in Node (for tests).
//
// Method, in one paragraph:
//  1. For every outcome, compute a "fair" win probability by removing the bookmaker margin
//     (de-vig) at each book that lists it, then averaging across books (Pinnacle weighted 2x).
//  2. Each candidate leg = the target book's price + that fair probability. Leg EV = p*price - 1.
//  3. Drop props on players listed Out/Doubtful/IR (and Questionable unless allowed).
//  4. Search combinations of compatible legs whose combined price lands near the requested
//     payout, maximising combined fair probability. For a fixed payout, that is the same as
//     minimising the total margin you pay, which usually means fewer, better-priced legs.
// Nothing here predicts football better than the market. It finds the cheapest-priced path
// to the payout you asked for, and tells you the honest odds of hitting it.

export const BOOK_NAMES = { draftkings: 'DraftKings', fanduel: 'FanDuel' };
const BOOK_WEIGHT = { pinnacle: 2, lowvig: 1.5 };

export const MARKET_LABEL = {
  h2h: 'Moneyline', spreads: 'Spread', alternate_spreads: 'Alt spread',
  totals: 'Total', alternate_totals: 'Alt total',
  player_anytime_td: 'Anytime TD', player_pass_yds: 'Pass yds', player_rush_yds: 'Rush yds',
  player_reception_yds: 'Rec yds', player_receptions: 'Receptions', player_pass_tds: 'Pass TDs',
  team_totals: 'Team total'
};

const isSpread = k => k === 'spreads' || k === 'alternate_spreads';
const isTotal = k => k === 'totals' || k === 'alternate_totals';
const isProp = k => k.startsWith('player_');

// ---------- odds helpers ----------
export const decToAmerican = d => d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1));
export const fmtAmerican = d => { const a = decToAmerican(d); return a > 0 ? `+${a}` : `${a}`; };
export const normName = s => (s || '').toLowerCase().replace(/[.'’]/g, '').replace(/\s+(jr|sr|ii|iii|iv|v)$/, '').replace(/\s+/g, ' ').trim();

// Outcomes that are two sides of the same bet share a pair key.
function pairKey(mkt, o) {
  if (mkt === 'h2h') return 'ml';
  if (isSpread(mkt)) return `sp|${Math.abs(o.pt)}`;
  return `${o.d || ''}|${o.pt ?? ''}`;
}
function outcomeKey(mkt, o) { return `${mkt}|${o.n}|${o.d || ''}|${o.pt ?? ''}`; }

// Fair probabilities for one book's market: { outcomeKey: p }
function devigMarket(mkt, market) {
  const groups = new Map();
  for (const o of market.o) {
    if (!(o.p > 1)) continue;
    const k = pairKey(mkt, o);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(o);
  }
  const out = {};
  for (const g of groups.values()) {
    const imp = g.map(o => 1 / o.p);
    const sum = imp.reduce((a, b) => a + b, 0);
    if (g.length >= 2 && sum > 1) {
      g.forEach((o, i) => { out[outcomeKey(mkt, o)] = imp[i] / sum; });
    } else {
      // one-sided market (e.g. anytime TD "Yes"): assume a typical margin
      const margin = isProp(mkt) ? 1.20 : 1.06; // one-sided markets (anytime TD) carry ~20% hold
      g.forEach((o, i) => { out[outcomeKey(mkt, o)] = imp[i] / margin; });
    }
  }
  return out;
}

// { eventId: { outcomeKey: { p, books } } }
export function buildConsensus(events) {
  const cons = {};
  for (const ev of events) {
    const acc = {};
    for (const [bk, book] of Object.entries(ev.books || {})) {
      const w = BOOK_WEIGHT[bk] || 1;
      for (const [mkt, market] of Object.entries(book.m || {})) {
        const fair = devigMarket(mkt, market);
        for (const [k, p] of Object.entries(fair)) {
          const a = acc[k] || (acc[k] = { sw: 0, sp: 0, books: [] });
          a.sw += w; a.sp += w * p; a.books.push(bk);
        }
      }
    }
    cons[ev.id] = Object.fromEntries(Object.entries(acc).map(([k, a]) => [k, { p: a.sp / a.sw, books: a.books }]));
  }
  return cons;
}

// ---------- injuries ----------
export function indexInjuries(list) {
  const byPlayer = new Map(), byTeam = new Map();
  for (const i of list || []) {
    byPlayer.set(normName(i.player), i);
    if (!byTeam.has(i.team)) byTeam.set(i.team, []);
    byTeam.get(i.team).push(i);
  }
  return { byPlayer, byTeam };
}
const OUT_RE = /out|doubtful|injured reserve|^ir$|suspend|pup|non-football/i;
const Q_RE = /questionable|day-to-day/i;

export function teamInjuryNotes(team, inj) {
  const list = inj.byTeam.get(team) || [];
  return list
    .filter(i => OUT_RE.test(i.status) || Q_RE.test(i.status))
    .filter(i => ['QB', 'RB', 'WR', 'TE', 'OT', 'LT', 'G', 'C', 'DE', 'CB', 'LB', 'S', 'DT', 'EDGE'].includes(i.pos))
    .sort((a, b) => (a.pos === 'QB' ? -1 : 0) - (b.pos === 'QB' ? -1 : 0));
}

// ---------- legs ----------
export function legLabel(leg) {
  const m = leg.market;
  if (m === 'h2h') return `${leg.name} to win`;
  if (isSpread(m)) return `${leg.name} ${leg.point > 0 ? '+' : ''}${leg.point}`;
  if (isTotal(m)) return `${leg.name} ${leg.point} total points`;
  if (m === 'player_anytime_td') return `${leg.desc} anytime TD`;
  if (isProp(m)) return `${leg.desc} ${leg.name} ${leg.point} ${MARKET_LABEL[m] || m}`;
  return `${leg.desc ? leg.desc + ' ' : ''}${leg.name}${leg.point != null ? ' ' + leg.point : ''}`;
}

// slot = things that cannot both be in one parlay (same side / same total / same player-stat)
export function slotOf(leg) {
  const m = leg.market;
  if (m === 'h2h' || isSpread(m)) return `${leg.eventId}|side`;
  if (isTotal(m)) return `${leg.eventId}|total`;
  if (isProp(m)) return `${leg.eventId}|${normName(leg.desc)}|${m.replace('_alternate', '')}`;
  return `${leg.eventId}|${m}|${leg.desc || ''}`;
}

export function buildLegs(data, injuriesList, opts) {
  const { book, eventIds, includeProps = true, includeAlts = true, includeML = true, includeSpreads = true, includeTotals = true, includeTD = true, allowQuestionable = false, stats = null, useForm = true } = opts;
  const evById = new Map(data.events.map(e => [e.id, e]));
  const cons = buildConsensus(data.events);
  const inj = indexInjuries(injuriesList);
  const legs = [], excluded = [];
  for (const ev of data.events) {
    if (eventIds && !eventIds.includes(ev.id)) continue;
    const b = ev.books?.[book];
    if (!b) continue;
    for (const [mkt, market] of Object.entries(b.m || {})) {
      if (!includeProps && isProp(mkt)) continue;
      if (!includeAlts && mkt.startsWith('alternate_')) continue;
      if (!includeML && mkt === 'h2h') continue;
      if (!includeSpreads && isSpread(mkt)) continue;
      if (!includeTotals && isTotal(mkt)) continue;
      if (!includeTD && mkt === 'player_anytime_td') continue;
      if (!MARKET_LABEL[mkt]) continue;
      for (const o of market.o) {
        if (!(o.p > 1.01)) continue;
        if (isProp(mkt) && o.n === 'No') continue;
        const c = cons[ev.id]?.[outcomeKey(mkt, o)];
        if (!c) continue;
        const leg = {
          id: `${ev.id}~${outcomeKey(mkt, o)}`,
          eventId: ev.id, game: `${ev.away} @ ${ev.home}`, start: ev.start,
          market: mkt, name: o.n, desc: o.d, point: o.pt,
          dec: o.p, p: c.p, nBooks: new Set(c.books).size,
          ev: c.p * o.p - 1,
          link: o.link || market.link || b.link || null,
          sid: o.sid || null, marketSid: market.sid || null, eventSid: b.sid || null,
          notes: []
        };
        leg.label = legLabel(leg);
        if (isProp(mkt)) {
          const i = inj.byPlayer.get(normName(o.d));
          if (i && OUT_RE.test(i.status)) { excluded.push({ leg, why: `${i.player} listed ${i.status}` }); continue; }
          if (i && Q_RE.test(i.status)) {
            if (!allowQuestionable) { excluded.push({ leg, why: `${i.player} listed ${i.status}` }); continue; }
            leg.notes.push(`${i.player} is ${i.status}${i.detail ? ' (' + i.detail + ')' : ''}`);
          }
        }
        // Recent form: shown always; nudges the probability only when useForm is on.
        leg.pMarket = leg.p;
        leg.form = stats ? legForm(leg, stats, evById.get(ev.id)) : null;
        // Player props need evidence: at least 2 recent games and an actual role in them.
        // (Skipped only when stats loaded at all, so a failed ESPN pull doesn't wipe out every prop.)
        if (isProp(mkt) && stats?.players) {
          const sp = stats.players[normName(o.d)];
          const g = (sp?.games || []).slice(0, 5);
          const used = g.filter(x => x.car + x.tgt + (x.py > 0 ? 1 : 0) > 0).length;
          if (g.length < 2) { excluded.push({ leg, why: `${o.d}: no recent game data`, kind: 'nodata' }); continue; }
          if (used === 0) { excluded.push({ leg, why: `${o.d}: no touches or targets in last ${g.length} games`, kind: 'nodata' }); continue; }
        }
        if (useForm && leg.form && leg.form.n >= 2) leg.p = blendForm(leg.pMarket, leg.form);
        // Prices that disagree wildly with every other book are usually stale or mismatched lines.
        if (leg.ev > 0.25) { excluded.push({ leg, why: 'price looks stale vs. other books' }); continue; }
        if (leg.nBooks < 2) leg.notes.push('only one book prices this - fair odds less certain');
        leg.slot = slotOf(leg);
        legs.push(leg);
      }
    }
  }
  return { legs, excluded };
}

// ---------- search ----------
// target = decimal odds wanted (e.g. $10 to win $1000 -> 101.0)
export function findParlays(legs, target, opts = {}) {
  const { maxLegs = 8, minLegs = 1, maxPerGame = 3, sameGame = true, lo = 1.0, hi = 1.3, beam = 400, results = 3, locked = [] } = opts;
  // Locked legs are on every ticket; the search fills in the rest of the payout around them.
  const nL = locked.length;
  const lockD = locked.reduce((a, l) => a + Math.log(l.dec), 0), lockP = locked.reduce((a, l) => a + Math.log(l.p), 0);
  const lockSlots = new Set(locked.map(l => l.slot));
  const lockGame = {}; for (const l of locked) lockGame[l.eventId] = (lockGame[l.eventId] || 0) + 1;
  const lockIds = new Set(locked.map(l => l.id));
  // With a leg minimum (promo requirements), legs must be shorter-priced on average,
  // so let heavier favourites into the pool.
  const rem = target / Math.exp(lockD);   // payout still to find after the locked legs
  const perLeg = Math.pow(Math.max(1.01, rem), 1 / Math.max(1, minLegs - nL));
  const minDec = Math.min(1.08, 1 + (perLeg - 1) * 0.35);
  const logT = Math.log(target);

  // Candidate pool: reasonably priced legs that can contribute without overshooting alone.
  let pool = legs.filter(l => l.ev > -0.12 && l.dec <= rem * hi && l.dec >= minDec && !lockIds.has(l.id) && !lockSlots.has(l.slot)
    && (sameGame || !lockGame[l.eventId]));
  // score each leg by how efficiently it buys odds: log(p)/log(dec) closer to -1 is better
  for (const l of pool) l.eff = Math.log(l.p) / Math.log(l.dec);
  pool.sort((a, b) => b.ev - a.ev);
  pool = pool.slice(0, 260);
  pool.sort((a, b) => a.id < b.id ? -1 : 1);
  if (!pool.length && !nL) return [];

  // best efficiency among top legs - used to estimate the cost of the remaining distance
  const effs = pool.map(l => l.eff).sort((a, b) => b - a);
  const bestEff = effs.length ? effs[Math.min(5, effs.length - 1)] : -1;

  const done = [];
  const consider = s => {
    if (s.idx.length + nL < minLegs || s.idx.length + nL === 0) return;
    const ratio = Math.exp(s.logD - logT);
    if (ratio >= lo && ratio <= hi) done.push(s);
  };
  let states = [{ idx: [], logD: lockD, logP: lockP, slots: new Set(lockSlots), perGame: { ...lockGame }, last: -1 }];
  consider(states[0]);   // the locked legs alone might already be the ticket
  if (nL && done.length) return [summarize(locked)];   // don't pad it with filler legs
  for (let depth = 1; depth <= maxLegs - nL; depth++) {
    const next = [];
    for (const s of states) {
      for (let i = s.last + 1; i < pool.length; i++) {
        const l = pool[i];
        if (s.slots.has(l.slot)) continue;
        const g = s.perGame[l.eventId] || 0;
        if (g >= (sameGame ? maxPerGame : 1)) continue;
        const logD = s.logD + Math.log(l.dec);
        if (logD > logT + Math.log(hi)) continue;
        // can the legs still required by minLegs fit under the payout cap?
        const still = Math.max(0, minLegs - nL - s.idx.length - 1);
        if (still && logD + still * Math.log(minDec) > logT + Math.log(hi)) continue;
        const slots = new Set(s.slots); slots.add(l.slot);
        const ns = { idx: [...s.idx, i], logD, logP: s.logP + Math.log(l.p), slots, perGame: { ...s.perGame, [l.eventId]: g + 1 }, last: i };
        consider(ns);
        next.push(ns);
      }
    }
    if (!next.length) break;
    // estimated final log-probability if we finish efficiently
    for (const s of next) {
      const still = Math.max(0, minLegs - nL - s.idx.length);
      // remaining odds to buy, at least enough for the legs still required
      const need = Math.max(logT - s.logD, still * Math.log(minDec * 1.15));
      s.h = s.logP + Math.max(0, need) * bestEff - 0.01 * s.idx.length;
    }
    next.sort((a, b) => b.h - a.h);
    states = next.slice(0, beam);
  }
  if (!done.length) return [];

  // Rank by win probability, with partial credit for paying a bit more than asked
  // (so a ticket paying 1.2x the target isn't beaten by a hair-better one paying 0.97x).
  const rank = s => s.logP + 0.5 * (s.logD - logT) - 0.002 * s.idx.length;
  done.sort((a, b) => rank(b) - rank(a));
  const picked = [];
  for (const s of done) {
    const idea = i => `${pool[i].slot}|${pool[i].name}|${pool[i].desc || ''}`;
    const ideas = new Set(s.idx.map(idea));
    const tooSimilar = picked.some(p => {
      if (!p.idx.length || !s.idx.length) return !p.idx.length && !s.idx.length;
      const inter = p.idx.filter(i => ideas.has(idea(i))).length;
      return inter / Math.min(p.idx.length, s.idx.length) > 0.5;
    });
    if (!tooSimilar) picked.push(s);
    if (picked.length >= results) break;
  }
  return picked.map(s => summarize([...locked, ...s.idx.map(i => pool[i])]));
}

export function summarize(legs) {
  const dec = legs.reduce((a, l) => a * l.dec, 1);
  const p = legs.reduce((a, l) => a * l.p, 1);
  const pMarket = legs.reduce((a, l) => a * (l.pMarket ?? l.p), 1);
  const games = new Set(legs.map(l => l.eventId));
  return {
    legs, dec, p,
    bookImplied: 1 / dec,
    pMarket,
    ev: pMarket * dec - 1,               // vs the betting market (negative = house edge)
    sameGame: games.size < legs.length,
    games: games.size
  };
}

// ---------- recent form (ESPN game logs) ----------
const STAT_KEY = { player_pass_yds: 'py', player_rush_yds: 'ry', player_reception_yds: 'recy', player_receptions: 'rec', player_pass_tds: 'ptd' };
const STAT_WORD = { py: 'pass yds', ry: 'rush yds', recy: 'rec yds', rec: 'catches', ptd: 'pass TDs' };
const r1 = x => Math.round(x * 10) / 10;
const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const nick = n => (n || '').split(' ').slice(-1)[0];
const lastN = (g, k = 5) => g.slice(0, k);

// Shrink the recent hit rate hard toward the market (8 phantom games at market odds),
// weight it by sample size (5 games = 11%, 10 games = 20%), and never move a leg more
// than ±35% of its market chance. Small samples can't outvote the betting market.
export function blendForm(pMarket, f) {
  const hr = (f.h + 8 * pMarket) / (f.n + 8);
  const w = f.n / (f.n + 40);
  const p = (1 - w) * pMarket + w * hr;
  return Math.min(0.97, Math.max(pMarket * 0.65, Math.min(pMarket * 1.35, p)));
}

function teamLine(stats, name) {
  const t = stats.teams?.[name];
  if (!t || !t.games.length) return null;
  const g = t.games, w = g.filter(x => x.res === 'W').length, l = g.filter(x => x.res === 'L').length;
  return { t, g, w, l, pf: avg(g.map(x => x.pf)), pa: avg(g.map(x => x.pa)), margin: avg(g.map(x => x.pf - x.pa)) };
}

export function legForm(leg, stats, ev) {
  const m = leg.market;
  // --- player props
  if (m.startsWith('player_')) {
    const p = stats.players?.[normName(leg.desc)];
    if (!p) return null;
    const g = lastN(p.games);
    const n = g.length;
    if (!n) return null;
    if (m === 'player_anytime_td') {
      const h = g.filter(x => x.rtd + x.rectd > 0).length;
      const touches = avg(g.map(x => x.car + x.rec)), tgt = avg(g.map(x => x.tgt));
      const usage = p.pos === 'QB' ? `${r1(avg(g.map(x => x.car)))} carries/game`
        : tgt >= 2 && touches - avg(g.map(x => x.rec)) >= 3 ? `${r1(avg(g.map(x => x.car)))} carries + ${r1(tgt)} targets/game`
        : tgt >= 1 ? `${r1(tgt)} targets/game` : `${r1(touches)} touches/game`;
      if (touches === 0 && tgt === 0) return { h, n, text: `${leg.desc} hasn't had a touch or target in his last ${n} game${n > 1 ? 's' : ''} — a deep-roster long shot` };
      return { h, n, text: `${leg.desc} has scored in ${h} of his last ${n} game${n > 1 ? 's' : ''} (${usage})` };
    }
    const k = STAT_KEY[m];
    if (!k) return null;
    const vals = g.map(x => x[k]);
    const over = leg.name === 'Over';
    const h = vals.filter(v => over ? v > leg.point : v < leg.point).length;
    return { h, n, text: `${leg.desc} is averaging ${r1(avg(vals))} ${STAT_WORD[k]} over his last ${n} (${vals.join(', ')}) — ${over ? 'cleared' : 'stayed under'} ${leg.point} in ${h} of ${n}` };
  }
  if (!ev) return null;
  // --- game totals
  if (/totals/.test(m)) {
    const A = teamLine(stats, ev.away), B = teamLine(stats, ev.home);
    if (!A || !B) return null;
    const all = [...lastN(A.g), ...lastN(B.g)].map(x => x.pf + x.pa);
    const over = leg.name === 'Over';
    const h = all.filter(v => over ? v > leg.point : v < leg.point).length;
    return { h, n: all.length,
      text: `${nick(ev.away)} games are averaging ${r1(avg(lastN(A.g).map(x => x.pf + x.pa)))} total points and ${nick(ev.home)} games ${r1(avg(lastN(B.g).map(x => x.pf + x.pa)))}; ${h} of their ${all.length} games went ${over ? 'over' : 'under'} ${leg.point}` };
  }
  // --- moneyline / spreads
  const me = teamLine(stats, leg.name);
  const oppName = leg.name === ev.home ? ev.away : ev.home;
  const op = teamLine(stats, oppName);
  if (!me) return null;
  const g = lastN(me.g);
  const rec = `${nick(leg.name)} are ${me.w}-${me.l} (scoring ${r1(me.pf)}, allowing ${r1(me.pa)})`;
  const opRec = op ? `; ${nick(oppName)} are ${op.w}-${op.l} (scoring ${r1(op.pf)}, allowing ${r1(op.pa)})` : '';
  if (m === 'h2h') {
    return { h: g.filter(x => x.res === 'W').length, n: g.length, text: rec + opRec };
  }
  const pt = leg.point;
  const h = g.filter(x => x.pf - x.pa + pt > 0).length;
  const cover = pt < 0 ? `won by ${Math.ceil(-pt)}+ in ${h} of ${g.length}` : `won or lost by ${Math.floor(pt)} or fewer in ${h} of ${g.length}`;
  return { h, n: g.length, text: `${rec}, and have ${cover}${opRec}` };
}

// ---------- plain-English rationale ----------
const pc = p => p >= 0.1 ? `${Math.round(p * 100)}%` : `${(p * 100).toFixed(1)}%`;
const am = d => { const a = decToAmerican(d); return a > 0 ? `+${a}` : `${a}`; };

// Returns { bullets: [{ label, odds, form, verdict }], closing }
export function explainTicket(t, ctx = {}) {
  const { injuries = [], excludedCount = 0, events = [], stats = null } = ctx;
  const legs = [...t.legs].filter(l => !l.gone).sort((a, b) => a.p - b.p);
  if (!legs.length) return { bullets: [], closing: '' };
  const bullets = legs.map((l, i) => {
    const role = legs.length === 1 ? 'the whole ticket'
      : i === 0 ? `swing leg, ~${Math.round(Math.log(l.dec) / Math.log(t.dec) * 100)}% of the payout`
      : l.p >= 0.55 ? 'likely leg, fine-tunes the price' : 'adds to the price';
    const fm = l.form;
    let verdict = '';
    if (fm && fm.n >= 2) {
      // how surprising is the recent hit rate if the market's number were right? (z-score)
      const hr = fm.h / fm.n, mp = l.pMarket ?? l.p;
      const z = (hr - mp) / Math.sqrt(Math.max(mp * (1 - mp), 0.0025) / fm.n);
      verdict = z > 1 ? 'Form backs it' : z < -1 ? 'Form is against it' : 'Form is in line with the odds';
    }
    // role change: a teammate at the same position is out
    let role2 = '';
    const sp = l.desc && stats?.players?.[normName(l.desc)];
    if (sp) {
      const mates = injuries.filter(i => i.team === sp.team && i.pos === sp.pos && normName(i.player) !== normName(l.desc) && /out|doubtful|reserve/i.test(i.status));
      if (mates.length) role2 = ` With ${mates.slice(0, 2).map(i => `${i.player} (${i.status})`).join(' and ')} out at ${sp.pos}, a bigger role is likely — part of why the price is what it is.`;
    }
    return {
      label: l.label,
      odds: `${am(l.dec)} · ${pc(l.p)} chance · ${role}`,
      form: (fm ? fm.text + '.' : 'No recent game-log data for this one.') + role2,
      verdict
    };
  });

  const parts = [];
  // how the legs relate within a game
  const byGame = {};
  for (const l of legs) (byGame[l.eventId] ||= []).push(l);
  for (const gl of Object.values(byGame)) {
    if (gl.length < 2) continue;
    const over = gl.find(l => /total/.test(l.market) && l.name === 'Over');
    const under = gl.find(l => /total/.test(l.market) && l.name === 'Under');
    const bigFav = gl.find(l => /spread/.test(l.market) && l.point <= -10);
    const dog = gl.find(l => (l.market === 'h2h' || /spread/.test(l.market)) && (l.point > 0 || l.dec > 2.2));
    const td = gl.filter(l => l.market === 'player_anytime_td');
    if (over && (bigFav || td.length)) parts.push(`The legs tell one story — a high-scoring game${bigFav ? ` where the ${nick(bigFav.name)} pull away` : ''}${td.length ? ' with touchdowns to go around' : ''} — so they tend to hit together; the book may trim the same-game price for that.`);
    else if (under && dog) parts.push(`Under + ${nick(dog.name)} pair naturally: a slow, low-scoring game is how an underdog keeps it close.`);
    else if (under && td.length) parts.push(`An Under and a TD prop work slightly against each other (fewer points, fewer TDs), so true odds are a bit worse than shown.`);
  }
  const mkt = legs.reduce((a, l) => a * (l.pMarket ?? l.p), 1);
  const formMoved = Math.abs(t.p - mkt) / mkt > 0.03;
  parts.push(`Overall: about ${pc(t.p)} to cash (1 in ${t.p > 0.5 ? (1 / t.p).toFixed(1) : Math.round(1 / t.p).toLocaleString()})${formMoved ? ` — the betting market alone says ${pc(mkt)}, recent form ${t.p > mkt ? 'nudges it up' : 'nudges it down'}` : ''}.`);

  const teams = new Set(legs.flatMap(l => { const e = events.find(x => x.id === l.eventId); return e ? [e.home, e.away] : []; }));
  const keyOut = injuries.filter(i => teams.has(i.team) && /out|doubtful|reserve/i.test(i.status) && ['QB', 'RB', 'WR', 'TE'].includes(i.pos));
  if (keyOut.length || excludedCount) {
    const names = keyOut.slice(0, 3).map(i => `${i.player} (${i.pos}, ${i.status})`).join(', ');
    parts.push(`Injuries: ${names ? `${names}${keyOut.length > 3 ? ` +${keyOut.length - 3} more` : ''} out — already reflected in the lines` : 'no key skill players out'}${excludedCount ? `; ${excludedCount} prop${excludedCount > 1 ? 's' : ''} on injured players skipped` : ''}.`);
  }
  return { bullets, closing: parts.join(' ') };
}

// ---------- deep links ----------
// FanDuel outcome links look like .../addToBetslip?marketId=42.448600011&selectionId=29165
function fdIds(leg) {
  let marketId = leg.marketSid, selectionId = leg.sid;
  if (leg.link && leg.link.includes('addToBetslip')) {
    try {
      const u = new URL(leg.link);
      marketId = u.searchParams.get('marketId') || marketId;
      selectionId = u.searchParams.get('selectionId') || selectionId;
    } catch { /* ignore */ }
  }
  return marketId && selectionId ? { marketId, selectionId } : null;
}

export function betslipLink(book, legs, cfg) {
  if (book === 'fanduel') {
    const ids = legs.map(fdIds);
    if (ids.every(Boolean)) {
      if (legs.length === 1 && legs[0].link?.includes('addToBetslip')) return { url: legs[0].link, complete: true };
      const qs = ids.map((x, i) => `marketId[${i}]=${encodeURIComponent(x.marketId)}&selectionId[${i}]=${encodeURIComponent(x.selectionId)}`).join('&');
      return { url: `${cfg.fanduelHost}/addToBetslip?${qs}`, complete: true };
    }
  }
  if (book === 'draftkings') {
    // The Odds API returns DK outcome links as https://sportsbook.draftkings.com/?outcomes=0ML84695534_3
    // Multiple selections: join with %2B in one parameter (tested 2026-10-12; ',' fails).
    const outs = legs.map(l => {
      if (l.link && l.link.includes('outcomes=')) {
        try { return new URL(l.link).searchParams.get('outcomes'); } catch { /* fall through */ }
      }
      return l.sid;
    }).filter(Boolean);
    if (outs.length === legs.length) {
      return { url: `${cfg.draftkingsHost}/?outcomes=${outs.map(encodeURIComponent).join('%2B')}`, complete: true }; // verified: %2B-joined loads every leg
    }
  }
  // fallback: deepest link we have for the first leg
  const any = legs.find(l => l.link);
  return { url: any ? any.link : (book === 'fanduel' ? cfg.fanduelHost : cfg.draftkingsHost), complete: false };
}
