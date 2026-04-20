#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

echo "Dungeon Blitz (local dev server)"
echo

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: Node.js is not installed or not on PATH."
  echo "Install Node.js (LTS) then re-run this file."
  echo
  read -r -p "Press Enter to close..."
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "ERROR: npm is not installed or not on PATH."
  echo "Reinstall Node.js (LTS) then re-run this file."
  echo
  read -r -p "Press Enter to close..."
  exit 1
fi

echo "Node: $(node -v)"
echo "npm:  $(npm -v)"
echo

if [[ ! -d "node_modules" ]]; then
  echo "Installing root dependencies..."
  npm install
  echo
else
  echo "Root dependencies already installed; skipping."
  echo
fi

if [[ ! -d "src/server/node_modules" ]]; then
  echo "Installing server dependencies..."
  (cd "src/server" && npm install)
  echo
else
  echo "Server dependencies already installed; skipping."
  echo
fi

echo "Starting server (npm run dev)..."
echo "When it's ready, open the URL shown in the logs."
echo
set +e
npm run dev
EXIT_CODE=$?
set -e

echo
echo "Server exited with code $EXIT_CODE"
read -r -p "Press Enter to close..."
exit "$EXIT_CODE"
