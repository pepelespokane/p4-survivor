/* Power 4 Survivor Pool
 * Pick one team from the ACC, Big Ten, Big 12 and SEC every week for 13 weeks.
 * No team may be used twice all season.
 *
 * Schedule and results come from docs/schedule.json (rebuilt by build_schedule.py).
 * Players and picks live in Supabase.
 */

const state = {
  sched: null,
  teams: {},      // teamId -> team record
  confOf: {},     // teamId -> conference key
  players: [],
  picks: [],      // every pick from every player
  me: null,       // { id, name }
  week: 1,
  draft: {},      // conf -> teamId, the unsaved selection in the Picks tab
  boardWeek: 1,
  sort: { key: 'leagues', dir: -1 },   // standings column + direction
};

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  return n;
};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const slug = (s) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/* ---------------- schedule helpers ---------------- */

const weekData = (w) => state.sched.weeks.find((x) => x.week === w);
const totalTeams = () => Object.keys(state.teams).length;

const kickoff = (g) => new Date(g.kickoff);
const started = (g) => Date.now() >= kickoff(g).getTime();

/** The game a team plays in a given week. Week 1 on ESPN also carries the
 *  Week 0 games, so prefer a game that has not kicked off yet. */
function gameFor(w, teamId) {
  const wk = weekData(w);
  if (!wk) return null;
  const hits = wk.games.filter((g) => g.home.id === teamId || g.away.id === teamId);
  if (!hits.length) return null;
  return hits.find((g) => !started(g)) || hits[hits.length - 1];
}

function sideOf(g, teamId) {
  return g.home.id === teamId ? g.home : g.away;
}
function oppOf(g, teamId) {
  return g.home.id === teamId ? g.away : g.home;
}

/** 'win' | 'loss' | 'pending' for one team in one week. */
function outcome(w, teamId) {
  const g = gameFor(w, teamId);
  if (!g || !g.completed) return 'pending';
  const me = sideOf(g, teamId);
  if (me.winner === true) return 'win';
  if (me.winner === false) return 'loss';
  return 'pending';
}

function matchupLabel(g, teamId) {
  const o = oppOf(g, teamId);
  const home = g.home.id === teamId;
  const rank = o.rank && o.rank <= 25 ? `#${o.rank} ` : '';
  const at = g.neutral ? 'vs' : home ? 'vs' : 'at';
  return `${at} ${rank}${o.name}`;
}

