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
 *
 * ---------------------------------------------------------------------------------------
 * Second pass (2026-08-04). Three more effects, and the first one that needed a second class.
 *
 *   Subjugate         adds 60% of the Templar's Expertise as damage to a burning target
 *   Penance           the same, at 45%
 *   Empyrean Aura     the boost outlives its 4-second base by Expertise x 4 milliseconds,
 *                     up to a second 4 seconds -- and PowerType's #dur# says so
 *
 * ---------------------------------------------------------------------------------------
 * Third pass (2026-08-05). One item, and it is a repair rather than a retune.
 *
 *   Heavy Blows       the stone's damage now reaches the Heavy Blow proc it names. See the
 *                     edit itself for why it never did.
 *
 * "Expertise damage" is read the way the rest of this file already reads it: Holy Smash draws
 * "300% of Defense" as `_loc7_ += 3 * armorClass`, so 60% of Expertise is
 * `_loc7_ += 0.6 * magicDamage`. _loc7_ is method_1393's flat-damage accumulator, folded in
 * against the hit's own base at the end, which is where a bonus drawn from a stat that is not
 * attack damage belongs. "vs Holy Fire" is read off the target's own buff list rather than by
 * BuffType identity, because Celestial Lance, Divine Word and Sanctum hand out different
 * HolyFire ranks and all of them are burning.
 *
 * Empyrean Aura is the awkward one, and the shape is worth not rediscovering. Buff durations
 * are not a CombatState decision -- Buff reads `this.type.var_454 + method_59("Duration")`,
 * and Buff is control-flow obfuscated past the point of recompiling. The one thing
 * CombatState *does* hand the buff is the mods vector, so the extension rides in as a mod:
 * PowerModTypes carries a carrier entry (EmpyreanExpertise, ModID 900, BuffProperty Duration
 * over LeoneanAura1..10) that no talent node ever offers, and the code below fabricates a
 * class_140 against it with the milliseconds in place of an owned magnitude. Its modValue is
 * one entry long because class_140 indexes modValue by *property*, not by buff name -- which
 * is also what class_17's "Buff Value length must match Buff Property length" is checking.
 *
 * The magnitude, 4ms per point of Expertise capped at the buff's own authored duration, is a
 * first cut: it doubles the aura for a Templar around 1000 Expertise, which is where the
 * 8-second rank-10 aura used to sit. Both numbers live in EMPYREAN_MS_PER_EXPERTISE and the
 * cap below, and the same pair is reproduced in PowerType so the tooltip cannot drift from
 * the effect.
 */

const TARGET_SWF = path.join('src', 'client', 'content', 'localhost', 'p', 'cbp', 'DungeonBlitz.swf');

/**
 * The carrier mod Empyrean Aura's duration extension rides on. Authored by
 * patch_gameswz_paladin_mastery_balance (MOD_INSERTS); the two must agree or the extension
 * silently resolves to nothing.
 */
const EMPYREAN_MOD_ID = 900;
// Milliseconds of extra boost per point of Expertise, capped at the buff's authored duration.
const EMPYREAN_MS_PER_EXPERTISE = 4;

/**
 * Every edit is an anchor plus its replacement. Anchors are whole statements copied out of
 * the decompiler's own output, indentation included -- a looser match would risk landing in
 * one of the several other places these locals appear.
 *
 * `marker` is the string that proves the edit has already landed. An edit without one is
 * treated as applied once its anchor is gone, which is how the pure deletion below is
 * recognised. Skipping per edit rather than per file is what lets a later pass add an edit to
 * a source the earlier ones already changed.
 */
