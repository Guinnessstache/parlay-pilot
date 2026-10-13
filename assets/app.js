import { CONFIG } from './config.js';
import { getScoreboard, getBoardFor, matchGame, gradeLeg, legChance } from './live.js';
import { parseSlip } from './slipscan.js';
import {
  BOOK_NAMES, MARKET_LABEL, buildLegs, findParlays, summarize, betslipLink,
  fmtAmerican, indexInjuries, teamInjuryNotes, legLabel, explainTicket, normName
} from './engine.js';

const $ = s => document.querySelector(s);
const state = { data: null, injuries: [], inj: null, book: CONFIG.defaultBook, selected: new Set() };

// ---------- formatting ----------
const money = n => n >= 1000 ? `$${Math.round(n).toLocaleString()}` : `$${(Math.round(n * 100) / 100).toLocaleString(undefined, { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
const pct = p => p >= 0.1 ? `${(p * 100).toFixed(0)}%` : p >= 0.01 ? `${(p * 100).toFixed(1)}%` : `${(p * 100).toFixed(2)}%`;
const oneIn = p => `1 in ${p > 0.5 ? (1 / p).toFixed(1) : Math.round(1 / p).toLocaleString()}`;
const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
const sameLocalDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
function ago(iso) {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} hr ago` : `${Math.round(h / 24)} days ago`;
}
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 2200);
}
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));


function nextRefresh() {
  const { hoursUTC, minute, days } = CONFIG.refreshSchedule || {};
  if (!hoursUTC) return null;
  const now = Date.now();
  for (let d = 0; d < 8; d++) for (const h of hoursUTC) {
    const t = new Date(); t.setUTCDate(t.getUTCDate() + d); t.setUTCHours(h, minute, 0, 0);
    if (t > now && days.includes(t.getUTCDay())) return t;
  }
  return null;
}
function isOwner() {
  const m = location.search.match(/[?&]owner=([01])/);
  try { if (m) localStorage.setItem('pp-owner', m[1]); return localStorage.getItem('pp-owner') === '1'; }
  catch { return m?.[1] === '1'; }
}

// ---------- data ----------
async function loadData() {
  const bust = `?t=${Math.floor(Date.now() / 60000)}`;
  const [odds, inj, stats] = await Promise.all([
    fetch(`data/odds.json${bust}`).then(r => r.json()),
    fetch(`data/injuries.json${bust}`).then(r => r.json()).catch(() => ({ injuries: [] })),
    fetch(`data/stats.json${bust}`).then(r => r.ok ? r.json() : null).catch(() => null)
  ]);
  state.stats = stats;
  state.data = odds;
  state.injuries = inj.injuries || [];
  state.inj = indexInjuries(state.injuries);
  $('#demo-banner').hidden = !odds.demo;
  const fresh = $('#freshness');
  const stale = (Date.now() - Date.parse(odds.generated_at)) / 60000 > CONFIG.staleAfterMinutes;
  fresh.classList.toggle('stale', stale);
  const nxt = nextRefresh();
  fresh.innerHTML = `<span class="dot"></span>Odds &amp; injuries updated ${ago(odds.generated_at)}` +
    (nxt ? `<br>Next auto-update ${dayFmt.format(nxt)}` : '') +
    (isOwner() ? `<a class="owner-refresh" target="_blank" rel="noopener" href="https://github.com/${CONFIG.repo}/actions/workflows/${CONFIG.workflowFile}" title="Opens GitHub: click 'Run workflow' (~9 credits). New odds appear in ~1 min.">↻ Refresh odds</a>` : '');
}
const isPractice = () => $('#practice')?.checked;
const started = e => Date.parse(e.start) <= Date.now() - 5 * 60e3;
const finished = e => { const g = matchGame(e, state.board); return g?.state === 'post'; };
// Practice mode adds games already underway (not finished) using the last odds snapshot.
const upcoming = () => (state.data?.events || []).filter(e => !started(e) || (isPractice() && !finished(e)))
  .sort((a, b) => (started(b) - started(a)) || Date.parse(a.start) - Date.parse(b.start));

// ---------- natural-language parsing ----------
const NUM = String.raw`\$?\s*(\d[\d,]*(?:\.\d+)?)\s*(k)?`;
const toNum = (n, k) => parseFloat(n.replace(/,/g, '')) * (k ? 1000 : 1);
const DAY_WORDS = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, mnf: 1, tnf: 4, snf: 0 };

function parsePrompt(text) {
  const t = ` ${text.toLowerCase()} `;
  const out = {};
  let m;
  // practice mode must be on before games are resolved, so live games are matchable
  if (/\bpractice\b|in progress|\blive\b|already started|mid.?game/.test(t) && !$('#practice').checked) { $('#practice').checked = true; }
  if ((m = t.match(new RegExp(String.raw`(?:bet|wager|risk|put|stake|with)\s+(?:about\s+)?${NUM}`)))) out.stake = toNum(m[1], m[2]);
  if ((m = t.match(new RegExp(String.raw`(?:turn|make)\s+${NUM}\s+(?:dollars\s+)?into\s+${NUM}`)))) {
    out.stake = toNum(m[1], m[2]); out.win = toNum(m[3], m[4]); out.mode = 'total';
  } else if ((m = t.match(new RegExp(String.raw`(?:into|pay(?:s|out)?(?:\s+of)?|return(?:\s+of)?)\s+${NUM}`)))) {
    out.win = toNum(m[1], m[2]); out.mode = 'total';
  } else if ((m = t.match(new RegExp(String.raw`(?:win|profit|make|get)\s+(?:about\s+|like\s+)?${NUM}`)))) {
    out.win = toNum(m[1], m[2]); out.mode = 'profit';
  }
  if (out.stake == null) {
    const all = [...t.matchAll(/\$\s*(\d[\d,]*(?:\.\d+)?)(k)?/g)].map(x => toNum(x[1], x[2]));
    if (all.length >= 1) out.stake = all[0];
    if (all.length >= 2 && out.win == null) { out.win = all[1]; out.mode = 'profit'; }
  }
  if ((m = t.match(/\+(\d{3,6})\b/)) && out.stake) { out.win = out.stake * parseInt(m[1]) / 100; out.mode = 'profit'; }
  if ((m = t.match(/(\d+(?:\.\d+)?)\s*(?:x|to\s*1)\b/)) && out.stake && out.win == null) { out.win = out.stake * parseFloat(m[1]); out.mode = 'total'; }

  if (/fan\s?duel|\bfd\b/.test(t)) out.book = 'fanduel';
  if (/draft\s?kings|\bdk\b/.test(t)) out.book = 'draftkings';
  if (/\bpractice\b|in progress|\blive\b|already started|mid.?game/.test(t)) out.practice = true;
  out.props = !/no (?:player )?props|without props|game lines only/.test(t);  // each request resets it
  // bet types: "no moneyline", "no spreads", "no ML or spreads", "props only", "totals and props only"
  const only = t.match(/\b((?:(?:props?|totals?|spreads?|moneylines?|ml)(?:\s*(?:,|and|&|\+|or)\s*)?)+)\s+only\b|\bonly\s+((?:(?:props?|totals?|spreads?|moneylines?|ml)(?:\s*(?:,|and|&|\+|or)\s*)?)+)/);
  if (only) {
    const w = only[1] || only[2];
    out.ml = /moneyline|\bml\b/.test(w); out.spreads = /spread/.test(w); out.totals = /total/.test(w); out.props = /prop/.test(w);
  } else {
    const neg = t.match(/\b(?:no|without|skip|exclude)\s+((?:(?:the\s+)?(?:props?|totals?|spreads?|moneylines?|ml|alt(?:ernate)? lines?|(?:anytime\s+)?(?:tds?|touchdowns?))(?:\s*(?:,|and|&|or|\/)\s*)?)+)/g) || [];
    const n = neg.join(' ');
    out.ml = !/moneyline|\bml\b/.test(n); out.spreads = !/spread/.test(n); out.totals = !/total/.test(n);
    if (/prop/.test(n)) out.props = false;
    out.alts = !/alt/.test(n);
  }
  out.tds = !(/\b(?:tds?|touchdowns?)\b/.test((t.match(/\b(?:no|without|skip|exclude)\s+[^.;]*/g) || []).join(' ')) || /no anytime/.test(t));
  out.sgp = !/no same.?game|different games|no sgp/.test(t);
  // leg counts: "3-5 legs", "exactly 4 legs", "at least 4 legs", "4+ legs", "minimum 3 legs", "max 5 legs", "4 legs"
  const cap = n => Math.max(1, Math.min(CONFIG.maxLegsCap, n));
  if ((m = t.match(/(\d+)\s*(?:-|to)\s*(\d+)\s*legs?/))) { out.minLegs = cap(+m[1]); out.maxLegs = cap(+m[2]); }
  else if ((m = t.match(/exactly\s+(\d+)\s*legs?/))) { out.minLegs = out.maxLegs = cap(+m[1]); }
  else if ((m = t.match(/(?:at least|minimum(?: of)?|min)\s+(\d+)\s*legs?|(\d+)\s*\+\s*legs?|(\d+)\s*or more legs?/))) { out.minLegs = cap(+(m[1] || m[2] || m[3])); }
  else if ((m = t.match(/(?:at most|maximum(?: of)?|max|up to|no more than)\s+(\d+)\s*legs?/))) { out.maxLegs = cap(+m[1]); }
  else if ((m = t.match(/(\d+)\s*-?\s*legs?/))) { out.minLegs = out.maxLegs = cap(+m[1]); }

  // which games
  const games = upcoming();
  const now = new Date();
  let ids = null;
  // Nicknames first ("Rams"); fall back to city ("Los Angeles") only if no nickname matched.
  const parts = team => { const w = team.toLowerCase().split(' '); return { nick: w[w.length - 1], city: w.slice(0, -1).join(' ') }; };
  let teamHits = games.filter(g => [g.home, g.away].some(team => new RegExp(`\\b${parts(team).nick}\\b`).test(t)));
  if (!teamHits.length) teamHits = games.filter(g => [g.home, g.away].some(team => { const c = parts(team).city; return c.length > 3 && t.includes(c); }));
  // A named team means its next game, not every game it has on the board.
  if (teamHits.length) {
    const seenTeams = new Set();
    teamHits = teamHits.sort((a, b) => Date.parse(a.start) - Date.parse(b.start)).filter(g => {
      const named = [g.home, g.away].filter(team => new RegExp(`\\b${parts(team).nick}\\b`).test(t) || t.includes(parts(team).city));
      if (named.every(n => seenTeams.has(n))) return false;
      named.forEach(n => seenTeams.add(n));
      return true;
    });
  }
  if (teamHits.length) ids = teamHits.map(g => g.id);
  else if (/tonight|today/.test(t)) ids = games.filter(g => sameLocalDay(new Date(g.start), now)).map(g => g.id);
  else {
    for (const [w, d] of Object.entries(DAY_WORDS)) {
      if (new RegExp(`\\b${w}`).test(t)) {
        const inWeek = games.filter(g => { const s = new Date(g.start); return s.getDay() === d && s - now < 7 * 864e5; });
        // Monday night games kick off after midnight UTC; local getDay() handles that
        ids = (ids || []).concat(inWeek.map(g => g.id));
      }
    }
    if (/this week|all games|whole slate|any game/.test(t)) ids = games.map(g => g.id);
  }
  if (ids) out.games = [...new Set(ids)];
  if (/tonight|today/.test(t) && ids && !ids.length) out.noneTonight = true;
  return out;
}

