#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/**
 * Shadow Legion clones run a fixed rotation instead of spamming one skill.
 *
 *   Scorpion's Sting -> 3 sword swings -> Black Miasma -> 3 sword swings -> Dark Chi -> 3 swings
 *
 * Each clone enters that loop at a different point, which is decided by EntType <Powers> order
 * in patch_gameswz_shadowstalker_balance (clone one opens on the Sting, clone two on the Miasma,
 * clone three on the Chi). This script supplies the spacing, and neither half works alone.
 *
 * Why it cannot be data. Brain walks e.hudPowers -- EntType <Powers>, in order -- and fires the
 * first entry whose cooldown stamp has expired, then returns; a clone with nothing available
 * falls through to MeleePower. So the melee gap is simply "every rotation skill is on cooldown",
 * and the order of the three is decided entirely by when each stamp expires. The stamps are per
 * powerID (CombatState.var_114) and nothing shares them across a PowerGroup, so authoring
 * <CoolDownTime> can only ever produce one steady state: whatever offsets the three powers
 * happened to have on the first cycle. At spawn all three are ready, so that first cycle is the
 * three skills back to back followed by one long melee stretch -- which is what authoring alone
 * gives you, no matter what numbers go in.
 *
 * So the schedule is written directly. Firing any one of the three stamps all three: the
 * successor becomes ready one melee gap after the fired skill's own animation ends, the one
 * after that a further skill-plus-gap later, and the fired skill itself a full cycle out. Only
 * one is ever ready at a time, so drift cannot let two fire together and the order cannot slip.
 *
 * The gap is expressed in milliseconds because that is the only clock var_114 has. Three swings
 * of FalseSaberMelee is 3 * (CastTime 65 + RecoverTime 385) = 1350ms. A clone that is out of
 * melee range spends the gap running instead of swinging, which is the same thing the authored
 * behaviour did between casts.
 *
 * Player skills are untouched: the rotation is keyed on the clone-only BasePowerNames, while a
 * Shadowstalker's own copies are CrippleStrike, ShadowTendrilDash and DarkChi. Cooldowns live on
 * each clone's own CombatState, so the three clones rotate independently.
 *
 * CombatState has to be decompiled and recompiled for this -- it needs a helper method, which no
 * in-place byte splice can express.
 */

const TARGET_SWF = path.join('src', 'client', 'content', 'localhost', 'p', 'cbp', 'DungeonBlitz.swf');

// CastTime + RecoverTime per rotation skill, in rotation order. FalseTendrilDash's CastTime is a
// five-step list (200,100,100,100,100) because it is a Cleave, so its 600 is the sum.
const ROTATION = [
    { base: 'FalseScorpionSting', busyMs: 660 },
    { base: 'FalseTendrilDash', busyMs: 1150 },
    { base: 'FalseChi', busyMs: 700 }
];
const MELEE_GAP_MS = 1350;

const HELPER_ANCHOR = '      public function method_749(param1:PowerType) : void\n';
const CAST_STAMP_ANCHOR = '         this.var_114[param1.powerID] = _loc5_ + param1.coolDownTime + _loc11_;\n';

const GUARD = [
    '         if(this.shadowLegionRotationSlot(param1) >= 0)',
    '         {',
    '            this.shadowLegionRotate(param1,_loc5_);',
    '         }',
    ''
].join('\n');

const HELPER_BODY = [
    '      public function shadowLegionRotationSlot(param1:PowerType) : int',
    '      {',
    '         if(!param1)',
    '         {',
    '            return -1;',
    '         }',
    ...ROTATION.map((entry, index) => [
        `         if(param1.basePowerName == "${entry.base}")`,
        '         {',
        `            return ${index};`,
        '         }'
    ].join('\n')),
    '         return -1;',
    '      }',
    '      ',
    '      public function shadowLegionRotate(param1:PowerType, param2:uint) : void',
    '      {',
    '         var _slOrder:Array = [' + ROTATION.map((entry) => `"${entry.base}"`).join(',') + '];',
    '         var _slBusy:Array = [' + ROTATION.map((entry) => entry.busyMs).join(',') + '];',
    '         var _slSlot:int = this.shadowLegionRotationSlot(param1);',
    '         var _slStep:int = 0;',
    '         var _slIndex:int = 0;',
    '         var _slRank:int = 0;',
    '         var _slPower:PowerType = null;',
    '         var _slReadyAt:uint = 0;',
    '         if(_slSlot < 0)',
    '         {',
    '            return;',
    '         }',
    `         _slReadyAt = param2 + uint(_slBusy[_slSlot]) + ${MELEE_GAP_MS};`,
    '         for(_slStep = 1; _slStep <= 3; _slStep++)',
    '         {',
    '            _slIndex = (_slSlot + _slStep) % 3;',
    '            for(_slRank = 0; _slRank <= 10; _slRank++)',
    '            {',
    '               _slPower = class_14.powerTypesDict[_slRank > 0 ? _slOrder[_slIndex] + _slRank : _slOrder[_slIndex]];',
    '               if(Boolean(_slPower))',
    '               {',
    '                  this.var_114[_slPower.powerID] = _slReadyAt;',
    '               }',
    '            }',
    `            _slReadyAt = _slReadyAt + uint(_slBusy[_slIndex]) + ${MELEE_GAP_MS};`,
    '         }',
    '      }'
].join('\n');

