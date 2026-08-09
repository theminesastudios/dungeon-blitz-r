const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const testDir = path.resolve(__dirname, '..', 'test');
const tests = fs.readdirSync(testDir)
    .filter((name) => /_regression\.(ts|js)$/.test(name))
    .sort();

// Run every test even after one fails. Bailing on the first failure meant a single known
// red test hid everything sorting after it -- the suite still exits non-zero, it just says
// what else broke first.
const failed = [];

for (const test of tests) {
    const testPath = path.join(testDir, test);
    const args = test.endsWith('.ts')
        ? ['-r', 'ts-node/register', testPath]
        : [testPath];
    console.log(`[regression] ${test}`);
    const result = spawnSync(process.execPath, args, {
        cwd: path.resolve(__dirname, '..'),
        env: {
            ...process.env,
            TS_NODE_COMPILER_OPTIONS: JSON.stringify({ types: ['node'] })
        },
        stdio: 'inherit'
    });
    if (result.status !== 0) {
        failed.push(test);
    }
}

if (failed.length > 0) {
    console.error(`[regression] ${failed.length}/${tests.length} FAILED:`);
    for (const test of failed) {
        console.error(`[regression]   ${test}`);
    }
    process.exit(1);
}

console.log(`[regression] ${tests.length} tests passed`);
