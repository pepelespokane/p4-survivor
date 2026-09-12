"""Commissioner tool: enter a player's picks for them, by team name.

For when somebody cannot get the site to work and sends their picks by text.

It does NOT write to survivor_picks directly. It looks up that player's token
and calls survivor_save_picks, the same function the browser calls, so every
rule still applies: the team must play that week in that conference, its game
must not have kicked off, the league must not already be committed, and the team
must not have been used earlier in the season. A pick that breaks a rule is
reported and skipped; the rest still save.

The service key is needed only to read the player's token, because the
publishable key cannot see the players table.

  set SUPABASE_SERVICE_KEY=...
  python add_picks.py bo-j Colorado Washington "South Carolina"      # shows the plan
  python add_picks.py bo-j Colorado Washington "South Carolina" --commit
"""

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

try:
    from zoneinfo import ZoneInfo
    PT = ZoneInfo("America/Los_Angeles")
except ImportError:
    PT = timezone.utc

URL = os.environ.get("SUPABASE_URL", "https://zaunmubozapvjmnigmqj.supabase.co").rstrip("/")
SVC = os.environ.get("SUPABASE_SERVICE_KEY", "")
PUB = "sb_publishable_cQxgG1XHPjjb_oeVW4NB-A_f2czaY_R"


def call(path, key, params=None, body=None):
    url = URL + "/rest/v1/" + path + (("?" + urllib.parse.urlencode(params)) if params else "")
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method="POST" if data else "GET", headers={
        "apikey": key, "Authorization": "Bearer " + key, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read().decode()
            return json.loads(raw) if raw.strip() else []
    except urllib.error.HTTPError as e:
        raise RuntimeError(path + " -> " + str(e.code) + ": " + e.read().decode()[:300])


def main():
    args = [a for a in sys.argv[1:] if a != "--commit"]
    commit = "--commit" in sys.argv
    if len(args) < 2:
        print(__doc__)
        return 1
    who, names = args[0].lower(), args[1:]

    if not SVC:
        print("SUPABASE_SERVICE_KEY is not set. Supabase -> Project Settings -> API Keys")
        print("-> service_role. It is only used to read this player's token.")
        return 1

    now = datetime.now(timezone.utc)
    sched = json.loads(open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                         "docs", "schedule.json"), encoding="utf-8").read())
    wk = next((w for w in sched["weeks"]
               if any(datetime.fromisoformat(g["kickoff"].replace("Z", "+00:00")) > now
                      for g in w["games"])), None)
    if not wk:
        print("Season is over.")
        return 1
    week = wk["week"]

    players = call("survivor_players", SVC, {"select": "id,name,token"})
    p = next((x for x in players if x["id"].lower() == who
              or (x.get("name") or "").lower() == who), None)
    if not p:
        print("No player matching " + who + ". Known: "
              + ", ".join(sorted(x["id"] for x in players)))
        return 1

    games = call("survivor_games", SVC,
                 {"select": "team_id,team_name,conf,kickoff", "week": "eq." + str(week)})

    picks, problems = [], []
    for n in names:
        hits = [g for g in games if (g["team_name"] or "").lower() == n.lower()]
        if not hits:
            near = sorted(g["team_name"] for g in games
                          if n.lower() in (g["team_name"] or "").lower())
            problems.append(n + ": no week " + str(wk["poolWeek"]) + " game"
                            + (" (did you mean " + ", ".join(near) + "?)" if near else ""))
            continue
        if len(hits) > 1:
            problems.append(n + ": ambiguous, matches " + str(len(hits)) + " teams")
            continue
        g = hits[0]
        ko = datetime.fromisoformat(g["kickoff"].replace("Z", "+00:00"))
        picks.append({"conf": g["conf"], "team_id": g["team_id"],
                      "team_name": g["team_name"], "kickoff": ko})

    print("Player : " + p["name"] + " (" + p["id"] + ")")
    print("Week   : " + str(wk["poolWeek"]))
    print("Now    : " + now.astimezone(PT).strftime("%a %m/%d %I:%M %p PT"))
    print("")
    for q in picks:
        late = q["kickoff"] <= now
        print("  %-8s %-20s kickoff %s%s"
              % (q["conf"], q["team_name"],
                 q["kickoff"].astimezone(PT).strftime("%a %I:%M %p"),
                 "   ALREADY KICKED OFF, will be rejected" if late else ""))
    for x in problems:
        print("  !! " + x)
    if not picks:
        return 1

    if not commit:
        print("")
        print("Dry run. Re-run with --commit to submit these.")
        return 0

    # Submitted through the player's own token, so the database applies exactly the
    # same checks it would if they had clicked Save themselves.
    res = call("rpc/survivor_save_picks", PUB, body={
        "p_token": p["token"], "p_week": week,
        "p_picks": [{"conf": q["conf"], "team_id": q["team_id"]} for q in picks]})

    print("")
    saved = (res or {}).get("saved", []) if isinstance(res, dict) else []
    failed = (res or {}).get("failed", []) if isinstance(res, dict) else []
    for sv in saved:
        print("  SAVED    %-8s %s%s" % (sv["conf"], sv["team_name"],
                                        "" if sv.get("changed") else "  (already had it)"))
    for f in failed:
        print("  REJECTED %-8s %s %s" % (f["conf"], f["code"], f.get("detail", "")))
    if not saved and not failed:
        print("  Unexpected response: " + json.dumps(res)[:300])
    return 0


sys.exit(main())
