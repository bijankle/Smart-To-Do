#!/bin/bash
# Double-click this file to update to the latest version and launch Smart To-Do.
# (macOS opens .command files in Terminal automatically.)

cd "$(dirname "$0")" || exit 1

echo "── Smart To-Do launcher ──────────────────────────"
echo "Checking for updates…"
git pull --ff-only || echo "(Couldn't fetch updates — starting the local copy instead.)"

echo "Installing/refreshing dependencies…"
npm install --no-audit --no-fund --silent

echo "Building…"
npm run build --silent

# Stop any previous copy of the app still holding the port.
lsof -ti tcp:4173 | xargs kill 2>/dev/null

# Give the server a second to start, then open the app in the default browser.
(sleep 1 && open "http://localhost:4173") &

node tools/serve.mjs