// ---------- form ----------

function practiceTicketPre(t) { return t.legs.some(l => l.start && Date.parse(l.start) <= Date.now() - 5 * 60e3); }
function liveBadge(ev) {
  const g = matchGame(ev, state.board);
  if (!g) return '<span class="live-dot">LIVE</span>';
  const ab = n => n.split(' ').slice(-1)[0];
  return `<span class="live-dot">LIVE</span> ${esc(g.detail)} · ${esc(ab(g.away))} ${g.awayScore} – ${esc(ab(g.home))} ${g.homeScore}`;
}
function setBook(b) {
  state.book = b;
  document.querySelectorAll('#book button').forEach(x => x.setAttribute('aria-checked', String(x.dataset.v === b)));
}
function renderGames() {
  const box = $('#games');
  const games = upcoming();
  if (!games.length) { box.innerHTML = '<p class="empty-games">No upcoming games in the current odds snapshot.</p>'; return; }
  box.innerHTML = games.map(g => {
    const notes = teamInjuryNotes(g.home, state.inj).concat(teamInjuryNotes(g.away, state.inj))
      .filter(i => /out|ir|reserve|doubtful/i.test(i.status) && ['QB', 'RB', 'WR', 'TE'].includes(i.pos));
    const qbOut = notes.find(i => i.pos === 'QB');
    const has = state.selected.has(g.id);
    const bookHas = !!g.books?.[state.book];
    return `<label class="game ${has ? 'on' : ''}" title="${bookHas ? '' : BOOK_NAMES[state.book] + ' has no lines for this game yet'}">
      <input type="checkbox" value="${esc(g.id)}" ${has ? 'checked' : ''} ${bookHas ? '' : 'disabled'}>
      <span><span class="when">${started(g) ? liveBadge(g) : esc(dayFmt.format(new Date(g.start)))}</span><br>${esc(g.away)} <span class="muted">@</span> ${esc(g.home)}
      ${notes.length ? `<br><span class="inj">${qbOut ? `QB ${esc(qbOut.player)} ${esc(qbOut.status)}` : `${notes.length} key skill player${notes.length > 1 ? 's' : ''} out`}</span>` : ''}</span>
    </label>`;
  }).join('');
  box.querySelectorAll('input').forEach(i => i.addEventListener('change', () => {
    i.checked ? state.selected.add(i.value) : state.selected.delete(i.value);
    i.closest('.game').classList.toggle('on', i.checked);
    countGames();
  }));
  countGames();
}
function countGames() { $('#games-count').textContent = state.selected.size ? `· ${state.selected.size} selected` : '· none selected = all'; }
function selectScope(scope) {
  const games = upcoming().filter(g => g.books?.[state.book]);
  const now = new Date();
  let ids = [];
  if (scope === 'live') ids = games.filter(g => started(g)).map(g => g.id);
  if (scope === 'tonight') ids = games.filter(g => sameLocalDay(new Date(g.start), now) && (!started(g) || isPractice())).map(g => g.id);
  if (scope === 'next') ids = games.slice(0, 1).map(g => g.id);
  if (scope === 'week') ids = games.map(g => g.id);
  if (scope === 'tonight' && !ids.length) toast('No games tonight — showing the next game');
  if (!ids.length && games.length) ids = [games[0].id];
  state.selected = new Set(ids);
  renderGames();
}
function applyParsed(p) {
  if (p.stake) $('#stake').value = p.stake;
  if (p.win) $('#win').value = Math.round(p.win * 100) / 100;
  if (p.mode) $('#mode').value = p.mode;
  if (p.book) setBook(p.book);
  if (p.practice && !$('#practice').checked) { $('#practice').checked = true; $('.more').open = true; }
  if (p.props != null) $('#props').checked = p.props;
  for (const k of ['ml', 'spreads', 'totals', 'alts', 'tds']) if (p[k] != null) $('#' + k).checked = p[k];
  if (['ml', 'spreads', 'totals', 'props', 'alts', 'tds'].some(k => p[k] === false)) $('.more').open = true;
  if (p.sgp != null) $('#sgp').checked = p.sgp;
  {
    // each request sets the leg range; unmentioned = default 1-6
    const mn = p.minLegs || 1, mx = Math.max(p.maxLegs || Math.max(6, mn), mn);
    $('#minlegs').value = mn; $('#maxlegs').value = mx;
    if (mn > 1) $('.more').open = true;
  }
  if (p.games) { state.selected = new Set(p.games); renderGames(); }
}

function legRange() {
  const clamp = v => Math.max(1, Math.min(CONFIG.maxLegsCap, parseInt(v) || 1));
  const mn = clamp($('#minlegs').value), mx = Math.max(mn, clamp($('#maxlegs').value));
  return { minLegs: mn, maxLegs: mx };
}
function readForm() {
  const stake = parseFloat($('#stake').value);
  const win = parseFloat($('#win').value);
  const mode = $('#mode').value;
  return {
    stake, win, mode, book: state.book,
    target: mode === 'profit' ? 1 + win / stake : win / stake,
    games: [...state.selected],
    props: $('#props').checked, alts: $('#alts').checked, sgp: $('#sgp').checked,
    ml: $('#ml').checked, spreads: $('#spreads').checked, totals: $('#totals').checked, tds: $('#tds').checked,
    questionable: $('#questionable').checked, form: $('#form-weight').checked, ...legRange()
  };
}

