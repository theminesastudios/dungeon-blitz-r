#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/**
 * Plague Battalion as a timed window rather than a one-shot buff on whoever was standing there.
 *
 * The requested rule: cast once, and for three seconds your own basic attacks and every one of
 * your undead minions' attacks leave Plague on what they hit. The three seconds grows by 0.1% of
 * Expertise, so 7000 Expertise runs the window to ten seconds. The cast keeps its authored mastery
 * mana cost; the attacks themselves cost no mastery mana. Minions raised *during* the window get
 * the buff too.
 *
 * Two of those cannot be data, which is why this file exists:
 *
 *   - No XML field says "extend this buff by a fraction of a stat".
 *   - AddTargetBuff applies at cast time to the minions standing there then. A minion summoned
 *     five seconds later can never be reached by it.
 *
 * Both have precedent in this class, and both are followed rather than invented.
 *
 * THE EXPERTISE EXTENSION rides the same carrier shape Empyrean Aura uses
 * (patch-dungeonblitz-templar-talent-effects). Buff computes its lifetime as the authored Duration
 * plus whatever its mods vector adds, and a mod is only expressible as a class_140 built against a
 * real PowerModType -- so patch_gameswz_plague_battalion_overrides authors a carrier
 * (PlagueExpertise, ModID 1099, BuffProperty Duration) and this fabricates a class_140 against it
 * at cast time with the milliseconds in place of a magnitude. modValue is one entry long because
 * class_140 indexes modValue by property, not by buff name.
 *
 * `this.var_3.magicDamage` is Expertise -- the same read Holy Smash and Subjugate use for it. One
 * millisecond per point is 0.1% of Expertise expressed in seconds, so the arithmetic is a bare
 * multiply by 1 and is written as such rather than dressed up.
 *
 * Unlike Empyrean Aura this does NOT cap the bonus at the authored Duration. Empyrean caps because
 * its rule is "outlives its base by up to its base"; here 7000 Expertise is meant to turn 3s into
 * 10s, and a cap at 3000 would silently halve the headline number.
 *
 * A fresh vector is built rather than pushed onto the one method_101 returned, for the reason the
 * templar patch gives: `_loc16_` is only assigned when the caster has a mod set at all, so it can
 * still hold a previous iteration's value, and appending a duration onto some other buff's mods
 * would be a genuinely confusing bug.
 *
 * THE MINION REFRESH IS NOT HERE, and this is the part worth reading before writing it again.
 *
 * It hung off method_960, the per-tick combat update, beside the Sentinel fury block: while the
 * local player carried PlagueBattalion<n>, every friendly undead pet in range was given
 * PlagueBattalionMinion<n>. It crashed the client three times and came out in e6effa9b. All three
 * crashes were one shape -- reaching into another entity's CombatState from a tick while that
 * entity is still being built. Guarding this.var_84 fixed two (216e488e, 1100249e) and AddBuff
 * still had its own uninitialised state to trip over, so the third guard was not attempted.
 *
 * The shape it has to come back in is read-only: Entity.GetMeleePower asking the pet's *owner*
 * whether the window is up, rather than a tick writing a buff onto a stranger. That needs Entity
 * to be source-compilable. The code that was tried is in e6effa9b's parent if it is ever wanted;
 * it is not kept here, because what is worth keeping is the reason it does not work.
 *
 * Two details from it that any rewrite still needs. Pets are identified the way ActivePower's own
 * UndeadPet targeting does (PowerType.const_698): friendly, MONSTER, on the caster's team, and
 * behaviorType.var_679 set -- the flag BehaviorType stamps on "UndeadPet" and "UndeadPetRanged",
 * which is the game's own definition rather than a guess. And anything that writes a buff must be
 * gated on clientEntID == id: every entity's CombatState ticks through here and AddBuff reports to
 * the server, so an ungated version has every client announcing buffs on everyone else's pets.
 */

const TARGET_SWF = path.join('src', 'client', 'content', 'localhost', 'p', 'cbp', 'DungeonBlitz.swf');
const PLAGUE_EXPERTISE_MOD_ID = 1099;
/** Milliseconds of window per point of Expertise: 0.1% of Expertise, in seconds. */
const MS_PER_EXPERTISE = 1;

// The self-buff application loop -- the one place an AddSelfBuff entry's mods vector is assembled
// before it reaches AddBuff.
const SELF_ANCHOR = [
    '                  _loc21_ = uint(this.var_3.magicDamage);',
    '                  if(this.var_3.var_18)',
    '                  {',
    '                     _loc16_ = this.var_3.var_18.method_101(this.var_3,_loc20_);',
    '                  }',
    '                  this.var_3.combatState.AddBuff(_loc20_,this.var_3,_loc21_,param1.powerID,1,_loc16_);',
    ''
].join('\n');