const COMBAT_STATE_EDITS = [
    {
        name: 'Sentinel damage from Defence and max HP, and Dominate',
        marker: '_loc7_ += 3 * this.var_3.armorClass',
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
        /**
         * Heavy Blows, which has never done anything.
         *
         * The stone is a "Power" mod that adds .02-.15 to ProcMassive's BaseDamageMult, and
         * ProcMassive is the crit proc the screen calls Heavy Blow. But method_72 -- the one
         * path a proc's damage takes -- never reads the power's BaseDamageMult. It carries the
         * damage in as `param4` and scales it by `_loc6_`, and for ProcMassive `_loc6_` is
         * assigned the hardcoded const_1248 (0.2) outright. Whatever the mod added to the
         * power's own multiplier was overwritten before it could be read, at every rank.
         *
         * So the mod is read here instead, off the same class_44 the rest of the file reads
         * its Power mods from -- method_102(owner, powerName, property) is exactly the lookup
         * ActivePower does at line 2008 for a normal cast, and it returns 0 for an owner who
         * has no such stone. basePowerName rather than powerName because that is the key the
         * mod table is built against; PowerType falls it back to powerName for a block like
         * ProcMassive that authors no BasePowerName, so the two agree here.
         *
         * The truthiness guard is not decoration: method_102 is control-flow obfuscated and
         * has a path that falls off its end, and `_loc6_ += undefined` would turn the whole
         * multiplier into NaN and silently zero every Heavy Blow. `if(0)` and `if(NaN)` are
         * both false, so the guard covers "no stone" and "no answer" in one test.
         */
        name: 'Heavy Blows reaches the Heavy Blow proc',
        marker: '_hbBonus',
        anchor: [
            '         if(param1.powerName == "ProcMassive")',
            '         {',
            '            _loc6_ = const_1248;',
            '         }',
            ''
        ].join('\n'),
        replacement: [
            '         if(param1.powerName == "ProcMassive")',
            '         {',
            '            _loc6_ = const_1248;',
            '            if(this.var_3.var_18)',
            '            {',
            '               var _hbBonus:Number = this.var_3.var_18.method_102(this.var_3,param1.basePowerName,"BaseDamageMult");',
            '               if(_hbBonus)',
            '               {',
            '                  _loc6_ += _hbBonus;',
            '               }',
            '            }',
            '         }',
            ''
        ].join('\n')
    },
    {
        name: 'Retribution reflects triple Expertise plus 150% Defence',
        marker: 'param4 = param4 * 3 + 1.5 * this.var_3.armorClass;',
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
        marker: 'this.var_840 += int(_loc12_.substr(5)) * 0.01;',
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
        marker: '_faCooldownBase',
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
    },
    {
        /**
         * Subjugate and Penance against a burning target. Anchored on the tail of the
         * Sentinel damage chain the first pass wrote, so the whole family of "this power
         * hits harder because of a stat" rules stays in one readable block.
         *
         * The burning test walks the target's own buff list because "Holy Fire" is five
         * BuffTypes, not one, and which rank a target carries depends on which Templar power
         * lit it. Reading `type.buffName` off each Buff covers every rank and any rank added
         * later.
         */
        name: 'Subjugate and Penance draw Expertise against a burning target',
        marker: '_hfBurning',
        anchor: [
            '         else if(param2.basePowerName == "DetShieldDetonate")',
            '         {',
            '            _loc7_ += 0.0006 * this.var_3.maxHP;',
            '         }',
            ''
        ].join('\n'),
        replacement: [
            '         else if(param2.basePowerName == "DetShieldDetonate")',
            '         {',
            '            _loc7_ += 0.0006 * this.var_3.maxHP;',
            '         }',
            '         if(param2.basePowerName == "Subjugate" || param2.basePowerName == "Penance")',
            '         {',
            '            var _hfBurning:Boolean = false;',
            '            var _hfBuff:Buff = null;',
            '            for each(_hfBuff in _loc5_.var_84)',
            '            {',
            '               if(Boolean(_hfBuff.type) && _hfBuff.type.buffName.indexOf("HolyFire") == 0)',
            '               {',
            '                  _hfBurning = true;',
            '               }',
            '            }',
            '            if(_hfBurning)',
            '            {',
            '               _loc7_ += (param2.basePowerName == "Subjugate" ? 0.6 : 0.45) * this.var_3.magicDamage;',
            '            }',
            '         }',
            ''
        ].join('\n')
    },
    {
        /**
         * Empyrean Aura's boost outlives its base by Expertise.
         *
         * The anchor is the AddTargetBuff application site -- the one place a target buff's
         * mods vector is assembled before it is handed to AddBuff. `_loc53_ = totalMods` is
         * in the anchor purely to make it unique; the same method_101 call appears again a
         * few lines down on the random-buff path, which Empyrean Aura never takes.
         *
         * A fresh vector is built rather than pushed onto the one method_101 returned. That
         * vector is freshly allocated per call today, but `_loc16_` is only assigned when the
         * caster has a mod set at all, so it can carry a previous iteration's value -- and
         * appending a duration to some other buff's mods would be a genuinely confusing bug.
         */
        name: 'Empyrean Aura lasts longer with Expertise',
        marker: '_eaBonus',
        anchor: [
            '                        if(this.var_3.var_18)',
            '                        {',
            '                           _loc16_ = this.var_3.var_18.method_101(this.var_3,_loc52_);',
            '                        }',
            '                        _loc17_ = uint(this.var_3.magicDamage);',
            '                        _loc53_ = this.var_3.totalMods;',
            ''
        ].join('\n'),
        replacement: [
            '                        if(this.var_3.var_18)',
            '                        {',
            '                           _loc16_ = this.var_3.var_18.method_101(this.var_3,_loc52_);',
            '                        }',
            '                        if(_loc52_.buffName.indexOf("LeoneanAura") == 0)',
            '                        {',
            `                           var _eaBonus:Number = this.var_3.magicDamage * ${EMPYREAN_MS_PER_EXPERTISE};`,
            '                           if(_eaBonus > _loc52_.var_454)',
            '                           {',
            '                              _eaBonus = _loc52_.var_454;',
            '                           }',
            '                           var _eaMods:Vector.<class_140> = new Vector.<class_140>();',
            '                           var _eaCarried:class_140 = null;',
            '                           if(_loc16_)',
            '                           {',
            '                              for each(_eaCarried in _loc16_)',
            '                              {',
            '                                 _eaMods.push(_eaCarried);',
            '                              }',
            '                           }',
            '                           var _eaValue:Vector.<Number> = new Vector.<Number>();',
            '                           _eaValue.push(_eaBonus);',
            `                           _eaMods.push(new class_140(${EMPYREAN_MOD_ID},_eaValue));`,
            '                           _loc16_ = _eaMods;',
            '                        }',
            '                        _loc17_ = uint(this.var_3.magicDamage);',
            '                        _loc53_ = this.var_3.totalMods;',
            ''
        ].join('\n')
    }
];

