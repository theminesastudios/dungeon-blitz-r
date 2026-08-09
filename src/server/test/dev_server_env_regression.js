const assert = require('assert').strict;
const { applyDevServerEnv, findMissingDependencies } = require('../tools/runDevServer');
const fs = require('fs');
const os = require('os');
const path = require('path');

const env = {
    MULTIPLAYER_MODE: 'true',
    GAME_MONGODB_URI: 'mongodb://game.example.invalid:27017',
    MONGODB_URI: 'mongodb://legacy.example.invalid:27017',
    SPONSOR_MONGODB_URI: 'mongodb://sponsor.example.invalid:27017',
    ENABLE_MONGO_GAME_DATA: 'true',
    SPONSOR_ACCOUNT_CREATION_REQUIRED: 'true'
};

applyDevServerEnv(env);

assert.equal(env.MULTIPLAYER_MODE, 'false');
assert.equal(env.ENABLE_MONGO_GAME_DATA, 'false');
assert.equal(env.GAME_MONGODB_URI, '');
assert.equal(env.MONGODB_URI, '');
assert.equal(env.SPONSOR_MONGODB_URI, '');
assert.equal(env.SPONSOR_ACCOUNT_CREATION_REQUIRED, 'false');

// A player pulled the commit that added express-rate-limit, ran dev without installing,
// and got a TSError twelve lines deep that read like broken code rather than a stale tree.
// The runner now names what is missing before ts-node ever loads a file.
assert.deepEqual(
    findMissingDependencies(path.resolve(__dirname, '..')),
    [],
    'this checkout cannot resolve one of its own declared dependencies'
);

// A tree that genuinely lacks a declared dependency has to be reported, not passed over.
// Inside src/server on purpose: node resolves upward, so a real dependency like express
// still resolves from here and only the invented one comes back missing.
const fixture = fs.mkdtempSync(path.join(path.resolve(__dirname, '..'), 'dev-dep-check-'));
fs.writeFileSync(
    path.join(fixture, 'package.json'),
    JSON.stringify({ dependencies: { 'a-package-that-is-not-installed': '^1.0.0', express: '^5.0.0' } })
);
assert.deepEqual(
    findMissingDependencies(fixture),
    ['a-package-that-is-not-installed'],
    'a missing dependency was not reported'
);
fs.rmSync(fixture, { recursive: true, force: true });

console.log('dev_server_env_regression: ok');