// ---------- generate ----------
function generate(q) {
  const res = $('#results');
  if (!(q.stake > 0) || !(q.win > 0)) { res.innerHTML = '<div class="notice bad">Enter how much you want to bet and how much you want to win.</div>'; return; }
  if (q.target < 1.05) { res.innerHTML = '<div class="notice bad">That payout is less than your bet back. Raise the "to win" amount.</div>'; return; }
  const eventIds = q.games.length ? q.games : null;
  const { legs, excluded } = buildLegs(state.data, state.injuries, {
    book: q.book, eventIds, includeProps: q.props, includeAlts: q.alts, includeML: q.ml, includeSpreads: q.spreads, includeTotals: q.totals, includeTD: q.tds, allowQuestionable: q.questionable,
    stats: state.stats, useForm: q.form
  });
  const nGames = new Set(legs.map(l => l.eventId)).size;
  let tickets = findParlays(legs, q.target, { maxLegs: q.maxLegs, minLegs: q.minLegs, sameGame: q.sgp, maxPerGame: q.sgp ? Math.max(2, q.minLegs, Math.min(q.maxLegs, 5)) : 1 });
  let widened = false;
  if (!tickets.length) { // retry with a looser payout window
    tickets = findParlays(legs, q.target, { maxLegs: q.maxLegs, minLegs: q.minLegs, sameGame: q.sgp, maxPerGame: q.sgp ? Math.max(5, q.minLegs) : 1, lo: 0.85, hi: 1.8 });
    widened = tickets.length > 0;
  }

  const header = `<div class="head"><h2>Your best shots</h2><span class="sub">${money(q.stake)} → ${money(q.stake * q.target)} payout · ${fmtAmerican(q.target)} · ${legs.length} lines across ${nGames} game${nGames === 1 ? '' : 's'} on ${BOOK_NAMES[q.book]}</span></div>`;
  if (!tickets.length) {
    // Explain *why*: games that only have main lines posted, and the most they can pay.
    const chosen = (eventIds || upcoming().map(g => g.id)).map(id => state.data.events.find(e => e.id === id)).filter(Boolean);
    const thin = chosen.filter(e => Object.keys(e.books?.[q.book]?.m || {}).every(k => ['h2h', 'spreads', 'totals'].includes(k)));
    const best = (ev, keys) => Math.max(1, ...keys.flatMap(k => (ev.books?.[q.book]?.m?.[k]?.o || []).map(o => o.p)));
    const sideKeys = [q.ml && 'h2h', q.spreads && 'spreads'].filter(Boolean);
    const maxDec = chosen.slice(0, q.maxLegs).reduce((a, e) => {
      const side = sideKeys.length ? best(e, sideKeys) : 1, tot = q.totals ? best(e, ['totals']) : 1;
      return a * (q.sgp ? side * tot : Math.max(side, tot));
    }, 1);
    const rich = upcoming().filter(e => Object.keys(e.books?.[q.book]?.m || {}).some(k => !['h2h', 'spreads', 'totals'].includes(k)));
    let msg = `Couldn't reach ${fmtAmerican(q.target)} from ${nGames} game${nGames === 1 ? '' : 's'}${q.sgp ? '' : ' (same-game legs are off)'}.`;
    if (thin.length) msg += ` ${thin.map(e => `${esc(e.away)} @ ${esc(e.home)}`).slice(0, 2).join(' and ')}${thin.length > 2 ? ` (+${thin.length - 2} more)` : ''} only ${thin.length > 1 ? 'have' : 'has'} game lines posted so far — alt lines and player props load about 12 hours before kickoff. With just those${!q.ml || !q.spreads || !q.totals ? ' (and your bet-type filters)' : ''}, the most ${nGames === 1 ? 'this game' : 'these games'} can pay is about ${fmtAmerican(maxDec)}.`;
    else if (q.minLegs > 1 && !q.sgp && q.minLegs > nGames) msg += ` A ${q.minLegs}-leg minimum with same-game legs off needs at least ${q.minLegs} games — pick more games or turn same-game legs on.`;
    else if (q.minLegs > 1) msg += ` With at least ${q.minLegs} legs, each leg has to be a short price — try lowering the minimum, adding games, or raising the target.`;
    else if (!q.ml || !q.spreads || !q.totals || !q.props || !q.tds) msg += ` Some bet types are switched off (${[!q.ml && 'moneyline', !q.spreads && 'spreads', !q.totals && 'totals', !q.props && 'props', !q.tds && 'anytime TDs'].filter(Boolean).join(', ')}) — turning one back on, adding games or changing the target will help.`;
    else msg += ' Try adding games, raising max legs, or lowering the target.';
    const fixes = [];
    if (rich.length && thin.length) fixes.push(`<button type="button" class="btn" data-fix="rich">Use ${rich.length === 1 ? `${esc(rich[0].away)} @ ${esc(rich[0].home)}` : `the ${rich.length} games with props`}</button>`);
    if (upcoming().length > nGames) fixes.push(`<button type="button" class="btn" data-fix="all">Use all ${upcoming().length} games</button>`);
    res.innerHTML = header + `<div class="notice bad">${msg}${fixes.length ? `<div class="fixes">${fixes.join('')}</div>` : ''}</div>`;
    res.querySelectorAll('[data-fix]').forEach(b => b.addEventListener('click', () => {
      state.selected = new Set((b.dataset.fix === 'rich' ? rich : upcoming()).filter(g => g.books?.[q.book]).map(g => g.id));
      renderGames();
      $('#form').requestSubmit();
    }));
    return;
  }
  const notes = [];
  if (widened) notes.push(`<div class="notice">Nothing landed right on your number, so these are the closest tickets available.</div>`);
  if (q.target > 50) notes.push(`<div class="notice info">At ${fmtAmerican(q.target)} the best realistic ticket hits about ${oneIn(tickets[0].p)} times. These are the cheapest-priced ways to get there, not likely winners.</div>`);
  const outCount = excluded.filter(e => /listed/.test(e.why)).length;
  const noData = [...new Set(excluded.filter(e => e.kind === 'nodata').map(e => e.leg.desc))].filter(n => !/D\/ST|Defense/.test(n));
  if (noData.length) notes.push(`<div class="notice info">Left out ${noData.length} player${noData.length > 1 ? 's' : ''} with no recent game data or no role in recent games: ${noData.slice(0, 5).map(esc).join(', ')}${noData.length > 5 ? ` and ${noData.length - 5} more` : ''}.</div>`);
  if (outCount) notes.push(`<div class="notice">Skipped ${outCount} prop line${outCount > 1 ? 's' : ''} on injured players (${[...new Set(excluded.filter(e => /listed/.test(e.why)).map(e => e.why))].slice(0, 3).map(esc).join('; ')}${outCount > 3 ? '…' : ''}).</div>`);

  res.innerHTML = header + notes.join('');
  tickets.forEach((t, i) => res.appendChild(renderTicket(t, q, i === 0 ? 'Best chance' : `Option ${i + 1}`, { excludedCount: outCount })));
  gradePractice();
  res.scrollIntoView({ behavior: 'smooth', block: 'start' });
}


// ---------- practice-mode live grading ----------
const ICON = { won: '✓', lost: '✗', ahead: '▲', behind: '▼', pending: '•' };
const WORD = { won: 'Won', lost: 'Lost', ahead: 'On track', behind: 'Behind', pending: 'Pending' };
async function gradePractice() {
  clearTimeout(gradePractice.t);
  const cards = [...document.querySelectorAll('.ticket[data-practice="1"]')];
  if (!cards.length) return;
  state.board = await getScoreboard();
  let anyLive = false;
  for (const card of cards) {
    const t = card._ticket;
    const items = card.querySelectorAll('.t-legs li');
    const res = [];
    for (let i = 0; i < t.legs.length; i++) {
      const l = t.legs[i];
      const ev = state.data.events.find(e => e.id === l.eventId);
      const r = ev ? await gradeLeg(l, ev, state.board) : { status: 'pending', text: '' };
      r.chance = ev ? await legChance(l, ev, state.board, l.pMarket ?? l.p) : null;
      if (r.chance != null && (r.status === 'ahead' || r.status === 'behind') && (/totals/.test(l.market) || l.market.startsWith('player_'))) r.status = r.chance >= 0.5 ? 'ahead' : 'behind';
      res.push(r);
      const g = ev && matchGame(ev, state.board);
      if (g?.state === 'in') anyLive = true;
      let chip = items[i]?.querySelector('.grade');
      if (items[i] && !chip) { chip = document.createElement('span'); chip.className = 'grade'; items[i].appendChild(chip); }
      if (chip) { chip.className = `grade ${r.status}`; chip.innerHTML = `${ICON[r.status]} ${WORD[r.status]}${r.text ? ' · ' + esc(r.text) : ''}${r.chance != null && r.status !== 'won' && r.status !== 'lost' ? ` <b class="lc">${pctTxt(r.chance)}</b>` : ''}`; }
    }
    const lost = res.some(r => r.status === 'lost'), allWon = res.every(r => r.status === 'won');
    const alive = res.filter(r => r.status !== 'lost').length;
    let sum = card.querySelector('.t-practice-status');
    if (!sum) { sum = document.createElement('div'); sum.className = 't-practice-status'; card.querySelector('.t-practice').after(sum); }
    const ev0 = state.data.events.find(e => e.id === t.legs[0].eventId);
    const g0 = ev0 && matchGame(ev0, state.board);
    sum.className = `t-practice-status ${allWon ? 'won' : lost ? 'lost' : ''}`;
    sum.textContent = (g0 ? `${g0.detail} · ${g0.away.split(' ').pop()} ${g0.awayScore} – ${g0.home.split(' ').pop()} ${g0.homeScore} · ` : '') +
      (allWon ? 'TICKET WON' : lost ? 'Ticket lost' : `${res.filter(r => r.status === 'won').length} of ${res.length} legs won, ${alive} still alive`) +
      (!allWon && !lost && res.every(r => r.chance != null) ? ` · live chance ${pctTxt(res.reduce((a, r) => a * r.chance, 1))}` : '');
  }
  if (anyLive) gradePractice.t = setTimeout(gradePractice, 30000); // refresh every 30s while a game is live
}


