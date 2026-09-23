#!/bin/sh
# Opens the QQ group briefing (Linux / macOS). The console runs in the
# background; this script returns as soon as the browser opens.
#   ./start.sh               open the briefing
#   ./start.sh --background  just make sure it is running (login autostart)
cd "$(dirname "$0")" || exit 1

if [ -x ./node/bin/node ]; then
  NODE=./node/bin/node
elif command -v node >/dev/null 2>&1; then
  NODE=node
else
  echo "Node.js was not found. Install Node.js 20 or newer (https://nodejs.org) and try again."
  exit 1
fi

if [ ! -d node_modules/better-sqlite3-multiple-ciphers ]; then
  echo "First run: installing dependencies with npm install, this can take a minute..."
  npm install || exit 1
fi

exec "$NODE" src/launcher.js "$@"
