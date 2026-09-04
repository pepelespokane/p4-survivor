# Power 4 Survivor Pool

Pick one team from the ACC, Big Ten, Big 12 and SEC every week for 13 weeks.
No team can be used twice all season. 52 picks out of 67 available teams.

Static site. Schedule and results come from ESPN and ship as a JSON file.
Players and picks live in Supabase, so everyone sees the same board.

**Live at https://pepelespokane.github.io/p4-survivor/**
Repo: https://github.com/pepelespokane/p4-survivor

## What's here

```
build_schedule.py     pulls the 2026 P4 schedule + results from ESPN -> docs/schedule.json
schema.sql            run once in Supabase to create the two tables
update.bat            double-click to refresh results by hand
.github/workflows/    the Action that refreshes results automatically
docs/                 the site (this folder is what you host)
  index.html
  schedule.json       67 teams, 13 weeks, 486 games
  css/style.css
  js/config.js        pool rules + Supabase keys
  js/app.js
```

## The 13 weeks

ESPN weeks 1-13 line up exactly with the 13 pool Saturdays, **Sep 5 through Nov 28**.
ESPN's week 1 bucket also carries the Aug 29 openers and the Sep 3-4 weeknight games.
Those are already played, so the app treats them as locked and they drop off the
pick list on their own. No special-casing needed.

## Setup, once

This is the only part that needs hands. Roughly ten minutes.

### 1. Create the Supabase project

Its own project, separate from AGP Trivia, so a football pool never affects
anything that matters.

1. Go to **https://supabase.com/dashboard** and sign in.
2. Click **New project** (green button, top right).
3. Organization: your existing one is fine.
4. **Name:** `survivor-pool`
5. **Database Password:** click **Generate a password**, then **Copy**. Paste it
   somewhere safe. You will not need it for this app, but you cannot see it again.
6. **Region:** `West US (North California)`
7. **Pricing Plan:** **Free**. This pool will not come close to the free limits.
8. Click **Create new project** and wait about two minutes for it to provision.

### 2. Create the tables

1. In the left sidebar click **SQL Editor** (terminal icon).
2. Click **New query**.
3. Open `schema.sql` from this folder, copy the whole file, paste it into the editor.
4. Click **Run** (bottom right, or Ctrl+Enter).
5. You should see **Success. No rows returned.** That is correct, it only creates things.
6. Click **Table Editor** in the sidebar and confirm `survivor_players` and
   `survivor_picks` are both listed.

### 3. Copy the two keys into the app

1. Left sidebar, bottom: **Project Settings** (gear icon).
2. Click **Data API**. Copy the **Project URL**. It looks like
   `https://abcdefghijkl.supabase.co`.
3. Click **API Keys** in the same settings menu. Copy the **publishable** key
   (starts `sb_publishable_`). Do **not** use the secret or service_role key.
   Never put that one in a web page.
4. Open `docs/js/config.js` and replace the two placeholder lines:

```js
const SUPABASE_URL = 'https://abcdefghijkl.supabase.co';
const SUPABASE_KEY = 'sb_publishable_...';
```

5. Save, then `git add -A`, `git commit -m "Point at the survivor Supabase project"`,
   `git push`.

### 4. Already done

GitHub Pages is on and serving from `main` / `/docs`, and Actions has read-write
permission so the results job can commit back. The repo is public, which Pages on
the free plan requires. Nothing sensitive is in it.

## Every week

Nothing, if the Action is running. `.github/workflows/update-results.yml` repulls ESPN
hourly through Saturday and Saturday night, once a day the rest of the week, and
commits `docs/schedule.json` only when something actually changed. Standings recompute
in the browser from that file.

To force a refresh: repo -> **Actions** tab -> **Update schedule and results** ->
**Run workflow**. Or locally, run `python build_schedule.py` (or double-click
`update.bat`) and push.

## How people use it

- **Standings & Picks** - the leaderboard plus everyone's picks for a chosen week.
  A pick reads "submitted" to everyone else until that team kicks off, so a Friday
  night game never leaks somebody's Saturday plan. You always see your own.
- **Make Picks** - sign in with a name and a 4-digit PIN. First sign-in creates the
  entry and asks the money question once. Then one team per conference; used teams,
  byes and kicked-off teams are greyed out and cannot be selected.
- **Rules** - the rules, plus the running tally of the money question: most points
  wins the pot, or nobody wins and it gets invested and rolled to next year. The app
  only collects the answers, it does not act on them.
- **Teams Used** - the full 67-team board for any player, showing what is burned,
  which week it was used, and whether it hit.
- **Schedule** - every P4 game that week with kickoff times, TV and final scores.

## ESPN, and why the code talks to two hosts

`site.api.espn.com` is the clean endpoint and it is what runs locally. It has two
traps:

- A long User-Agent string gets a **403**. `Mozilla/5.0` works; adding
  `(Windows NT 10.0; Win64; x64)` does not. This is not documented anywhere.
- It **refuses datacenter IPs**, so it 403s every time from a GitHub Actions runner.

So `build_schedule.py` falls back to `cdn.espn.com/core/college-football/schedule`,
which answers from anywhere and carries the same data: ids, kickoff times, TV,
venues, ranks, scores and winners. Verified identical game sets for weeks 1, 3 and 13.
If the Action ever starts failing, that fallback is the first place to look.

## Rules the code enforces

- One pick per conference per week.
- A team cannot be used twice, checked in the browser and again by a unique index
  in Postgres so a double-submit cannot slip through.
- A team whose game has kicked off cannot be picked.
- A team on a bye cannot be picked.

## What it does not enforce

The PIN is a courtesy lock, not security. It is stored in plain text and the
Supabase anon key sits in the page, so anyone determined enough could read the
picks table directly. Fine for a pool among friends. Do not put money on the honor
of the PIN.

## Scoring

One point per correct pick, 52 possible over the season. Ties break on fewest misses.

Thursday and Friday games count the same as Saturday games. They lock at their own
kickoff, which is earlier, so a Friday pick is a commitment made with less information.
`POOL.weekdayGames` in `config.js` flips this to Saturday-only if the group hates it.

True survivor elimination, where the first loss ends your season, would empty the
pool by mid-October: you are making four picks a week, so surviving 13 weeks means
going 52-0. Points is the version that stays fun in November. If you want
elimination anyway, `POOL.scoring` in `config.js` is where that decision lives.

## Feasibility note

The Big 12 and the SEC have 16 teams and you burn 13 of them. Most teams have a bye
somewhere in the 13-week window, and the Big 12 has a thin week 6 (only 11 teams
play, 9 of them on Saturday). Hoarding the good teams for late works right up until
it doesn't. The Teams Used tab exists so people can see the squeeze coming.
