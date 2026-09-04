-- Power 4 Survivor Pool - Supabase schema
-- Run once: Supabase -> SQL Editor -> New query -> paste -> Run.
--
-- Two tables. Players self-register with a name and a 4-digit PIN.
-- The PIN is a "keep your brother-in-law out of your picks" lock, not real
-- security: it is stored in plain text and anyone with the page can read the
-- table. Fine for a friends pool, not fine for anything that matters.

create table if not exists survivor_players (
  id          text primary key,            -- slug of the display name
  name        text not null,
  pin         text not null,
  -- Answered once at signup: 'pot' = most points wins it,
  -- 'rollover' = nobody wins, it gets invested and carries to next year.
  payout_vote text check (payout_vote in ('pot','rollover')),
  created_at  timestamptz not null default now()
);

-- If the players table already exists from an earlier run, add the column.
alter table survivor_players add column if not exists payout_vote text;

create table if not exists survivor_picks (
  player_id    text not null references survivor_players(id) on delete cascade,
  week         int  not null check (week between 1 and 13),
  conf         text not null check (conf in ('acc','big10','big12','sec')),
  team_id      text not null,
  team_name    text not null,
  submitted_at timestamptz not null default now(),
  primary key (player_id, week, conf)
);

-- One team per player per season, across all weeks and conferences.
create unique index if not exists survivor_picks_no_reuse
  on survivor_picks (player_id, team_id);

create index if not exists survivor_picks_week on survivor_picks (week);

-- Row level security. Everything is readable; writes are open too, because
-- there is no server to authenticate against. The app hides other players'
-- picks until kickoff, which is a convention, not an enforcement.
alter table survivor_players enable row level security;
alter table survivor_picks   enable row level security;

drop policy if exists players_all on survivor_players;
create policy players_all on survivor_players for all using (true) with check (true);

drop policy if exists picks_all on survivor_picks;
create policy picks_all on survivor_picks for all using (true) with check (true);

-- Required for Data API access on tables created after Oct 30, 2026.
-- Harmless to run before then.
grant select, insert, update, delete on survivor_players to anon;
grant select, insert, update, delete on survivor_picks   to anon;
