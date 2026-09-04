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

async function loadPool() {
  const [p, k] = await Promise.all([
    sb.from('survivor_players').select('*').order('name'),
    sb.from('survivor_picks').select('*'),
  ]);
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

async function signIn(first, last, pin) {
  const { id, name } = buildIdentity(first, last);
  if (!/^\d{4}$/.test(pin)) throw new Error('PIN must be 4 digits.');

  const { data, error } = await sb.from('survivor_players').select('*').eq('id', id).maybeSingle();
  if (error) throw error;

  if (data) {
    if (data.pin !== pin) {
      // A genuinely different person with the same first name and initial also
      // lands here, so name both cases.
      throw new Error(
        `${data.name} is taken. If that is you, check your PIN. If you are a ` +
        `different ${data.name.split(' ')[0]}, add another letter of your last name.`);
    }
    state.me = { id: data.id, name: data.name };
  } else {
    const ins = await sb.from('survivor_players')
      .insert({ id, name, pin }).select().single();
    if (ins.error) throw ins.error;
    state.me = { id: ins.data.id, name: ins.data.name };
    state.players.push(ins.data);
  }
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
  const rows = state.players.map((p) => ({ p, r: record(p.id) }));
  rows.sort((a, b) => b.r.w - a.r.w || a.r.l - b.r.l || a.p.name.localeCompare(b.p.name));

  const t = $('#standings');
  t.innerHTML = '';
  if (!rows.length) {
    t.append(el('p', 'muted', 'No one has joined yet. Open the Make Picks tab to sign up.'));
  } else {
    const tb = el('table');
    tb.innerHTML = `<thead><tr>
      <th></th><th>Player</th><th>Correct</th><th>Missed</th>
      <th>Pending</th><th>Picks made</th><th>Teams left</th></tr></thead>`;
    const body = el('tbody');
    rows.forEach(({ p, r }, i) => {
      const tr = el('tr');
      tr.innerHTML = `
        <td><span class="rank${i === 0 && r.w > 0 ? ' top' : ''}">${i + 1}</span></td>
        <td><b>${esc(p.name)}</b></td>
        <td class="num"><span class="pill win">${r.w}</span></td>
        <td class="num"><span class="pill loss">${r.l}</span></td>
        <td class="num"><span class="pill pend">${r.pend}</span></td>
        <td class="num">${r.made} / ${POOL.weeks * 4}</td>
        <td class="num">${totalTeams() - Object.keys(usedBy(p.id)).length}</td>`;
      body.append(tr);
    });
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

  $('#pickHead').innerHTML =
    `<h2>Week ${wk.poolWeek} picks</h2>` +
    `<p class="muted">Pick one team from each conference. A team you have already ` +
    `used is greyed out, and so is any team whose game has kicked off.</p>`;

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
  $('#saveBtn').disabled = chosen === 0;
  $('#saveNote').textContent = `${chosen} of 4 conferences selected`;
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
      await signIn($('#firstIn').value, $('#lastIn').value, $('#pinIn').value);
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
