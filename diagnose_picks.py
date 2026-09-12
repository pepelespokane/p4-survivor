"""Read-only diagnostic: who actually has picks in, and when did they submit?

Answers the question the Saturday digest cannot: the digest is a snapshot taken at
14:00 UTC (7am Pacific), so a player who picks at 7:30am looks missing in the email
and is fine by kickoff. This prints submitted_at for every pick and marks which ones
landed AFTER the digest ran, which separates "the email was stale" from "the save is
broken".

Writes nothing. Needs the service key because migration_secure.sql revoked the
publishable key's access to survivor_picks and survivor_players.

  set SUPABASE_SERVICE_KEY=...            (or export, in bash)
  python diagnose_picks.py
  python diagnose_picks.py sean-b bo-j    (drill into specific players, all weeks)
"""

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone, timedelta
from pathlib import Path

try:
    from zoneinfo import ZoneInfo
    PAC = ZoneInfo("America/Los_Angeles")
except ImportError:
    PAC = timezone(timedelta(hours=-7))

SB_URL = os.environ.get("SUPABASE_URL", "https://zaunmubozapvjmnigmqj.supabase.co").rstrip("/")
SB_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
CONFS = [("acc", "ACC"), ("big10", "Big Ten"), ("big12", "Big 12"), ("sec", "SEC")]


def sb(path, params=None):
    url = SB_URL + "/rest/v1/" + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={
        "apikey": SB_KEY, "Authorization": "Bearer " + SB_KEY})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read().decode()
            return json.loads(raw) if raw.strip() else []
    except urllib.error.HTTPError as e:
        raise RuntimeError("GET " + path + " -> " + str(e.code) + ": " + e.read().decode()[:300])


def pac(ts):
    if not ts:
        return "(no timestamp)"
    return datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone(PAC).strftime("%a %m/%d %I:%M %p")


def main():
    if not SB_KEY:
        print("SUPABASE_SERVICE_KEY is not set.")
        print("Grab it from Supabase -> Project Settings -> API Keys -> service_role,")
        print("or from the GitHub repo secret SUPABASE_SERVICE_KEY, then:")
        print("  set SUPABASE_SERVICE_KEY=<key>   &&   python diagnose_picks.py")
        return 1

    now = datetime.now(timezone.utc)
    sched = json.loads((Path(__file__).parent / "docs" / "schedule.json").read_text(encoding="utf-8"))

    # Current pool week = first week with a game that has not kicked off. Mirrors
    # currentWeek() in app.js so this agrees with what players see.
    cur = None
    for wk in sched["weeks"]:
        if any(datetime.fromisoformat(g["kickoff"].replace("Z", "+00:00")) > now for g in wk["games"]):
            cur = wk
            break
    if cur is None:
        cur = sched["weeks"][-1]
    W = cur["week"]

    # Most recent Saturday 14:00 UTC = when the commissioner digest last ran.
    digest = now.replace(hour=14, minute=0, second=0, microsecond=0)
    while digest.weekday() != 5 or digest > now:
        digest -= timedelta(days=1)

    players = sb("survivor_players", {"select": "id,name,email"})
    picks = sb("survivor_picks", {"select": "player_id,week,conf,team_id,team_name,submitted_at"})
    games = sb("survivor_games", {"select": "week,team_id,team_name,conf,kickoff,won,completed"})

    gmap = {(g["week"], g["team_id"]): g for g in games}
    by = {}
    for p in picks:
        by.setdefault(p["player_id"], {}).setdefault(p["week"], {})[p["conf"]] = p

    print("=" * 78)
    print("POOL WEEK %d   |   now %s   |   last digest ran %s"
          % (cur["poolWeek"], pac(now.isoformat()), pac(digest.isoformat())))
    print("=" * 78)

    args = [a.lower() for a in sys.argv[1:]]
    if args:
        for p in players:
            if p["id"].lower() not in args and (p.get("name") or "").lower() not in args:
                continue
            print("\n### %s (%s)  %s" % (p["name"], p["id"], p.get("email") or "NO EMAIL"))
            weeks = by.get(p["id"], {})
            if not weeks:
                print("   NO PICKS AT ALL, any week.")
            for w in sorted(weeks):
                for key, label in CONFS:
                    pk = weeks[w].get(key)
                    if not pk:
                        print("   wk%-2d %-8s -" % (w, label))
                        continue
                    g = gmap.get((w, pk["team_id"]))
                    res = ""
                    if g and g.get("completed"):
                        res = "  WON" if g.get("won") else "  LOST"
                    print("   wk%-2d %-8s %-22s submitted %s%s"
                          % (w, label, pk["team_name"], pac(pk["submitted_at"]), res))
        return 0

    late, missing_now = [], []
    print("\n%-18s %-9s %-9s %-9s %-9s" % ("PLAYER", "ACC", "BIG TEN", "BIG 12", "SEC"))
    print("-" * 78)
    for p in sorted(players, key=lambda x: x["name"]):
        weeks = by.get(p["id"], {})
        have = weeks.get(W, {})
        cells, miss = [], []
        for key, label in CONFS:
            pk = have.get(key)
            if not pk:
                cells.append("--")
                miss.append(label)
                continue
            sub = datetime.fromisoformat(pk["submitted_at"].replace("Z", "+00:00")) \
                if pk.get("submitted_at") else None
            if sub and sub > digest:
                cells.append("IN*")
                late.append((p["name"], label, pac(pk["submitted_at"])))
            else:
                cells.append("in")
        print("%-18s %-9s %-9s %-9s %-9s%s"
              % (p["name"], cells[0], cells[1], cells[2], cells[3],
                 "   <- MISSING: " + ", ".join(miss) if miss else ""))
        if miss:
            missing_now.append((p["name"], miss))

    print("-" * 78)
    print("*  submitted AFTER the digest ran, so the email was correct when it was sent.")
    if late:
        print("\nPICKS THAT LANDED AFTER THE DIGEST:")
        for n, lb, t in late:
            print("   %-16s %-8s %s" % (n, lb, t))
    else:
        print("\nNo picks landed after the digest ran.")

    print("\nSTILL MISSING RIGHT NOW (week %d):" % cur["poolWeek"])
    if missing_now:
        for n, m in missing_now:
            print("   %-16s %s" % (n, ", ".join(m)))
    else:
        print("   Nobody. Everyone is fully in.")

    stray = sorted({p["week"] for p in picks} - {w["week"] for w in sched["weeks"]})
    if stray:
        print("\nWARNING: picks filed under unknown weeks: %s" % stray)
    return 0


sys.exit(main())
