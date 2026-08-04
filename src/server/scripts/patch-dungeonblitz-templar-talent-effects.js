#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/**
 * The half of the Sentinel/Justicar retune that no XML field can express.
 *
 * Everything here lives in CombatState, and every one of these effects is a shape the data
 * has no room for -- a power scaling off a stat that is not attack damage, a talentstone
 * doing something other than the one effect its ModType names, or one power reaching into
 * another power's cooldown. The magnitudes that *are* data stay in
 * patch_gameswz_paladin_mastery_balance; this file only ever changes what a number means.
 *
 *   Holy Smash        damage from 300% of Defense and 0.01% of max HP  (RollingSmash)
 *   Juggernaut        damage from 0.02% of max HP                      (JuggernautCharge)
 *   Defiance          damage from 0.02% of max HP
 *   Unstable Barrier  damage from 0.06% of max HP                      (DetShieldDetonate)
 *   Retribution       reflects three times the Expertise it did, plus 150% of Defense
 *   Dominate          stops being a crit stone: 10-50% damage against a Demoralized target,
 *                     doubled against a Staggered or Stunned one
 *   Taunt -> Taunter  keeps its Hate and adds 1-5% attack speed
 *   Flame Axe         each cast from rank 1 takes a second off Meteor Smash and Lightning
 *                     Bomb
 *
 * Screen names and data names disagree the same way they do everywhere else in this class:
 * Holy Smash is RollingSmash, Meteor Smash is LeapStrike, Unstable Barrier's explosion is
 * DetShieldDetonate. Getting one wrong retunes a different power.
 *
 * Where the four damage bonuses go, and why they are all in one place: method_1393 returns
 * the multiplier a hit is scaled by, and it already carries every "this power hits harder
 * when X" rule in the game. It keeps two running totals -- _loc6_ is the multiplier itself
 * and _loc7_ is flat damage, folded in at the end as `_loc6_ += _loc7_ / param1` against the
 * hit's own base damage. A bonus drawn from a stat that is not attack damage belongs in
 * _loc7_, which is exactly what Shadow Blade and Sever Strike already do with meleeDamage.
 * `this.var_3` is the attacker, so armorClass and maxHP are the caster's own.
 *
 * Retribution cannot join them, and it is worth saying why so the omission does not read as
 * an oversight. The reflect is fired as ProcRetribution through method_72, which carries its
 * damage as a flat argument rather than a BaseDamageMult -- method_1393 is only reached on
 * the multiplier path, so a branch there would never run. method_72 is the one place the
 * value passes through, and the value it receives was computed from magicDamage, which is
 * the Expertise-driven stat: tripling it there is the ask, literally.
 *
 * Dominate's old crit clause in method_1192 is deleted rather than left alone. The stone's
 * magnitudes went from .01-.08 to .1-.5 in the same pass, and var_1644 fed a crit *chance*
 * term -- leaving it would have handed the stone a 50% crit chance on top of the damage.
 *
 * "Demoralized" is read as the target's melee-damage debuff total being negative rather than
 * by looking for the buff by name. Warcry's debuff is authored under three different buff
 * names across its ranks (Warcry, WarcryRank10, and Demoralize on the shared block), and all
 * three do the same thing -- lower the target's attack. Testing the effect covers every one
 * of them, and covers Defiance's own debuff too, which is the same Sentinel's own work.
 *
 * Flame Axe walks all eleven ranks of both powers rather than the one the player owns: the
 * cooldown dictionary is keyed by powerID, and a Justicar who respecs mid-fight can have a
 * timer standing against a rank they no longer have. Clamping to _loc5_ rather than
 * subtracting blindly keeps a nearly-ready power from going *negative* and reading as ready
 * forever -- var_114 holds an absolute ready-at timestamp, not a remaining duration.
 *
 * CombatState is decompiled and recompiled for this, which is the expensive route; see the
 * note at the end of main() about what an FFDec import costs.
 */

const TARGET_SWF = path.join('src', 'client', 'content', 'localhost', 'p', 'cbp', 'DungeonBlitz.swf');

// Marks an already-patched source. One name that appears in exactly one of the edits below.
const SENTINEL = '_faCooldownBase';

/**
 * Every edit is an anchor plus its replacement. Anchors are whole statements copied out of
 * the decompiler's own output, indentation included -- a looser match would risk landing in
 * one of the several other places these locals appear.
 */
