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

BRIDGE_DIR="$ROOT_DIR/src/server/native_bridge"
BRIDGE_SDK_DIR="$BRIDGE_DIR/discord_social_sdk"
BRIDGE_EXECUTABLE="$BRIDGE_DIR/build/discord_social_bridge"

if [[ -x "$BRIDGE_DIR/build-macos.sh" && -d "$BRIDGE_SDK_DIR" ]]; then
  echo "Building Discord Social SDK native bridge..."
  (cd "$BRIDGE_DIR" && ./build-macos.sh)
  echo
elif [[ -x "$BRIDGE_EXECUTABLE" ]]; then
  echo "Discord Social SDK folder not installed; reusing existing native bridge build."
  echo
else
  echo "Discord Social SDK native bridge is not installed; skipping native bridge build."
  echo "Run npm run install:discord-social-sdk to install the optional SDK files."
  echo
fi

export DISCORD_SOCIAL_BRIDGE_EXECUTABLE="${DISCORD_SOCIAL_BRIDGE_EXECUTABLE:-$BRIDGE_EXECUTABLE}"

if [[ -x "$DISCORD_SOCIAL_BRIDGE_EXECUTABLE" ]]; then
  export DISCORD_SOCIAL_BRIDGE_ENABLED="${DISCORD_SOCIAL_BRIDGE_ENABLED:-true}"
  export DISCORD_SOCIAL_NATIVE_BRIDGE_ENABLED="${DISCORD_SOCIAL_NATIVE_BRIDGE_ENABLED:-true}"
  export DISCORD_SOCIAL_CHAT_RELAY_MODE="${DISCORD_SOCIAL_CHAT_RELAY_MODE:-native}"
else
  export DISCORD_SOCIAL_BRIDGE_ENABLED="false"
  export DISCORD_SOCIAL_NATIVE_BRIDGE_ENABLED="false"
  export DISCORD_SOCIAL_CHAT_RELAY_MODE="off"
fi

export DISCORD_SOCIAL_APP_ID="1447954255452311695"
export DISCORD_SOCIAL_DEVICE_FLOW="false"

echo "Starting server + Discord RPC (npm run dev:with-discord)..."
echo "Discord channel bridge enabled: $DISCORD_SOCIAL_BRIDGE_ENABLED"
echo "Discord Social SDK native bridge enabled: $DISCORD_SOCIAL_NATIVE_BRIDGE_ENABLED"
echo "Discord chat relay mode: $DISCORD_SOCIAL_CHAT_RELAY_MODE"
echo "Discord Social SDK app id: $DISCORD_SOCIAL_APP_ID"
echo "Discord Social SDK device flow: $DISCORD_SOCIAL_DEVICE_FLOW"
echo "Discord Social SDK bridge: $DISCORD_SOCIAL_BRIDGE_EXECUTABLE"
echo "When it's ready, open the URL shown in the logs."
echo
set +e
npm run dev:with-discord
EXIT_CODE=$?
set -e

echo
echo "Server exited with code $EXIT_CODE"
read -r -p "Press Enter to close..."
exit "$EXIT_CODE"
