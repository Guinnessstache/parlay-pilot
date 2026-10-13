// Turn bet-slip text (from a screenshot via OCR, or pasted) into trackable legs.
// Pure functions - no DOM - so it can be tested in Node.
import { normName, legLabel } from './engine.js';

const STAT_WORDS = [
  [/receptions?|catches/, 'player_receptions'],
  [/receiving|rec\.?\s*y(ar)?ds|rec yds/, 'player_reception_yds'],
  [/rushing|rush\.?\s*y(ar)?ds|rush yds/, 'player_rush_yds'],
  [/passing|pass\.?\s*y(ar)?ds|pass yds/, 'player_pass_yds']
];
const TD_RE = /anytime|td scorer|touchdown scorer|to score|score a (td|touchdown)|\btd\b/;

const clean = s => s.replace(/[—–−]/g, '-').replace(/[“”]/g, '"').replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim();
const money = s => parseFloat(String(s).replace(/[,$\s]/g, ''));

// ctx: { games: [{home, away, start}], teams: { "<Full Name>": { abbr } }, players: [{ name, team }] }
export function buildIndex(ctx) {
  const teamNames = [...new Set([...(ctx.games || []).flatMap(g => [g.home, g.away]), ...Object.keys(ctx.teams || {})])].filter(Boolean);
  const teams = teamNames.map(full => {
    const w = full.split(' ');
    const nick = w[w.length - 1].toLowerCase();
    const city = w.slice(0, -1).join(' ').toLowerCase();
    const abbr = (ctx.teams?.[full]?.abbr || '').toLowerCase();
    return { full, nick, city, abbr };
  });
  const players = [];
  const seen = new Set();
  for (const p of ctx.players || []) {
    const k = normName(p.name);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    const parts = k.split(' ');
    players.push({ name: p.name, key: k, team: p.team, first: parts[0], last: parts.slice(1).join(' ') });
  }
  return { teams, players, games: ctx.games || [] };
}

function findTeams(line, idx) {
  const l = ` ${line.toLowerCase()} `;
  const hits = [];
  for (const t of idx.teams) {
    let pos = -1;
    const nickRe = new RegExp(`\\b${t.nick}\\b`);
    const m = l.match(nickRe);
    if (m) pos = m.index;
    else if (t.abbr && new RegExp(`\\b${t.abbr}\\b`).test(l) && !/\b(over|under)\b/.test(t.abbr)) pos = l.search(new RegExp(`\\b${t.abbr}\\b`));
    if (pos >= 0) hits.push({ team: t.full, pos });
  }
  return hits.sort((a, b) => a.pos - b.pos);
}