const EDITS = [
    {
        name: 'Sentinel damage from Defence and max HP, and Dominate',
        anchor: [
            '         _loc6_ += _loc7_ / param1;',
            ''
        ].join('\n'),
        replacement: [
            '         if(param2.basePowerName == "RollingSmash")',
            '         {',
            '            _loc7_ += 3 * this.var_3.armorClass + 0.0001 * this.var_3.maxHP;',
            '         }',
            '         else if(param2.basePowerName == "JuggernautCharge")',
            '         {',
            '            _loc7_ += 0.0002 * this.var_3.maxHP;',
            '         }',
            '         else if(param2.basePowerName == "Defiance")',
            '         {',
            '            _loc7_ += 0.0002 * this.var_3.maxHP;',
            '         }',
            '         else if(param2.basePowerName == "DetShieldDetonate")',
            '         {',
            '            _loc7_ += 0.0006 * this.var_3.maxHP;',
            '         }',
            '         if(this.var_1644)',
            '         {',
            '            if(_loc5_.var_683 || _loc5_.var_2291)',
            '            {',
            '               _loc6_ += 2 * this.var_1644;',
            '            }',
            '            else if(_loc5_.var_495 < 0)',
            '            {',
            '               _loc6_ += this.var_1644;',
            '            }',
            '         }',
            '         _loc6_ += _loc7_ / param1;',
            ''
        ].join('\n')
    },
    {
        name: 'Dominate is no longer a crit stone',
        anchor: [
            '               if(Boolean(this.var_1644) && (_loc13_.var_683 || _loc13_.var_2291))',
            '               {',
            '                  _loc59_ += this.var_1644;',
            '               }',
            ''
        ].join('\n'),
        replacement: ''
    },
    {
        name: 'Retribution reflects triple Expertise plus 150% Defence',
        anchor: [
            '         if(param1.var_470)',
            ''
        ].join('\n'),
        replacement: [
            '         if(param1.powerName == "ProcRetribution")',
            '         {',
            '            param4 = param4 * 3 + 1.5 * this.var_3.armorClass;',
            '         }',
            '         if(param1.var_470)',
            ''
        ].join('\n')
    },
    {
        name: 'Taunter grants attack speed',
        anchor: [
            '               else if(_loc12_.indexOf("Taunt") == 0)',
            '               {',
            '                  this.var_984 += _loc15_;',
            '               }',
            ''
        ].join('\n'),
        replacement: [
            '               else if(_loc12_.indexOf("Taunt") == 0)',
            '               {',
            '                  this.var_984 += _loc15_;',
            '                  this.var_840 += int(_loc12_.substr(5)) * 0.01;',
            '               }',
            ''
        ].join('\n')
    },
    {
        name: 'Flame Axe shortens Meteor Smash and Lightning Bomb',
        anchor: [
            '         this.var_114[param1.powerID] = _loc5_ + param1.coolDownTime + _loc11_;',
            ''
        ].join('\n'),
        replacement: [
            '         this.var_114[param1.powerID] = _loc5_ + param1.coolDownTime + _loc11_;',
            '         if(param1.basePowerName == "FlameAxe" && param1.var_7 >= 1)',
            '         {',
            '            var _faCooldownBase:String = null;',
            '            var _faRank:int = 0;',
            '            var _faPower:PowerType = null;',
            '            var _faReadyAt:uint = 0;',
            '            var _faBases:Array = ["LeapStrike","LightningBomb"];',
            '            for each(_faCooldownBase in _faBases)',
            '            {',
            '               _faRank = 0;',
            '               while(_faRank <= 10)',
            '               {',
            '                  _faPower = class_14.powerTypesDict[_faRank > 0 ? _faCooldownBase + _faRank : _faCooldownBase];',
            '                  if(_faPower)',
            '                  {',
            '                     _faReadyAt = uint(this.var_114[_faPower.powerID]);',
            '                     if(_faReadyAt > _loc5_ + 1000)',
            '                     {',
            '                        this.var_114[_faPower.powerID] = _faReadyAt - 1000;',
            '                     }',
            '                     else if(_faReadyAt > _loc5_)',
            '                     {',
            '                        this.var_114[_faPower.powerID] = _loc5_;',
            '                     }',
            '                  }',
            '                  _faRank++;',
            '               }',
            '            }',
            '         }',
            ''
        ].join('\n')
    }
];