/**
 * PowerType, for the one item that is a tooltip rather than an effect.
 *
 * #dur# already resolves to the authored duration of the first buff a power hands out, which
 * is the aura's 4-second base. It has to say what a player actually gets, so the same
 * Expertise term the effect uses is added here -- `_loc8_` is already `param1.magicDamage`,
 * read at the top of the method for exactly this kind of arithmetic, and _loc15_ is the
 * duration in seconds, so the milliseconds are scaled down to match.
 */
const POWER_TYPE_EDITS = [
    {
        name: 'Empyrean Aura tooltip counts the Expertise extension',
        marker: '_eaShown',
        anchor: [
            '               else if(_loc18_[_loc35_] == "dur")',
            '               {',
            '                  _loc18_[_loc35_] = MathUtil.method_29(_loc15_);',
            '               }',
            ''
        ].join('\n'),
        replacement: [
            '               else if(_loc18_[_loc35_] == "dur")',
            '               {',
            '                  var _eaShown:Number = _loc15_;',
            '                  if(this.basePowerName == "LeoneanAura")',
            '                  {',
            `                     var _eaExtra:Number = _loc8_ * ${EMPYREAN_MS_PER_EXPERTISE} * 0.001;`,
            '                     if(_eaExtra > _loc15_)',
            '                     {',
            '                        _eaExtra = _loc15_;',
            '                     }',
            '                     _eaShown += _eaExtra;',
            '                  }',
            '                  _loc18_[_loc35_] = MathUtil.method_29(_eaShown);',
            '               }',
            ''
        ].join('\n')
    }
];

const CLASSES = [
    { className: 'CombatState', edits: COMBAT_STATE_EDITS },
    { className: 'PowerType', edits: POWER_TYPE_EDITS }
];

// Snippets that must be present once the patch has landed, and that a later FFDec import of
// this same class would silently drop. The two byte patches at the end are not ours -- they
// live in CombatState too, and a recompile is exactly what throws them away.
const REQUIRED = {
    CombatState: [
        '_loc7_ += 3 * this.var_3.armorClass + 0.0001 * this.var_3.maxHP;',
        'else if(param2.basePowerName == "JuggernautCharge")',
        'else if(param2.basePowerName == "Defiance")',
        'else if(param2.basePowerName == "DetShieldDetonate")',
        'param4 = param4 * 3 + 1.5 * this.var_3.armorClass;',
        'this.var_840 += int(_loc12_.substr(5)) * 0.01;',
        'if(param1.basePowerName == "FlameAxe" && param1.var_7 >= 1)',
        'param3 = uint(param2.meleeDamage);',
        'param2.maxHP * 0.3',
        'if(param2.basePowerName == "Subjugate" || param2.basePowerName == "Penance")',
        'var _hbBonus:Number = this.var_3.var_18.method_102(this.var_3,param1.basePowerName,"BaseDamageMult");',
        `_eaMods.push(new class_140(${EMPYREAN_MOD_ID},_eaValue));`
    ],
    PowerType: [
        'if(this.basePowerName == "LeoneanAura")',
        // Not ours -- patch-dungeonblitz-critical-power lives in this class, and importing it
        // is exactly what would throw the edit away.
        'else if(_loc56_ == "ProcCriticalHit")'
    ]
};

