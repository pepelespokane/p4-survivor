-- Power 4 Survivor - slow down PIN guessing
-- Run once in Supabase -> SQL Editor -> New query -> paste -> Run.
--
-- A 4-digit PIN is 10,000 combinations. With no limit that is a few minutes of
-- scripting, and a correct PIN hands out a token, which is write access to that
-- person's picks. This caps it at 5 wrong guesses per name, then a 15 minute wait.
--
-- The catch that shapes the design: raising an exception rolls the transaction
-- back, which would undo the counter that recorded the failed attempt. So the
-- function stops raising for a bad PIN and returns an `err` column instead. That
-- commits, so the count actually sticks.

create table if not exists survivor_signin_fails (
  player_id  text primary key,
  fails      int not null default 0,
  last_fail  timestamptz not null default now()
);
alter table survivor_signin_fails enable row level security;
-- No policy and no grant: only SECURITY DEFINER functions touch this.

drop function if exists survivor_signin(text, text, text, text);

create function survivor_signin(
  p_id text, p_name text, p_pin text, p_email text default null
)
returns table (id text, name text, token uuid, err text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v          survivor_players%rowtype;
  v_fails    int := 0;
  v_last     timestamptz;
  c_max      constant int := 5;
  c_window   constant interval := interval '15 minutes';
begin
  if p_pin !~ '^[0-9]{4}$' then
    return query select null::text, null::text, null::uuid, 'BAD_PIN_FORMAT'::text;
    return;
  end if;

  select f.fails, f.last_fail into v_fails, v_last
    from survivor_signin_fails f where f.player_id = p_id;

  -- SELECT INTO sets the variable to NULL when no row matches, so a first-time
  -- failure would otherwise try to write NULL into a not-null column.
  v_fails := coalesce(v_fails, 0);

  -- Old failures age out, so an honest mistake yesterday does not count today.
  if v_last is not null and v_last < now() - c_window then
    v_fails := 0;
  end if;

  if v_fails >= c_max then
    return query select null::text, null::text, null::uuid, 'LOCKED_OUT'::text;
    return;
  end if;

  select * into v from survivor_players p where p.id = p_id;

  if not found then
    insert into survivor_players (id, name, pin, email)
    values (p_id, p_name, p_pin, nullif(btrim(coalesce(p_email, '')), ''))
    returning * into v;
  else
    if v.pin <> p_pin then
      insert into survivor_signin_fails (player_id, fails, last_fail)
      values (p_id, v_fails + 1, now())
      on conflict (player_id) do update
        set fails = coalesce(v_fails, 0) + 1, last_fail = now();
      return query select null::text, null::text, null::uuid, 'BAD_PIN'::text;
      return;
    end if;

    if nullif(btrim(coalesce(p_email, '')), '') is not null
       and coalesce(v.email, '') <> btrim(p_email) then
      update survivor_players p set email = btrim(p_email) where p.id = p_id
      returning * into v;
    end if;
  end if;

  -- Clean slate on a successful sign-in.
  delete from survivor_signin_fails f where f.player_id = p_id;

  return query select v.id, v.name, v.token, null::text;
end
$$;

grant execute on function survivor_signin(text, text, text, text) to anon;
