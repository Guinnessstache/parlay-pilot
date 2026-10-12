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
function slotOf(leg) {
  const m = leg.market;
  if (m === 'h2h' || isSpread(m)) return `${leg.eventId}|side`;
  if (isTotal(m)) return `${leg.eventId}|total`;
  if (isProp(m)) return `${leg.eventId}|${normName(leg.desc)}|${m.replace('_alternate', '')}`;
  return `${leg.eventId}|${m}|${leg.desc || ''}`;
}

export function buildLegs(data, injuriesList, opts) {
  const { book, eventIds, includeProps = true, includeAlts = true, allowQuestionable = false } = opts;
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
  const { maxLegs = 8, maxPerGame = 3, sameGame = true, lo = 1.0, hi = 1.3, beam = 400, results = 3 } = opts;
  const logT = Math.log(target);

  // Candidate pool: reasonably priced legs that can contribute without overshooting alone.
  let pool = legs.filter(l => l.ev > -0.12 && l.dec <= target * hi && l.dec >= 1.08);
  // score each leg by how efficiently it buys odds: log(p)/log(dec) closer to -1 is better
  for (const l of pool) l.eff = Math.log(l.p) / Math.log(l.dec);
  pool.sort((a, b) => b.ev - a.ev);
  pool = pool.slice(0, 260);
  pool.sort((a, b) => a.id < b.id ? -1 : 1);
  if (!pool.length) return [];

  // best efficiency among top legs - used to estimate the cost of the remaining distance
  const effs = pool.map(l => l.eff).sort((a, b) => b - a);
  const bestEff = effs[Math.min(5, effs.length - 1)];

  const done = [];
  const consider = s => {
    const ratio = Math.exp(s.logD - logT);
    if (ratio >= lo && ratio <= hi) done.push(s);
  };
  let states = [{ idx: [], logD: 0, logP: 0, slots: new Set(), perGame: {}, last: -1 }];
  for (let depth = 1; depth <= maxLegs; depth++) {
    const next = [];
    for (const s of states) {
      for (let i = s.last + 1; i < pool.length; i++) {
        const l = pool[i];
        if (s.slots.has(l.slot)) continue;
        const g = s.perGame[l.eventId] || 0;
        if (g >= (sameGame ? maxPerGame : 1)) continue;
        const logD = s.logD + Math.log(l.dec);
        if (logD > logT + Math.log(hi)) continue;
        const slots = new Set(s.slots); slots.add(l.slot);
        const ns = { idx: [...s.idx, i], logD, logP: s.logP + Math.log(l.p), slots, perGame: { ...s.perGame, [l.eventId]: g + 1 }, last: i };
        consider(ns);
        next.push(ns);
      }
    }
    if (!next.length) break;
    // estimated final log-probability if we finish efficiently
    for (const s of next) s.h = s.logP + Math.max(0, logT - s.logD) * bestEff - 0.01 * s.idx.length;
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
      const inter = p.idx.filter(i => ideas.has(idea(i))).length;
      return inter / Math.min(p.idx.length, s.idx.length) > 0.5;
    });
    if (!tooSimilar) picked.push(s);
    if (picked.length >= results) break;
  }
  return picked.map(s => summarize(s.idx.map(i => pool[i])));
}

export function summarize(legs) {
  const dec = legs.reduce((a, l) => a * l.dec, 1);
  const p = legs.reduce((a, l) => a * l.p, 1);
  const games = new Set(legs.map(l => l.eventId));
  return {
    legs, dec, p,
    bookImplied: 1 / dec,
    ev: p * dec - 1,                     // expected return per $1 (negative = house edge)
    sameGame: games.size < legs.length,
    games: games.size
  };
}

// ---------- plain-English rationale ----------
// Built only from numbers already on the ticket - no invented analysis.
const pc = p => p >= 0.1 ? `${Math.round(p * 100)}%` : `${(p * 100).toFixed(1)}%`;
const am = d => { const a = decToAmerican(d); return a > 0 ? `+${a}` : `${a}`; };
const shortTeam = n => (n || '').split(' ').slice(-1)[0];

function favoriteIn(leg, events) {
  const ev = events.find(e => e.id === leg.eventId);
  return ev ? { home: ev.home, away: ev.away } : null;
}