// The crit clause Dominate used to have. Its absence is as much a part of the patch as
// anything in REQUIRED, because the stone's magnitudes moved with it.
const FORBIDDEN = { CombatState: ['_loc59_ += this.var_1644;'], PowerType: [] };

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

/**
 * Both classes come out in one export and go back in one import. FFDec's -importScript takes
 * a directory and reads every .as under it, so a single round trip covers the pair -- and one
 * import is one constant-pool rebuild rather than two.
 */
function exportClasses(ffdecPath, workRoot, swfPath) {
    fs.rmSync(workRoot, { recursive: true, force: true });
    fs.mkdirSync(workRoot, { recursive: true });
    runFfdec(ffdecPath, [
        '-selectclass', CLASSES.map((entry) => entry.className).join(','),
        '-export', 'script', workRoot, swfPath
    ]);

    const paths = {};
    for (const { className } of CLASSES) {
        const classPath = path.join(workRoot, 'scripts', `${className}.as`);
        if (!fs.existsSync(classPath)) throw new Error(`FFDec export did not produce ${classPath}`);
        paths[className] = classPath;
    }
    return paths;
}

/**
 * Edits are skipped one at a time rather than the file at a time. A whole-file sentinel would
 * mean that the moment one pass lands, no later pass can add anything -- which is exactly the
 * trap this hit when the second pass came along.
 */
function patchSource(source, className, edits, swfPath) {
    let next = source.replace(/\r\n/g, '\n');
    const name = path.basename(swfPath);

    for (const edit of edits) {
        const alreadyApplied = edit.marker
            ? next.includes(edit.marker)
            : !next.includes(edit.anchor);
        if (alreadyApplied) continue;

        const occurrences = next.split(edit.anchor).length - 1;
        if (occurrences !== 1) {
            throw new Error(
                `${name}: ${className} does not open the way this patch expects -- ` +
                `"${edit.name}" matched its anchor ${occurrences} times, expected exactly 1.`
            );
        }
        next = next.replace(edit.anchor, edit.replacement);
    }

    return next;
}

function verifySource(source, className, swfPath) {
    const text = source.replace(/\r\n/g, '\n');
    const name = path.basename(swfPath);
    for (const snippet of REQUIRED[className]) {
        if (!text.includes(snippet)) {
            throw new Error(`${name} is missing a Templar talent effect in ${className}: ${snippet}`);
        }
    }
    for (const snippet of FORBIDDEN[className]) {
        if (text.includes(snippet)) {
            throw new Error(`${name} still carries Dominate's old critical-chance clause: ${snippet}`);
        }
    }
}

function main() {
    const root = repoRoot();
    const args = parseArgs(process.argv);
    const swfPath = resolvePath(root, args.swf);
    const ffdecPath = detectFfdec(root, args.ffdec);

    if (!ffdecPath) throw new Error('FFDec not found. Pass --ffdec or install JPEXS FFDec.');
    if (!fs.existsSync(swfPath)) throw new Error(`SWF not found: ${swfPath}`);

    const workRoot = path.join(root, 'build', args.verify ? 'ffdec-templar-talents-verify' : 'ffdec-templar-talents');
    const classPaths = exportClasses(ffdecPath, workRoot, swfPath);

    if (args.verify) {
        for (const { className } of CLASSES) {
            verifySource(fs.readFileSync(classPaths[className], 'utf8'), className, swfPath);
        }
        console.log(`Verified Templar talent effects in ${swfPath}`);
        return;
    }

    for (const { className, edits } of CLASSES) {
        const source = fs.readFileSync(classPaths[className], 'utf8');
        fs.writeFileSync(classPaths[className], patchSource(source, className, edits, swfPath));
    }

    const patchedSwfPath = path.join(workRoot, `${path.basename(swfPath, path.extname(swfPath))}.patched.swf`);
    runFfdec(ffdecPath, ['-importScript', swfPath, patchedSwfPath, path.join(workRoot, 'scripts')]);
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
