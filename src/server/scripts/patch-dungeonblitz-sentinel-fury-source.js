#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/**
 * Sentinel Form's last 20 energy is a burn phase: the Sentinel turns red and hits 60% harder
 * until the bar empties and the form drops on its own.
 *
 * This replaces patch-dungeonblitz-sentinel-form-low-energy-fury.ts, which did the same thing by
 * splicing hand-written bytecode into the head of method_960. That injection worked -- the buff
 * went on and came off correctly -- but its converging forward branches were control flow FFDec
 * cannot express in ActionScript, so it decompiled to `§§goto(addr04f8)` and every later attempt
 * to recompile the class died on `Compiling §§goto is not available`.
 *
 * That single injection is what closed CombatState. Proven rather than assumed: exporting the
 * class from a backup that predates it yields zero gotos, and applying only that one patch to
 * that same backup yields exactly one. The other byte patch living in this class,
 * patch-dungeonblitz-combat-stats-armor, was tested the same way and decompiles clean -- it is
 * not part of the problem and is left alone.
 *
 * Closing CombatState mattered far past this buff, because three source patches have to be able
 * to recompile it (shadowstalker-shroud-passive, templar-talent-effects,
 * sentinel-form-exit-cooldown) and every future change to cast handling, form cooldowns, buff
 * spread and cinematic input gating lands here too.
 *
 * The logic is unchanged from the bytecode version, written out as the source it always
 * described. Notes on the shape, all load-bearing and carried over verbatim:
 *
 *   - The clientEntID/id test keeps this on the local player. Every other entity's CombatState
 *     ticks through here too, and AddBuff reports to the server (linkUpdater.method_1262), so an
 *     ungated version would have each client announcing the buff on everyone else's body. The one
 *     report the local player sends is what puts the red on every other screen.
 *   - var_39 is the sustained-power id, which is how the class already asks "is the form up". It
 *     clears when the form ends, so the else-branch takes the buff off without hooking the exit.
 *   - The buff-type lookup is null-guarded but the power-type lookup is not, matching what the
 *     surrounding code does with powerTypesDict["SentinelForm1"].
 *   - AddBuff's amount argument is 0 on purpose: buff ids >= 740 have it overwritten with the
 *     caster's meleeDamage anyway, and SentinelFury has no DoT for it to scale.
 *
 * Run patch_gameswz_sentinel_fury_buff.ts first -- without it buffTypesDict["SentinelFury"] is
 * undefined and the block below quietly does nothing.
 *
 * Anchor: the same `_loc1_ = this.var_1.mTimeThisTick;` line the Midnight Shroud passive already
 * hangs off, which is the per-tick method's own timestamp read.
 */

const TARGET_SWF = path.join('src', 'client', 'content', 'localhost', 'p', 'cbp', 'DungeonBlitz.swf');
const FURY_BUFF_NAME = 'SentinelFury';
const FORM_POWER_NAME = 'SentinelForm1';
const FURY_ENERGY_THRESHOLD = 20;

const ANCHOR = '         _loc1_ = this.var_1.mTimeThisTick;\n';

const FURY = ANCHOR + [
    '         if(Boolean(this.var_1) && Boolean(this.var_3) && this.var_1.clientEntID == this.var_3.id)',
    '         {',
    `            var _furyBuff:BuffType = class_14.buffTypesDict["${FURY_BUFF_NAME}"];`,
    '            if(_furyBuff)',
    '            {',
    `               if(this.var_39 == class_14.powerTypesDict["${FORM_POWER_NAME}"].powerID && this.var_3.var_31 <= ${FURY_ENERGY_THRESHOLD})`,
    '               {',
    '                  if(!this.method_135(_furyBuff))',
    '                  {',
    '                     this.AddBuff(_furyBuff,this.var_3,0,0);',
    '                  }',
    '               }',
    '               else if(this.method_135(_furyBuff))',
    '               {',
    '                  this.RemoveBuff(_furyBuff);',
    '               }',
    '            }',
    '         }',
    ''
].join('\n');