// ---------- My tickets (saved on this device) ----------
const MINE_KEY = 'pp-mine-v1';
function loadMine() {
  let list;
  try { list = JSON.parse(localStorage.getItem(MINE_KEY) || '[]'); } catch { return []; }
  let fixed = false;
  for (const x of list) {
    if (!x.scanned || x.repaired) continue;
    const key = l => `${l.home}|${l.away}|${l.start}`;
    const named = x.legs.filter(l => !/totals/.test(l.market) && l.home);
    const games = [...new Set(named.map(key))];
    if (games.length === 1) {
      const g = named[0];
      for (const l of x.legs) if (/totals/.test(l.market) && key(l) !== games[0]) { Object.assign(l, { home: g.home, away: g.away, start: g.start }); x.result = null; fixed = true; }
    }
    x.repaired = true;
  }
  if (fixed) try { localStorage.setItem(MINE_KEY, JSON.stringify(list)); } catch {}
  return list;
}
function storeMine(list) { try { localStorage.setItem(MINE_KEY, JSON.stringify(list)); } catch { toast("Couldn't save — browser storage is blocked"); } updateMineCount(); }
const ticketKey = (t, q) => `${q.book}|${t.legs.map(l => l.id).sort().join(',')}|${q.stake}`;
function isTracked(t, q) { return loadMine().some(x => x.key === ticketKey(t, q)); }
function trackTicket(t, q, { practice = false, quiet = false } = {}) {
  const list = loadMine();
  const key = ticketKey(t, q);
  if (list.some(x => x.key === key)) return false;
  const evs = new Map(state.data.events.map(e => [e.id, e]));
  list.unshift({
    key, savedAt: new Date().toISOString(), book: q.book, stake: q.stake, dec: t.dec, p: t.p, practice,
    legs: t.legs.filter(l => !l.gone).map(l => {
      const e = evs.get(l.eventId) || {};
      return { id: l.id, eventId: l.eventId, market: l.market, name: l.name, desc: l.desc, point: l.point, dec: l.dec, label: l.label, p: l.p,
        home: e.home, away: e.away, start: e.start || l.start };
    }),
    result: null // set once every leg is settled
  });
  storeMine(list.slice(0, 200));
  if (!quiet) toast(practice ? 'Practice ticket saved to My tickets' : 'Saved to My tickets');
  return true;
}
function untrack(key) { storeMine(loadMine().filter(x => x.key !== key)); }
function updateMineCount() {
  const n = loadMine().length;
  $('#mine-count').textContent = n ? `(${n})` : '';
}
function openMine() {
  $('#mine').hidden = false;
  renderMine();
  $('#mine').scrollIntoView({ behavior: 'smooth', block: 'start' });
}


// pre-game chance for a leg we didn't price ourselves (scanned slips): look it up in the odds snapshot
function prePFor(l) {
  if (l.p != null) return l.p;
  if (l.market !== 'player_anytime_td' || !l.desc) return null;
  const ev = state.data?.events.find(e => e.home === l.home && e.away === l.away);
  const ps = [];
  for (const b of Object.values(ev?.books || {})) for (const o of b.m?.player_anytime_td?.o || []) if (o.d && normName(o.d) === normName(l.desc) && o.p > 1) ps.push(1 / o.p / 1.2);
  return ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : null;
}
// never round a live (unsettled) chance to 0% or 100% - that reads as already lost / won
const pctTxt = p => p >= 1 ? '100%' : p <= 0 ? '0%' : p >= 0.995 ? '>99%' : p < 0.001 ? '<0.1%' : p >= 0.1 ? `${Math.round(p * 100)}%` : `${(p * 100).toFixed(1)}%`;
function sparkline(hist) {
  if (!hist || hist.length < 2) return '';
  const w = 110, h = 26, t0 = hist[0][0], t1 = hist.at(-1)[0] || t0 + 1;
  const pts = hist.map(([t, p]) => `${((t - t0) / Math.max(1, t1 - t0) * w).toFixed(1)},${(h - 2 - p * (h - 4)).toFixed(1)}`).join(' ');
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
}

const RICON = { won: '✓', lost: '✗', ahead: '▲', behind: '▼', pending: '•' };
const RWORD = { won: 'Won', lost: 'Lost', ahead: 'On track', behind: 'Behind', pending: 'Pending' };

function mineTotals(list) {
  const real = list.filter(x => !x.practice);
  const settled = real.filter(x => x.result);
  const won = settled.filter(x => x.result === 'won');
  const staked = settled.reduce((a, x) => a + x.stake, 0);
  const returned = won.reduce((a, x) => a + x.stake * x.dec, 0);
  const pending = real.length - settled.length;
  const pr = list.filter(x => x.practice && x.result);
  return { n: real.length, settled: settled.length, won: won.length, staked, returned, net: returned - staked, pending,
    expected: settled.filter(x => x.p).reduce((a, x) => a + x.p, 0), withP: settled.filter(x => x.p).length, prWon: pr.filter(x => x.result === 'won').length, prN: pr.length };
}

function renderMine() {
  const list = loadMine();
  const T = mineTotals(list);
  $('#mine-totals').innerHTML = list.length ? `
    <div><span class="k">Record</span><span class="v">${T.won}–${T.settled - T.won}</span></div>
    <div><span class="k">Staked</span><span class="v">${money(T.staked)}</span></div>
    <div><span class="k">Returned</span><span class="v">${money(T.returned)}</span></div>
    <div><span class="k">Net</span><span class="v ${T.net >= 0 ? 'pos' : 'neg'}">${T.net >= 0 ? '+' : '−'}${money(Math.abs(T.net))}</span></div>
    <p class="mine-sub">${mineSub(T)}</p>` : '';
  $('#mine-list').innerHTML = list.length ? list.map(x => `
    <article class="mine-item ${x.result || ''}" data-key="${esc(x.key)}" data-book="${esc(x.book)}">
      <header>
        <span class="mi-odds">${fmtAmerican(x.dec)}</span>
        <span class="mi-meta">${money(x.stake)} → ${money(x.stake * x.dec)} · ${esc(BOOK_NAMES[x.book] || x.book)}${x.practice ? ' · <b class="pr">PRACTICE</b>' : ''}${x.scanned ? ' · 📷 scanned' : ''}</span>
        <span class="mi-status">${x.result === 'won' ? '✓ WON' : x.result === 'lost' ? '✗ LOST' : '…'}</span>
        <span class="mi-score"></span>
      </header>
      <ol>${x.legs.map((l, i) => `<li><span class="pick">${esc(l.label)}</span> <span class="muted">${l.dec ? fmtAmerican(l.dec) : ''}</span>
        <span class="mi-game muted">${l.home ? `${esc(l.away)} @ ${esc(l.home)} · ${esc(dayFmt.format(new Date(l.start)))}` : 'No game set'}${x.scanned ? `<span class="mi-fixwrap" hidden> · <button type="button" class="linkish mi-fix" data-i="${i}">change game</button></span>` : ''}</span>
        <span class="grade pending" data-i="${i}">• checking…</span></li>`).join('')}</ol>
      <footer><span class="muted">Saved ${esc(new Date(x.savedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}</span>
        <span>${x.scanned ? '<button type="button" class="linkish mi-edit">Change games</button> ' : ''}<button type="button" class="btn ghost mi-remove">Remove</button></span></footer>
    </article>`).join('') : '<p class="muted">No tickets yet. Build one and tap <b>☆ Track</b> or <b>Open in…</b>.</p>';
  $('#mine-list').querySelectorAll('.mi-edit').forEach(b => b.addEventListener('click', () => {
    const card = b.closest('.mine-item');
    const show = card.querySelector('.mi-fixwrap')?.hidden;
    card.querySelectorAll('.mi-fixwrap').forEach(w => (w.hidden = !show));
    b.textContent = show ? 'Done' : 'Change games';
  }));
  $('#mine-list').querySelectorAll('.mi-fix').forEach(b => b.addEventListener('click', () => {
    const key = b.closest('.mine-item').dataset.key, i = +b.dataset.i;
    const games = sortedGames(scanContext().games);
    const sel = document.createElement('select');
    sel.className = 'sc-game';
    sel.innerHTML = '<option value="">Pick the game…</option>' + games.map((g, k) => `<option value="${k}">${esc(gameLabel(g))}</option>`).join('');
    b.replaceWith(sel);
    sel.focus();
    sel.addEventListener('change', () => {
      const g = games[+sel.value]; if (!g) return;
      const list = loadMine(), x = list.find(t => t.key === key);
      // a same-game parlay: move every leg that was on the old game
      const old = `${x.legs[i].home}|${x.legs[i].away}|${x.legs[i].start}`;
      x.legs.forEach(l => { if (`${l.home}|${l.away}|${l.start}` === old || !l.home || l === x.legs[i]) Object.assign(l, { home: g.home, away: g.away, start: g.start }); });
      x.result = null;
      storeMine(list); renderMine(); toast('Game updated');
    });
  }));
  $('#mine-list').querySelectorAll('.mi-remove').forEach(b => b.addEventListener('click', () => {
    untrack(b.closest('.mine-item').dataset.key); renderMine();
  }));
  gradeMine();
}