function timeLabel(g) {
  const d = kickoff(g);
  const day = d.toLocaleDateString(undefined, { weekday: 'short' });
  const t = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${day} ${t}${g.tv ? ' · ' + g.tv : ''}`;
}

/** First kickoff of a pool week, used as the reveal point for everyone's picks.
 *  ESPN's week 1 bucket also holds the Aug 29 openers, a full week early. Anchor
 *  on the Saturday that carries the most games, then take the first kickoff from
 *  the three days before it, so Thursday and Friday games still close the week. */
function weekOpens(w) {
  const wk = weekData(w);
  if (!wk || !wk.games.length) return null;

  const byDate = {};
  for (const g of wk.games) {
    if (g.day !== 'Sat') continue;
    const d = g.kickoff.slice(0, 10);
    byDate[d] = (byDate[d] || 0) + 1;
  }
  const dates = Object.keys(byDate);
  if (!dates.length) return Math.min(...wk.games.map((g) => kickoff(g).getTime()));

  const anchor = dates.sort((a, b) => byDate[b] - byDate[a] || a.localeCompare(b))[0];
  const floor = new Date(anchor + 'T00:00:00Z').getTime() - 3 * 86400000;
  const live = wk.games.filter((g) => kickoff(g).getTime() >= floor);
  const pool = live.length ? live : wk.games;
  return Math.min(...pool.map((g) => kickoff(g).getTime()));
}

/** Can this pick be shown to everyone yet? Hidden until that team kicks off, so
 *  a Friday-night pick never leaks a Saturday one. Your own picks always show. */
function pickVisible(pick) {
  if (!POOL.hidePicksUntilKickoff) return true;
  if (state.me && pick.player_id === state.me.id) return true;
  const g = gameFor(pick.week, pick.team_id);
  return g ? started(g) : true;
}

/** The week to land people on: the first one with a game still to kick off. */
function currentWeek() {
  for (const wk of state.sched.weeks) {
    if (wk.games.some((g) => !started(g))) return wk.week;
  }
  return state.sched.weeks[state.sched.weeks.length - 1].week;
}

/* ---------------- data loading ---------------- */

async function loadSchedule() {
  const r = await fetch('schedule.json?v=' + Date.now());
  state.sched = await r.json();
  for (const c of state.sched.conferences) {
    for (const t of c.teams) {
      state.teams[t.id] = t;
      state.confOf[t.id] = c.key;
    }
  }
}

/** True once migration_email.sql has been run. Until then the app falls back to
 *  talking to the players table directly, so the site keeps working either way. */
let LOCKED_DOWN = true;

async function loadPool() {
  let p = await sb.from('survivor_players_public').select('*').order('name');
  if (p.error) {
    // View is missing, so the migration has not run yet.
    LOCKED_DOWN = false;
    p = await sb.from('survivor_players').select('id,name').order('name');
  }
  const k = await sb.from('survivor_picks').select('*');
  if (p.error) throw p.error;
  if (k.error) throw k.error;
  state.players = p.data || [];
  state.picks = k.data || [];
}

const picksOf = (playerId) => state.picks.filter((x) => x.player_id === playerId);
const pickAt = (playerId, w, conf) =>
  state.picks.find((x) => x.player_id === playerId && x.week === w && x.conf === conf);

/** Teams a player has already burned, teamId -> week. */
function usedBy(playerId) {
  const m = {};
  for (const x of picksOf(playerId)) m[x.team_id] = x.week;
  return m;
}

/** Four independent survivor pools, one per conference. Losing your SEC pick ends
 *  your SEC run and touches nothing else.
 *
 *  Returns { week, reason } for the week that conference run ended, or null if the
 *  player is still alive in it. */
function elimConf(playerId, conf) {
  for (const wk of state.sched.weeks) {
    const w = wk.week;
    const pk = pickAt(playerId, w, conf);

    if (pk) {
      const o = outcome(w, pk.team_id);
      if (o === 'loss') return { week: w, reason: pk.team_name + ' lost' };
      if (o === 'pending') return null;      // still riding on this one
    } else {
      // A missing pick only counts against you once that week is actually over.
      if (!wk.games.every((g) => g.completed)) return null;
      return { week: w, reason: 'no pick submitted' };
    }
  }
  return null;
}

/** Weeks fully survived in one conference. */
function survivedConf(playerId, conf, out) {
  if (out) return out.week - 1;
  let n = 0;
  for (const wk of state.sched.weeks) {
    const pk = pickAt(playerId, wk.week, conf);
    if (pk && outcome(wk.week, pk.team_id) === 'win') n++;
    else break;
  }
  return n;
}

/** One conference's league table: everyone ranked, plus who is currently winning
 *  it. Alive players share the lead; if all are out, the deepest survivors tie. */
function leagueTable(conf) {
  const rows = state.players.map((p) => {
    const out = elimConf(p.id, conf);
    return { p, out, survived: survivedConf(p.id, conf, out) };
  });
  rows.sort((a, b) =>
    (a.out ? 1 : 0) - (b.out ? 1 : 0) ||
    b.survived - a.survived ||
    a.p.name.localeCompare(b.p.name));

  const alive = rows.filter((x) => !x.out);
  const best = rows.length ? Math.max(...rows.map((x) => x.survived)) : 0;
  const leaders = alive.length ? alive : rows.filter((x) => x.survived === best);

  // Shared rank: same alive-state and same weeks survived means the same number.
  let rank = 0, lastKey = null;
  rows.forEach((x, i) => {
    const key = (x.out ? 'out' : 'alive') + ':' + x.survived;
    if (key !== lastKey) { rank = i + 1; lastKey = key; }
    x.rank = rank;
  });

  return { rows, alive, leaders };
}

/** How many of the four leagues a player is still alive in. */
function leaguesAlive(playerId) {
  return POOL.conferences.filter((c) => !elimConf(playerId, c.key)).length;
}

function record(playerId) {
  let w = 0, l = 0, pend = 0;
  for (const p of picksOf(playerId)) {
    const o = outcome(p.week, p.team_id);
    if (o === 'win') w++;
    else if (o === 'loss') l++;
    else pend++;
  }
  return { w, l, pend, made: w + l + pend };
}

/* ---------------- session ---------------- */

function restoreSession() {
  try {
    const raw = localStorage.getItem('survivor.me');
    if (raw) state.me = JSON.parse(raw);
  } catch (e) { /* private mode, no session */ }
}

function saveSession() {
  try {
    if (state.me) localStorage.setItem('survivor.me', JSON.stringify(state.me));
    else localStorage.removeItem('survivor.me');
  } catch (e) { /* fine, they just sign in again */ }
}

/** Signing in should be a once-per-device thing. The session below keeps people
 *  signed in; this keeps their details in the boxes if the session ever goes. */
function rememberDetails(first, last, email) {
  try {
    localStorage.setItem('survivor.last',
      JSON.stringify({ first: first, last: last, email: email || '' }));
  } catch (e) { /* private mode */ }
}

function prefillSignIn() {
  let d = null;
  try { d = JSON.parse(localStorage.getItem('survivor.last') || 'null'); }
  catch (e) { d = null; }
  if (!d) return;
  const set = (sel, v) => { const n = $(sel); if (n && !n.value && v) n.value = v; };
  set('#firstIn', d.first);
  set('#lastIn', d.last);
  set('#emailIn', d.email);
}

/** First name plus at least one letter of the last name. Requiring the second
 *  field is what keeps two Mikes from fighting over the same entry. */
function buildIdentity(first, last) {
  first = (first || '').trim();
  last = (last || '').trim();
  if (first.length < 2) throw new Error('Enter your first name.');
  if (!/^[A-Za-z]{1,3}$/.test(last)) {
    throw new Error('Last initial: just the first letter or two of your last name.');
  }
  const id = slug(first) + '-' + last.toLowerCase();
  if (!slug(first)) throw new Error('First name needs at least one letter.');
  const cap = (x) => x.charAt(0).toUpperCase() + x.slice(1).toLowerCase();
  const name = first.charAt(0).toUpperCase() + first.slice(1) + ' ' + cap(last);
  return { id, name };
}

/** Read the sign-in fields, tolerating a stale cached page.
 *  GitHub Pages caches HTML for ten minutes, so a browser can end up running new
 *  JS against an old form. Rather than throw, fall back to the old single field
 *  and split it, so an out-of-date page still signs people in. */
function readSignInFields() {
  const f = $('#firstIn'), l = $('#lastIn');
  if (f && l) return [f.value, l.value];

  const n = $('#nameIn');
  if (n) {
    const parts = String(n.value || '').trim().split(/\s+/).filter(Boolean);
    if (parts.length > 1) return [parts.slice(0, -1).join(' '), parts[parts.length - 1]];
    return [parts[0] || '', ''];
  }
  throw new Error('This page is out of date. Reload it (Ctrl+Shift+R) and try again.');
}

async function signIn(first, last, pin, email) {
  const { id, name } = buildIdentity(first, last);
  if (!/^\d{4}$/.test(pin)) throw new Error('PIN must be 4 digits.');
  email = (email || '').trim();
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email)) {
    throw new Error('That email does not look right.');
  }

  const taken = () => new Error(
    `${name} is taken. If that is you, check your PIN. If you are a ` +
    `different ${name.split(' ')[0]}, add another letter of your last name.`);

  // Preferred path: sign-in and registration happen server side, so the browser
  // never gets to read anyone's PIN or email back out of the database.
  const { data, error } = await sb.rpc('survivor_signin', {
    p_id: id, p_name: name, p_pin: pin, p_email: email || null,
  });

  if (!error) {
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) throw new Error('Sign-in failed. Try again.');
    state.me = { id: row.id, name: row.name };
    await loadPool();
    saveSession();
    return;
  }

  const m = String(error.message || '') + ' ' + String(error.code || '');
  if (m.includes('BAD_PIN_FORMAT')) throw new Error('PIN must be 4 digits.');
  if (m.includes('BAD_PIN')) throw taken();

  const missing = m.includes('PGRST202') || m.includes('survivor_signin')
    || m.includes('Could not find') || m.includes('404');
  if (!missing) throw error;

  // Fallback for a database where migration_email.sql has not been run yet.
  // Same rules, just enforced in the browser instead of in Postgres.
  LOCKED_DOWN = false;
  const q = await sb.from('survivor_players').select('*').eq('id', id).maybeSingle();
  if (q.error) throw q.error;
  if (q.data) {
    if (q.data.pin !== pin) throw taken();
    state.me = { id: q.data.id, name: q.data.name };
  } else {
    const ins = await sb.from('survivor_players')
      .insert({ id, name, pin }).select().single();
    if (ins.error) throw ins.error;
    state.me = { id: ins.data.id, name: ins.data.name };
  }
  await loadPool();
  saveSession();
}

/* ---------------- rendering: chrome ---------------- */

function renderHeader() {
  const box = $('#who');
  box.innerHTML = '';
  if (state.me) {
    box.append(el('span', '', `Signed in as <b>${esc(state.me.name)}</b>`));
    const out = el('button', 'ghost', 'Sign out');
    out.onclick = () => { state.me = null; saveSession(); renderAll(); };
    box.append(out);
  } else {
    box.append(el('span', 'muted', 'Not signed in'));
  }
}

function weekBar(container, selected, onPick) {
  container.innerHTML = '';
  for (const wk of state.sched.weeks) {
    const done = !wk.games.some((g) => !started(g));
    const b = el('button', (wk.week === selected ? 'on ' : '') + (done ? 'done' : ''),
      String(wk.poolWeek));
    b.title = `Week ${wk.poolWeek}`;
    b.onclick = () => onPick(wk.week);
    container.append(b);
  }
}

/* ---------------- view: standings + board ---------------- */

function renderBoard() {
  const t = $('#standings');
  t.innerHTML = '';

  if (!state.players.length) {
    t.append(el('p', 'muted', 'No one has joined yet. Open the Make Picks tab to sign up.'));
  } else {
    const tables = {};
    for (const c of POOL.conferences) tables[c.key] = leagueTable(c.key);

    t.append(el('p', 'muted',
      `${state.players.length} ${state.players.length === 1 ? 'entry' : 'entries'} ` +
      `&middot; four separate races &middot; last one standing wins each conference`));

    // ---- who is winning each league ----
    const strip = el('div', 'leagues');
    for (const c of POOL.conferences) {
      const { alive, leaders } = tables[c.key];
      const card = el('div', 'league');
      const names = leaders.map((x) => esc(x.p.name)).join(', ') || '-';
      card.innerHTML =
        `<div class="lhead"><span class="dot" style="background:${c.color}"></span>` +
        `<b>${c.name}</b></div>` +
        `<div class="lbody"><div class="lname">${names}</div>` +
        `<small>${alive.length ? alive.length + ' still alive' : 'all out - ' +
          (leaders.length > 1 ? leaders.length + ' way tie' : 'winner')}</small></div>`;
      strip.append(card);
    }
    t.append(strip);

    // ---- one row per player, one column per league ----
    const cols = [{ key: 'name', label: 'Player' }]
      .concat(POOL.conferences.map((c) => ({ key: c.key, label: c.short })))
      .concat([{ key: 'leagues', label: 'Leagues alive' }]);

    const tb = el('table');
    const head = el('thead');
    const hrow = el('tr');
    for (const col of cols) {
      const on = state.sort.key === col.key;
      const th = el('th', 'sortable' + (on ? ' on' : ''),
        `${col.label}<span class="arrow">${on ? (state.sort.dir < 0 ? '▾' : '▴') : ''}</span>`);
      th.onclick = () => {
        if (state.sort.key === col.key) state.sort.dir *= -1;
        // Names read best A to Z; everything else best-first.
        else state.sort = { key: col.key, dir: col.key === 'name' ? 1 : -1 };
        renderBoard();
      };
      hrow.append(th);
    }
    head.append(hrow);
    tb.append(head);
    const body = el('tbody');

    // Sort value for one player under the currently selected column. Alive always
    // outranks eliminated in a league column; deeper survival breaks the tie.
    const sortVal = (p) => {
      const k = state.sort.key;
      if (k === 'name') return p.name.toLowerCase();
      if (k === 'leagues') return leaguesAlive(p.id);
      const row = tables[k].rows.find((x) => x.p.id === p.id);
      return (row.out ? 0 : 1000) + row.survived;
    };

    const ordered = state.players.slice().sort((a, b) => {
      const va = sortVal(a), vb = sortVal(b);
      const cmp = typeof va === 'string' ? va.localeCompare(vb) : va - vb;
      return (cmp * state.sort.dir) || a.name.localeCompare(b.name);
    });

    for (const p of ordered) {
      const tr = el('tr');
      let cells = `<td><b>${esc(p.name)}</b></td>`;
      let n = 0;
      for (const c of POOL.conferences) {
        const row = tables[c.key].rows.find((x) => x.p.id === p.id);
        if (row.out) {
          cells += `<td class="pk"><span class="pill loss">Out &middot; W` +
            `${weekData(row.out.week).poolWeek}</span>` +
            `<small>${esc(row.out.reason)}</small></td>`;
        } else {
          n++;
          const lead = tables[c.key].leaders.includes(row);
          cells += `<td class="pk"><span class="pill win">Alive</span>` +
            `<small>${row.survived} week${row.survived === 1 ? '' : 's'}` +
            `${lead ? ' &middot; leading' : ''}</small></td>`;
        }
      }
      cells += `<td class="num"><b>${n}</b> / 4</td>`;
      tr.innerHTML = cells;
      tr.className = n === 0 ? 'dead' : '';
      body.append(tr);
    }
    tb.append(body);
    const wrap = el('div', 'scroll');
    wrap.append(tb);
    t.append(wrap);
  }

  // Everyone's picks for the selected week.
  weekBar($('#boardWeeks'), state.boardWeek, (w) => { state.boardWeek = w; renderBoard(); });

  const g = $('#boardGrid');
  g.innerHTML = '';
  const w = state.boardWeek;
  if (!state.players.length) return;

  const opens = weekOpens(w);
  if (POOL.hidePicksUntilKickoff && opens !== null && Date.now() < opens) {
    g.append(el('div', 'notice',
      'Each pick stays hidden until that team kicks off. Your own picks always show.'));
  }

  const tb = el('table', 'board');
  tb.innerHTML = `<thead><tr><th>Player</th>` +
    POOL.conferences.map((c) => `<th>${c.short}</th>`).join('') +
    `<th>Week</th></tr></thead>`;
  const body = el('tbody');

  for (const p of state.players) {
    const tr = el('tr');
    let cells = `<td><b>${esc(p.name)}</b></td>`;
    let w_ = 0, l_ = 0;
    for (const c of POOL.conferences) {
      const pk = pickAt(p.id, w, c.key);
      if (!pk) { cells += `<td class="pk muted">-</td>`; continue; }
      if (!pickVisible(pk)) {
        cells += `<td class="pk"><span class="pill">submitted</span>` +
          `<small>hidden until kickoff</small></td>`;
        continue;
      }
      const o = outcome(w, pk.team_id);
      if (o === 'win') w_++;
      if (o === 'loss') l_++;
      const g2 = gameFor(w, pk.team_id);
      const sub = g2 ? matchupLabel(g2, pk.team_id) : '';
      const cls = o === 'win' ? 'win' : o === 'loss' ? 'loss' : 'pend';
      cells += `<td class="pk"><span class="pill ${cls}">${esc(pk.team_name)}</span>` +
        `<small>${esc(sub)}</small></td>`;
    }
    cells += `<td class="num">${w_}-${l_}</td>`;
    tr.innerHTML = cells;
    body.append(tr);
  }
  tb.append(body);
  const sc = el('div', 'scroll');
  sc.append(tb);
  g.append(sc);
}

/* ---------------- view: make picks ---------------- */

function renderPicks() {
  const gate = $('#signin');
  const area = $('#pickArea');

  if (!state.me) {
    gate.style.display = '';
    area.style.display = 'none';
    prefillSignIn();
    return;
  }
  gate.style.display = 'none';
  area.style.display = '';

  weekBar($('#pickWeeks'), state.week, (w) => { state.week = w; state.draft = {}; renderPicks(); });

  const w = state.week;
  const wk = weekData(w);
  const used = usedBy(state.me.id);

  // Seed the draft from what is already saved for this week.
  for (const c of POOL.conferences) {
    if (state.draft[c.key] === undefined) {
      const pk = pickAt(state.me.id, w, c.key);
      state.draft[c.key] = pk ? pk.team_id : null;
    }
  }

  const outByConf = {};
  for (const c of POOL.conferences) outByConf[c.key] = elimConf(state.me.id, c.key);
  const deadConfs = POOL.conferences.filter((c) => outByConf[c.key]);

  const banner = deadConfs.length
    ? `<div class="notice">You are out of ` +
      deadConfs.map((c) => `<b>${c.name}</b> (week ` +
        `${weekData(outByConf[c.key].week).poolWeek})`).join(', ') + `. ` +
      (deadConfs.length === POOL.conferences.length
        ? 'All four of your runs are over. '
        : 'Your other leagues are still live. ') +
      (POOL.zombiePicks
        ? 'You can keep picking in a dead league for bragging rights; it does not ' +
          'affect the standings.'
        : 'Picks are closed in those leagues.') + `</div>`
    : '';

  $('#pickHead').innerHTML = banner +
    `<h2>Week ${wk.poolWeek} picks</h2>` +
    `<p class="muted">Each conference is its own survivor pool. A loss ends your run ` +
    `in that conference only. Teams you have already used are greyed out, and so is ` +
    `any team whose game has kicked off.</p>`;

  const grid = $('#pickGrid');
  grid.innerHTML = '';

  for (const c of POOL.conferences) {
    const conf = state.sched.conferences.find((x) => x.key === c.key);
    const card = el('div', 'confcard');
    const hd = el('header');
    hd.append(el('span', 'dot'));
    hd.lastChild.style.background = c.color;
    hd.append(el('b', '', c.name));
    hd.append(el('span', 'spacer'));
    const dead = outByConf[c.key];
    hd.append(el('span', dead ? 'pill loss' : 'pill win',
      dead ? `Out W${weekData(dead.week).poolWeek}` : 'Alive'));
    card.append(hd);

    const opts = el('div', 'opts');
    let available = 0;

    for (const t of conf.teams) {
      const g = gameFor(w, t.id);
      const usedWeek = used[t.id];
      const usedElsewhere = usedWeek !== undefined && usedWeek !== w;
      const locked = g ? started(g) : false;
      const bye = !g;
      const weekday = g && g.day !== 'Sat';
      if (bye && POOL.weekdayGames === 'hide') { /* still show bye as dead */ }
      if (weekday && POOL.weekdayGames === 'hide') continue;

      const dead = bye || locked || usedElsewhere;
      if (!dead) available++;

      const row = el('label', 'opt' + (dead ? ' dead' : '') +
        (state.draft[c.key] === t.id ? ' sel' : ''));
      const rb = el('input');
      rb.type = 'radio';
      rb.name = 'conf-' + c.key;
      rb.checked = state.draft[c.key] === t.id;
      rb.disabled = dead;
      rb.onchange = () => { state.draft[c.key] = t.id; renderPicks(); };
      row.append(rb);
      row.append(el('span', 'tm', esc(t.name)));

      let right;
      if (usedElsewhere) right = `used wk ${weekData(usedWeek).poolWeek}`;
      else if (bye) right = 'bye';
      else if (locked) right = 'started';
      else right = `${esc(matchupLabel(g, t.id))}<br>${esc(timeLabel(g))}`;
      row.append(el('span', 'vs', right));

      opts.append(row);
    }
    card.append(opts);

    const cur = state.draft[c.key];
    card.append(el('div', 'chosen', cur
      ? `Selected: <b>${esc(state.teams[cur].name)}</b>`
      : `<span class="muted">Nothing selected · ${available} available</span>`));
    grid.append(card);
  }

  const chosen = POOL.conferences.filter((c) => state.draft[c.key]).length;
  const live = POOL.conferences.filter((c) => !outByConf[c.key]);
  const liveChosen = live.filter((c) => state.draft[c.key]).length;
  $('#saveBtn').disabled = chosen === 0;
  $('#saveNote').textContent = live.length === 0
    ? 'All four of your runs are over. Picks are just for fun now.'
    : `${liveChosen} of ${live.length} live league${live.length === 1 ? '' : 's'} selected` +
      (liveChosen < live.length
        ? ' - skipping one ends your run in that league'
        : '');
}

async function savePicks() {
  const w = state.week;
  const rows = [];
  const seen = new Set();
  const used = usedBy(state.me.id);

  for (const c of POOL.conferences) {
    const tid = state.draft[c.key];
    if (!tid) continue;
    if (seen.has(tid)) throw new Error('Same team picked twice this week.');
    seen.add(tid);
    if (used[tid] !== undefined && used[tid] !== w) {
      throw new Error(`${state.teams[tid].name} was already used in week ${weekData(used[tid]).poolWeek}.`);
    }
    const g = gameFor(w, tid);
    if (!g) throw new Error(`${state.teams[tid].name} is on a bye in week ${weekData(w).poolWeek}.`);
    if (started(g)) throw new Error(`${state.teams[tid].name} has already kicked off.`);
    rows.push({
      player_id: state.me.id, week: w, conf: c.key,
      team_id: tid, team_name: state.teams[tid].name,
      submitted_at: new Date().toISOString(),
    });
  }
  if (!rows.length) throw new Error('Nothing to save.');

  const { error } = await sb.from('survivor_picks')
    .upsert(rows, { onConflict: 'player_id,week,conf' });
  if (error) {
    if (String(error.message).includes('survivor_picks_no_reuse')) {
      throw new Error('One of those teams is already used somewhere this season.');
    }
    throw error;
  }
  await loadPool();
}

/* ---------------- view: used teams ---------------- */

function renderTeams() {
  const host = $('#teamsView');
  host.innerHTML = '';

  if (!state.me) {
    host.append(el('div', 'notice', 'Sign in on the Make Picks tab to see your own team board.'));
  }

  const sel = $('#teamsWho');
  const prev = sel.value;
  sel.innerHTML = '';
  for (const p of state.players) {
    const o = el('option', '', esc(p.name));
    o.value = p.id;
    sel.append(o);
  }
  if (!state.players.length) {
    host.append(el('p', 'muted', 'No players yet.'));
    return;
  }
  const ids = state.players.map((p) => p.id);
  const who = ids.includes(prev) ? prev
    : (state.me && ids.includes(state.me.id) ? state.me.id : ids[0]);
  sel.value = who;

  // Someone else's board only shows picks that have already kicked off.
  const used = {};
  let hiddenCount = 0;
  for (const x of picksOf(who)) {
    if (pickVisible(x)) used[x.team_id] = x.week;
    else hiddenCount++;
  }
  const total = Object.keys(used).length;
  host.append(el('p', 'muted',
    `${total} of ${totalTeams()} teams used · ${totalTeams() - total} still available` +
    (hiddenCount ? ` · ${hiddenCount} pick${hiddenCount > 1 ? 's' : ''} hidden until kickoff` : '')));

  for (const c of POOL.conferences) {
    const conf = state.sched.conferences.find((x) => x.key === c.key);
    const panel = el('div', 'panel');
    const usedHere = conf.teams.filter((t) => used[t.id] !== undefined).length;
    panel.append(el('h3', '', `${esc(c.name)} · ${usedHere}/${conf.teams.length} used`));
    const grid = el('div', 'teamgrid');
    for (const t of conf.teams) {
      const u = used[t.id];
      const chip = el('div', 'tchip' + (u !== undefined ? ' used' : ''));
      chip.append(el('span', '', esc(t.name)));
      if (u !== undefined) {
        const o = outcome(u, t.id);
        chip.append(el('span', 'wk',
          `W${weekData(u).poolWeek} ${o === 'win' ? '✓' : o === 'loss' ? '✗' : ''}`));
      }
      grid.append(chip);
    }
    panel.append(grid);
    host.append(panel);
  }
}

/* ---------------- view: schedule ---------------- */

function renderSchedule() {
  weekBar($('#schedWeeks'), state.boardWeek, (w) => { state.boardWeek = w; renderSchedule(); });
  const host = $('#schedList');
  host.innerHTML = '';
  const wk = weekData(state.boardWeek);

  const byDay = {};
  for (const g of wk.games) {
    const d = kickoff(g).toLocaleDateString(undefined,
      { weekday: 'long', month: 'short', day: 'numeric' });
    (byDay[d] = byDay[d] || []).push(g);
  }

  for (const [day, games] of Object.entries(byDay)) {
    host.append(el('div', 'day', esc(day)));
    for (const g of games) {
      const row = el('div', 'game');
      const tag = (side) => {
        const c = state.confOf[side.id];
        const cf = c ? POOL.conferences.find((x) => x.key === c) : null;
        const rank = side.rank && side.rank <= 25 ? `<span class="muted">#${side.rank}</span> ` : '';
        const nm = esc(side.name);
        const b = g.completed && side.winner ? `<b class="w">${nm}</b>` : nm;
        return `${rank}${b}${cf ? ` <span class="pill">${cf.short}</span>` : ''}`;
      };
      const score = g.completed
        ? ` <span class="meta">${g.away.score}-${g.home.score}</span>` : '';
      row.append(el('div', 'matchup',
        `${tag(g.away)} ${g.neutral ? 'vs' : 'at'} ${tag(g.home)}${score}`));
      row.append(el('div', 'meta', esc(timeLabel(g)) + (g.venue ? ` · ${esc(g.venue)}` : '')));
      host.append(row);
    }
  }
}