function parseArgs(argv) {
    const args = { ffdec: '', swf: '', verify: false };
    for (let i = 2; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--ffdec' || arg === '-f') { args.ffdec = argv[++i] || ''; continue; }
        if (arg === '--swf' || arg === '-s') { args.swf = argv[++i] || ''; continue; }
        if (arg === '--verify') { args.verify = true; continue; }
        throw new Error(`Unknown argument: ${arg}`);
    }
    return args;
}

function repoRoot() {
    return path.resolve(__dirname, '..', '..', '..');
}

function detectFfdec(root, override) {
    const candidates = [
        override,
        process.env.FFDEC_PATH,
        path.join(root, 'build', 'ffdec', 'ffdec.sh'),
        path.join(root, 'build', 'ffdec', 'ffdec.jar'),
        path.join(root, 'build', 'ffdec', 'ffdec-cli.jar'),
        '/Applications/FFDec.app/Contents/Resources/ffdec.sh',
        '/Applications/FFDec.app/Contents/Resources/ffdec.jar'
    ];
    return candidates.find((c) => c && fs.existsSync(c)) || '';
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
    const next = source.replace(/\r\n/g, '\n');
    const name = path.basename(swfPath);

    if (next.includes('_furyBuff')) {
        return next;
    }
    // The bytecode cut has to be gone first: it is the thing that made this class uncompilable,
    // and its §§goto would fail the import long before anything below could matter.
    if (next.includes('§§goto')) {
        throw new Error(
            `${name}: CombatState still carries the bytecode fury injection (§§goto). ` +
            'Rebuild this SWF from one that predates it before applying the source version.'
        );
    }
    if (!next.includes(ANCHOR)) {
        throw new Error(`${name}: CombatState.method_960 does not open the way this patch expects.`);
    }
    return next.replace(ANCHOR, FURY);
}

function verifySource(source, swfPath) {
    const next = source.replace(/\r\n/g, '\n');
    const name = path.basename(swfPath);
    const required = [
        `class_14.buffTypesDict["${FURY_BUFF_NAME}"]`,
        `class_14.powerTypesDict["${FORM_POWER_NAME}"].powerID`,
        `this.var_3.var_31 <= ${FURY_ENERGY_THRESHOLD}`,
        'this.AddBuff(_furyBuff,this.var_3,0,0);',
        'this.RemoveBuff(_furyBuff);'
    ];
    for (const snippet of required) {
        if (!next.includes(snippet)) {
            throw new Error(`${name} is missing the Sentinel fury source block: ${snippet}`);
        }
    }
    if (next.includes('§§goto')) {
        throw new Error(`${name}: CombatState is uncompilable again -- a §§goto is back.`);
    }
    console.log(`Verified Sentinel fury source block in ${swfPath}`);
}

function main() {
    const root = repoRoot();
    const args = parseArgs(process.argv);
    const swfPath = path.resolve(root, args.swf || TARGET_SWF);
    const ffdecPath = detectFfdec(root, args.ffdec);

    if (!ffdecPath) throw new Error('FFDec not found. Pass --ffdec or install JPEXS FFDec.');
    if (!fs.existsSync(swfPath)) throw new Error(`SWF not found: ${swfPath}`);

    const workRoot = path.join(root, 'build', args.verify ? 'ffdec-sentinel-fury-source-verify' : 'ffdec-sentinel-fury-source');
    const classPath = exportCombatState(ffdecPath, workRoot, swfPath);

    if (args.verify) {
        verifySource(fs.readFileSync(classPath, 'utf8'), swfPath);
        return;
    }

    fs.writeFileSync(classPath, patchSource(fs.readFileSync(classPath, 'utf8'), swfPath));

    const patchedSwfPath = path.join(workRoot, `${path.basename(swfPath, path.extname(swfPath))}.patched.swf`);
    runFfdec(ffdecPath, ['-importScript', swfPath, patchedSwfPath, path.dirname(classPath)]);
    if (!fs.existsSync(`${swfPath}.bak`)) fs.copyFileSync(swfPath, `${swfPath}.bak`);
    fs.copyFileSync(patchedSwfPath, swfPath);
    console.log(`Patched Sentinel fury (source) in ${swfPath}`);
    console.log(
        'NOTE: recompiling CombatState rebuilds the ABC constant pool. Re-run\n' +
        '      patch-dungeonblitz-forge-charm-durations.ts afterwards.'
    );
}

main();