async function gradeMine() {
  clearTimeout(gradeMine.t);
  if ($('#mine').hidden) return;
  const list = loadMine();
  let anyLive = false, changed = false;
  for (const x of list) {
    const card = $('#mine-list').querySelector(`.mine-item[data-key="${CSS.escape(x.key)}"]`);
    const res = [];
    for (let i = 0; i < x.legs.length; i++) {
      const l = x.legs[i];
      const ev = { home: l.home, away: l.away, start: l.start };
      const board = await getBoardFor(l.start);
      const g = matchGame(ev, board);
      if (g?.state === 'in') anyLive = true;
      const r = await gradeLeg(l, ev, board);
      r.chance = await legChance(l, ev, board, prePFor(l));
      if (r.chance != null && (r.status === 'ahead' || r.status === 'behind') && (/totals/.test(l.market) || l.market.startsWith('player_'))) r.status = r.chance >= 0.5 ? 'ahead' : 'behind';
      res.push(r);
      const chip = card?.querySelector(`.grade[data-i="${i}"]`);
      if (chip) { chip.className = `grade ${r.status}`; chip.innerHTML = `${RICON[r.status]} ${RWORD[r.status]}${r.text ? ' · ' + esc(r.text) : ''}${g && g.state !== 'pre' ? ` (${esc(g.detail)})` : ''}${r.chance != null && r.status !== 'won' && r.status !== 'lost' ? ` <b class="lc">${pctTxt(r.chance)}</b>` : ''}`; }
    }
    // whole-ticket live chance + trend
    const known = res.every(r => r.chance != null);
    const tp = known ? res.reduce((a, r) => a * r.chance, 1) : null;
    if (tp != null) {
      x.hist = x.hist || [];
      const last = x.hist.at(-1);
      if (!last || Math.abs(last[1] - tp) > 0.003 || Date.now() - last[0] > 120000) { x.hist.push([Date.now(), +tp.toFixed(4)]); x.hist = x.hist.slice(-80); changed = true; }
    }
    if (card) {
      // live score badge(s): one per game on the ticket
      const seenG = new Map();
      for (const l of x.legs) {
        const k = `${l.home}|${l.away}|${l.start}`;
        if (seenG.has(k) || !l.home) continue;
        seenG.set(k, matchGame({ home: l.home, away: l.away, start: l.start }, await getBoardFor(l.start)) || { pre: true, ...l });
      }
      const ab = n => state.stats?.teams?.[n]?.abbr || (n || '').split(' ').pop().slice(0, 3).toUpperCase();
      const badge = g => g.pre || g.state === 'pre'
        ? `<span class="sc pre"><span class="sc-top">${esc(dayFmt.format(new Date(g.start)))}</span><span class="sc-row">${ab(g.away)} @ ${ab(g.home)}</span></span>`
        : `<span class="sc ${g.state === 'in' ? 'live' : 'final'}"><span class="sc-top">${g.state === 'in' ? `<i class="live-dot">LIVE</i> ${esc(g.detail.replace(' - ', ' '))}` : 'FINAL'}</span><span class="sc-row">${ab(g.away)} <b>${g.awayScore}</b> <span class="muted">–</span> ${ab(g.home)} <b>${g.homeScore}</b></span></span>`;
      card.querySelector('.mi-score').innerHTML = [...seenG.values()].map(badge).join('');
      let lc = card.querySelector('.mi-live');
      if (!lc) { lc = document.createElement('div'); lc.className = 'mi-live'; card.querySelector('ol').before(lc); }
      lc.innerHTML = tp == null ? '' : `<span class="k">${res.some(r => r.status !== 'pending') || anyLive ? 'Live chance to win' : 'Chance to win'} <button type="button" class="info" data-info="live" aria-label="What is this?">i</button></span><span class="v">${pctTxt(tp)}</span>${sparkline(x.hist)}`;
    }
    const result = res.some(r => r.status === 'lost') ? 'lost' : res.length && res.every(r => r.status === 'won') ? 'won' : null;
    if (result !== x.result) { x.result = result; changed = true; }
    if (card) {
      card.className = `mine-item ${result || ''}`;
      card.querySelector('.mi-status').textContent = result === 'won' ? '✓ WON' : result === 'lost' ? '✗ LOST'
        : `${res.filter(r => r.status === 'won').length}/${res.length} won · ${res.filter(r => r.status !== 'lost').length} alive`;
    }
  }
  if (changed) { storeMine(list); renderMineHeader(list); }
  if (anyLive) gradeMine.t = setTimeout(gradeMine, 30000);
}
function renderMineHeader(list) {
  const T = mineTotals(list);
  const el = $('#mine-totals');
  el.querySelectorAll('.v')[0] && (el.querySelectorAll('.v')[0].textContent = `${T.won}–${T.settled - T.won}`);
  el.querySelectorAll('.v')[1] && (el.querySelectorAll('.v')[1].textContent = money(T.staked));
  el.querySelectorAll('.v')[2] && (el.querySelectorAll('.v')[2].textContent = money(T.returned));
  const n = el.querySelectorAll('.v')[3];
  if (n) { n.textContent = `${T.net >= 0 ? '+' : '−'}${money(Math.abs(T.net))}`; n.className = `v ${T.net >= 0 ? 'pos' : 'neg'}`; }
  const sub = el.querySelector('.mine-sub');
  if (sub) sub.textContent = mineSub(T);
}
function mineSub(T) {
  return `${T.pending ? `${T.pending} ticket${T.pending > 1 ? 's' : ''} still open. ` : ''}${T.withP ? `Expected wins at the odds: ${T.expected.toFixed(1)} of ${T.withP}. ` : ''}${T.prN ? `Practice: ${T.prWon} of ${T.prN} won.` : ''}`;
}


// ---------- add tickets from a screenshot (OCR runs on this device) ----------
const TESS_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/tesseract.min.js';
let tessWorker = null;
function loadScript(src) {
  return new Promise((ok, bad) => { if (window.Tesseract) return ok(); const el = document.createElement('script'); el.src = src; el.onload = ok; el.onerror = () => bad(new Error('Could not load the text reader')); document.head.appendChild(el); });
}
async function getWorker(onProgress) {
  await loadScript(TESS_URL);
  if (!tessWorker) tessWorker = await window.Tesseract.createWorker('eng', 1, { logger: m => m.status === 'recognizing text' && onProgress?.(m.progress) });
  return tessWorker;
}
// upscale small screenshots, grayscale, flip dark-mode slips to dark-on-light, stretch contrast
async function prepImage(file) {
  const img = await createImageBitmap(file);
  const scale = img.width < 1000 ? 2 : 1;
  const c = document.createElement('canvas');
  c.width = img.width * scale; c.height = img.height * scale;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0, c.width, c.height);
  const d = g.getImageData(0, 0, c.width, c.height), px = d.data;
  let sum = 0;
  for (let i = 0; i < px.length; i += 4) { const y = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]; px[i] = px[i + 1] = px[i + 2] = y; sum += y; }
  const dark = sum / (px.length / 4) < 110;
  for (let i = 0; i < px.length; i += 4) { let y = px[i]; if (dark) y = 255 - y; y = Math.max(0, Math.min(255, (y - 128) * 1.4 + 128)); px[i] = px[i + 1] = px[i + 2] = y; }
  g.putImageData(d, 0, 0);
  return c;
}
function scanContext() {
  const games = [...state.data.events.map(e => ({ home: e.home, away: e.away, start: e.start })),
    ...(state.board || []).map(g => ({ home: g.home, away: g.away, start: g.start }))];
  const seen = new Set();
  const uniq = games.filter(g => { const k = `${g.home}|${g.away}|${g.start?.slice(0, 10)}`; if (seen.has(k)) return false; seen.add(k); return true; });
  const players = [
    ...Object.values(state.stats?.players || {}).map(p => ({ name: p.name, team: p.team })),
    ...state.data.events.flatMap(e => Object.values(e.books || {}).flatMap(b => Object.entries(b.m || {}).filter(([k]) => k.startsWith('player_')).flatMap(([, m]) => m.o.map(o => ({ name: o.d }))))).filter(p => p.name)
  ];
  return { games: uniq, teams: state.stats?.teams || {}, players };
}

