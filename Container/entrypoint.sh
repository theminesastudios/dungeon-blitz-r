#!/usr/bin/env sh

cd /opt/games/dungeon-blitz-r/src/server
npm install
npm run build

npm run start:multiplayer
