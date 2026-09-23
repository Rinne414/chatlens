#!/bin/sh
# Builds the zero-setup Linux x64 release bundle: clean source at a git ref +
# an official Node.js linux-x64 runtime + node_modules installed BY that
# runtime (so the prebuilt better_sqlite3.node matches its ABI), trimmed and
# packed as a .tar.gz that users extract and run with ./start.sh.
#
#   sh scripts/build_linux_bundle.sh v0.0.8 latest-v22.x dist/chatlens-v0.0.8-linux-x64.tar.gz
#
# Run on Linux (or WSL) with git, curl, tar and xz available.
set -eu

REF="${1:-HEAD}"
NODE_CHANNEL="${2:-latest-v22.x}"
OUT="${3:-dist/chatlens-linux-x64.tar.gz}"
ROOT=$(cd "$(dirname "$0")/.." && pwd)
case "$OUT" in /*) ;; *) OUT="$ROOT/$OUT" ;; esac
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
PREFIX=qqnt-readonly-summary-toolkit
STAGE="$WORK/$PREFIX"
mkdir -p "$STAGE" "$(dirname "$OUT")"

# 1) Tracked source only (never store/, runs/, reports/ or config/defaults.json).
git -C "$ROOT" archive --format=tar "$REF" | tar -xf - -C "$STAGE"

# 2) Official Node runtime, checksum-verified.
BASE="https://nodejs.org/dist/$NODE_CHANNEL"
curl -fsSL "$BASE/SHASUMS256.txt" -o "$WORK/SHASUMS256.txt"
TARBALL=$(grep -o 'node-v[0-9.]*-linux-x64\.tar\.xz' "$WORK/SHASUMS256.txt" | head -1)
[ -n "$TARBALL" ] || { echo "no linux-x64 tarball listed at $BASE" >&2; exit 1; }
curl -fsSL "$BASE/$TARBALL" -o "$WORK/$TARBALL"
(cd "$WORK" && grep " $TARBALL\$" SHASUMS256.txt | sha256sum -c -)
tar -xJf "$WORK/$TARBALL" -C "$WORK"
mv "$WORK/${TARBALL%.tar.xz}" "$STAGE/node"

# 3) Dependencies installed by the bundled runtime, then trimmed.
(cd "$STAGE" && PATH="$STAGE/node/bin:$PATH" npm install --omit=dev --no-audit --no-fund)
BS="$STAGE/node_modules/better-sqlite3-multiple-ciphers"
cp "$BS/build/Release/better_sqlite3.node" "$WORK/better_sqlite3.node"
rm -rf "$BS/build" "$BS/deps" "$BS/src" "$BS/docs"
mkdir -p "$BS/build/Release"
mv "$WORK/better_sqlite3.node" "$BS/build/Release/better_sqlite3.node"
rm -rf "$STAGE/node/include" "$STAGE/node/share" "$STAGE/node/lib/node_modules/npm" "$STAGE/node/lib/node_modules/corepack"
rm -f "$STAGE/node/bin/npm" "$STAGE/node/bin/npx" "$STAGE/node/bin/corepack"
chmod +x "$STAGE/start.sh" "$STAGE/node/bin/node"

# 4) Pack.
tar -czf "$OUT" -C "$WORK" "$PREFIX"
echo "bundle written: $OUT ($(du -h "$OUT" | cut -f1)) node=$("$STAGE/node/bin/node" -v)"
