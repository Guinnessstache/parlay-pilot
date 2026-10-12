import { CONFIG } from './config.js';
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
const upcoming = () => (state.data?.events || []).filter(e => Date.parse(e.start) > Date.now() - 5 * 60e3);

// ---------- natural-language parsing ----------
const NUM = String.raw`\$?\s*(\d[\d,]*(?:\.\d+)?)\s*(k)?`;
const toNum = (n, k) => parseFloat(n.replace(/,/g, '')) * (k ? 1000 : 1);
const DAY_WORDS = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, mnf: 1, tnf: 4, snf: 0 };

function parsePrompt(text) {
  const t = ` ${text.toLowerCase()} `;
  const out = {};
  let m;
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
  if (/no (?:player )?props|without props|game lines only/.test(t)) out.props = false;
  if (/no same.?game|different games|no sgp/.test(t)) out.sgp = false;
  if ((m = t.match(/(\d+)\s*(?:-|\s)?legs?/))) out.maxLegs = Math.min(CONFIG.maxLegsCap, parseInt(m[1]));

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
      <span><span class="when">${esc(dayFmt.format(new Date(g.start)))}</span><br>${esc(g.away)} <span class="muted">@</span> ${esc(g.home)}
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
  if (scope === 'tonight') ids = games.filter(g => sameLocalDay(new Date(g.start), now)).map(g => g.id);
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
  if (p.props != null) $('#props').checked = p.props;
  if (p.sgp != null) $('#sgp').checked = p.sgp;
  if (p.maxLegs) { $('#maxlegs').value = p.maxLegs; $('#maxlegs-out').value = p.maxLegs; }
  if (p.games) { state.selected = new Set(p.games); renderGames(); }
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
    questionable: $('#questionable').checked, form: $('#form-weight').checked, maxLegs: parseInt($('#maxlegs').value)
  };
}

// ---------- generate ----------
function generate(q) {
  const res = $('#results');
  if (!(q.stake > 0) || !(q.win > 0)) { res.innerHTML = '<div class="notice bad">Enter how much you want to bet and how much you want to win.</div>'; return; }
  if (q.target < 1.05) { res.innerHTML = '<div class="notice bad">That payout is less than your bet back. Raise the "to win" amount.</div>'; return; }
  const eventIds = q.games.length ? q.games : null;
  const { legs, excluded } = buildLegs(state.data, state.injuries, {
    book: q.book, eventIds, includeProps: q.props, includeAlts: q.alts, allowQuestionable: q.questionable,
    stats: state.stats, useForm: q.form
  });
  const nGames = new Set(legs.map(l => l.eventId)).size;
  let tickets = findParlays(legs, q.target, { maxLegs: q.maxLegs, sameGame: q.sgp, maxPerGame: q.sgp ? Math.max(2, Math.min(q.maxLegs, 5)) : 1 });
  let widened = false;
  if (!tickets.length) { // retry with a looser payout window
    tickets = findParlays(legs, q.target, { maxLegs: q.maxLegs, sameGame: q.sgp, maxPerGame: q.sgp ? 5 : 1, lo: 0.85, hi: 1.8 });
    widened = tickets.length > 0;
  }

  const header = `<div class="head"><h2>Your best shots</h2><span class="sub">${money(q.stake)} → ${money(q.stake * q.target)} payout · ${fmtAmerican(q.target)} · ${legs.length} lines across ${nGames} game${nGames === 1 ? '' : 's'} on ${BOOK_NAMES[q.book]}</span></div>`;
  if (!tickets.length) {
    // Explain *why*: games that only have main lines posted, and the most they can pay.
    const chosen = (eventIds || upcoming().map(g => g.id)).map(id => state.data.events.find(e => e.id === id)).filter(Boolean);
    const thin = chosen.filter(e => Object.keys(e.books?.[q.book]?.m || {}).every(k => ['h2h', 'spreads', 'totals'].includes(k)));
    const best = (ev, keys) => Math.max(1, ...keys.flatMap(k => (ev.books?.[q.book]?.m?.[k]?.o || []).map(o => o.p)));
    const maxDec = chosen.slice(0, q.maxLegs).reduce((a, e) => a * best(e, ['h2h', 'spreads']) * (q.sgp ? best(e, ['totals']) : 1), 1);
    const rich = upcoming().filter(e => Object.keys(e.books?.[q.book]?.m || {}).some(k => !['h2h', 'spreads', 'totals'].includes(k)));
    let msg = `Couldn't reach ${fmtAmerican(q.target)} from ${nGames} game${nGames === 1 ? '' : 's'}${q.sgp ? '' : ' (same-game legs are off)'}.`;
    if (thin.length) msg += ` ${thin.map(e => `${esc(e.away)} @ ${esc(e.home)}`).slice(0, 2).join(' and ')}${thin.length > 2 ? ` (+${thin.length - 2} more)` : ''} only ${thin.length > 1 ? 'have' : 'has'} moneyline, spread and total posted so far — alt lines and player props load about 12 hours before kickoff. With just those, the most ${nGames === 1 ? 'this game' : 'these games'} can pay is about ${fmtAmerican(maxDec)}.`;
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
  if (outCount) notes.push(`<div class="notice">Skipped ${outCount} prop line${outCount > 1 ? 's' : ''} on injured players (${[...new Set(excluded.filter(e => /listed/.test(e.why)).map(e => e.why))].slice(0, 3).map(esc).join('; ')}${outCount > 3 ? '…' : ''}).</div>`);

  res.innerHTML = header + notes.join('');
  tickets.forEach((t, i) => res.appendChild(renderTicket(t, q, i === 0 ? 'Best chance' : `Option ${i + 1}`, { excludedCount: outCount })));
  res.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
  if (started.length) w.push('A game on this ticket has started — pre-game prices no longer apply.');
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

// ---------- boot ----------
async function boot() {
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
  selectScope('tonight');
  setExamples();

  document.querySelectorAll('#book button').forEach(b => b.addEventListener('click', () => { setBook(b.dataset.v); renderGames(); }));
  document.querySelectorAll('.game-quick button').forEach(b => b.addEventListener('click', () => selectScope(b.dataset.scope)));
  $('#maxlegs').addEventListener('input', e => ($('#maxlegs-out').value = e.target.value));
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
