function applyDevServerEnv(env = process.env) {
    env.MULTIPLAYER_MODE = 'false';
    env.STATIC_PORT = env.STATIC_PORT || '8000';
    env.ENABLE_POLICY_SERVER = env.ENABLE_POLICY_SERVER || 'false';
    env.DEBUG_PROGRESS = env.DEBUG_PROGRESS || 'false';
    env.DEBUG_PACKETS = env.DEBUG_PACKETS || 'false';
    env.DEBUG_PAYLOAD_PREVIEW_BYTES = env.DEBUG_PAYLOAD_PREVIEW_BYTES || '64';
}

function startDevServer() {
    require('../scripts/cleanup-dev-instance');
    applyDevServerEnv();

    // The local dev server should not fail to boot because of TypeScript-only
    // Node ambient type errors. Runtime validation happens through the actual
    // server startup and packet flow.
    require('ts-node/register/transpile-only');
    require('../patches/NephitDirectRankPatch');
    require('../main.ts');
}

if (require.main === module) {
    startDevServer();
}

module.exports = {
    applyDevServerEnv,
    startDevServer
};
