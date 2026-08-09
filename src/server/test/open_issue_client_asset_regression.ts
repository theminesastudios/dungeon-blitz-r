import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

const serverRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(serverRoot, '..', '..');

function verifyScript(args: string[], label: string): void {
    const result = spawnSync(process.execPath, args, {
        cwd: serverRoot,
        encoding: 'utf8',
        env: process.env
    });
    assert.strictEqual(
        result.status,
        0,
        `${label} verification failed:\n${result.stdout || ''}${result.stderr || ''}`
    );
}

function verifyTypescriptPatch(script: string, label: string): void {
    verifyScript([
        '-r',
        path.join(serverRoot, 'node_modules', 'ts-node', 'register', 'transpile-only'),
        path.join(serverRoot, 'scripts', script),
        '--verify'
    ], label);
}

verifyTypescriptPatch('patch-dungeonblitz-forge-charm-durations.ts', 'issue #585 charm duration');
verifyTypescriptPatch('patch-dungeonblitz-gear-tooltip-drop-source.ts', 'gear tooltip drop source always visible');

verifyScript([
    path.join(serverRoot, 'scripts', 'patch-game-swz-statue-dialogue.js'),
    '--verify'
], 'issue #625 leaderboard statue dialogue');

const ffdecPath = '/Applications/FFDec.app/Contents/Resources/ffdec.jar';
if (fs.existsSync(ffdecPath)) {
    verifyScript([
        path.join(serverRoot, 'scripts', 'patch-dungeonblitz-critical-power.js'),
        '--verify',
        '--ffdec',
        ffdecPath
    ], 'issue #581 critical power');
    verifyScript([
        path.join(serverRoot, 'scripts', 'patch-levelsjc-attack-of-opportunity-lava-cycle.js'),
        '--verify',
        '--ffdec',
        ffdecPath
    ], 'issue #491 Imperial Barracks lava cycle');
}

for (const script of [
    'patch-dungeonblitz-activepower-method1507-null-guard.ts',
    'patch-dungeonblitz-activepower-method243-null-guard.ts',
    'patch-dungeonblitz-entity-method1826-null-guard.ts',
    'patch-dungeonblitz-entity-method853-null-guard.ts',
    'patch-dungeonblitz-entity-method900-null-guard.ts',
    'patch-dungeonblitz-superanim-method200-bitmapdata-guard.ts',
    'patch-dungeonblitz-game-superanim-tick-guard.ts',
    'patch-dungeonblitz-demon-maligner-passive-regen.ts',
    'patch_dungeonblitz_buff_back_vfx_depth.ts',
    'patch-dungeonblitz-dungeon-quest-helper.ts',
    'patch_dungeonblitz_cutscene_untargetable.ts'
]) {
    verifyTypescriptPatch(script, `served-client guard ${script}`);
}

const forgeHandler = fs.readFileSync(path.join(serverRoot, 'handlers', 'ForgeHandler.ts'), 'utf8');
assert.match(
    forgeHandler,
    /FORGE_DURATIONS_BY_SIZE\s*=\s*\[300, 900, 1800, 3600, 7200, 14400, 21600, 28800, 43200, 86400\]/,
    'server and served-client charm duration schedules must remain aligned'
);

const criticalPatcher = fs.readFileSync(
    path.join(serverRoot, 'scripts', 'patch-dungeonblitz-critical-power.js'),
    'utf8'
);
assert.match(criticalPatcher, /ProcCriticalHit[\s\S]*?_loc3_\.var_470 = true/);

const buffTypes = fs.readFileSync(path.join(repoRoot, 'src/client/content/xml/PlayerBuffTypes.xml'), 'utf8');
for (const buffName of ['PoisonStrike', 'Bound', 'ChaosWeaken', 'ChaosPoison', 'SoulReaver1', 'SoulReaver10']) {
    const block = buffTypes.match(new RegExp(`<BuffType BuffName="${buffName}">([\\s\\S]*?)<\\/BuffType>`))?.[1];
    assert.ok(block, `${buffName} metadata must exist`);
    assert.match(block, /<Duration>5000<\/Duration>/, `${buffName} VFX must retain its five-second lifetime`);
    assert.match(block, /<GfxType>[\s\S]*?<AnimClass>[^<]+<\/AnimClass>[\s\S]*?<\/GfxType>/);
}

console.log('Open issue client asset regression passed (#478, #491, #523, #558, #581, #585, #625).');