const HELPER = HELPER_BODY + '\n      \n';

function parseArgs(argv) {
    const args = { ffdec: '', swf: TARGET_SWF, verify: false, syncRevOnly: false };
    for (let index = 2; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--ffdec' || arg === '-f') { args.ffdec = argv[++index] || ''; continue; }
        if (arg === '--swf' || arg === '-s') { args.swf = argv[++index] || ''; continue; }
        if (arg === '--verify' || arg === '--dry-run') { args.verify = true; continue; }
        if (arg === '--sync-rev') { args.syncRevOnly = true; continue; }
        if (arg === '--help' || arg === '-h') {
            console.log([
                'Usage:',
                '  node src/server/scripts/patch-dungeonblitz-shadow-legion-rotation.js [--verify] [--sync-rev] [--swf <path>] [--ffdec <path>]',
                '',
                '  --sync-rev  only repoint index.html at the SWF currently on disk. Run this last,',
                '              after every script that writes DungeonBlitz.swf.',
                '',
                'Gives Shadow Legion clones a Sting / Miasma / Chi rotation with three sword swings between each.'
            ].join('\n'));
            process.exit(0);
        }
        throw new Error(`Unknown argument: ${arg}`);
    }
    return args;
}

function repoRoot() { return path.resolve(__dirname, '..', '..', '..'); }

const DEFAULT_SWF_ABS = path.resolve(__dirname, '..', '..', 'client', 'content', 'localhost', 'p', 'cbp', 'DungeonBlitz.swf');
const INDEX_HTML = path.resolve(__dirname, '..', '..', 'client', 'content', 'localhost', 'index.html');

