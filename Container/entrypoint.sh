#!/usr/bin/env sh

cd /opt/games/dungeon-blitz-r/src/server
export MULTIPLAYER_MODE=true
export ENABLE_POLICY_SERVER=true
exec node dist/main.js