// games for pickers: in progress first, then upcoming by kickoff, then finished (most recent first)
function gameState(g) { return matchGame(g, state.board)?.state || (Date.parse(g.start) > Date.now() ? 'pre' : 'post'); }
function sortedGames(games) {
  const rank = g => ({ in: 0, pre: 1, post: 2 })[gameState(g)] ?? 1;
  return [...games].sort((a, b) => rank(a) - rank(b) || (rank(a) === 2 ? Date.parse(b.start) - Date.parse(a.start) : Date.parse(a.start) - Date.parse(b.start)));
}
function gameLabel(g) {
  const st = gameState(g), b = matchGame(g, state.board);
  return `${g.away} @ ${g.home} · ${st === 'in' ? `LIVE ${b?.detail || ''}` : st === 'post' ? `Final · ${dayFmt.format(new Date(g.start))}` : dayFmt.format(new Date(g.start))}`;
}
async function scanFiles(files) {
  const box = $('#scan');
  box.hidden = false;
  for (const f of files) {
    box.innerHTML = `<p class="scan-status">Reading ${esc(f.name || 'screenshot')}… <span id="scan-pct">0%</span><br><span class="muted">First time loads the text reader (~5 MB). Your image stays on this device.</span></p>`;
    try {
      const w = await getWorker(p => { const el = $('#scan-pct'); if (el) el.textContent = `${Math.round(p * 100)}%`; });
      const canvas = await prepImage(f);
      const { data } = await w.recognize(canvas);
      await reviewScan(data.text, URL.createObjectURL(f));
    } catch (e) {
      box.innerHTML = `<div class="notice bad">Couldn't read that image (${esc(e.message)}). You can paste the slip text instead.</div>`;
      return;
    }
  }
}

// amounts come straight off the slip; only ask when the slip didn't show one
function amountField(id, label, v) {
  return v != null && v > 0
    ? `<span class="sc-amt" id="${id}" data-v="${v}">${label} <b>${money(v)}</b></span>`
    : `<label>${label} $<input id="${id}" type="number" step="0.01" placeholder="not found"></label>`;
}
function readAmount(box, sel) {
  const el = box.querySelector(sel);
  return el?.dataset?.v ? parseFloat(el.dataset.v) : parseFloat(el?.value);
}
function reviewScan(text, thumb) {
  return new Promise(done => {
    const box = $('#scan');
    const ctx = scanContext();
    ctx.games = sortedGames(ctx.games);
    const gameOpts = ctx.games.map((g, i) => `<option value="${i}">${esc(gameLabel(g))}</option>`).join('');
    const render = () => {
      const r = parseSlip(box.querySelector('textarea')?.value ?? text, ctx);
      const book = r.book || state.book;
      box.innerHTML = `
        <div class="scan-grid">
          ${thumb ? `<img class="scan-thumb" src="${thumb}" alt="Your screenshot">` : ''}
          <div class="scan-body">
            <h3>Check what we read</h3>
            <div class="scan-row">
              <label>Book <select id="sc-book"><option value="draftkings" ${book === 'draftkings' ? 'selected' : ''}>DraftKings</option><option value="fanduel" ${book === 'fanduel' ? 'selected' : ''}>FanDuel</option></select></label>
              ${amountField('sc-stake', 'Wager', r.stake)}
              ${amountField('sc-pay', 'Payout', r.payout ?? (r.stake && r.dec ? +(r.stake * r.dec).toFixed(2) : null))}
            </div>
            ${r.legs.length ? `<ol class="scan-legs">${r.legs.map((l, i) => `
              <li data-i="${i}"><label><input type="checkbox" checked> <b>${esc(l.label)}</b></label>
                ${l.game ? `<span class="muted">${esc(l.game)}</span>` : `<select class="sc-game"><option value="">Which game?</option>${gameOpts}</select>`}</li>`).join('')}</ol>`
              : '<div class="notice">No legs recognised. Fix the text below (one leg per line works best, e.g. "Bills -3.5", "Over 44.5", "Dawson Knox anytime TD") and tap Re-read.</div>'}
            <details class="scan-text"><summary>Text we read (edit if something's wrong)</summary>
              <textarea rows="8">${esc(box.querySelector('textarea')?.value ?? text)}</textarea>
              <button type="button" class="btn" id="sc-reread">Re-read text</button></details>
            <div class="scan-actions">
              <button type="button" class="btn primary" id="sc-save" ${r.legs.length ? '' : 'disabled'}>Save ticket</button>
              <button type="button" class="btn ghost" id="sc-cancel">Cancel</button>
            </div>
          </div>
        </div>`;
      box.querySelector('#sc-reread').addEventListener('click', render);
      box.querySelector('#sc-cancel').addEventListener('click', () => { box.hidden = true; box.innerHTML = ''; done(); });
      box.querySelector('#sc-save').addEventListener('click', () => {
        const stake = readAmount(box, '#sc-stake'), pay = readAmount(box, '#sc-pay');
        const legs = [];
        box.querySelectorAll('.scan-legs li').forEach(li => {
          if (!li.querySelector('input[type=checkbox]').checked) return;
          const l = { ...r.legs[+li.dataset.i] };
          const sel = li.querySelector('.sc-game');
          if (sel) { const g = ctx.games[+sel.value]; if (!g) return; Object.assign(l, { home: g.home, away: g.away, start: g.start, game: `${g.away} @ ${g.home}` }); }
          legs.push({ id: `scan|${l.market}|${l.name}|${l.desc || ''}|${l.point ?? ''}`, market: l.market, name: l.name, desc: l.desc, point: l.point, dec: null, label: l.label, home: l.home, away: l.away, start: l.start });
        });
        if (!legs.length) { toast('Tick at least one leg (and pick its game)'); return; }
        if (!(stake > 0)) { toast('Enter the wager'); return; }
        const list = loadMine();
        list.unshift({ key: `scan-${Date.now()}`, savedAt: new Date().toISOString(), book: box.querySelector('#sc-book').value, stake,
          dec: pay > 0 ? pay / stake : (r.dec || 1), p: null, practice: false, scanned: true, legs, result: null });
        storeMine(list.slice(0, 200));
        toast(`Saved ${legs.length}-leg ticket`);
        box.hidden = true; box.innerHTML = '';
        renderMine();
        done();
      });
    };
    render();
  });
}