/** See patch-dungeonblitz-sentinel-form-exit-cooldown.js: a patched SWF reaches nobody until this moves. */
function syncClientRev(swfPath) {
    if (path.resolve(swfPath) !== DEFAULT_SWF_ABS || !fs.existsSync(INDEX_HTML)) {
        return;
    }
    const digest = crypto.createHash('sha1').update(fs.readFileSync(swfPath)).digest('hex').slice(0, 12);
    const html = fs.readFileSync(INDEX_HTML, 'utf8');
    const updated = html.replace(/clientrev=[^&`"'$]+/, `clientrev=swf-${digest}`);
    if (updated !== html) {
        fs.writeFileSync(INDEX_HTML, updated);
        console.log(`  index.html clientrev -> swf-${digest} (cache buster)`);
    }
}

function clientRevIsCurrent(swfPath) {
    if (path.resolve(swfPath) !== DEFAULT_SWF_ABS || !fs.existsSync(INDEX_HTML)) {
        return true;
    }
    const digest = crypto.createHash('sha1').update(fs.readFileSync(swfPath)).digest('hex').slice(0, 12);
    return fs.readFileSync(INDEX_HTML, 'utf8').includes(`clientrev=swf-${digest}`);
}

function resolvePath(root, value) { return !value ? '' : (path.isAbsolute(value) ? value : path.join(root, value)); }

function detectFfdec(root, preferred) {
    const candidates = [];
    if (preferred) candidates.push(resolvePath(root, preferred));
    candidates.push(
        path.join(root, 'build', 'ffdec', 'ffdec.sh'),
        path.join(root, 'build', 'ffdec', 'ffdec.jar'),
        'C:\\Program Files (x86)\\FFDec\\ffdec.jar',
        'C:\\Program Files\\FFDec\\ffdec.jar',
        '/Applications/FFDec.app/Contents/Resources/ffdec.sh',
        '/Applications/FFDec.app/Contents/Resources/ffdec.jar'
    );
    return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || '';
}

function runFfdec(ffdecPath, args) {
    const resolved = path.resolve(ffdecPath);
    if (path.basename(resolved).toLowerCase().endsWith('.jar')) {
        execFileSync('java', ['-jar', resolved, '-cli', ...args], { stdio: 'inherit' });
        return;
    }
    execFileSync(resolved, ['-cli', ...args], { stdio: 'inherit' });
}

function exportCombatState(ffdecPath, workRoot, swfPath) {
    fs.rmSync(workRoot, { recursive: true, force: true });
    fs.mkdirSync(workRoot, { recursive: true });
    runFfdec(ffdecPath, ['-selectclass', 'CombatState', '-export', 'script', workRoot, swfPath]);
    const classPath = path.join(workRoot, 'scripts', 'CombatState.as');
    if (!fs.existsSync(classPath)) throw new Error(`FFDec export did not produce ${classPath}`);
    return classPath;
}

function patchSource(source, swfPath) {
    let next = source.replace(/\r\n/g, '\n');
    const name = path.basename(swfPath);

    // Replace an earlier cut rather than stacking a second copy on top of it.
    if (next.includes('public function shadowLegionRotate')) {
        const helperPattern = /      public function shadowLegionRotationSlot\(param1:PowerType\) : int[\s\S]*?\n      }\n      \n(?=      public function method_749)/;
        if (!helperPattern.test(next)) {
            throw new Error(`${name}: could not isolate the existing Shadow Legion rotation helpers.`);
        }
        next = next.replace(helperPattern, HELPER);
        next = next.split(GUARD).join('');
    }

    if (!next.includes(CAST_STAMP_ANCHOR)) {
        throw new Error(`${name}: CombatState.method_51 cooldown stamp was not found.`);
    }
    next = next.replace(CAST_STAMP_ANCHOR, CAST_STAMP_ANCHOR + GUARD);

    if (!next.includes(HELPER_ANCHOR)) {
        throw new Error(`${name}: CombatState.method_749 does not open the way this patch expects.`);
    }
    return next.replace(HELPER_ANCHOR, HELPER + HELPER_ANCHOR);
}

function verifySource(source, swfPath) {
    source = source.replace(/\r\n/g, '\n');
    const name = path.basename(swfPath);
    const required = [
        'public function shadowLegionRotationSlot(param1:PowerType) : int',
        'public function shadowLegionRotate(param1:PowerType, param2:uint) : void',
        ...ROTATION.map((entry) => `param1.basePowerName == "${entry.base}"`),
        `+ ${MELEE_GAP_MS};`,
        '_slIndex = (_slSlot + _slStep) % 3;',
        'this.var_114[_slPower.powerID] = _slReadyAt;',
        'this.shadowLegionRotate(param1,_loc5_);'
    ];
    for (const snippet of required) {
        if (!source.includes(snippet)) {
            throw new Error(`${name} is missing the Shadow Legion rotation: ${snippet}`);
        }
    }
    // One hook only. A second would restart the schedule mid-cycle and collapse the spacing.
    const hooks = source.split('this.shadowLegionRotate(param1,_loc5_);').length - 1;
    if (hooks !== 1) {
        throw new Error(`${name} has ${hooks} Shadow Legion rotation hooks, expected 1.`);
    }
    // The other patches that share CombatState must have survived the recompile.
    for (const [snippet, owner] of [
        ['sentinelFormExitCooldown', 'Sentinel Form exit cooldown'],
        ['_shroudPower', 'Midnight Shroud passive'],
        ['param3 = uint(param2.meleeDamage);', 'Viperblade passive scaling'],
        ['param2.maxHP * 0.3', 'Clutch Heal threshold']
    ]) {
        if (!source.includes(snippet)) {
            throw new Error(`${name} lost the ${owner} patch.`);
        }
    }
    console.log(`Verified Shadow Legion rotation in ${swfPath}`);
}

function main() {
    const root = repoRoot();
    const args = parseArgs(process.argv);
    const swfPath = resolvePath(root, args.swf);
    const ffdecPath = detectFfdec(root, args.ffdec);

    if (!fs.existsSync(swfPath)) throw new Error(`SWF not found: ${swfPath}`);

    if (args.syncRevOnly) {
        syncClientRev(swfPath);
        console.log(clientRevIsCurrent(swfPath) ? 'index.html points at the SWF on disk.' : 'index.html could not be resynced.');
        return;
    }

    if (!ffdecPath) throw new Error('FFDec not found. Pass --ffdec or install JPEXS FFDec.');

    const workRoot = path.join(root, 'build', args.verify ? 'ffdec-shadow-legion-rotation-verify' : 'ffdec-shadow-legion-rotation');
    const classPath = exportCombatState(ffdecPath, workRoot, swfPath);

    if (args.verify) {
        verifySource(fs.readFileSync(classPath, 'utf8'), swfPath);
        if (!clientRevIsCurrent(swfPath)) {
            throw new Error(
                'index.html clientrev does not match the SWF on disk, so players load a cached ' +
                'copy and none of the SWF patches take effect. Re-run this script without ' +
                '--verify to resync it.'
            );
        }
        return;
    }

    fs.writeFileSync(classPath, patchSource(fs.readFileSync(classPath, 'utf8'), swfPath));

    const patchedSwfPath = path.join(workRoot, `${path.basename(swfPath, path.extname(swfPath))}.patched.swf`);
    runFfdec(ffdecPath, ['-importScript', swfPath, patchedSwfPath, path.dirname(classPath)]);
    if (!fs.existsSync(`${swfPath}.bak`)) fs.copyFileSync(swfPath, `${swfPath}.bak`);
    fs.copyFileSync(patchedSwfPath, swfPath);
    syncClientRev(swfPath);
    console.log(`Patched Shadow Legion rotation into ${swfPath}`);
    console.log(
        'NOTE: recompiling CombatState rebuilds the ABC constant pool. Re-run\n' +
        '      patch-dungeonblitz-forge-charm-durations.ts afterwards -- it stores its values\n' +
        '      in the int pool and is reverted by every FFDec import.'
    );
}

main();
