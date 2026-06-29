#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

DEV_URL="${DEV_URL:-http://localhost:8000/}"
FLASH_BROWSER_APP_NAME="${FLASH_BROWSER_APP_NAME:-FlashBrowser}"
FLASH_BROWSER_PREFS_FILE="${FLASH_BROWSER_PREFS_FILE:-$HOME/Library/Application Support/Flash Browser/user-preferences.json}"
FLASH_BROWSER_OPEN_ATTEMPTS="${FLASH_BROWSER_OPEN_ATTEMPTS:-120}"
FLASH_BROWSER_OPEN_DELAY_SECONDS="${FLASH_BROWSER_OPEN_DELAY_SECONDS:-1}"

update_from_main() {
  if ! command -v git >/dev/null 2>&1; then
    echo "Git is not installed or not on PATH; skipping project update."
    echo
    return 0
  fi

  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "This folder is not a git checkout; skipping project update."
    echo
    return 0
  fi

  local stashed_local_changes="false"

  echo "Saving local account/save changes before updating..."
  if [[ -n "$(git status --porcelain --untracked-files=all)" ]]; then
    git stash push --include-untracked -m "dev-mac auto-stash before update $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    stashed_local_changes="true"
  else
    echo "No local changes to stash."
  fi

  echo "Fetching latest main from origin..."
  git fetch origin main

  if git rev-parse --verify main >/dev/null 2>&1; then
    git checkout main
  else
    git checkout -B main origin/main
  fi

  echo "Pulling latest game version..."
  git pull --ff-only origin main

  if [[ "$stashed_local_changes" == "true" ]]; then
    echo "Restoring local account/save changes..."
    git stash pop
  fi

  echo
}

configure_flashbrowser_homepage() {
  local prefs_file="$1"
  local url="$2"

  node - "$prefs_file" "$url" <<'NODE'
const fs = require("fs");
const path = require("path");

const [prefsFile, url] = process.argv.slice(2);

fs.mkdirSync(path.dirname(prefsFile), { recursive: true });

let preferences = {};
try {
  preferences = JSON.parse(fs.readFileSync(prefsFile, "utf8"));
} catch {
  preferences = {};
}

preferences.homepage = url;
fs.writeFileSync(prefsFile, `${JSON.stringify(preferences)}\n`);
NODE
}

quit_flashbrowser() {
  local app_name="$1"

  osascript - "$app_name" <<'APPLESCRIPT'
on run argv
  set appName to item 1 of argv
  tell application appName to quit
end run
APPLESCRIPT
}

force_flashbrowser_location() {
  local app_name="$1"
  local url="$2"

  osascript - "$app_name" "$url" <<'APPLESCRIPT'
on run argv
  set appName to item 1 of argv
  set targetUrl to item 2 of argv
  set the clipboard to targetUrl

  tell application appName to activate
  delay 1.5

  tell application "System Events"
    keystroke "l" using command down
    delay 0.15
    keystroke "v" using command down
    delay 0.15
    key code 36
  end tell
end run
APPLESCRIPT
}

open_flashbrowser_url() {
  local url="$1"
  local app_name="$2"
  local prefs_file="$3"
  local homepage_configured="false"

  if configure_flashbrowser_homepage "$prefs_file" "$url"; then
    homepage_configured="true"
    echo "FlashBrowser homepage set to $url"
  else
    echo "NOTE: Could not update FlashBrowser homepage preferences."
  fi

  quit_flashbrowser "$app_name" >/dev/null 2>&1 || true
  sleep 1

  if ! open -a "$app_name" >/dev/null 2>&1; then
    return 1
  fi

  if [[ "$homepage_configured" != "true" ]]; then
    if ! force_flashbrowser_location "$app_name" "$url" >/dev/null 2>&1; then
      echo "NOTE: FlashBrowser opened, but Terminal could not automate the URL bar."
      echo "If macOS asks for permission, allow Terminal to control FlashBrowser/System Events."
    fi
  fi

  return 0
}

open_flashbrowser_when_ready() {
  local url="$1"
  local app_name="$2"
  local attempts="$3"
  local delay_seconds="$4"
  local attempt
  local total_seconds

  total_seconds=$((attempts * delay_seconds))

  echo "Waiting for $url before opening $app_name..."

  for ((attempt = 1; attempt <= attempts; attempt++)); do
    if curl -fsS --max-time 2 "$url" >/dev/null 2>&1; then
      echo "Opening $url in $app_name..."

      if ! open_flashbrowser_url "$url" "$app_name" "$FLASH_BROWSER_PREFS_FILE"; then
        echo "WARNING: Could not open $app_name."
        echo "Install FlashBrowser, or set FLASH_BROWSER_APP_NAME to the installed app name."
        echo "Then open $url manually."
      fi

      return 0
    fi

    sleep "$delay_seconds"
  done

  echo "WARNING: $url did not become ready after $total_seconds seconds."
  echo "Open it manually in $app_name once the server is ready."
}

FLASH_BROWSER_WATCHER_PID=""

cleanup_flashbrowser_watcher() {
  if [[ -n "$FLASH_BROWSER_WATCHER_PID" ]]; then
    kill "$FLASH_BROWSER_WATCHER_PID" >/dev/null 2>&1 || true
  fi
}

trap cleanup_flashbrowser_watcher EXIT

echo "Dungeon Blitz (local dev server)"
echo

update_from_main

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
echo "FlashBrowser URL: $DEV_URL"
echo
open_flashbrowser_when_ready "$DEV_URL" "$FLASH_BROWSER_APP_NAME" "$FLASH_BROWSER_OPEN_ATTEMPTS" "$FLASH_BROWSER_OPEN_DELAY_SECONDS" &
FLASH_BROWSER_WATCHER_PID=$!
set +e
npm run dev:with-discord
EXIT_CODE=$?
set -e

echo
echo "Server exited with code $EXIT_CODE"
read -r -p "Press Enter to close..."
exit "$EXIT_CODE"
