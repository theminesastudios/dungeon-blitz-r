function applyDevServerEnv(env = process.env) {
    env.MULTIPLAYER_MODE = 'false';
    env.STATIC_PORT = env.STATIC_PORT || '8000';
    env.ENABLE_POLICY_SERVER = env.ENABLE_POLICY_SERVER || 'false';
    env.DEBUG_PROGRESS = env.DEBUG_PROGRESS || 'true';
    env.DEBUG_PACKETS = env.DEBUG_PACKETS || 'true';
    env.DEBUG_PAYLOAD_PREVIEW_BYTES = env.DEBUG_PAYLOAD_PREVIEW_BYTES || '512';
}

function startDevServer() {
    require('../scripts/cleanup-dev-instance');
    applyDevServerEnv();

    require('ts-node/register');
    require('../main.ts');
}

if (require.main === module) {
    startDevServer();
}

module.exports = {
    applyDevServerEnv,
    startDevServer
};
