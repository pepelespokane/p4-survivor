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

Get the values:

1. Left sidebar, bottom: **Project Settings** (gear icon).
2. Click **Data API**. Copy the **Project URL**. It looks like
   `https://abcdefghijkl.supabase.co`. If you copied it from a page that shows
   `.../rest/v1/` on the end, drop that part. The app wants the bare project URL.
3. Click **API Keys** in the same settings menu. Copy the **publishable** key
   (starts `sb_publishable_`).

⚠️ That page also has a **secret** key, sometimes labeled `service_role`. Never put
that one in a web page, a repo, or a chat. It ignores every access rule on the
database. Only the publishable key belongs in this app.

Then get them into the file. Two ways:

**Easiest: hand them to Claude.** Paste both values into the chat and ask it to update
`docs/js/config.js` and publish. That is it.

**Or do it yourself:**

1. Open `C:\Users\sfpug\Projects\personal\SurvivorPool\docs\js\config.js` in Notepad
   or VS Code.
2. Replace the two placeholder lines near the bottom:

```js
const SUPABASE_URL = 'https://abcdefghijkl.supabase.co';
const SUPABASE_KEY = 'sb_publishable_...';
```

3. Save the file.
4. Publish it. In the Claude Code terminal, type `!` followed by the command, which
   runs it right in the session:

```
! git add -A && git commit -m "Point at the survivor Supabase project" && git push
```

   Give GitHub Pages about a minute to rebuild, then reload the site.

### 4. Already done

GitHub Pages is on and serving from `main` / `/docs`, and Actions has read-write
permission so the results job can commit back. The repo is public, which Pages on
the free plan requires. Nothing sensitive is in it.

## Every week

Nothing, if the Action is running. `.github/workflows/update-results.yml` repulls ESPN
**hourly from Thursday through Monday**, covering Thursday and Friday night games, all
of Saturday, and the occasional Sunday or Monday game. Tuesday and Wednesday it runs
once a day, only to catch kickoff times moving. It commits `docs/schedule.json` only
when something actually changed, and pushes kickoff times into the database so the
pick rules can be enforced there. Standings recompute in the browser from that file.

To force a refresh: repo -> **Actions** tab -> **Update schedule and results** ->
**Run workflow**. Or locally, run `python build_schedule.py` (or double-click
`update.bat`) and push.

## How people use it

- **Standings & Picks** - the leaderboard plus everyone's picks for a chosen week.
  A pick reads "submitted" to everyone else until that team kicks off, so a Friday
  night game never leaks somebody's Saturday plan. You always see your own.
- **Make Picks** - sign in with first name, last initial, and a 4-digit PIN. First
  sign-in creates the entry. Then one team per conference; used teams, byes and
  kicked-off teams are greyed out and cannot be selected.
- **Rules** - how it works, in plain language, for anyone joining cold.
- **Teams Left** - the board for any player, defaulting to what they still have
  available, with filters for Used and All. Per conference it shows how many are left,
  how many are burned, and whether that league is still alive for them. Another
  player's board only reveals picks that have already kicked off, so it cannot be used
  to scout what they are sitting on this week.
- **Schedule** - every P4 game that week with kickoff times, TV and final scores.

## After changing any file in docs/

Run `python bump_version.py` before committing. It stamps `index.html` with a hash of
the asset contents, so the `?v=` cache buster changes whenever the files do.

This is not optional politeness. GitHub Pages caches HTML for ten minutes, and a change
shipped under a version that is already cached is invisible to anyone who has loaded the
page before, no matter how many times they refresh. That happened twice before this
script existed.

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

## Where the rules are enforced

Originally all of it lived in the browser, which meant none of it was real: the page
carries a publishable key, and that key had full read and write on the picks table.
Anyone could read picks that had not kicked off, rewrite a pick after their team lost,
or delete the pool.

`migration_secure.sql` moves it into Postgres. The publishable key can no longer touch
`survivor_picks` at all. Instead:

- `survivor_signin()` hands back a per-player **token**, kept in the browser.
- `survivor_picks_read(token)` returns everyone's picks **only once their team has
  kicked off**, plus all of your own. The hiding is now done by the database.
- `survivor_save_picks(token, week, picks)` re-checks every rule server side: the token
  is real, the team plays in that conference that week, its game has not started, that
  league is not already committed for the week, and the team has not been used before.
- `survivor_games` holds the kickoff times, pushed by `sync_games.py` from the results
  workflow, because Postgres cannot read `schedule.json`.

The app falls back to the old direct-table path when those functions are missing, so a
deploy can never outrun a migration.

## Rules the code enforces

