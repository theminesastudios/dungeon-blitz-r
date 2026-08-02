#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/**
 * Midnight Shroud re-arms itself five seconds after the Shadowstalker was last in combat.
 *
 * Most of this power already worked. ShadowArmor's buff authors Duration 0 and
 * RemoveOnDamage false, so once it is up it stays up; CombatState records its rank in
 * var_576 while it is held, and the attack that spends it already reads that rank to scale
 * the bonus and then drops the buff. What was missing was only the arming: the shroud had to
 * be cast by hand, for 30-50 mana.
 *
 * So this adds the timer and nothing else. Every clause of the spec falls out of parts that
 * already exist:
 *
 *   "5 seconds without being hit"  method_123(5000). var_2361 is stamped in the damage path
 *                                  at both ends -- the victim's own combatState and the
 *                                  attacker's -- so it covers taking a hit and landing one.
 *   "or using a skill"             method_960 already stamps it when an active power has a
 *                                  mana cost or is not a plain melee, so casting re-arms the
 *                                  timer without another check here.
 *   "stays until you hit"          Duration 0 plus the authored consume-on-attack path.
 *   "costs no mana"                the buff is applied directly. Casting ShadowArmor as a
 *                                  power would charge its ManaCost; AddBuff does not.
 *   "works while moving"           nothing here looks at movement. The authored buff's own
 *                                  SpeedChange still applies at low ranks.
 *
 * The rank comes from the player's own hotbar rather than a constant: hudPowers holds the
 * ranked PowerType the ability book resolved, so a rank 3 Shadowstalker arms ShadowArmor3.
 * Hardcoding a rank would hand everyone the rank 10 buff.
 *
 * Guarded to the local player and to Shadowwalker -- "shadowwalker" is the internal name for
 * the Shadowstalker discipline, which Entity.mMasterClass carries in lowercase. Remote
 * players receive the buff over the wire from AddBuff's own link update, so running this on
 * every client would apply it several times over.
 *
 * CombatState has to be decompiled and recompiled for this: it needs a new statement in a
 * per-tick method, which no in-place byte splice can express. That is the expensive route --
 * see the warning below about what a recompile costs.
 */

const TARGET_SWF = path.join('src', 'client', 'content', 'localhost', 'p', 'cbp', 'DungeonBlitz.swf');
const IDLE_MS = 5000;
const MASTER_CLASS = 'shadowwalker';

const ANCHOR = '         _loc1_ = this.var_1.mTimeThisTick;\n';

const PASSIVE = ANCHOR + [
    '         if(Boolean(this.var_3.var_20 & Entity.LOCAL) && this.var_3.mMasterClass == "' + MASTER_CLASS + '" && !this.var_576 && this.method_123(' + IDLE_MS + '))',
    '         {',
    '            var _shroudPower:PowerType = null;',
    '            var _shroudCandidate:PowerType = null;',
    '            for each(_shroudCandidate in this.var_3.hudPowers)',
    '            {',
    '               if(Boolean(_shroudCandidate) && _shroudCandidate.basePowerName == "ShadowArmor")',
    '               {',
    '                  _shroudPower = _shroudCandidate;',
    '                  break;',
    '               }',
    '            }',
    '            if(Boolean(_shroudPower) && Boolean(class_14.buffTypesDict["ShadowArmor" + _shroudPower.var_7]))',
    '            {',
    '               this.AddBuff(class_14.buffTypesDict["ShadowArmor" + _shroudPower.var_7],this.var_3,this.var_3.magicDamage,_shroudPower.powerID);',
    '            }',
    '         }',
    '',
].join('\n');