// ---------- ticket rendering ----------
function renderTicket(t, q, title, opts = {}) {
  const node = $('#ticket-tpl').content.firstElementChild.cloneNode(true);
  node.dataset.book = q.book;
  node.querySelector('.t-rank').textContent = `${title} · ${t.legs.length} leg${t.legs.length > 1 ? 's' : ''}${t.sameGame ? ' · same-game' : ''}`;
  node.querySelector('.t-american').textContent = fmtAmerican(t.dec);
  node.querySelector('.t-book').textContent = BOOK_NAMES[q.book];
  node.querySelector('.t-stake').textContent = money(q.stake);
  node.querySelector('.t-payout').textContent = money(q.stake * t.dec);
  node.querySelector('.t-chance').textContent = `${pct(t.p)} · ${oneIn(t.p)}`;
  node.querySelector('.t-meter .fill').style.width = `${Math.max(0.5, Math.min(100, t.p * 100))}%`;
  const edge = -t.ev;
  node.querySelector('.t-meter-label').textContent = edge > 0 ? `House edge ${(edge * 100).toFixed(1)}%` : `Pays ${(t.ev * 100).toFixed(1)}% more than other books' average`;

  const ol = node.querySelector('.t-legs');
  for (const l of t.legs) {
    const li = document.createElement('li');
    if (l.gone) li.className = 'gone';
    li.innerHTML = `<span class="pick">${esc(l.label)}</span>
      <span class="px">${fmtAmerican(l.dec)}<small>${pct(l.p)} real</small></span>
      <span class="meta">${esc(MARKET_LABEL[l.market] || l.market)} · ${esc(l.game)} · ${esc(dayFmt.format(new Date(l.start)))}${l.link ? ` · <a class="single" href="${esc(l.link)}" target="_blank" rel="noopener">open leg</a>` : ''}</span>
      ${l.notes.concat(l.moved ? [l.moved] : []).map(n => `<span class="note">${esc(n)}</span>`).join('')}`;
    ol.appendChild(li);
  }

  const whyData = explainTicket(t, { injuries: state.injuries, events: state.data.events, stats: state.stats, excludedCount: opts.excludedCount || 0 });
  node.querySelector('.t-summary').innerHTML = whyData.bullets.length ? `
    <ul>${whyData.bullets.map(b => `<li><b>${esc(b.label)}</b> <span class="w-odds">${esc(b.odds)}</span><br>${esc(b.form)}${b.verdict ? ` <span class="verdict ${/backs/.test(b.verdict) ? 'up' : /against/.test(b.verdict) ? 'down' : ''}">${esc(b.verdict)}</span>` : ''}</li>`).join('')}</ul>
    <p>${esc(whyData.closing)}</p>` : '';

  const warn = node.querySelector('.t-warn');
  const w = [];
  if (t.sameGame) w.push(`${BOOK_NAMES[q.book]} re-prices same-game legs for correlation, so the slip may show different odds than ${fmtAmerican(t.dec)}.`);
  const started = t.legs.filter(l => Date.parse(l.start) < Date.now());
  if (started.length && !practiceTicketPre(t)) w.push('A game on this ticket has started — pre-game prices no longer apply.');
  for (const gid of new Set(t.legs.map(l => l.eventId))) {
    const ev = state.data.events.find(e => e.id === gid);
    if (!ev) continue;
    const qbs = teamInjuryNotes(ev.home, state.inj).concat(teamInjuryNotes(ev.away, state.inj)).filter(i => i.pos === 'QB' && /out|doubtful|questionable|reserve/i.test(i.status));
    for (const qb of qbs) w.push(`${qb.team} QB ${qb.player} is ${qb.status} — check the line reflects it.`);
  }
  if (opts.extraWarnings) w.push(...opts.extraWarnings);
  warn.innerHTML = w.map(x => `<li>${esc(x)}</li>`).join('');

  const live = t.legs.filter(l => !l.gone);
  const link = betslipLink(q.book, live, CONFIG);
  const open = node.querySelector('.t-open');
  const practiceTicket = t.legs.some(l => l.start && Date.parse(l.start) <= Date.now() - 5 * 60e3);
  if (practiceTicket) {
    node.classList.add('practice');
    open.replaceWith(Object.assign(document.createElement('span'), { className: 'btn disabled', textContent: 'Practice only — can\'t be placed', title: 'A game on this ticket has started. Prices are from before kickoff, so this ticket is for tracking only.' }));
    const banner = document.createElement('div');
    banner.className = 't-practice';
    banner.innerHTML = '<b>PRACTICE TICKET</b> — built from pre-kickoff prices for a game already underway. Not placeable; legs are graded live below.';
    node.querySelector('.t-head').after(banner);
    node.dataset.practice = '1';
    node._ticket = t;
  }
  open.href = link.url;
  open.textContent = link.complete ? `Open in ${BOOK_NAMES[q.book]}` : `Go to ${BOOK_NAMES[q.book]}`;
  if (!link.complete) open.title = 'This book did not return bet-slip IDs for every leg — add them using the "open leg" links.';


  const trackBtn = node.querySelector('.t-track');
  const markTracked = () => { trackBtn.textContent = '★ Tracked'; trackBtn.classList.add('on'); };
  if (isTracked(t, q)) markTracked();
  trackBtn.addEventListener('click', () => {
    if (isTracked(t, q)) { untrack(ticketKey(t, q)); trackBtn.textContent = '☆ Track'; trackBtn.classList.remove('on'); toast('Removed from My tickets'); return; }
    trackTicket(t, q, { practice: node.dataset.practice === '1' }); markTracked();
  });
  const openBtn = node.querySelector('.t-open');
  if (openBtn) openBtn.addEventListener('click', () => {
    if (trackTicket(t, q, { quiet: true })) { markTracked(); toast("Saved to My tickets — tap ★ Tracked to remove if you don't place it"); }
  });
  node.querySelector('.t-share').addEventListener('click', () => shareTicket(t, q));
  const whyBtn = node.querySelector('.t-why'), why = node.querySelector('.t-why-body');
  whyBtn.addEventListener('click', () => {
    if (why.hidden) why.innerHTML = explain(t, q);
    why.hidden = !why.hidden;
  });
  return node;
}

function explain(t, q) {
  const rows = t.legs.map(l => `<tr><td>${esc(l.label)}</td><td class="n">${fmtAmerican(l.dec)}</td><td class="n">${pct(1 / l.dec)}</td><td class="n">${pct(l.p)}</td><td class="n">${l.nBooks}</td></tr>`).join('');
  return `<p>Each leg's <b>real chance</b> is the average of what ${t.legs[0]?.nBooks > 2 ? 'several sportsbooks (sharp books weighted higher)' : 'the books we track'} imply once their margin is removed. The ticket's real chance is those multiplied together; the payout is ${BOOK_NAMES[q.book]}'s prices multiplied together. Among every combination that pays about ${money(q.stake * q.target)}, this one keeps the most of your money's value — usually fewer legs, each priced close to fair.</p>
  <table><thead><tr><th>Leg</th><th>Price</th><th>Book says</th><th>Real</th><th>Books</th></tr></thead><tbody>${rows}</tbody></table>
  <p>Expected return: ${money(q.stake * (1 + t.ev))} back per ${money(q.stake)} bet, on average.${t.sameGame ? ' Same-game legs are treated as independent here; in reality they are correlated, which the sportsbook prices in.' : ''}</p>`;
}

// ---------- sharing ----------
const b64e = s => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64d = s => decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/'))));

async function shareTicket(t, q) {
  const payload = { v: 1, b: q.book, s: q.stake, w: q.win, m: q.mode, l: t.legs.map(l => [l.id, l.dec]), at: state.data.generated_at };
  const url = `${location.origin}${location.pathname}#t=${b64e(JSON.stringify(payload))}`;
  const text = `${money(q.stake)} to pay ${money(q.stake * t.dec)} (${fmtAmerican(t.dec)}) — ${t.legs.length}-leg NFL parlay on ${BOOK_NAMES[q.book]}`;
  if (navigator.share && /Mobi|Android|iPhone/i.test(navigator.userAgent)) {
    try { await navigator.share({ title: CONFIG.siteName, text, url }); return; } catch { /* fall through to copy */ }
  }
  try { await navigator.clipboard.writeText(url); toast('Share link copied'); }
  catch { prompt('Copy this link:', url); }
}

function loadShared(hash) {
  let p;
  try { p = JSON.parse(b64d(hash)); } catch { return false; }
  if (!p || p.v !== 1 || !Array.isArray(p.l)) return false;
  const { legs } = buildLegs(state.data, state.injuries, { book: p.b, includeProps: true, includeAlts: true, allowQuestionable: true, stats: state.stats, useForm: true });
  const byId = new Map(legs.map(l => [l.id, l]));
  const resolved = p.l.map(([id, dec]) => {
    const cur = byId.get(id);
    if (!cur) {
      const [eventId, rest = ''] = id.split('~');
      const [market, name, desc, pt] = rest.split('|');
      const ghost = { id, gone: true, dec, p: 1 / dec, market, name, desc: desc || undefined, point: pt === '' || pt == null ? undefined : Number(pt), eventId, nBooks: 0,
        game: 'No longer offered', start: new Date().toISOString(),
        notes: ['Not in the latest odds — it may have started, settled or been pulled.'] };
      ghost.label = legLabel(ghost);
      return ghost;
    }
    const leg = { ...cur, notes: [...cur.notes] };
    if (Math.abs(cur.dec - dec) / dec > 0.02) leg.moved = `Price moved: was ${fmtAmerican(dec)} when shared, now ${fmtAmerican(cur.dec)}`;
    return leg;
  });
  const t = summarize(resolved.filter(l => !l.gone));
  const q = { book: p.b, stake: p.s, win: p.w, mode: p.m };
  q.target = p.m === 'profit' ? 1 + p.w / p.s : p.w / p.s;
  t.legs = resolved;
  const gone = resolved.filter(l => l.gone).length;
  const res = $('#results');
  res.innerHTML = `<div class="head"><h2>Shared ticket</h2><span class="sub">Built ${ago(p.at)} · prices shown are current</span></div>` +
    (gone ? `<div class="notice bad">${gone} leg${gone > 1 ? 's are' : ' is'} no longer available. The rest can still be opened, or build a fresh ticket above.</div>` : '');
  res.appendChild(renderTicket(t, q, 'Shared with you'));
  $('#stake').value = p.s; $('#win').value = p.w; $('#mode').value = p.m; setBook(p.b);
  return true;
}


function setExamples() {
  const games = upcoming();
  if (!games.length) return;
  const now = new Date();
  const rich = games.filter(g => Object.keys(g.books?.draftkings?.m || g.books?.fanduel?.m || {}).some(k => k.startsWith('player_')));
  const first = rich[0] || games[0];
  const tonight = sameLocalDay(new Date(first.start), now);
  const when = tonight ? "tonight's game" : `the ${new Intl.DateTimeFormat(undefined, { weekday: 'long' }).format(new Date(first.start))} game`;
  const nick = n => n.split(' ').slice(-1)[0];
  const ex = [
    `$10 to win $1000 on ${when}`,
    `$25 to win $250 this week, no props`,
    `$5 into $500 on FanDuel, ${nick(first.home)} game`
  ];
  $('#examples').innerHTML = ex.map(t => `<button type="button">${esc(t)}</button>`).join('');
}


