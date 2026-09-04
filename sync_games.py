"""
Push kickoff times and results from docs/schedule.json into survivor_games.

Postgres cannot read the schedule file, but it has to know kickoff times to
enforce the pick rules server side. This is the bridge. It runs right after
build_schedule.py in the results workflow.

One row per team per week: the game that week's pick rides on. Where a team has
two games inside one ESPN week bucket (week 1 carries the Week 0 openers), it
picks the same one the app would: the game that has not kicked off yet, else the
last one.

Environment:
  SUPABASE_URL          project url, no trailing path
  SUPABASE_SERVICE_KEY  service_role key
"""

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

SB_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SB_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
BATCH = 500


def sb(method, path, body=None, params=None, prefer=None):
    url = SB_URL + "/rest/v1/" + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    data = json.dumps(body).encode() if body is not None else None
    headers = {
        "apikey": SB_KEY,
        "Authorization": "Bearer " + SB_KEY,
        "Content-Type": "application/json",
        "Prefer": prefer or "return=minimal",
    }
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=45) as r:
            raw = r.read().decode()
            return json.loads(raw) if raw.strip() else []
    except urllib.error.HTTPError as e:
        raise RuntimeError(method + " " + path + " -> " + str(e.code) + ": "
                           + e.read().decode()[:400])


def main():
    if not SB_URL or not SB_KEY:
        print("SUPABASE_URL / SUPABASE_SERVICE_KEY not set. Skipping game sync.")
        return 0

    sched = json.loads((Path(__file__).parent / "docs" / "schedule.json")
                       .read_text(encoding="utf-8"))
    now = datetime.now(timezone.utc)

    conf_of = {}
    for c in sched["conferences"]:
        for t in c["teams"]:
            conf_of[t["id"]] = c["key"]

    rows = {}
    for wk in sched["weeks"]:
        for g in wk["games"]:
            kick = datetime.fromisoformat(g["kickoff"].replace("Z", "+00:00"))
            for side in (g["home"], g["away"]):
                conf = conf_of.get(side["id"])
                if not conf:
                    continue                       # not a Power 4 team
                key = (wk["week"], side["id"])
                prev = rows.get(key)
                if prev is not None:
                    prev_kick = datetime.fromisoformat(prev["kickoff"])
                    # Prefer a game still to come, matching gameFor() in app.js.
                    prev_future = prev_kick > now
                    this_future = kick > now
                    if prev_future and not this_future:
                        continue
                    if not (this_future and not prev_future) and kick <= prev_kick:
                        continue
                rows[key] = {
                    "week": wk["week"],
                    "team_id": side["id"],
                    "conf": conf,
                    "team_name": side["name"],
                    "kickoff": kick.isoformat(),
                    "completed": bool(g["completed"]),
                    "won": side.get("winner"),
                }

    payload = list(rows.values())
    print("Syncing " + str(len(payload)) + " team-weeks...")
    for i in range(0, len(payload), BATCH):
        chunk = payload[i:i + BATCH]
        sb("POST", "survivor_games", body=chunk,
           params={"on_conflict": "week,team_id"},
           prefer="resolution=merge-duplicates,return=minimal")
        print("  rows " + str(i + 1) + "-" + str(i + len(chunk)))

    check = sb("GET", "survivor_games", params={"select": "week", "limit": "1"},
               prefer="count=exact")
    print("Done. survivor_games responded to a read: " + str(bool(check) or "empty"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
