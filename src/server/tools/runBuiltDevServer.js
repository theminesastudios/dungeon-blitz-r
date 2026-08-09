const fs = require('fs');
const path = require('path');
const { applyDevServerEnv } = require('./runDevServer');

const distMainPath = path.resolve(__dirname, '..', 'dist', 'main.js');

// Same local environment runDevServer.js applies, but running the compiled output instead of
// ts-node. Keeps `npm run dev:built` pointed at localhost with Mongo off, so it exercises the
// production build without touching live game data.
function startBuiltDevServer() {
    if (!fs.existsSync(distMainPath)) {
        console.error('[DevServer] dist/main.js is missing. Run `npm run build` first.');
        process.exitCode = 1;
        return;
    }

    require('../scripts/cleanup-dev-instance');
    applyDevServerEnv();
    require(distMainPath);
}

if (require.main === module) {
    startBuiltDevServer();
}

module.exports = {
    startBuiltDevServer
};
