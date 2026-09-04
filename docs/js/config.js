// Pool settings and the Supabase connection.
// The publishable key is meant to sit in client-side code; access is governed
// by the row-level-security policies in schema.sql.

const POOL = {
  name: 'Power 4 Survivor',
  season: 2026,
  weeks: 13,

  // Conferences you must pick one team from, every week.
  conferences: [
    { key: 'acc', name: 'ACC', short: 'ACC', color: '#013ca6' },
    { key: 'big10', name: 'Big Ten', short: 'B1G', color: '#0088ce' },
    { key: 'big12', name: 'Big 12', short: 'B12', color: '#c8102e' },
    { key: 'sec', name: 'SEC', short: 'SEC', color: '#1e2c58' },
  ],

  // Classic survivor. One losing pick, or a week where you did not submit all
  // four, ends your run. Last player standing wins; if everyone is out, whoever
  // lasted longest wins, and people knocked out in the same week tie and split.
  scoring: 'elimination',

  // Knocked-out players can keep making picks for bragging rights. It has no
  // effect on the standings. Set false to lock them out entirely.
  zombiePicks: true,

  // Thursday and Friday games count the same as Saturday games.
  // Set to 'hide' to make it a Saturday-only pool.
  weekdayGames: 'allow',

  // Each pick stays hidden from other players until that team kicks off.
  // Your own picks are always visible to you.
  hidePicksUntilKickoff: true,
};

// Fill these in from Supabase -> Project Settings -> API Keys.
// See README.md, "Setup, once". The publishable key is designed to sit in
// client-side code; access is governed by the policies in schema.sql.
const SUPABASE_URL = 'https://zaunmubozapvjmnigmqj.supabase.co';
const SUPABASE_KEY = 'sb_publishable_cQxgG1XHPjjb_oeVW4NB-A_f2czaY_R';

// eslint-disable-next-line no-undef
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
window.sb = sb;
window.POOL = POOL;
