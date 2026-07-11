#!/bin/bash
# Double-click this file to update to the latest version and launch Smart To-Do.
# (macOS opens .command files in Terminal automatically.)
#
# Updates via git when available, otherwise via a direct download using the
# curl + tar tools built into macOS — so no developer tools are required.

cd "$(dirname "$0")" || exit 1

BRANCH="claude/smart-todo-list-arch-dpf2wq"
TARBALL="https://github.com/bijankle/Smart-To-Do/archive/refs/heads/$BRANCH.tar.gz"

main() {
  echo "── Smart To-Do launcher ──────────────────────────"
  echo "Checking for updates…"
  if command -v git >/dev/null 2>&1 && [ -d .git ]; then
    git pull --ff-only || echo "(Couldn't fetch updates — starting the local copy instead.)"
  else
    TMP="$(mktemp -d)"
    if curl -fsSL "$TARBALL" -o "$TMP/src.tar.gz" && tar -xzf "$TMP/src.tar.gz" -C "$TMP"; then
      cp -R "$TMP"/*/. .
      echo "Updated via direct download."
    else
      echo "(Couldn't download updates — starting the local copy instead.)"
    fi
    rm -rf "$TMP"
  fi

  echo "Installing/refreshing dependencies…"
  npm install --no-audit --no-fund --silent

  echo "Building…"
  npm run build --silent

  # Stop any previous copy of the app still holding the port.
  lsof -ti tcp:4173 | xargs kill 2>/dev/null

  # Give the server a second to start, then open the app in the default browser.
  (sleep 1 && open "http://localhost:4173") &

  node tools/serve.mjs
}

main "$@"
