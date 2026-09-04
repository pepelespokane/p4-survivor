"""
Email the pool when picks are about to lock.

Fires once per week, LEAD_HOURS before the first kickoff of that pool week, and
only to people who are still alive and still missing at least one pick. Every send
is logged in survivor_reminders so a re-run never double-mails anyone.

Runs from GitHub Actions on an hourly cron; the window check below is what turns an
hourly job into a single email.

Environment:
  SUPABASE_URL          project url, no trailing path
  SUPABASE_SERVICE_KEY  service_role key. It reads emails, so it must be the secret
                        one, and it must only ever live in GitHub Actions secrets.
  SMTP_HOST             default smtp.gmail.com
  SMTP_PORT             default 587
  SMTP_USER             the sending address
  SMTP_PASS             app password for that address
  SITE_URL              default https://pepelespokane.github.io/p4-survivor/
  DRY_RUN               set to 1 to print instead of send
"""

import json
import os
import smtplib
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone, timedelta
from email.message import EmailMessage
from pathlib import Path
try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover
    ZoneInfo = None

# Thursday morning Pacific is the cadence people asked for. The 8-hour rule is the
# safety net: if a week ever opens with an early game, the email moves earlier so it
# still lands before anything locks. In the 2026 schedule Thursday 8am always wins,
# because no week kicks off before Thursday afternoon.
REMINDER_DOW = 3          # Monday = 0, so 3 = Thursday
REMINDER_HOUR = 8         # 8am
REMINDER_TZ = "America/Los_Angeles"
LEAD_HOURS = 8

CONFS = [("acc", "ACC"), ("big10", "Big Ten"), ("big12", "Big 12"), ("sec", "SEC")]

SITE = os.environ.get("SITE_URL", "https://pepelespokane.github.io/p4-survivor/")
SB_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SB_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
DRY = os.environ.get("DRY_RUN") == "1"


# ----------------------------------------------------------------- supabase
def sb(method, path, body=None, params=None):
    url = SB_URL + "/rest/v1/" + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "apikey": SB_KEY,
        "Authorization": "Bearer " + SB_KEY,
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read().decode()
            return json.loads(raw) if raw.strip() else []
    except urllib.error.HTTPError as e:
        detail = e.read().decode()[:300]
        raise RuntimeError(method + " " + path + " -> " + str(e.code) + ": " + detail)


# ----------------------------------------------------------------- schedule
def load_schedule():
    path = Path(__file__).parent / "docs" / "schedule.json"
    return json.loads(path.read_text(encoding="utf-8"))


def kick(g):
    return datetime.fromisoformat(g["kickoff"].replace("Z", "+00:00"))


def week_opens(wk):
    """First kickoff of a pool week. Mirrors weekOpens() in app.js: anchor on the
    Saturday carrying the most games, so ESPN's stray Week 0 games sitting in the
    week 1 bucket do not drag the deadline a week early."""
    sats = {}
    for g in wk["games"]:
        if g["day"] == "Sat":
            day = g["kickoff"][:10]
            sats[day] = sats.get(day, 0) + 1
    if not sats:
        return min(kick(g) for g in wk["games"])
    anchor = sorted(sats, key=lambda d: (-sats[d], d))[0]
    floor = datetime.fromisoformat(anchor + "T00:00:00+00:00") - timedelta(days=3)
    live = [g for g in wk["games"] if kick(g) >= floor]
    return min(kick(g) for g in (live or wk["games"]))


def pacific():
    """America/Los_Angeles, or a fixed offset if the tz database is missing.
    The season runs Sep-Nov, so the only transition inside it is Nov 1 2026."""
    if ZoneInfo is not None:
        try:
            return ZoneInfo(REMINDER_TZ)
        except Exception:  # noqa: BLE001 - no tzdata installed
            pass
    return timezone(timedelta(hours=-7))


def reminder_time(opens):
    """When to email for a week whose first kickoff is `opens`: the Thursday before
    it at 8am Pacific, or 8 hours before kickoff, whichever comes first."""
    tz = pacific()
    local = opens.astimezone(tz)
    back = (local.weekday() - REMINDER_DOW) % 7
    thursday = (local - timedelta(days=back)).replace(
        hour=REMINDER_HOUR, minute=0, second=0, microsecond=0)
    if thursday >= local:                      # kickoff is Thursday morning or earlier
        thursday -= timedelta(days=7)
    return min(thursday.astimezone(timezone.utc), opens - timedelta(hours=LEAD_HOURS))


def current_week(sched, now):
    for wk in sched["weeks"]:
        if any(kick(g) > now for g in wk["games"]):
            return wk
    return None


def game_for(wk, team_id, now):
    hits = [g for g in wk["games"]
            if g["home"]["id"] == team_id or g["away"]["id"] == team_id]
    if not hits:
        return None
    for g in hits:
        if kick(g) > now:
            return g
    return hits[-1]


def outcome(wk, team_id, now):
    g = game_for(wk, team_id, now)
    if not g or not g["completed"]:
        return "pending"
    side = g["home"] if g["home"]["id"] == team_id else g["away"]
    if side.get("winner") is True:
        return "win"
    if side.get("winner") is False:
        return "loss"
    return "pending"