// Snippets that must be present once the patch has landed, and that a later FFDec import of
// this same class would silently drop. The two byte patches at the end are not ours -- they
// live in CombatState too, and a recompile is exactly what throws them away.
const REQUIRED = [
    '_loc7_ += 3 * this.var_3.armorClass + 0.0001 * this.var_3.maxHP;',
    'else if(param2.basePowerName == "JuggernautCharge")',
    'else if(param2.basePowerName == "Defiance")',
    'else if(param2.basePowerName == "DetShieldDetonate")',
    'param4 = param4 * 3 + 1.5 * this.var_3.armorClass;',
    'this.var_840 += int(_loc12_.substr(5)) * 0.01;',
    'if(param1.basePowerName == "FlameAxe" && param1.var_7 >= 1)',
    'param3 = uint(param2.meleeDamage);',
    'param2.maxHP * 0.3'
];

// The crit clause Dominate used to have. Its absence is as much a part of the patch as
// anything in REQUIRED, because the stone's magnitudes moved with it.
const FORBIDDEN = ['_loc59_ += this.var_1644;'];

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
                '  node src/server/scripts/patch-dungeonblitz-templar-talent-effects.js [--verify] [--swf <path>] [--ffdec <path>]',
                '',
                'Applies the Sentinel/Justicar retune effects that are bytecode rather than data.'
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
        'C:\\Program Files (x86)\\FFDec\\ffdec-cli.exe',
        'C:\\Program Files\\FFDec\\ffdec-cli.exe',
        '/Applications/FFDec.app/Contents/Resources/ffdec.sh',
        '/Applications/FFDec.app/Contents/Resources/ffdec.jar'
    );
    return candidates.find((c) => c && fs.existsSync(c)) || '';
}

function runFfdec(ffdecPath, args) {
    const resolved = path.resolve(ffdecPath);
    const lower = path.basename(resolved).toLowerCase();
    if (lower.endsWith('.jar')) {
        execFileSync('java', ['-jar', resolved, '-cli', ...args], { stdio: 'inherit' });
        return;
    }
    // ffdec-cli.exe is already the CLI entry point; passing -cli to it is an unknown argument.
    if (lower === 'ffdec-cli.exe') {
        execFileSync(resolved, args, { stdio: 'inherit' });
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

    if (next.includes(SENTINEL)) {
        return next;
    }

    for (const edit of EDITS) {
        const occurrences = next.split(edit.anchor).length - 1;
        if (occurrences !== 1) {
            throw new Error(
                `${name}: CombatState does not open the way this patch expects -- ` +
                `"${edit.name}" matched its anchor ${occurrences} times, expected exactly 1.`
            );
        }
        next = next.replace(edit.anchor, edit.replacement);
    }

    return next;
}

function verifySource(source, swfPath) {
    const text = source.replace(/\r\n/g, '\n');
    const name = path.basename(swfPath);
    for (const snippet of REQUIRED) {
        if (!text.includes(snippet)) {
            throw new Error(`${name} is missing a Templar talent effect: ${snippet}`);
        }
    }
    for (const snippet of FORBIDDEN) {
        if (text.includes(snippet)) {
            throw new Error(`${name} still carries Dominate's old critical-chance clause: ${snippet}`);
        }
    }
    console.log(`Verified Templar talent effects in ${swfPath}`);
}

function main() {
    const root = repoRoot();
    const args = parseArgs(process.argv);
    const swfPath = resolvePath(root, args.swf);
    const ffdecPath = detectFfdec(root, args.ffdec);

    if (!ffdecPath) throw new Error('FFDec not found. Pass --ffdec or install JPEXS FFDec.');
    if (!fs.existsSync(swfPath)) throw new Error(`SWF not found: ${swfPath}`);

    const workRoot = path.join(root, 'build', args.verify ? 'ffdec-templar-talents-verify' : 'ffdec-templar-talents');
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
    console.log(`Patched Templar talent effects in ${swfPath}`);
    console.log(
        'NOTE: recompiling CombatState rebuilds the ABC constant pool. Re-run\n' +
        '      patch-dungeonblitz-forge-charm-durations.ts afterwards -- it stores its values\n' +
        '      in the int pool and is reverted by every FFDec import.'
    );
}

main();