export function explainTicket(t, ctx = {}) {
  const { target, injuries = [], excludedCount = 0, events = [] } = ctx;
  const legs = [...t.legs].filter(l => !l.gone).sort((a, b) => a.p - b.p);
  if (!legs.length) return '';
  const out = [];

  // 1. what's doing the lifting
  const swing = legs[0];
  const safe = legs.filter(l => l.p >= 0.55);
  if (legs.length === 1) {
    out.push(`A single bet was the cheapest way to reach this payout: ${swing.label} at ${am(swing.dec)} lands about ${pc(swing.p)} of the time, and every extra leg would only add more house margin.`);
  } else {
    const share = Math.log(swing.dec) / Math.log(t.dec);
    out.push(`${swing.label} (${am(swing.dec)}) is the swing leg — it supplies about ${Math.round(share * 100)}% of the payout and hits roughly ${pc(swing.p)} of the time on its own.`);
    const rest = legs.slice(1).filter(l => !safe.includes(l));
    if (rest.length) out.push(`${rest.map(l => `${l.label} (${am(l.dec)}, ~${pc(l.p)})`).join(' and ')} ${rest.length > 1 ? 'push' : 'pushes'} the price the rest of the way.`);
    if (safe.length) out.push(`${safe.map(l => l.label).join(' and ')} ${safe.length > 1 ? 'are' : 'is'} a likely leg (${safe.map(l => pc(l.p)).join(', ')}) added to fine-tune the payout without much extra risk.`);
  }

  // 2. same-game logic (how the legs relate)
  const byGame = {};
  for (const l of legs) (byGame[l.eventId] ||= []).push(l);
  for (const gl of Object.values(byGame)) {
    if (gl.length < 2) continue;
    const over = gl.find(l => /total/.test(l.market) && l.name === 'Over');
    const under = gl.find(l => /total/.test(l.market) && l.name === 'Under');
    const bigFav = gl.find(l => /spread/.test(l.market) && l.point <= -10);
    const dog = gl.find(l => (l.market === 'h2h' || /spread/.test(l.market)) && (l.point > 0 || l.dec > 2.2));
    const td = gl.filter(l => l.market === 'player_anytime_td');
    if (over && (bigFav || td.length)) out.push(`These legs tell one story — a high-scoring game${bigFav ? ` where the ${shortTeam(bigFav.name)} pull away` : ''}${td.length ? ' with touchdowns to go around' : ''} — so they tend to hit together, and the sportsbook may trim the same-game price for that.`);
    else if (under && dog) out.push(`Under + ${shortTeam(dog.name)} pair naturally: a slow, low-scoring game is how underdogs keep it close.`);
    else if (under && td.length) out.push(`Heads-up: an Under and a touchdown prop work slightly against each other (fewer points, fewer TDs), so the true odds of both hitting are a bit worse than shown.`);
  }

  // 3. pricing honesty
  const avgEdge = legs.reduce((a, l) => a + (-l.ev), 0) / legs.length;
  out.push(`${legs.length === 1 ? 'It is' : 'Each leg is'} priced within ${Math.max(1, Math.round(avgEdge * 100))}% of the market's fair odds${legs.length === 1 ? '' : ' on average'}, which is what made this the most efficient combo for ${target ? am(target) : 'your target'}; overall it cashes about ${pc(t.p)} of the time (1 in ${Math.round(1 / t.p)}).`);

  // 4. injuries
  const teams = new Set(legs.flatMap(l => { const g = favoriteIn(l, events); return g ? [g.home, g.away] : []; }));
  const keyOut = injuries.filter(i => teams.has(i.team) && /out|doubtful|reserve/i.test(i.status) && ['QB', 'RB', 'WR', 'TE'].includes(i.pos));
  if (keyOut.length || excludedCount) {
    const names = keyOut.slice(0, 3).map(i => `${i.player} (${i.pos}, ${i.status})`).join(', ');
    out.push(`Injury check: ${names ? `${names}${keyOut.length > 3 ? ` and ${keyOut.length - 3} more` : ''} ${keyOut.length > 1 ? 'are' : 'is'} sidelined — already baked into the lines` : 'no key skill players out'}${excludedCount ? `, and ${excludedCount} prop${excludedCount > 1 ? 's' : ''} on injured players ${excludedCount > 1 ? 'were' : 'was'} skipped` : ''}.`);
  }
  return out.join(' ');
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