def elim_conf(sched, picks_by_week, conf, now):
    """Mirrors elimConf() in app.js. Each conference is its own survivor pool, so a
    loss only ends that one. Returns the pool week it ended, or None if still alive."""
    for wk in sched["weeks"]:
        pk = picks_by_week.get(wk["week"], {}).get(conf)
        if pk:
            o = outcome(wk, pk["team_id"], now)
            if o == "loss":
                return wk["poolWeek"]
            if o == "pending":
                return None
        else:
            if not all(g["completed"] for g in wk["games"]):
                return None
            return wk["poolWeek"]
    return None


def fmt_local(dt):
    """'Saturday at 9:00 AM Pacific'. Built by hand because %-I is not portable."""
    local = dt.astimezone(pacific())
    hour = local.hour % 12 or 12
    return local.strftime("%A at ") + str(hour) + local.strftime(":%M %p Pacific")


# -------------------------------------------------------------------- email
def send(to_addr, subject, body):
    host = os.environ.get("SMTP_HOST", "smtp.gmail.com")
    port = int(os.environ.get("SMTP_PORT", "587"))
    user = os.environ["SMTP_USER"]
    pw = os.environ["SMTP_PASS"]

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = "Power 4 Survivor <" + user + ">"
    msg["To"] = to_addr
    msg.set_content(body)

    if DRY:
        print("\n--- DRY RUN to " + to_addr + " ---")
        print(subject)
        print()
        print(body)
        return

    with smtplib.SMTP(host, port, timeout=30) as server:
        server.starttls(context=ssl.create_default_context())
        server.login(user, pw)
        server.send_message(msg)


# --------------------------------------------------------------------- main
def main():
    now = datetime.now(timezone.utc)
    sched = load_schedule()
    wk = current_week(sched, now)
    if not wk:
        print("Season is over. Nothing to send.")
        return 0

    opens = week_opens(wk)
    due = reminder_time(opens)
    print("Pool week " + str(wk["poolWeek"])
          + " first kickoff " + opens.strftime("%a %Y-%m-%d %H:%M UTC")
          + ", reminder due " + due.strftime("%a %Y-%m-%d %H:%M UTC"))

    if now < due:
        mins = (due - now).total_seconds() / 60.0
        print("Too early by " + format(mins / 60.0, ".1f") + "h. Nothing to send.")
        return 0
    if now >= opens:
        print("First game has kicked off. Not sending a 'picks due' note now.")
        return 0

    players = sb("GET", "survivor_players", params={"select": "id,name,email"})
    all_picks = sb("GET", "survivor_picks",
                   params={"select": "player_id,week,conf,team_id,team_name"})
    log = sb("GET", "survivor_reminders",
             params={"select": "player_id", "week": "eq." + str(wk["week"]),
                     "kind": "eq.picks-due"})
    already = set(r["player_id"] for r in log)

    by_player = {}
    for pk in all_picks:
        weeks = by_player.setdefault(pk["player_id"], {})
        weeks.setdefault(pk["week"], {})[pk["conf"]] = pk

    sent = 0
    for p in players:
        if p["id"] in already:
            print("  " + p["name"] + ": already reminded for this week")
            continue
        if not p.get("email"):
            print("  " + p["name"] + ": no email on file")
            continue

        picks_by_week = by_player.get(p["id"], {})
        have = picks_by_week.get(wk["week"], {})

        # Only nag about leagues they are still alive in.
        live, dead = [], []
        for key, label in CONFS:
            if elim_conf(sched, picks_by_week, key, now) is None:
                live.append((key, label))
            else:
                dead.append(label)

        if not live:
            print("  " + p["name"] + ": out of all four leagues")
            continue

        missing = [label for key, label in live if key not in have]
        if not missing:
            print("  " + p["name"] + ": picks in for every live league")
            continue

        first = p["name"].split(" ")[0]
        need = ", ".join(missing)
        lines_ = [
            first + ",",
            "",
            "Week " + str(wk["poolWeek"]) + " picks lock as each team kicks off. "
            "The first game of the week is " + fmt_local(opens) + ".",
            "",
            "Still need a pick in: " + need,
        ]
        if dead:
            lines_.append("Already out in: " + ", ".join(dead))
        lines_ += [
            "",
            "Each conference is its own pool, so skipping one only ends your run in "
            "that league.",
            "",
            "Make your picks: " + SITE,
            "",
        ]
        body = chr(10).join(lines_)
        subject = ("Week " + str(wk["poolWeek"]) + " picks: " + str(len(missing))
                   + " league" + ("" if len(missing) == 1 else "s") + " still open")

        try:
            send(p["email"], subject, body)
            if not DRY:
                sb("POST", "survivor_reminders",
                   body={"week": wk["week"], "player_id": p["id"], "kind": "picks-due"})
            sent += 1
            print("  " + p["name"] + ": reminded, needs " + need)
        except Exception as e:  # noqa: BLE001 - one bad address must not stop the rest
            print("  " + p["name"] + ": FAILED - " + str(e))

    print("\nSent " + str(sent) + " reminder(s).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