const SELF_PATCHED = [
    '                  _loc21_ = uint(this.var_3.magicDamage);',
    '                  if(this.var_3.var_18)',
    '                  {',
    '                     _loc16_ = this.var_3.var_18.method_101(this.var_3,_loc20_);',
    '                  }',
    '                  if(_loc20_.buffName.indexOf("PlagueBattalion") == 0 && _loc20_.buffName.indexOf("PlagueBattalionMinion") != 0)',
    '                  {',
    `                     var _pbBonus:Number = this.var_3.magicDamage * ${MS_PER_EXPERTISE};`,
    '                     var _pbMods:Vector.<class_140> = new Vector.<class_140>();',
    '                     var _pbCarried:class_140 = null;',
    '                     if(_loc16_)',
    '                     {',
    '                        for each(_pbCarried in _loc16_)',
    '                        {',
    '                           _pbMods.push(_pbCarried);',
    '                        }',
    '                     }',
    '                     var _pbValue:Vector.<Number> = new Vector.<Number>();',
    '                     _pbValue.push(_pbBonus);',
    `                     _pbMods.push(new class_140(${PLAGUE_EXPERTISE_MOD_ID},_pbValue));`,
    '                     _loc16_ = _pbMods;',
    '                  }',
    '                  this.var_3.combatState.AddBuff(_loc20_,this.var_3,_loc21_,param1.powerID,1,_loc16_);',
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
    return [
        override,
        process.env.FFDEC_PATH,
        path.join(root, 'build', 'ffdec', 'ffdec.sh'),
        path.join(root, 'build', 'ffdec', 'ffdec.jar'),
        path.join(root, 'build', 'ffdec', 'ffdec-cli.jar'),
        '/Applications/FFDec.app/Contents/Resources/ffdec.sh',
        '/Applications/FFDec.app/Contents/Resources/ffdec.jar'
    ].find((c) => c && fs.existsSync(c)) || '';
}

function runFfdec(ffdecPath, args) {
    const resolved = path.resolve(ffdecPath);
    if (path.basename(resolved).toLowerCase().endsWith('.jar')) {
        execFileSync('java', ['-jar', resolved, '-cli', ...args], { stdio: 'inherit' });
        return;
    }
    execFileSync(resolved, ['-cli', ...args], { stdio: 'inherit' });
}

function exportClass(ffdecPath, workRoot, swfPath, className) {
    fs.rmSync(workRoot, { recursive: true, force: true });
    fs.mkdirSync(workRoot, { recursive: true });
    runFfdec(ffdecPath, ['-selectclass', className, '-export', 'script', workRoot, swfPath]);
    const classPath = path.join(workRoot, 'scripts', `${className}.as`);
    if (!fs.existsSync(classPath)) throw new Error(`FFDec export did not produce ${classPath}`);
    return classPath;
}

function patchCombatState(source, swfPath) {
    const next = source.replace(/\r\n/g, '\n');
    const name = path.basename(swfPath);

    if (next.includes('§§goto')) {
        throw new Error(`${name}: CombatState is uncompilable (§§goto). Repair that before patching.`);
    }
    if (next.includes('_pbBonus')) {
        return next;
    }
    if (!next.includes(SELF_ANCHOR)) {
        throw new Error(`${name}: CombatState self-buff application does not open the way this patch expects.`);
    }
    // Only the self-buff half is applied; see the minion-refresh note in the file header for
    // why the per-tick half came out in e6effa9b and what shape it has to come back in.
    return next.replace(SELF_ANCHOR, SELF_PATCHED);
}

function verifyAll(combatSource, swfPath) {
    const name = path.basename(swfPath);
    const checks = [
        `new class_140(${PLAGUE_EXPERTISE_MOD_ID},_pbValue)`,
        `var _pbBonus:Number = this.var_3.magicDamage * ${MS_PER_EXPERTISE};`
    ];
    const source = combatSource.replace(/\r\n/g, '\n');
    for (const snippet of checks) {
        if (!source.includes(snippet)) {
            throw new Error(`${name} is missing the Plague Battalion window: ${snippet}`);
        }
    }
    if (source.includes('§§goto')) {
        throw new Error(`${name}: CombatState is uncompilable again -- a §§goto is back.`);
    }
    console.log(`Verified Plague Battalion window in ${swfPath}`);
}

function main() {
    const root = repoRoot();
    const args = parseArgs(process.argv);
    const swfPath = path.resolve(root, args.swf || TARGET_SWF);
    const ffdecPath = detectFfdec(root, args.ffdec);

    if (!ffdecPath) throw new Error('FFDec not found. Pass --ffdec or install JPEXS FFDec.');
    if (!fs.existsSync(swfPath)) throw new Error(`SWF not found: ${swfPath}`);

    const suffix = args.verify ? '-verify' : '';
    const combatRoot = path.join(root, 'build', `ffdec-plague-window-combat${suffix}`);

    if (args.verify) {
        const combatPath = exportClass(ffdecPath, combatRoot, swfPath, 'CombatState');
        verifyAll(fs.readFileSync(combatPath, 'utf8'), swfPath);
        return;
    }

    const classPath = exportClass(ffdecPath, combatRoot, swfPath, 'CombatState');
    fs.writeFileSync(classPath, patchCombatState(fs.readFileSync(classPath, 'utf8'), swfPath));
    const patchedSwfPath = path.join(combatRoot, `${path.basename(swfPath, path.extname(swfPath))}.patched.swf`);
    runFfdec(ffdecPath, ['-importScript', swfPath, patchedSwfPath, path.dirname(classPath)]);
    if (!fs.existsSync(`${swfPath}.bak`)) fs.copyFileSync(swfPath, `${swfPath}.bak`);
    fs.copyFileSync(patchedSwfPath, swfPath);
    console.log('Patched CombatState for the Plague Battalion window.');

    console.log(
        'NOTE: recompiling this class rebuilds the ABC constant pool. Re-run\n' +
        '      patch-dungeonblitz-forge-charm-durations.ts and the CombatState byte patches afterwards.'
    );
}

main();
