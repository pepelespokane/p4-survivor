"""
Stamp docs/index.html with a version derived from the actual asset contents.

Why this exists: the ?v=N cache buster only works if someone remembers to change
it. Twice now a change shipped under a version that was already cached, so people
kept seeing old text and a normal refresh could not fix it. Deriving the version
from a hash of the files removes the remembering.

Run before committing any change to app.js, config.js or style.css:
    python bump_version.py
"""

import hashlib
import re
import sys
from pathlib import Path

DOCS = Path(__file__).parent / "docs"
ASSETS = ["js/app.js", "js/config.js", "css/style.css"]
INDEX = DOCS / "index.html"


def main():
    h = hashlib.sha256()
    for rel in ASSETS:
        h.update((DOCS / rel).read_bytes())
    version = h.hexdigest()[:8]

    html = INDEX.read_text(encoding="utf-8")
    new = re.sub(r"\?v=[0-9a-f]+", "?v=" + version, html)

    stamped = len(re.findall(r"\?v=" + version, new))
    if new == html:
        print("Already at v=" + version + " (" + str(stamped) + " references).")
        return 0

    INDEX.write_text(new, encoding="utf-8")
    print("Stamped v=" + version + " on " + str(stamped) + " references.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
