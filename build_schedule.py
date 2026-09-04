"""
Build schedule.json for the Power 4 Survivor Pool from ESPN's public endpoints.

Pulls:
  1. The four Power 4 conference rosters (ACC, Big Ten, Big 12, SEC) for 2026.
  2. Every FBS regular-season game for the pool weeks.

Writes docs/schedule.json, which the web app loads. Re-run any time ESPN
firms up kickoff times or a game moves; the app picks up the new file.

Usage:  python build_schedule.py
"""

import json
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone, timedelta
from pathlib import Path

SEASON = 2026
# ESPN weeks 1-13 line up exactly with the 13 pool Saturdays: Sep 5 -> Nov 28.
POOL_WEEKS = list(range(1, 14))

# ESPN conference group ids (confirmed against the core API)
P4 = [
    ("acc", "ACC", 1),
    ("big10", "Big Ten", 5),
    ("big12", "Big 12", 4),
    ("sec", "SEC", 8),
]

# ESPN is picky. A long User-Agent string gets a hard 403 on site.api, and so do
# bare requests from datacenter IPs such as GitHub Actions runners. These headers
# are what a browser actually sends.
UA = {
    "User-Agent": "Mozilla/5.0",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.espn.com/college-football/scoreboard",
    "Origin": "https://www.espn.com",
}
OUT = Path(__file__).parent / "docs" / "schedule.json"
CACHE = Path(__file__).parent / ".cache"

# ESPN throttles hard when the roster pull and the scoreboard pull happen in one
# burst, so every phase is cached to .cache/ and skipped on re-run. If a phase
# 403s, just run the script again; it resumes where it left off.


def week_cached(w):
    """A week is only cached once every game in it is final, so re-running the
    script picks up scores for the week just played without refetching the
    weeks that are already settled."""
    CACHE.mkdir(exist_ok=True)
    f = CACHE / f"week_{w}.json"
    if f.exists():
        return json.loads(f.read_text(encoding="utf-8"))
    games = week_games(w)
    if games and all(g["completed"] for g in games):
        f.write_text(json.dumps(games), encoding="utf-8")
    return games


def cached(name, fn):
    CACHE.mkdir(exist_ok=True)
    f = CACHE / f"{name}.json"
    if f.exists():
        return json.loads(f.read_text(encoding="utf-8"))
    val = fn()
    f.write_text(json.dumps(val), encoding="utf-8")
    return val


def get(url, tries=3):
    last = None
    for _ in range(tries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=45) as r:
                return json.load(r)
        except Exception as e:  # noqa: BLE001 - transient ESPN hiccups
            last = e
            time.sleep(2)
    raise RuntimeError(f"failed: {url} ({last})")


def conference_teams(group_id):
    """Team list for one conference, straight off ESPN's core API."""
    url = (
        "https://sports.core.api.espn.com/v2/sports/football/leagues/college-football/"
        f"seasons/{SEASON}/types/2/groups/{group_id}/teams?limit=50"
    )
    idx = get(url)
    teams = []
    for item in idx["items"]:
        t = get(item["$ref"])
        time.sleep(0.3)  # ESPN throttles bursts of core-API calls
        teams.append(
            {
                "id": str(t["id"]),
                "name": t.get("location") or t.get("name"),
                "full": t.get("displayName"),
                "abbr": t.get("abbreviation") or "",
                "color": "#" + (t.get("color") or "444444"),
                "alt": "#" + (t.get("alternateColor") or "cccccc"),
                "logo": (t.get("logos") or [{}])[0].get("href", ""),
            }
        )
    teams.sort(key=lambda x: x["name"])
    return teams


def week_games(week):
    url = (
        "https://site.api.espn.com/apis/site/v2/sports/football/college-football/"
        f"scoreboard?dates={SEASON}&seasontype=2&week={week}&groups=80&limit=400"
    )
    data = get(url)
    games = []
    for ev in data.get("events", []):
        comp = ev["competitions"][0]
        home = away = None
        for c in comp["competitors"]:
            side = {
                "id": str(c["team"]["id"]),
                "abbr": c["team"].get("abbreviation") or "",
                "name": c["team"].get("location") or c["team"].get("displayName"),
                "rank": c.get("curatedRank", {}).get("current"),
                "score": c.get("score"),
                "winner": c.get("winner"),
            }
            if c["homeAway"] == "home":
                home = side
            else:
                away = side
        if not home or not away:
            continue

        status = comp.get("status", {}).get("type", {})
        bcast = ""
        for b in comp.get("broadcasts", []):
            if b.get("names"):
                bcast = b["names"][0]
                break

        games.append(
            {
                "id": str(ev["id"]),
                "kickoff": ev["date"],  # ISO 8601, UTC
                "neutral": bool(comp.get("neutralSite")),
                "venue": (comp.get("venue") or {}).get("fullName", ""),
                "tv": bcast,
                "state": status.get("state", "pre"),  # pre | in | post
                "completed": bool(status.get("completed")),
                "home": home,
                "away": away,
            }
        )
    games.sort(key=lambda g: g["kickoff"])
    return games


def et_day(iso_utc):
    """Day of week in US Eastern, so 'Saturday' means what a fan means by it."""
    dt = datetime.fromisoformat(iso_utc.replace("Z", "+00:00"))
    # Sept-Nov is always EDT (UTC-4); no DST edge inside the pool window.
    return (dt.astimezone(timezone(timedelta(hours=-4)))).strftime("%a")


def main():
    print("Fetching Power 4 rosters...")
    conferences = []
    p4_ids = {}
    for key, name, gid in P4:
        teams = cached(f"teams_{key}", lambda g=gid: conference_teams(g))
        conferences.append({"key": key, "name": name, "teams": teams})
        for t in teams:
            p4_ids[t["id"]] = key
        print(f"  {name}: {len(teams)} teams")

    print("Fetching weekly schedules...")
    time.sleep(5)
    weeks = []
    for w in POOL_WEEKS:
        allgames = week_cached(w)
        time.sleep(1)
        # Keep any game with at least one P4 team in it.
        games = []
        for g in allgames:
            hc = p4_ids.get(g["home"]["id"])
            ac = p4_ids.get(g["away"]["id"])
            if not hc and not ac:
                continue
            g["homeConf"] = hc
            g["awayConf"] = ac
            g["day"] = et_day(g["kickoff"])
            games.append(g)
        dates = sorted({g["kickoff"][:10] for g in games})
        weeks.append(
            {
                "week": w,
                "poolWeek": POOL_WEEKS.index(w) + 1,
                "start": dates[0] if dates else "",
                "end": dates[-1] if dates else "",
                "games": games,
            }
        )
        print(f"  Week {w} (pool wk {POOL_WEEKS.index(w) + 1}): {len(games)} P4 games")

    out = {
        "season": SEASON,
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "poolWeeks": len(POOL_WEEKS),
        "conferences": conferences,
        "weeks": weeks,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)

    # Leave the file alone when nothing but the timestamp moved, so the nightly
    # job does not commit a no-op every time it runs.
    if OUT.exists():
        try:
            old = json.loads(OUT.read_text(encoding="utf-8"))
            if {k: v for k, v in old.items() if k != "generated"} == \
               {k: v for k, v in out.items() if k != "generated"}:
                print("\nNo change since the last run.")
                return
        except Exception:  # noqa: BLE001 - a corrupt file just gets rewritten
            pass

    OUT.write_text(json.dumps(out, indent=1), encoding="utf-8")
    print(f"\nWrote {OUT}  ({OUT.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