/* ---------------- wiring ---------------- */

function renderAll() {
  renderHeader();
  renderBoard();
  renderPicks();
  renderTeams();
  renderSchedule();
}

function showTab(name) {
  document.querySelectorAll('nav button').forEach((b) =>
    b.classList.toggle('on', b.dataset.tab === name));
  document.querySelectorAll('.view').forEach((v) =>
    v.classList.toggle('on', v.id === 'view-' + name));
}

async function boot() {
  try {
    await loadSchedule();
  } catch (e) {
    $('#boot').textContent = 'Could not load schedule.json. ' + e.message;
    return;
  }
  state.week = currentWeek();
  state.boardWeek = state.week;
  restoreSession();

  try {
    await loadPool();
  } catch (e) {
    $('#boot').innerHTML =
      '<div class="notice">Connected to the schedule but not to the pool database. ' +
      'Run schema.sql in Supabase, then reload. <br><small>' + esc(e.message) + '</small></div>';
  }

  $('#boot').style.display = $('#boot').innerHTML ? '' : 'none';
  $('#seasonTag').textContent = `${state.sched.season} · ${POOL.weeks} weeks`;

  document.querySelectorAll('nav button').forEach((b) => {
    b.onclick = () => showTab(b.dataset.tab);
  });

  $('#signinForm').onsubmit = async (e) => {
    e.preventDefault();
    const msg = $('#signinMsg');
    msg.textContent = '';
    try {
      const [first, last] = readSignInFields();
      const emailEl = $('#emailIn');
      const emailVal = emailEl ? emailEl.value : '';
      await signIn(first, last, $('#pinIn').value, emailVal);
      rememberDetails(first, last, emailVal);
      state.draft = {};
      renderAll();
    } catch (err) {
      msg.textContent = err.message;
    }
  };

  $('#saveBtn').onclick = async () => {
    const msg = $('#saveMsg');
    msg.textContent = 'Saving...';
    try {
      await savePicks();
      msg.textContent = 'Saved.';
      state.draft = {};
      renderAll();
    } catch (err) {
      msg.textContent = err.message;
    }
  };

  $('#teamsWho').onchange = renderTeams;

  renderAll();
  showTab('board');
}

boot();
