-- Show THAT a pick is in without showing WHAT it is.
--
-- The problem this fixes: survivor_picks_read only returned rows whose game had
-- already kicked off, so a hidden pick was not sent to the browser at all. The
-- standings grid therefore could not tell "hasn't picked" from "picked, hidden"
-- and drew a dash for both. The "submitted / hidden until kickoff" pill already
-- in app.js was unreachable code. It also meant the only way to answer "is
-- everyone in?" was to read the picks table with the service key.
--
-- The fix: return a row for every pick, but null out team_id and team_name while
-- the pick is still hidden, and flag it. Who has picked becomes public; what they
-- picked stays private until their game starts, which is the same guarantee as
-- before. Your own picks are always revealed to you.
--
-- submitted_at is returned too. It is what separates "the reminder was sent
-- before they picked" from "the pick never saved", which is exactly the question
-- that prompted this.
--
-- Run in the Supabase SQL editor. Safe to re-run.

drop function if exists survivor_picks_read(uuid);

create function survivor_picks_read(p_token uuid default null)
returns table (
  player_id    text,
  week         int,
  conf         text,
  team_id      text,
  team_name    text,
  submitted_at timestamptz,
  hidden       boolean
)
language sql
security definer
set search_path = public
as $$
  select
    k.player_id,
    k.week,
    k.conf,
    case when v.reveal then k.team_id   else null end,
    case when v.reveal then k.team_name else null end,
    k.submitted_at,
    not v.reveal
  from survivor_picks k
  left join survivor_games g
    on g.week = k.week and g.team_id = k.team_id
  cross join lateral (
    select (
         g.kickoff is null          -- no game row, nothing to protect
      or g.kickoff <= now()         -- kicked off, so it is public
      or k.player_id = (select p.id from survivor_players p where p.token = p_token)
    ) as reveal
  ) v;
$$;

grant execute on function survivor_picks_read(uuid) to anon;