- One pick per conference per week.
- **Picks can be changed freely until the chosen team kicks off.** After that the whole
  conference is frozen for that week, so you cannot watch your team lose and swap to a
  later game. Checked against the pick you are leaving, not just the one you are taking.
- A team cannot be used twice, checked in the browser and again by a unique index
  in Postgres so a double-submit cannot slip through.
- A team whose game has kicked off cannot be picked.
- A team on a bye cannot be picked.

## What it does not enforce

The PIN is a courtesy lock, not security. It is stored in plain text and the
Supabase anon key sits in the page, so anyone determined enough could read the
picks table directly. Fine for a pool among friends. Do not put money on the honor
of the PIN.

## Scoring: four separate survivor pools

**Each conference is its own race.** Lose your SEC pick and your SEC run is over; you
are still alive in the ACC, Big Ten and Big 12. Four independent eliminations running
at the same time.

- **Each league has its own winner**, the last one standing in that conference.
- **Skipping a league ends your run in it.** No pick for a conference counts as a loss
  there, applied once that week's games are final.
- **If nobody survives all 13 weeks in a league**, whoever lasted longest in it wins it,
  and everyone knocked out of that league in the same week ties.
- Once you are out of a league you can keep picking in it for bragging rights; it does
  not affect the standings. `POOL.zombiePicks` in `config.js` turns that off.

Picking is unchanged: still one team per conference per week, still no team twice all
season. Only the elimination and the leaderboard changed.

The site never mentions the buy-in; that stays between you and the players. The
standings show a card per conference naming who is leading it, and a
table with one row per player and one column per league. **Every column header sorts**,
including each conference, so you can rank the table by any league.

Thursday and Friday games count the same as Saturday. They lock at their own kickoff,
so a Friday pick is a commitment made with less information. `POOL.weekdayGames`
flips this to Saturday-only.

## Pick reminders by email

`send_reminders.py`, run hourly by `.github/workflows/reminders.yml`, emails everyone
who still has an open pick. It fires once a week, **Thursday 8am Pacific**, or 8 hours
before the first kickoff if a week ever opens earlier than that. Every send is logged
in `survivor_reminders`, so a re-run can never double-mail.

It only nags about leagues you are **still alive in**, and it names them:

```
Week 3 picks lock as each team kicks off. The first game of the week is
Thursday at 4:30 PM Pacific.

Still need a pick in: ACC, Big 12
Already out in: SEC
```

### Turning it on

The job reads email addresses, so it needs Supabase's **secret** key, and it needs a
mailbox to send from. Both live in GitHub Actions secrets, where the browser and this
repo can never see them.

1. **Run `migration_email.sql`** in Supabase -> SQL Editor. This adds the email column
   and, importantly, takes the players table away from the public key entirely. After
   it runs, the browser can only read id and name through a view, and sign-in happens
   inside a database function.

   The app works either way: it tries the view and the function first, and falls back
   to reading the table directly if they are not there yet. So the site never breaks
   waiting on this. Emails just cannot be stored until it runs.
2. **Make a Gmail app password.** Google hides this page; the Security menu usually
   does not link to it even with 2-Step on. Go straight to
   **https://myaccount.google.com/apppasswords**, or search "app passwords" in the
   search bar at the top of myaccount.google.com. Type a name, click Create, copy the
   16 characters. Spaces are cosmetic. A normal Gmail password will not work.

   If that page is unavailable: you are on a Workspace account whose admin disabled
   app passwords, or Advanced Protection is on. Use a personal Gmail, or any other SMTP
   provider by setting the repo **variables** `SMTP_HOST` and `SMTP_PORT`
   (Settings -> Secrets and variables -> Actions -> Variables). No code changes needed.
3. **Add four repo secrets.** GitHub repo -> Settings -> Secrets and variables ->
   Actions -> New repository secret:
   - `SUPABASE_URL` - the bare project url
   - `SUPABASE_SERVICE_KEY` - Supabase -> Project Settings -> API Keys -> **secret**
     key. This one bypasses every access rule, so it goes here and nowhere else.
   - `SMTP_USER` - the Gmail address sending the reminders
   - `SMTP_PASS` - the app password from step 2
4. **Test it.** Actions tab -> Pick reminders -> Run workflow, leave "dry run" checked.
   It prints the emails it would send without sending any.

## Feasibility note## Feasibility note

The Big 12 and the SEC have 16 teams and you burn 13 of them. Most teams have a bye
somewhere in the 13-week window, and the Big 12 has a thin week 6 (only 11 teams
play, 9 of them on Saturday). Hoarding the good teams for late works right up until
it doesn't. The Teams Used tab exists so people can see the squeeze coming.
