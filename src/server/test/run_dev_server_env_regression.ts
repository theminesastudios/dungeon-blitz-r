import { strict as assert } from 'assert';

const { applyDevServerEnv } = require('../tools/runDevServer.js') as {
    applyDevServerEnv: (env: Record<string, string | undefined>) => void;
};

function testDevServerUsesFastLocalPolicyDefaults(): void {
    const env: Record<string, string | undefined> = {};

    applyDevServerEnv(env);

    assert.equal(env.MULTIPLAYER_MODE, 'false');
    assert.equal(env.STATIC_PORT, '8000');
    assert.equal(env.ENABLE_POLICY_SERVER, 'false');
}

function testExplicitPolicyOverrideIsPreserved(): void {
    const env: Record<string, string | undefined> = {
        ENABLE_POLICY_SERVER: 'false'
    };

    applyDevServerEnv(env);

    assert.equal(env.MULTIPLAYER_MODE, 'false');
    assert.equal(env.ENABLE_POLICY_SERVER, 'false');
}

function main(): void {
    testDevServerUsesFastLocalPolicyDefaults();
    testExplicitPolicyOverrideIsPreserved();
    console.log('run_dev_server_env_regression: ok');
}

main();