function findPlayer(line, idx) {
  const l = normName(line.replace(/[^A-Za-z.' -]/g, ' '));
  const squashed = l.replace(/[^a-z]/g, '');               // OCR often drops the space: "KelekiLatu"
  let best = null;
  for (const p of idx.players) {
    let pos = l.indexOf(p.key);
    if (pos < 0 && p.last) {
      const ini = `${p.first[0]} ${p.last}`;           // "d knox" (after normName strips the dot)
      pos = l.indexOf(ini);
    }
    if (pos < 0) {
      const sq = p.key.replace(/[^a-z]/g, '');
      if (sq.length >= 8 && squashed.includes(sq)) pos = squashed.indexOf(sq);
    }
    if (pos >= 0 && (!best || p.key.length > best.p.key.length)) best = { p, pos };
  }
  return best?.p || null;
}

function gameFor(teamA, teamB, idx) {
  const now = Date.now();
  const cands = idx.games.filter(g => [g.home, g.away].includes(teamA) && (!teamB || [g.home, g.away].includes(teamB)));
  // closest to now (bets are usually on this week's games)
  return cands.sort((a, b) => Math.abs(Date.parse(a.start) - now) - Math.abs(Date.parse(b.start) - now))[0] || null;
}

export function parseSlip(raw, ctx) {
  const idx = buildIndex(ctx);
  const lines = String(raw || '').split(/\r?\n/).map(clean).filter(Boolean);
  const low = lines.map(l => l.toLowerCase());
  const out = { book: null, stake: null, payout: null, odds: null, legs: [], notes: [] };

  // ---- book
  const all = low.join(' ');
  if (/draft\s?kings|\bdk\b|sgpx?\b|pick sgp/.test(all)) out.book = 'draftkings';
  if (/fan\s?duel|same game parlay\+?|\bfd\b/.test(all)) out.book = out.book || 'fanduel';
  // wording hints when the logo isn't in the screenshot
  if (!out.book && /\bto pay\b/.test(all)) out.book = 'draftkings';
  if (!out.book && /to return|total payout|spread betting/.test(all)) out.book = 'fanduel';

  // ---- money: "Wager: $10.00  To Pay: $110.40", or labels on one line and amounts on the next
  const LABEL = /(wager|stake|risk|bet amount|total wager)|(to pay|payout|potential payout|to return|returns?|total payout)|(to win|potential win|win)/;
  for (let i = 0; i < low.length; i++) {
    const pairs = [...low[i].matchAll(/(wager|stake|risk|bet amount|total wager|to pay|payout|potential payout|to return|returns?|total payout|to win|potential win)\s*:?\s*\$\s*([\d,]+(?:\.\d{1,2})?)/g)];
    for (const [, lab, amt] of pairs) assignMoney(out, lab, money(amt));
    if (!pairs.length && LABEL.test(low[i]) && !/\$/.test(low[i])) {
      const labs = [...low[i].matchAll(/(total wager|wager|stake|risk|bet amount|to pay|total payout|potential payout|payout|to return|returns?|to win|potential win)/g)].map(m => m[1]);
      const amtsOf = j => (j >= 0 && j < low.length && !/cash ?out/.test(low[j])) ? [...low[j].matchAll(/\$\s*([\d,]+(?:\.\d{1,2})?)/g)].map(m => money(m[1])) : [];
      // FanDuel prints "$5.00 $693.87" above "TOTAL WAGER TOTAL PAYOUT"; DraftKings/others print amounts below
      const above = amtsOf(i - 1), below = amtsOf(i + 1);
      const amts = above.length >= labs.length ? above : below.length ? below : above;
      labs.forEach((lab, k) => { if (amts[k] != null) assignMoney(out, lab, amts[k]); });
    }
  }
  // ---- overall odds: biggest +/- number of 3+ digits on a line that isn't a leg line with a point
  const oddsCands = low.flatMap(l => [...l.matchAll(/(?:^|\s)([+-]\d{3,6})(?:\s|$)/g)].map(m => +m[1]));
  if (oddsCands.length) out.odds = oddsCands.sort((a, b) => Math.abs(b) - Math.abs(a))[0];

  // ---- game headers: lines with two teams ("Bills @ Rams", "BUF Bills @ LA Rams")
  const headers = [];
  low.forEach((l, i) => {
    const t = findTeams(l, idx);
    // "Bills @ Rams", "BUF Bills @ LA Rams", or DraftKings' "BUF  Today 8:15 PM  LAR" (two teams, no bet on the line)
    const looksLikeBet = /\b(over|under)\b|[+-]\d{1,2}(\.\d)?\b(?!\d)|moneyline|spread/.test(l);
    if (t.length >= 2 && (/@|\bvs\.?\b|\bat\b/.test(l) || !looksLikeBet)) {
      const g = gameFor(t[0].team, t[1].team, idx);
      if (g) headers.push({ i, g });
    }
  });
  let lastHeaderDist = null;
  const nearestGame = i => {
    if (!headers.length) return null;
    // prefer the next header at/after this line (both apps print the game under its legs), else the previous one
    const after = headers.find(h => h.i >= i);
    const h = after || headers[headers.length - 1];
    lastHeaderDist = Math.abs(h.i - i);
    return h.g;
  };

  // ---- legs
  const used = new Set();
  const push = (leg, i) => {
    const k = `${leg.market}|${leg.name}|${leg.desc || ''}|${leg.point ?? ''}`;
    if (used.has(k)) return;
    used.add(k);
    leg.label = legLabel(leg);
    leg.line = i;
    out.legs.push(leg);
  };

  for (let i = 0; i < lines.length; i++) {
    const l = low[i];
    if (headers.some(h => h.i === i)) continue;
    const ctxText = [low[i], low[i + 1] || '', low[i + 2] || ''].join(' | ');
    const near = low[i + 1] || '';

    // milestone props: "Puka Nacua 80+ Receiving Yds"
    let m = l.match(/(\d+)\s*\+\s*(receptions?|rec(?:eiving)?\.?\s*y(?:ar)?ds?|rush(?:ing)?\.?\s*y(?:ar)?ds?|pass(?:ing)?\.?\s*y(?:ar)?ds?|receiving|rushing|passing)/);
    if (m) {
      const p = findPlayer(lines[i], idx);
      const mk = STAT_WORDS.find(([re]) => re.test(m[2]))?.[1];
      if (p && mk) { push(withGame({ market: mk, name: 'Over', point: +m[1] - 0.5, desc: p.name }, i, p), i); continue; }
    }

    // over / under
    m = l.match(/\b(over|under|o|u)\s*\(?\s*(\d{1,3}(?:\.\d)?)\s*\)?/);
    if (m && !/\$/.test(l.slice(m.index, m.index + 12))) {
      const side = m[1].startsWith('o') ? 'Over' : 'Under';
      const point = +m[2];
      const p = findPlayer(lines[i], idx) || (STAT_WORDS.some(([re]) => re.test(near)) ? findPlayer(lines[i - 1] || '', idx) : null);
      const statMk = STAT_WORDS.find(([re]) => re.test(ctxText))?.[1];
      if (p && statMk) { push(withGame({ market: statMk, name: side, point, desc: p.name }, i, p), i); continue; }
      if (!p) { push(withGame({ market: 'totals', name: side, point }, i), i); continue; }
    }

    // anytime TD: player on this line, TD wording on this or the next line
    const p = findPlayer(lines[i], idx);
    if (p && TD_RE.test(`${l} ${near}`) && !/\b(over|under)\b/.test(l)) { push(withGame({ market: 'player_anytime_td', name: 'Yes', desc: p.name }, i, p), i); continue; }

    // team bets
    const t = findTeams(l, idx);
    if (t.length === 1) {
      const team = t[0].team;
      const sp = l.slice(t[0].pos).match(/([+-]\d{1,2}(?:\.\d)?)(?!\d)/);
      if (sp && Math.abs(+sp[1]) < 60 && !/moneyline|money line/.test(ctxText)) { push(withGame({ market: 'spreads', name: team, point: +sp[1] }, i, null, team), i); continue; }
      if (/moneyline|money line|to win|winner|\bml\b/.test(`${l} ${near}`)) { push(withGame({ market: 'h2h', name: team }, i, null, team), i); continue; }
    }
  }

  function withGame(leg, i, player, team) {
    let g = null, src = null;
    if (team) { g = gameFor(team, null, idx); src = 'team'; }
    if (!g && player?.team) { g = gameFor(player.team, null, idx); src = 'player'; }
    if (!g) { g = nearestGame(i); src = g ? (lastHeaderDist <= 3 ? 'header-near' : 'header') : null; }
    if (g) Object.assign(leg, { home: g.home, away: g.away, start: g.start, game: `${g.away} @ ${g.home}` });
    leg.gameSrc = src;
    return leg;
  }

  // Legs that name a team or player pin down the game for sure. If they all agree (a same-game
  // parlay), legs that only had a nearby header or nothing (e.g. "Under 61.5") belong to that game too.
  const anchors = out.legs.filter(l => l.gameSrc === 'team' || l.gameSrc === 'player');
  const keys = [...new Set(anchors.map(l => l.game))];
  if (keys.length === 1) {
    const a = anchors[0];
    for (const l of out.legs) if (l.gameSrc === 'header' || !l.gameSrc) Object.assign(l, { home: a.home, away: a.away, start: a.start, game: a.game, gameSrc: 'parlay' });
  }

  // ---- totals check
  if (out.stake && !out.payout && out.toWin) out.payout = out.stake + out.toWin;
  if (out.stake && out.payout) out.dec = out.payout / out.stake;
  else if (out.odds) out.dec = out.odds > 0 ? 1 + out.odds / 100 : 1 + 100 / -out.odds;
  out.legs.filter(l => !l.home).forEach(l => out.notes.push(`Couldn't tell which game "${l.label}" is from — pick it below.`));
  return out;
}

function assignMoney(out, lab, v) {
  if (!Number.isFinite(v)) return;
  if (/wager|stake|risk|bet amount/.test(lab)) out.stake ??= v;
  else if (/to win|potential win/.test(lab)) out.toWin ??= v;
  else out.payout ??= v;
}
