process.env.MULTIPLAYER_MODE = 'true';
process.env.ENABLE_POLICY_SERVER = 'true';

// Build-freshness guard.
//
// The multiplayer server always runs the COMPILED output in ./dist. The dev
// server, by contrast, runs the TypeScript sources directly via ts-node, so it
// always reflects the latest edits. If a deploy pulls new source but the
// `npm run build` step is skipped, fails, or hangs, this process will silently
// keep serving a stale `dist` — which looks exactly like "the fixes didn't sync
// to production". This check makes that condition impossible to miss.
//
// It is intentionally non-fatal: a stale-but-running server is better than a
// crash loop. It only warns. In the container image the .ts sources are not
// shipped, so the check finds no sources and stays silent (the in-image dist is
// authoritative there).
function checkBuildFreshness() {
    try {
        const fs = require('fs');
        const path = require('path');

        const serverRoot = path.resolve(__dirname, '..');
        const distMain = path.join(serverRoot, 'dist', 'main.js');

        if (!fs.existsSync(distMain)) {
            warn([
                'No compiled build found at dist/main.js.',
                'Run `npm run build` in src/server before starting the multiplayer server.'
            ]);
            return;
        }

        const distMtime = fs.statSync(distMain).mtimeMs;

        // Only compare against sources that are actually part of the server build.
        const sourceDirs = ['auth', 'core', 'database', 'handlers', 'integrations', 'network', 'utils']
            .map((dir) => path.join(serverRoot, dir))
            .filter((dir) => fs.existsSync(dir));
        const extraFiles = [path.join(serverRoot, 'main.ts')].filter((file) => fs.existsSync(file));

        let newest = { mtimeMs: 0, file: null };
        const visit = (target) => {
            const stat = fs.statSync(target);
            if (stat.isDirectory()) {
                for (const entry of fs.readdirSync(target)) {
                    if (entry === 'node_modules' || entry === 'dist') {
                        continue;
                    }
                    visit(path.join(target, entry));
                }
                return;
            }
            if (target.endsWith('.ts') && stat.mtimeMs > newest.mtimeMs) {
                newest = { mtimeMs: stat.mtimeMs, file: target };
            }
        };

        for (const target of [...sourceDirs, ...extraFiles]) {
            visit(target);
        }

        // No sources present (e.g. container image) — dist is authoritative.
        if (!newest.file) {
            return;
        }

        // Small skew allowance so a same-second build doesn't false-positive.
        if (newest.mtimeMs > distMtime + 2000) {
            warn([
                'Compiled build (dist/main.js) is OLDER than the TypeScript sources.',
                `  dist/main.js  built: ${new Date(distMtime).toISOString()}`,
                `  newest source     : ${new Date(newest.mtimeMs).toISOString()} (${path.relative(serverRoot, newest.file)})`,
                'The server is running STALE code. Run `npm run build` and restart before',
                'trusting that recent fixes are live in production.'
            ]);
        }
    } catch (err) {
        // Never let the freshness check prevent the server from starting.
        console.warn(`[startup] build-freshness check skipped: ${err && err.message ? err.message : err}`);
    }
}

function warn(lines) {
    const bar = '='.repeat(72);
    const body = [bar, '  [BUILD WARNING]', ...lines.map((line) => `  ${line}`), bar].join('\n');
    console.warn(`\n${body}\n`);
}

checkBuildFreshness();

require('../dist/main.js');
