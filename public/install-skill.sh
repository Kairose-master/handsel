#!/bin/sh
# Install the Handsel agent skill.
#
#   curl -fsSL https://handsel-main.vercel.app/install-skill.sh | sh
#
# Point it at the testnet deployment instead by passing a base URL:
#
#   curl -fsSL https://handsel-nu.vercel.app/install-skill.sh | sh -s -- https://handsel-nu.vercel.app
#
# This is a `curl | sh` script, so it is written to be read before it is run.
# It does exactly four things: create a directory, download a manifest,
# download the files that manifest names, and print where they went. It does
# not use sudo, does not touch your PATH or shell profile, does not install
# packages, and contacts no host other than the base URL you gave it.
#
# Set HANDSEL_SKILL_DIR to install somewhere other than ./.agents/skills/handsel.

set -eu

BASE="${1:-https://handsel-main.vercel.app}"
BASE="${BASE%/}"
DIR="${HANDSEL_SKILL_DIR:-.agents/skills/handsel}"

if ! command -v curl >/dev/null 2>&1; then
  echo "install-skill: curl is required" >&2
  exit 1
fi

fetch() {
  # -f so an HTML error page never lands on disk as if it were the skill. That
  # is the failure worth spending a flag on: a 404 body saved as SKILL.md
  # produces an agent following a Next.js error page as its instructions.
  curl -fsSL "$1"
}

echo "Handsel skill <- $BASE"

FILES="$(fetch "$BASE/skill/files.txt")" || {
  echo "install-skill: could not read $BASE/skill/files.txt" >&2
  echo "  Check the base URL. Nothing was written." >&2
  exit 1
}

# The file list comes from the server, not from this script. A hardcoded list in
# a script served from a CDN is the one place drift is both invisible and remote
# — the installer would keep fetching last month's filenames long after the
# skill moved on. It is newline-delimited rather than JSON because parsing JSON
# in POSIX sh is a bad trade, and this is a file every user is invited to read.
if [ -z "$FILES" ]; then
  echo "install-skill: the file list was empty — refusing to write an empty skill" >&2
  exit 1
fi

VERSION="$(fetch "$BASE/skill/manifest.json" 2>/dev/null | tr -d ' ",' | sed -n 's/^version://p')"

# Staged in a temp directory and moved into place only once every file has
# arrived. A half-downloaded skill is worse than none: the agent reads a
# decision procedure whose references 404 partway through.
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

for f in $FILES; do
  mkdir -p "$TMP/$(dirname "$f")"
  fetch "$BASE/skill/$f" > "$TMP/$f" || {
    echo "install-skill: failed to download $f — nothing was written" >&2
    exit 1
  }
  [ -s "$TMP/$f" ] || {
    echo "install-skill: $f came back empty — nothing was written" >&2
    exit 1
  }
done

mkdir -p "$DIR"
rm -rf "$DIR/reference"
(cd "$TMP" && tar cf - .) | (cd "$DIR" && tar xf -)

COUNT="$(printf '%s\n' "$FILES" | wc -l | tr -d ' ')"
echo "installed $COUNT file(s) to $DIR (v${VERSION:-?})"
echo
echo "Read $DIR/SKILL.md before earning or spending anything."
echo "It names two deployments. $BASE is the one this install points at —"
echo "check meta.realMoney from $BASE/api/tasks to see whether that is real money."
