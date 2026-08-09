const { execSync } = require('child_process');
const path = require('path');

const APP_NAME = 'dungeon-mp';
const serverDir = path.resolve(__dirname, '..');

// This orchestrates a deploy: build, replace the PM2 app, persist the process list.
//
// It must never become the PM2 app command itself. PM2 would then be running a script whose
// first action is `pm2 delete dungeon-mp` -- which SIGINTs its own process tree partway
// through, so `pm2 start` never runs and the app disappears from the list entirely. That
// took production down on 2026-07-25 via
// `pm2 start npm --name dungeon-mp -- run multiplayer`.
//
// PM2 must start the compiled entry point directly instead:
//   pm2 start dist/main.js --name dungeon-mp
function refuseIfRunningUnderPm2() {
    if (process.env.pm_id === undefined) {
        return false;
    }

    console.error(
        `[deploy] Refusing to run as a PM2 app (pm_id=${process.env.pm_id}).\n` +
        '[deploy] This is a deploy command, not a server entry point -- it would delete the\n' +
        '[deploy] very process PM2 is running it under.\n' +
        `[deploy] Start the server with: pm2 start dist/main.js --name ${APP_NAME}`
    );
    return true;
}

function run(command, options = {}) {
    execSync(command, { cwd: serverDir, stdio: 'inherit', ...options });
}

function deploy() {
    if (refuseIfRunningUnderPm2()) {
        process.exitCode = 1;
        return;
    }

    // Gate the deploy, not every local build: the sweep takes ~2 minutes, and the moment that
    // actually matters is shipping a rebuilt SWF to players. Run `npm run verify:client-patches`
    // by hand after touching a client asset if you want the answer sooner.
    run('npm run verify:client-patches');
    run('npm run build');

    try {
        run(`pm2 delete ${APP_NAME}`, { stdio: 'ignore' });
    } catch {
        // No existing app on a first deploy; nothing to replace.
    }

    run(`pm2 start dist/main.js --name ${APP_NAME}`);
    run('pm2 save');
}

if (require.main === module) {
    deploy();
}

module.exports = {
    APP_NAME,
    deploy
};