function parseArgs(argv) {
    const args = { ffdec: '', swf: TARGET_SWF, verify: false };
    for (let index = 2; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--ffdec' || arg === '-f') { args.ffdec = argv[++index] || ''; continue; }
        if (arg === '--swf' || arg === '-s') { args.swf = argv[++index] || ''; continue; }
        if (arg === '--verify' || arg === '--dry-run') { args.verify = true; continue; }
        if (arg === '--help' || arg === '-h') {
            console.log([
                'Usage:',
                '  node src/server/scripts/patch-dungeonblitz-shadowstalker-shroud-passive.js [--verify] [--swf <path>] [--ffdec <path>]',
                '',
                `Re-arms Midnight Shroud ${IDLE_MS / 1000}s after a Shadowstalker was last in combat, for free.`
            ].join('\n'));
            process.exit(0);
        }
        throw new Error(`Unknown argument: ${arg}`);
    }
    return args;
}

function repoRoot() { return path.resolve(__dirname, '..', '..', '..'); }
function resolvePath(root, value) { return !value ? '' : (path.isAbsolute(value) ? value : path.join(root, value)); }

function detectFfdec(root, preferred) {
    const candidates = [];
    if (preferred) candidates.push(resolvePath(root, preferred));
    candidates.push(
        path.join(root, 'build', 'ffdec', 'ffdec.sh'),
        path.join(root, 'build', 'ffdec', 'ffdec.jar'),
        '/Applications/FFDec.app/Contents/Resources/ffdec.sh',
        '/Applications/FFDec.app/Contents/Resources/ffdec.jar'
    );
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
    let next = source.replace(/\r\n/g, '\n');
    const name = path.basename(swfPath);

    if (next.includes('_shroudPower')) {
        return next;
    }
    if (!next.includes(ANCHOR)) {
        throw new Error(`${name}: CombatState.method_960 does not open the way this patch expects.`);
    }
    // Only the first occurrence -- that is the per-tick method's own timestamp read.
    return next.replace(ANCHOR, PASSIVE);
}

function verifySource(source, swfPath) {
    source = source.replace(/\r\n/g, '\n');
    const required = [
        `this.var_3.mMasterClass == "${MASTER_CLASS}"`,
        `this.method_123(${IDLE_MS})`,
        'if(Boolean(_shroudCandidate) && _shroudCandidate.basePowerName == "ShadowArmor")',
        'this.AddBuff(class_14.buffTypesDict["ShadowArmor" + _shroudPower.var_7]'
    ];
    for (const snippet of required) {
        if (!source.includes(snippet)) {
            throw new Error(`${path.basename(swfPath)} is missing the Midnight Shroud passive: ${snippet}`);
        }
    }
    // The two byte patches that also live in CombatState must have survived the recompile.
    if (!source.includes('param3 = uint(param2.meleeDamage);')) {
        throw new Error(`${path.basename(swfPath)} lost the Viperblade passive scaling patch.`);
    }
    if (!source.includes('param2.maxHP * 0.3')) {
        throw new Error(`${path.basename(swfPath)} lost the Clutch Heal threshold patch.`);
    }
    console.log(`Verified Midnight Shroud passive in ${swfPath}`);
}

function main() {
    const root = repoRoot();
    const args = parseArgs(process.argv);
    const swfPath = resolvePath(root, args.swf);
    const ffdecPath = detectFfdec(root, args.ffdec);

    if (!ffdecPath) throw new Error('FFDec not found. Pass --ffdec or install JPEXS FFDec.');
    if (!fs.existsSync(swfPath)) throw new Error(`SWF not found: ${swfPath}`);

    const workRoot = path.join(root, 'build', args.verify ? 'ffdec-shadowstalker-shroud-verify' : 'ffdec-shadowstalker-shroud');
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
    console.log(`Patched Midnight Shroud passive in ${swfPath}`);
    console.log(
        'NOTE: recompiling CombatState rebuilds the ABC constant pool. Re-run\n' +
        '      patch-dungeonblitz-forge-charm-durations.ts afterwards -- it stores its values\n' +
        '      in the int pool and is reverted by every FFDec import.'
    );
}

main();
