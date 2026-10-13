import { CONFIG } from './config.js';
import { getScoreboard, matchGame, gradeLeg } from './live.js';
import {
  BOOK_NAMES, MARKET_LABEL, buildLegs, findParlays, summarize, betslipLink,
  fmtAmerican, indexInjuries, teamInjuryNotes, legLabel, explainTicket
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
      res.push(r);
      const g = ev && matchGame(ev, state.board);
      if (g?.state === 'in') anyLive = true;
      let chip = items[i]?.querySelector('.grade');
      if (items[i] && !chip) { chip = document.createElement('span'); chip.className = 'grade'; items[i].appendChild(chip); }
      if (chip) { chip.className = `grade ${r.status}`; chip.textContent = `${ICON[r.status]} ${WORD[r.status]}${r.text ? ' · ' + r.text : ''}`; }
    }
    const lost = res.some(r => r.status === 'lost'), allWon = res.every(r => r.status === 'won');
    const alive = res.filter(r => r.status !== 'lost').length;
    let sum = card.querySelector('.t-practice-status');
    if (!sum) { sum = document.createElement('div'); sum.className = 't-practice-status'; card.querySelector('.t-practice').after(sum); }
    const ev0 = state.data.events.find(e => e.id === t.legs[0].eventId);
    const g0 = ev0 && matchGame(ev0, state.board);
    sum.className = `t-practice-status ${allWon ? 'won' : lost ? 'lost' : ''}`;
    sum.textContent = (g0 ? `${g0.detail} · ${g0.away.split(' ').pop()} ${g0.awayScore} – ${g0.home.split(' ').pop()} ${g0.homeScore} · ` : '') +
      (allWon ? 'TICKET WON' : lost ? 'Ticket lost' : `${res.filter(r => r.status === 'won').length} of ${res.length} legs won, ${alive} still alive`);
  }
  if (anyLive) gradePractice.t = setTimeout(gradePractice, 30000); // refresh every 30s while a game is live
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
