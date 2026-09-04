-- Power 4 Survivor - move pick rules from the browser into Postgres
-- Run once in Supabase -> SQL Editor -> New query -> paste -> Run.
--
-- The problem this fixes: the page carries a publishable key that anyone can read
-- out of the source, and that key had full read and write on survivor_picks. So
-- every rule the app enforced was advisory. Anyone could read picks that had not
-- kicked off, rewrite a pick after their team lost, or delete the whole pool.
--
-- After this migration the publishable key cannot touch survivor_picks at all.
-- Reads and writes go through functions that check the rules server side:
--   * you are who you say you are          (token issued at sign-in)
--   * your team has not kicked off         (survivor_games.kickoff)
--   * that league is not already committed for the week
--   * you have not used that team before   (unique index, already in place)
--   * you only see other people's picks after their team kicks off

-- ------------------------------------------------------------------ 1. tokens
-- A random per-player secret, issued at sign-in and kept in the browser, so the
-- PIN itself never has to be stored client side or replayed on every write.
alter table survivor_players
  add column if not exists token uuid not null default gen_random_uuid();

-- --------------------------------------------------------------- 2. kickoffs
-- Postgres cannot read schedule.json, so the results job pushes the kickoff
-- times in. One row per team per week: the game that week's pick rides on.
create table if not exists survivor_games (
  week       int  not null,
  team_id    text not null,
  conf       text not null,
  team_name  text not null,
  kickoff    timestamptz not null,
  completed  boolean not null default false,
  won        boolean,
  primary key (week, team_id)
);
create index if not exists survivor_games_kick on survivor_games (week, kickoff);

alter table survivor_games enable row level security;
drop policy if exists games_read on survivor_games;
create policy games_read on survivor_games for select using (true);
grant select on survivor_games to anon;   -- kickoff times are not a secret

-- ------------------------------------------------------------ 3. sign in v2
-- Same as before, but hands back a token the app uses for everything after.
-- Postgres refuses to change a function's return type in place, and this one
-- gains a third output column, so the old version has to go first.
drop function if exists survivor_signin(text, text, text, text);
drop function if exists survivor_picks_read(uuid);
drop function if exists survivor_save_picks(uuid, int, jsonb);

create function survivor_signin(
  p_id text, p_name text, p_pin text, p_email text default null
)
returns table (id text, name text, token uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v survivor_players%rowtype;
begin
  if p_pin !~ '^[0-9]{4}$' then
    raise exception 'BAD_PIN_FORMAT';
  end if;

  select * into v from survivor_players p where p.id = p_id;

  if not found then
    insert into survivor_players (id, name, pin, email)
    values (p_id, p_name, p_pin, nullif(btrim(coalesce(p_email, '')), ''))
    returning * into v;
  else
    if v.pin <> p_pin then
      raise exception 'BAD_PIN';
    end if;
    if nullif(btrim(coalesce(p_email, '')), '') is not null
       and coalesce(v.email, '') <> btrim(p_email) then
      update survivor_players p set email = btrim(p_email) where p.id = p_id
      returning * into v;
    end if;
  end if;

  return query select v.id, v.name, v.token;
end
$$;

-- --------------------------------------------------------- 4. reading picks
-- Everyone's picks once their team has kicked off, plus all of your own.
-- A pick with no matching game row stays visible, matching how the app behaves
-- when it cannot find a game.
create function survivor_picks_read(p_token uuid default null)
returns table (player_id text, week int, conf text, team_id text, team_name text)
language sql
security definer
set search_path = public
as $$
  select k.player_id, k.week, k.conf, k.team_id, k.team_name
  from survivor_picks k
  left join survivor_games g on g.week = k.week and g.team_id = k.team_id
  where g.kickoff is null
     or g.kickoff <= now()
     or k.player_id = (select p.id from survivor_players p where p.token = p_token);
$$;

-- --------------------------------------------------------- 5. writing picks
-- p_picks looks like: [{"conf":"acc","team_id":"52"}, {"conf":"sec","team_id":"333"}]
create function survivor_save_picks(
  p_token uuid, p_week int, p_picks jsonb
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player  text;
  v_item    jsonb;
  v_conf    text;
  v_team    text;
  v_game    survivor_games%rowtype;
  v_current survivor_picks%rowtype;
  v_cur_kick timestamptz;
  v_used    int;
  v_written int := 0;
begin
  select p.id into v_player from survivor_players p where p.token = p_token;
  if v_player is null then
    raise exception 'BAD_TOKEN';
  end if;
  if p_week is null or p_week < 1 or p_week > 13 then
    raise exception 'BAD_WEEK';
  end if;

  for v_item in select * from jsonb_array_elements(p_picks) loop
    v_conf := v_item ->> 'conf';
    v_team := v_item ->> 'team_id';

    if v_conf not in ('acc', 'big10', 'big12', 'sec') then
      raise exception 'BAD_CONF:%', v_conf;
    end if;

    -- The team must actually play in that conference that week.
    select * into v_game from survivor_games g
      where g.week = p_week and g.team_id = v_team;
    if not found then
      raise exception 'NO_GAME:%', v_team;
    end if;
    if v_game.conf <> v_conf then
      raise exception 'WRONG_CONF:%', v_game.team_name;
    end if;

    -- Their game must not have started.
    if v_game.kickoff <= now() then
      raise exception 'KICKED_OFF:%', v_game.team_name;
    end if;

    -- If this league is already committed for the week, it is final.
    select * into v_current from survivor_picks k
      where k.player_id = v_player and k.week = p_week and k.conf = v_conf;
    if found then
      if v_current.team_id = v_team then
        continue;                                  -- unchanged
      end if;
      select g.kickoff into v_cur_kick from survivor_games g
        where g.week = p_week and g.team_id = v_current.team_id;
      if v_cur_kick is not null and v_cur_kick <= now() then
        raise exception 'LOCKED:%', v_current.team_name;
      end if;
    end if;

    -- No team twice all season. The unique index also guards this; checking here
    -- lets us name the team in the error.
    select count(*) into v_used from survivor_picks k
      where k.player_id = v_player and k.team_id = v_team and k.week <> p_week;
    if v_used > 0 then
      raise exception 'ALREADY_USED:%', v_game.team_name;
    end if;

    insert into survivor_picks (player_id, week, conf, team_id, team_name, submitted_at)
    values (v_player, p_week, v_conf, v_team, v_game.team_name, now())
    on conflict (player_id, week, conf) do update
      set team_id = excluded.team_id,
          team_name = excluded.team_name,
          submitted_at = now();
    v_written := v_written + 1;
  end loop;

  return v_written;
end
$$;

-- ----------------------------------------------------------- 6. privileges
-- The publishable key loses direct access to picks entirely.
revoke all on survivor_picks from anon;
grant execute on function survivor_signin(text, text, text, text) to anon;
grant execute on function survivor_picks_read(uuid) to anon;
grant execute on function survivor_save_picks(uuid, int, jsonb) to anon;
