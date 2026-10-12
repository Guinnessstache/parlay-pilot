// Team results + recent player game logs from ESPN's public site API (free, no key).
// Called by fetch-data.mjs after odds are pulled. Output: data/stats.json
// Shape:
// { generated_at, teams: { "<Team Name>": { abbr, games:[{date,opp,home,pf,pa,res}] } },
//   players: { "<normalized name>": { name, team, pos, games:[{date,opp,py,ptd,ry,rtd,car,rec,tgt,recy,rectd}] } } }

const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl';
const ESPN_WEB = 'https://site.web.api.espn.com/apis/common/v3/sports/football/nfl';
const MAX_PLAYERS = Number(process.env.MAX_STAT_PLAYERS || 80);
const GAMES_KEPT = 6;

export const normName = s => (s || '').toLowerCase().replace(/[.'’]/g, '').replace(/\s+(jr|sr|ii|iii|iv|v)$/, '').replace(/\s+/g, ' ').trim();

async function getJSON(url) {
  for (let i = 0; i < 2; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch { /* retry */ }
  }
  return null;
}

// run fn over items with limited concurrency
async function pool(items, n, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

const num = v => { const x = parseFloat(v); return Number.isFinite(x) ? x : 0; };

export function parseSchedule(s, teamName) {
  const games = [];
  for (const ev of s?.events || []) {
    const c = ev.competitions?.[0];
    if (!c?.status?.type?.completed) continue;
    if (ev.seasonType && ev.seasonType.type !== 2 && ev.seasonType.type !== 3) continue; // reg/post only
    const me = c.competitors.find(x => x.team?.displayName === teamName);
    const op = c.competitors.find(x => x !== me);
    if (!me || !op) continue;
    const pf = num(me.score?.value ?? me.score), pa = num(op.score?.value ?? op.score);
    games.push({ date: ev.date, opp: op.team?.abbreviation, home: me.homeAway === 'home', pf, pa, res: pf > pa ? 'W' : pf < pa ? 'L' : 'T' });
  }
  games.sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
  return games;
}

export function parseGamelog(g) {
  const names = g?.names || [];
  const idx = n => names.indexOf(n);
  const pick = (stats, n) => (idx(n) >= 0 ? num(stats[idx(n)]) : 0);
  const games = [];
  for (const st of g?.seasonTypes || []) {
    if (!/regular|post/i.test(st.displayName || '')) continue;
    for (const cat of st.categories || []) {
      for (const e of cat.events || []) {
        const meta = g.events?.[e.eventId] || {};
        const s = e.stats || [];
        games.push({
          date: meta.gameDate, opp: meta.opponent?.abbreviation, res: meta.gameResult,
          py: pick(s, 'passingYards'), ptd: pick(s, 'passingTouchdowns'),
          car: pick(s, 'rushingAttempts'), ry: pick(s, 'rushingYards'), rtd: pick(s, 'rushingTouchdowns'),
          rec: pick(s, 'receptions'), tgt: pick(s, 'receivingTargets'), recy: pick(s, 'receivingYards'), rectd: pick(s, 'receivingTouchdowns')
        });
      }
    }
  }
  const seen = new Set();
  return games.filter(x => x.date && !seen.has(x.date) && seen.add(x.date))
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date)).slice(0, GAMES_KEPT);
}

export async function fetchStats(events) {
  const teamsResp = await getJSON(`${ESPN}/teams`);
  const teamList = (teamsResp?.sports?.[0]?.leagues?.[0]?.teams || []).map(t => t.team);
  const byName = new Map(teamList.map(t => [t.displayName, t]));

  // ---- team results for every team on the odds board
  const teamNames = [...new Set(events.flatMap(e => [e.home, e.away]))].filter(n => byName.has(n));
  const teams = {};
  await pool(teamNames, 6, async name => {
    const t = byName.get(name);
    const s = await getJSON(`${ESPN}/teams/${t.id}/schedule`);
    teams[name] = { abbr: t.abbreviation, games: parseSchedule(s, name) };
  });

  // ---- players that have prop lines on DK/FD
  const wanted = new Map(); // normName -> { name, eventTeams }
  for (const e of events) {
    for (const bk of ['draftkings', 'fanduel']) {
      for (const [mk, m] of Object.entries(e.books?.[bk]?.m || {})) {
        if (!mk.startsWith('player_')) continue;
        for (const o of m.o || []) if (o.d) wanted.set(normName(o.d), { name: o.d, teams: [e.home, e.away] });
      }
    }
  }
  const rosterTeams = [...new Set([...wanted.values()].flatMap(w => w.teams))].filter(n => byName.has(n));
  const roster = new Map(); // normName -> {id, team, pos}
  await pool(rosterTeams, 6, async name => {
    const r = await getJSON(`${ESPN}/teams/${byName.get(name).id}/roster`);
    for (const grp of r?.athletes || []) for (const a of grp.items || []) {
      roster.set(normName(a.displayName || a.fullName), { id: a.id, team: name, pos: a.position?.abbreviation || '' });
    }
  });

  const players = {};
  const targets = [...wanted.entries()].filter(([k]) => roster.has(k)).slice(0, MAX_PLAYERS);
  await pool(targets, 8, async ([key, w]) => {
    const r = roster.get(key);
    const g = await getJSON(`${ESPN_WEB}/athletes/${r.id}/gamelog`);
    const games = parseGamelog(g);
    if (games.length) players[key] = { name: w.name, team: r.team, pos: r.pos, games };
  });

  console.log(`stats: ${Object.keys(teams).length} teams, ${Object.keys(players).length}/${wanted.size} prop players matched`);
  return { teams, players };
}
