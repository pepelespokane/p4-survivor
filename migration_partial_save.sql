-- Partial pick saves.
--
-- The problem this fixes: survivor_save_picks ran all four leagues in one
-- transaction, so a single bad league rolled back the other three. The browser
-- then showed only the one team's error (usually "X is already used this
-- season"), which reads like one league failed and three succeeded. Nothing had
-- saved. A player could reasonably close the tab believing his picks were in and
-- be eliminated in all four leagues.
--
-- The fix: each league gets its own subtransaction via an inner BEGIN/EXCEPTION
-- block. A failure unwinds only that block, so leagues that already succeeded
-- stay committed. The return type changes from int to jsonb so the caller can
-- name exactly what saved and what did not:
--
--   {"saved":  [{"conf":"acc","team_name":"Miami","changed":true}, ...],
--    "failed": [{"conf":"sec","code":"ALREADY_USED","detail":"Georgia"}]}
--
-- BAD_TOKEN and BAD_WEEK stay hard failures for the whole call. They are not
-- per-league problems and there is nothing partial to salvage.
--
-- Run in the Supabase SQL editor. Safe to re-run.

drop function if exists survivor_save_picks(uuid, int, jsonb);

create function survivor_save_picks(
  p_token uuid, p_week int, p_picks jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player   text;
  v_item     jsonb;
  v_conf     text;
  v_team     text;
  v_game     survivor_games%rowtype;
  v_current  survivor_picks%rowtype;
  v_cur_kick timestamptz;
  v_used     int;
  v_found    boolean;
  v_saved    jsonb := '[]'::jsonb;
  v_failed   jsonb := '[]'::jsonb;
  v_msg      text;
  v_code     text;
  v_detail   text;
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

    -- One subtransaction per league. This block is the whole point of the
    -- migration: an exception raised inside it rolls back only this league.
    begin
      if v_conf is null or v_conf not in ('acc', 'big10', 'big12', 'sec') then
        raise exception 'BAD_CONF:%', coalesce(v_conf, '?');
      end if;

      -- The team must actually play in that conference that week.
      select * into v_game from survivor_games g
        where g.week = p_week and g.team_id = v_team;
      if not found then
        raise exception 'NO_GAME:%', coalesce(v_team, '?');
      end if;
      if v_game.conf <> v_conf then
        raise exception 'WRONG_CONF:%', v_game.team_name;
      end if;

      -- Their game must not have started.
      if v_game.kickoff <= now() then
        raise exception 'KICKED_OFF:%', v_game.team_name;
      end if;

      select * into v_current from survivor_picks k
        where k.player_id = v_player and k.week = p_week and k.conf = v_conf;
      v_found := found;

      if v_found and v_current.team_id = v_team then
        -- Already exactly this pick. Report it as in, but do not restamp
        -- submitted_at; that timestamp is how we tell a late pick from an
        -- early one when a reminder looks wrong.
        v_saved := v_saved || jsonb_build_object(
          'conf', v_conf, 'team_name', v_game.team_name, 'changed', false);
      else
        -- If this league is already committed for the week, it is final.
        if v_found then
          select g.kickoff into v_cur_kick from survivor_games g
            where g.week = p_week and g.team_id = v_current.team_id;
          if v_cur_kick is not null and v_cur_kick <= now() then
            raise exception 'LOCKED:%', v_current.team_name;
          end if;
        end if;

        -- No team twice all season. The unique index also guards this; checking
        -- here lets us name the team in the error.
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

        v_saved := v_saved || jsonb_build_object(
          'conf', v_conf, 'team_name', v_game.team_name, 'changed', true);
      end if;

    exception when others then
      -- Our own errors are raised as 'CODE:detail'. Anything else (a genuine
      -- database error) is passed through with an empty detail rather than
      -- swallowed, so it still surfaces in the browser.
      v_msg := SQLERRM;
      if strpos(v_msg, ':') > 0 then
        v_code   := split_part(v_msg, ':', 1);
        v_detail := substr(v_msg, strpos(v_msg, ':') + 1);
      else
        v_code   := v_msg;
        v_detail := '';
      end if;
      v_failed := v_failed || jsonb_build_object(
        'conf', coalesce(v_conf, '?'), 'code', v_code, 'detail', v_detail);
    end;
  end loop;

  return jsonb_build_object('saved', v_saved, 'failed', v_failed);
end
$$;

grant execute on function survivor_save_picks(uuid, int, jsonb) to anon;