// ---------- (i) help popovers ----------
const INFO = {
  stake: 'How much you want to put on the bet.',
  win: '"To win" = profit on top of your stake ($10 to win $100 pays $110 back). "Total payout" = everything you get back, stake included ($10 into $100 pays $100). Switch with the dropdown.',
  book: 'Which sportsbook the ticket is priced for. Prices and available bets differ between DraftKings and FanDuel, and the "Open in…" button loads the slip in that app.',
  games: 'Which games legs can come from. None ticked = every upcoming game. More games = more combinations to choose from, which usually finds a better-priced ticket. Games marked with injuries have key players out.',
  ml: 'Moneyline: a team simply has to win the game.',
  spreads: 'Spreads: a team has to win by more than the number (−6.5) or lose by less than it (+6.5). Turning this off also removes alternate spreads.',
  totals: 'Totals (over/under): combined points scored by both teams goes over or under the number.',
  props: 'Player props: bets on a single player, e.g. yards or catches over/under a number. Players with no recent game data or no role in recent games are always skipped. (Yardage props need the paid odds plan; on the free plan only anytime TDs load.)',
  tds: 'Anytime TD: the player scores at least one touchdown at any point in the game. Long-shot TD props are a common way tickets reach big payouts.',
  alts: 'Alt lines: the same spread/total bets at different numbers than the main line — e.g. Rams −20.5 at +900 instead of −3.5 at −110. They let the site tune the payout precisely. Off = main lines only.',
  sgp: 'Same-game legs: allow more than one leg from the same game (a same-game parlay). Off = at most one leg per game. Sportsbooks re-price same-game parlays, so the slip may show slightly different odds.',
  questionable: 'By default, props on players listed Questionable are skipped (Out / Doubtful / IR are always skipped). Turn this on to allow Questionable players — the leg will be flagged.',
  form: 'On: each leg\'s chance is nudged toward how often that bet hit in the player\'s/team\'s recent games. Example: Knox anytime TD is ~15% by the odds; he scored in 2 of his last 5 (40%), so it becomes ~16–17% — not 40%. Five games is little evidence and the odds already account for form, so the nudge is capped at ±35% of the market\'s number. It mostly breaks ties between similar legs. Off: odds only.',
  practice: 'Practice mode: include games that have already kicked off. Tickets are built from the last pre-kickoff prices, can\'t be placed (no sportsbook button), and every leg is graded live from ESPN — ✓ won, ✗ lost, ▲ on track, ▼ behind — updating every 30 seconds. Use it to see how the picks would have done. You can also type "practice" or "live" in the box.',
  scan: 'Add a bet you placed in the DraftKings or FanDuel app: upload a screenshot of the slip (My Bets → the ticket). The text is read on your phone — the image is never uploaded anywhere. You then check what was read (legs, wager, payout), fix anything, and save. It\'s tracked and graded live like any other ticket. Tip: crop to just the one ticket for best results.',
  live: 'Live chance: how likely the leg (or whole ticket) is to win from here. Moneylines use ESPN\'s live win probability. Spreads and totals use the current score, time left and the game\'s pre-game line (calibrated to match ESPN\'s win probability). Player props use what the player has so far and how much game is left. The ticket number multiplies the legs, so same-game legs that move together are treated as independent. Updates every 30 seconds.',
  legs: 'Minimum and maximum number of legs on a ticket. Useful for app promos that need e.g. 4+ legs for a profit boost. More legs = more house cut, so a minimum usually lowers your real chance a bit. You can also type "at least 4 legs" or "3-5 legs" in the box above.',
  payout: 'What the sportsbook pays back if every leg wins, stake included, at the prices when the odds were last updated. Check the slip — prices move.',
  chance: 'How likely the whole ticket is to win, from about 10 sportsbooks\' odds with their cut removed (and nudged by recent form if that option is on). "1 in 95" means it would win about once every 95 tries.',
  edge: 'Compares the payout to the ticket\'s fair value. "House edge 6%" = on average you\'d get back $94 per $100 bet over many tries. "Pays X% more than other books\' average" = this book is pricing these legs more generously than the rest — not a guarantee, often just a pricing difference.'
};
function setupInfo() {
  const tip = $('#infotip');
  let openFor = null;
  const close = () => { tip.hidden = true; openFor = null; };
  document.addEventListener('click', e => {
    const b = e.target.closest('.info');
    if (!b) { if (!e.target.closest('#infotip')) close(); return; }
    e.preventDefault(); e.stopPropagation();
    if (openFor === b) return close();
    tip.textContent = INFO[b.dataset.info] || '';
    tip.hidden = false; openFor = b;
    const r = b.getBoundingClientRect(), w = Math.min(320, window.innerWidth - 24);
    tip.style.width = w + 'px';
    tip.style.left = Math.max(12, Math.min(window.innerWidth - w - 12, r.left + r.width / 2 - w / 2)) + 'px';
    const below = r.bottom + 8 + window.scrollY;
    tip.style.top = below + 'px';
    // flip above if it would go off-screen
    requestAnimationFrame(() => { if (r.bottom + 8 + tip.offsetHeight > window.innerHeight) tip.style.top = (r.top + window.scrollY - tip.offsetHeight - 8) + 'px'; });
  }, true);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
  window.addEventListener('scroll', close, { passive: true });
}

// ---------- boot ----------
async function boot() {
  setupInfo();
  $('#helpline').textContent = CONFIG.helpline.text;
  $('#helpline').href = CONFIG.helpline.href;
  $('#stake').value = CONFIG.defaultStake;
  $('#win').value = CONFIG.defaultWin;
  setBook(CONFIG.defaultBook);
  try { await loadData(); }
  catch (e) {
    $('#results').innerHTML = `<div class="notice bad">Couldn't load odds data (${esc(e.message)}). If you just set this up, run the "Refresh data & deploy site" action once.</div>`;
    return;
  }
  state.board = await getScoreboard();
  selectScope('tonight');
  setExamples();
  updateMineCount();
  $('#mine-btn').addEventListener('click', () => $('#mine').hidden ? openMine() : ($('#mine').hidden = true));
  $('#mine-close').addEventListener('click', () => { $('#mine').hidden = true; });
  if (/[?&#]mine\b/.test(location.href)) openMine();
  $('#scan-file').addEventListener('change', e => { const f = [...e.target.files]; e.target.value = ''; if (f.length) scanFiles(f); });
  $('#scan-paste').addEventListener('click', () => { $('#scan').hidden = false; reviewScan('', null); $('#scan details').open = true; $('#scan textarea').focus(); });
  $('#practice').addEventListener('change', () => { selectScope($('#practice').checked ? 'live' : 'tonight'); });

  document.querySelectorAll('#book button').forEach(b => b.addEventListener('click', () => { setBook(b.dataset.v); renderGames(); }));
  document.querySelectorAll('.game-quick button').forEach(b => b.addEventListener('click', () => selectScope(b.dataset.scope)));
  // keep min <= max
  $('#minlegs').addEventListener('change', () => { const r = legRange(); $('#minlegs').value = r.minLegs; if (+$('#maxlegs').value < r.minLegs) $('#maxlegs').value = r.minLegs; });
  $('#maxlegs').addEventListener('change', () => { const r = legRange(); $('#maxlegs').value = r.maxLegs; if (+$('#minlegs').value > r.maxLegs) $('#minlegs').value = r.maxLegs; });
  $('#examples').addEventListener('click', e => {
    if (e.target.tagName !== 'BUTTON') return;
    $('#prompt').value = e.target.textContent;
    onPrompt();
  });
  let tmr;
  const onPrompt = () => {
    const p = parsePrompt($('#prompt').value);
    applyParsed(p);
    if (p.noneTonight) toast('No games tonight in the current odds — pick a game below');
  };
  $('#prompt').addEventListener('input', () => { clearTimeout(tmr); tmr = setTimeout(onPrompt, 250); });
  $('#prompt').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onPrompt(); $('#form').requestSubmit(); } });
  $('#form').addEventListener('submit', e => {
    e.preventDefault();
    const btn = $('#go'); btn.disabled = true; btn.textContent = 'Crunching…';
    setTimeout(() => {
      try { generate(readForm()); }
      finally { btn.disabled = false; btn.textContent = 'Build my parlay'; }
    }, 20);
  });

  const h = location.hash.match(/#t=([\w-]+)/);
  if (h && !loadShared(h[1])) toast("That share link couldn't be read");
}
boot();
