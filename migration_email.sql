-- Power 4 Survivor - add email + lock down who can read it
-- Run once in Supabase -> SQL Editor -> New query -> paste -> Run.
--
-- Why this is more than "add a column": the page talks to Supabase with a
-- publishable key that anyone can read out of the page source. Until now that was
-- fine, because the players table held nothing worth stealing. An email address is
-- different. So this migration takes direct read access to survivor_players away
-- from the public key entirely and replaces it with:
--   * a VIEW that exposes only id and name, for the standings board
--   * a FUNCTION that does sign-in and registration server side
-- After this, the browser can never read an email or a PIN, only send one in.

alter table survivor_players add column if not exists email text;

-- ---------------------------------------------------------------- public view
drop view if exists survivor_players_public;
create view survivor_players_public as
  select id, name, created_at from survivor_players;

-- ------------------------------------------------------------ sign in / join
-- Returns the player on success. Raises BAD_PIN if the name is taken and the PIN
-- does not match. Creates the entry on first use.
create or replace function survivor_signin(
  p_id text, p_name text, p_pin text, p_email text default null
)
returns table (id text, name text)
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
    -- The PIN just proved it is them, so let them correct their own email.
    if nullif(btrim(coalesce(p_email, '')), '') is not null
       and coalesce(v.email, '') <> btrim(p_email) then
      update survivor_players p set email = btrim(p_email) where p.id = p_id;
    end if;
  end if;

  return query select v.id, v.name;
end
$$;

-- ------------------------------------------------- reminder send log (server)
create table if not exists survivor_reminders (
  week       int  not null,
  player_id  text not null references survivor_players(id) on delete cascade,
  kind       text not null default 'picks-due',
  sent_at    timestamptz not null default now(),
  primary key (week, player_id, kind)
);
alter table survivor_reminders enable row level security;
-- No policy and no grant: only the service key touches this.

-- ----------------------------------------------------------------- privileges
revoke all on survivor_players from anon;
grant select on survivor_players_public to anon;
grant execute on function survivor_signin(text, text, text, text) to anon;

-- Picks stay directly readable and writable; there is nothing private in them.
grant select, insert, update, delete on survivor_picks to anon;
