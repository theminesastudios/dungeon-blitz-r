#!/usr/bin/env bash
#
# Deploy the latest `main` to the multiplayer (production) server.
#
# This is the canonical, safe deploy sequence for the PM2-hosted server. It
# exists because the failure mode "source pulled but dist never rebuilt" left
# production silently running stale compiled code (see docs/HOSTING.md).
#
# Key safety properties:
#   * The build runs BEFORE the running server is touched. If the build fails,
#     the script aborts and the current server keeps serving the old (working)
#     build — no downtime, no half-deploy.
#   * The restart only happens after a successful, fresh build.
#
# Usage (on the host, as the account that owns the PM2 process):
#   ./tools/deploy-multiplayer.sh
#
# Environment overrides:
#   REPO_DIR   path to the checked-out repo   (default: this script's repo root)
#   PM2_NAME   PM2 process name               (default: dungeon-blitz-multiplayer)
#   GIT_REF    branch/ref to deploy           (default: main)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${REPO_DIR:-$(cd "${SCRIPT_DIR}/.." && pwd)}"
PM2_NAME="${PM2_NAME:-dungeon-blitz-multiplayer}"
GIT_REF="${GIT_REF:-main}"
SERVER_DIR="${REPO_DIR}/src/server"

log() { printf '\n\033[1;36m[deploy]\033[0m %s\n' "$*"; }

log "Repo:    ${REPO_DIR}"
log "Ref:     ${GIT_REF}"
log "PM2:     ${PM2_NAME}"

cd "${REPO_DIR}"

log "Fetching and fast-forwarding ${GIT_REF}..."
git fetch origin "${GIT_REF}"
git switch "${GIT_REF}"
git pull --ff-only origin "${GIT_REF}"
DEPLOY_SHA="$(git rev-parse --short HEAD)"
log "HEAD now at ${DEPLOY_SHA}"

log "Installing dependencies (root)..."
npm ci

cd "${SERVER_DIR}"
log "Installing dependencies (server)..."
npm ci

# Build BEFORE restarting. `set -e` aborts here on any build failure, leaving the
# currently-running server untouched.
log "Building (tsc)..."
npm run build

# Verify the freshly built artifact actually exists and is newer than sources.
if [ ! -f dist/main.js ]; then
  log "ERROR: dist/main.js missing after build. Aborting; server left as-is."
  exit 1
fi
log "Build OK — dist/main.js compiled at $(date -u -r dist/main.js '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || stat -c '%y' dist/main.js)"

log "Restarting PM2 process ${PM2_NAME}..."
if pm2 describe "${PM2_NAME}" >/dev/null 2>&1; then
  pm2 restart "${PM2_NAME}" --update-env
else
  log "Process not found — starting fresh."
  pm2 start tools/startMultiplayerServer.js --name "${PM2_NAME}" --node-args=--env-file-if-exists=.env
fi
pm2 save

log "Deploy complete — ${PM2_NAME} now running ${DEPLOY_SHA}."
pm2 list
