#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/**
 * Adds Shadowstalker behavior that power XML cannot express: Expertise damage against
 * Bound targets and owner-rank skill inheritance for Shadow Legion clones.
 * CombatState.method_1393 already owns conditional flat-stat damage. _loc5_.var_1033 is
 * the target's cached Bound stack count, _loc7_ is flat damage, and magicDamage is the
 * caster's Expertise-derived stat.
 */

const TARGET_SWF = path.join('src', 'client', 'content', 'localhost', 'p', 'cbp', 'DungeonBlitz.swf');
const OLD_MARKER = 'if(this.var_414 && (param2.basePowerName == "CrippleStrike" || param2.basePowerName == "WhitheringMist"))';
const LEGACY_BOUND_MARKER = 'param2.basePowerName == "CrippleStrike" ? 0.6 : 0.4';
const MARKER = 'param2.basePowerName == "CrippleStrike" ? 0.7 : 0.3';
const CLONE_RANK_MARKER = '"FalseSaberMelee","FalseSaberMelee","FalseSaberMelee"';
const CLONE_ROTATION_MARKER = 'var _shadowLegionCompletedPower:PowerType = this.var_3.hudPowers.shift()';
const OLD_CLONE_GATE_CHECK = '(param1.powerName.indexOf("FalseChi") == 0 || param1.powerName.indexOf("FalseTendrilDash") == 0 || param1.powerName.indexOf("FalseScorpionSting") == 0)';
const CLONE_GATE_CHECK = '(param1.powerName.indexOf("FalseSaberMelee") == 0 || param1.powerName.indexOf("FalseChi") == 0 || param1.powerName.indexOf("FalseTendrilDash") == 0 || param1.powerName.indexOf("FalseScorpionSting") == 0)';
const SAFE_DARK_CHI_RANK_CHECK = 'if(_loc54_ && _loc54_.basePowerName == "DarkChi")';
const UNSAFE_DARK_CHI_RANK_CHECK = 'if(_loc54_.basePowerName == "DarkChi")';
const UNSAFE_TENDRIL_RANK_CHECK = 'else if(_loc54_.basePowerName == "ShadowTendrilDash")';
const ANCHOR = [
    '         if(this.var_1644)',
    '         {',
    '            if(_loc5_.var_683 || _loc5_.var_2291 || _loc5_.var_495 < 0)',
    '            {',
    '               _loc6_ += this.var_1644;',
    '            }',
    '         }',
    '         _loc6_ += _loc7_ / param1;'
].join('\n');
const OLD_REPLACEMENT = [
    '         if(this.var_1644)',
    '         {',
    '            if(_loc5_.var_683 || _loc5_.var_2291 || _loc5_.var_495 < 0)',
    '            {',
    '               _loc6_ += this.var_1644;',
    '            }',
    '         }',
    '         if(this.var_414 && (param2.basePowerName == "CrippleStrike" || param2.basePowerName == "WhitheringMist"))',
    '         {',
    '            _loc7_ += (param2.basePowerName == "CrippleStrike" ? 0.6 : 0.4) * this.var_3.magicDamage;',
    '         }',
    '         _loc6_ += _loc7_ / param1;'
].join('\n');
const LEGACY_BOUND_REPLACEMENT = [
    '         if(this.var_1644)',
    '         {',
    '            if(_loc5_.var_683 || _loc5_.var_2291 || _loc5_.var_495 < 0)',
    '            {',
    '               _loc6_ += this.var_1644;',
    '            }',
    '         }',
    '         if(_loc5_.var_1033 && ((param2.basePowerName == "CrippleStrike" && param2.var_7 >= 2) || (param2.basePowerName == "WhitheringMist" && param2.var_7 >= 3)))',
    '         {',
    '            _loc7_ += (param2.basePowerName == "CrippleStrike" ? 0.6 : 0.4) * this.var_3.magicDamage;',
    '         }',
    '         _loc6_ += _loc7_ / param1;'
].join('\n');
const LEGACY_BOUND_DECOMPILED_REPLACEMENT = LEGACY_BOUND_REPLACEMENT.replace(
    'if(_loc5_.var_1033 && ((param2.basePowerName == "CrippleStrike" && param2.var_7 >= 2) || (param2.basePowerName == "WhitheringMist" && param2.var_7 >= 3)))',
    'if(_loc5_.var_1033 && (param2.basePowerName == "CrippleStrike" && param2.var_7 >= 2 || param2.basePowerName == "WhitheringMist" && param2.var_7 >= 3))'
);
const REPLACEMENT = [
    '         if(this.var_1644)',
    '         {',
    '            if(_loc5_.var_683 || _loc5_.var_2291 || _loc5_.var_495 < 0)',
    '            {',
    '               _loc6_ += this.var_1644;',
    '            }',
    '         }',
    '         if(_loc5_.var_1033 && ((param2.basePowerName == "CrippleStrike" && param2.var_7 >= 2) || (param2.basePowerName == "WhitheringMist" && param2.var_7 >= 3)))',
    '         {',
    '            _loc7_ += (param2.basePowerName == "CrippleStrike" ? 0.7 : 0.3) * this.var_3.magicDamage;',
    '         }',
    '         _loc6_ += _loc7_ / param1;'
].join('\n');
const CLONE_LOCALS_ANCHOR = '         var _loc53_:BuffType = null;';
const CLONE_LOCALS_REPLACEMENT = [
    '         var _loc53_:BuffType = null;',
    '         var _loc54_:PowerType = null;',
    '         var _loc55_:int = 0;',
    '         var _loc56_:int = 0;',
    '         var _loc57_:int = 0;'
].join('\n');
const CLONE_SPAWN_ANCHOR = [
    '                     _loc48_.ResetEntType(_loc48_.entType);',
    '                     _loc48_.bLeft = this.mActivePower.var_188;'
].join('\n');
const LEGACY_CLONE_SPAWN_REPLACEMENT = [
    '                     _loc48_.ResetEntType(_loc48_.entType);',
    '                     _loc55_ = 0;',
    '                     _loc56_ = 0;',
    '                     for each(_loc54_ in this.var_3.hudPowers)',
    '                     {',
    '                        if(_loc54_ && _loc54_.basePowerName == "DarkChi")',
    '                        {',
    '                           _loc55_ = _loc54_.var_7;',
    '                        }',
    '                        else if(_loc54_ && _loc54_.basePowerName == "ShadowTendrilDash")',
    '                        {',
    '                           _loc56_ = _loc54_.var_7;',
    '                        }',
    '                     }',
    '                     if(_loc39_)',
    '                     {',
    '                        _loc48_.method_822(["FalseTendrilDash" + (_loc56_ > 0 ? String(_loc56_) : "")]);',
    '                     }',
    '                     else',
    '                     {',
    '                        _loc48_.method_822(["FalseChi" + (_loc55_ > 0 ? String(_loc55_) : "")]);',
    '                     }',
    '                     _loc48_.bLeft = this.mActivePower.var_188;'
].join('\n');
const THREE_SKILL_CLONE_SPAWN_REPLACEMENT = [
    '                     _loc48_.ResetEntType(_loc48_.entType);',
    '                     _loc55_ = 0;',
    '                     _loc56_ = 0;',
    '                     _loc57_ = 0;',
    '                     for each(_loc54_ in this.var_3.hudPowers)',
    '                     {',
    '                        if(_loc54_ && _loc54_.basePowerName == "DarkChi")',
    '                        {',
    '                           _loc55_ = _loc54_.var_7;',
    '                        }',
    '                        else if(_loc54_ && _loc54_.basePowerName == "ShadowTendrilDash")',
    '                        {',
    '                           _loc56_ = _loc54_.var_7;',
    '                        }',
    '                        else if(_loc54_ && _loc54_.basePowerName == "CrippleStrike")',
    '                        {',
    '                           _loc57_ = _loc54_.var_7;',
    '                        }',
    '                     }',
    '                     if(_loc39_)',
    '                     {',
    '                        _loc48_.method_822(["FalseTendrilDash" + (_loc56_ > 0 ? String(_loc56_) : ""),"FalseChi" + (_loc55_ > 0 ? String(_loc55_) : ""),"FalseScorpionSting" + (_loc57_ > 0 ? String(_loc57_) : "")]);',
    '                     }',
    '                     else if(_loc33_.indexOf("ShadowLegionCloneThree") == 0)',
    '                     {',
    '                        _loc48_.method_822(["FalseChi" + (_loc55_ > 0 ? String(_loc55_) : ""),"FalseScorpionSting" + (_loc57_ > 0 ? String(_loc57_) : ""),"FalseTendrilDash" + (_loc56_ > 0 ? String(_loc56_) : "")]);',
    '                     }',
    '                     else',
    '                     {',
    '                        _loc48_.method_822(["FalseScorpionSting" + (_loc57_ > 0 ? String(_loc57_) : ""),"FalseTendrilDash" + (_loc56_ > 0 ? String(_loc56_) : ""),"FalseChi" + (_loc55_ > 0 ? String(_loc55_) : "")]);',
    '                     }',
    '                     _loc48_.bLeft = this.mActivePower.var_188;'
].join('\n');
const CLONE_SPAWN_REPLACEMENT = [
    '                     _loc48_.ResetEntType(_loc48_.entType);',
    '                     _loc55_ = 0;',
    '                     _loc56_ = 0;',
    '                     _loc57_ = 0;',
    '                     for each(_loc54_ in this.var_3.hudPowers)',
    '                     {',
    '                        if(_loc54_ && _loc54_.basePowerName == "DarkChi")',
    '                        {',
    '                           _loc55_ = _loc54_.var_7;',
    '                        }',
    '                        else if(_loc54_ && _loc54_.basePowerName == "ShadowTendrilDash")',
    '                        {',
    '                           _loc56_ = _loc54_.var_7;',
    '                        }',
    '                        else if(_loc54_ && _loc54_.basePowerName == "CrippleStrike")',
    '                        {',
    '                           _loc57_ = _loc54_.var_7;',
    '                        }',
    '                     }',
    '                     if(_loc39_)',
    '                     {',
    '                        _loc48_.method_822(["FalseTendrilDash" + (_loc56_ > 0 ? String(_loc56_) : ""),"FalseSaberMelee","FalseSaberMelee","FalseSaberMelee","FalseChi" + (_loc55_ > 0 ? String(_loc55_) : ""),"FalseSaberMelee","FalseSaberMelee","FalseSaberMelee","FalseScorpionSting" + (_loc57_ > 0 ? String(_loc57_) : ""),"FalseSaberMelee","FalseSaberMelee","FalseSaberMelee"]);',
    '                     }',
    '                     else if(_loc33_.indexOf("ShadowLegionCloneThree") == 0)',
    '                     {',
    '                        _loc48_.method_822(["FalseChi" + (_loc55_ > 0 ? String(_loc55_) : ""),"FalseSaberMelee","FalseSaberMelee","FalseSaberMelee","FalseScorpionSting" + (_loc57_ > 0 ? String(_loc57_) : ""),"FalseSaberMelee","FalseSaberMelee","FalseSaberMelee","FalseTendrilDash" + (_loc56_ > 0 ? String(_loc56_) : ""),"FalseSaberMelee","FalseSaberMelee","FalseSaberMelee"]);',
    '                     }',
    '                     else',
    '                     {',
    '                        _loc48_.method_822(["FalseScorpionSting" + (_loc57_ > 0 ? String(_loc57_) : ""),"FalseSaberMelee","FalseSaberMelee","FalseSaberMelee","FalseTendrilDash" + (_loc56_ > 0 ? String(_loc56_) : ""),"FalseSaberMelee","FalseSaberMelee","FalseSaberMelee","FalseChi" + (_loc55_ > 0 ? String(_loc55_) : ""),"FalseSaberMelee","FalseSaberMelee","FalseSaberMelee"]);',
    '                     }',
    '                     _loc48_.bLeft = this.mActivePower.var_188;'
].join('\n');
const CLONE_ROTATION_ANCHOR = [
    '         this.var_114[param1.powerID] = _loc5_ + param1.coolDownTime + _loc11_;',
    '         if(param1.basePowerName == "SentinelForm")'
].join('\n');
const CLONE_ROTATION_REPLACEMENT = [
    '         this.var_114[param1.powerID] = _loc5_ + param1.coolDownTime + _loc11_;',
    '         if(this.var_3.entType.entName.indexOf("ShadowLegionClone") == 0 && this.var_3.hudPowers.length > 1 && this.var_3.hudPowers[0] == param1)',
    '         {',
    '            var _shadowLegionCompletedPower:PowerType = this.var_3.hudPowers.shift();',
    '            this.var_3.hudPowers.push(_shadowLegionCompletedPower);',
    '         }',
    '         if(param1.basePowerName == "SentinelForm")'
].join('\n');
const CLONE_GATE_ANCHOR = [
    '         var _loc4_:uint = this.var_1.mTimeThisTick;',
    '         if(_loc4_ < this.var_114[param1.powerID])'
].join('\n');
const CLONE_GATE_REPLACEMENT = [
    '         var _loc4_:uint = this.var_1.mTimeThisTick;',
    `         if(this.var_3.entType.entName.indexOf("ShadowLegionClone") == 0 && this.var_3.hudPowers.length > 1 && ${CLONE_GATE_CHECK} && param1 != this.var_3.hudPowers[0])`,
    '         {',
    '            return false;',
    '         }',
    '         if(_loc4_ < this.var_114[param1.powerID])'
].join('\n');

function parseArgs(argv) {
    const args = { ffdec: '', swf: TARGET_SWF, verify: false };
    for (let i = 2; i < argv.length; i += 1) {
        if (argv[i] === '--ffdec') args.ffdec = argv[++i] || '';
        else if (argv[i] === '--swf') args.swf = argv[++i] || '';
        else if (argv[i] === '--verify' || argv[i] === '--dry-run') args.verify = true;
        else throw new Error(`Unknown argument: ${argv[i]}`);
    }
    return args;
}

function root() { return path.resolve(__dirname, '..', '..', '..'); }
function absolute(base, value) { return path.isAbsolute(value) ? value : path.join(base, value); }

function detectFfdec(base, preferred) {
    return [
        preferred && absolute(base, preferred),
        path.join(base, 'build', 'ffdec', 'ffdec.jar'),
        path.join(base, 'build', 'ffdec', 'ffdec-cli.exe'),
        'C:\\Program Files (x86)\\FFDec\\ffdec-cli.exe',
        'C:\\Program Files\\FFDec\\ffdec-cli.exe'
    ].find((candidate) => candidate && fs.existsSync(candidate)) || '';
}

function detectJava(base) {
    const bundled = path.join(base, 'build', 'jre');
    if (fs.existsSync(bundled)) {
        const candidates = fs.readdirSync(bundled).map((name) => path.join(bundled, name, 'bin', 'java.exe'));
        const found = candidates.find(fs.existsSync);
        if (found) return found;
    }
    return 'java';
}

function runFfdec(base, ffdec, args) {
    if (ffdec.toLowerCase().endsWith('.jar')) {
        execFileSync(detectJava(base), ['-jar', ffdec, '-cli', ...args], { stdio: 'inherit' });
    } else {
        execFileSync(ffdec, args, { stdio: 'inherit' });
    }
}

function main() {
    const base = root();
    const args = parseArgs(process.argv);
    const swf = absolute(base, args.swf);
    const ffdec = detectFfdec(base, args.ffdec);
    if (!ffdec) throw new Error('FFDec not found. Pass --ffdec or install JPEXS FFDec.');
    if (!fs.existsSync(swf)) throw new Error(`SWF not found: ${swf}`);

    const work = path.join(base, 'build', args.verify ? 'ffdec-shadowstalker-expertise-verify' : 'ffdec-shadowstalker-expertise');
    fs.rmSync(work, { recursive: true, force: true });
    fs.mkdirSync(work, { recursive: true });
    runFfdec(base, ffdec, ['-selectclass', 'CombatState', '-export', 'script', work, swf]);

    const sourcePath = path.join(work, 'scripts', 'CombatState.as');
    let source = fs.readFileSync(sourcePath, 'utf8').replace(/\r\n/g, '\n');
    if (args.verify) {
        if (!source.includes(MARKER)) throw new Error('DungeonBlitz.swf is missing the Shadowstalker Bound-target Expertise bonus.');
        if (source.includes(OLD_MARKER)) throw new Error('DungeonBlitz.swf still contains the old stealth-only Expertise bonus.');
        if (source.includes(LEGACY_BOUND_MARKER)) throw new Error('DungeonBlitz.swf still contains the old Bound-target Expertise values.');
        if (!source.includes(CLONE_RANK_MARKER)) throw new Error('DungeonBlitz.swf is missing Shadow Legion owner-rank skill inheritance.');
        if (!source.includes(CLONE_ROTATION_MARKER)) throw new Error('DungeonBlitz.swf is missing deterministic Shadow Legion skill rotation.');
        console.log(`Verified Shadowstalker runtime balance changes in ${swf}`);
        return;
    }

    let changed = false;

    if (source.includes(UNSAFE_DARK_CHI_RANK_CHECK) || source.includes(UNSAFE_TENDRIL_RANK_CHECK)) {
        source = source
            .replace(UNSAFE_DARK_CHI_RANK_CHECK, SAFE_DARK_CHI_RANK_CHECK)
            .replace(UNSAFE_TENDRIL_RANK_CHECK, 'else if(_loc54_ && _loc54_.basePowerName == "ShadowTendrilDash")');
        changed = true;
    }

    if (source.includes(LEGACY_CLONE_SPAWN_REPLACEMENT)) {
        source = source.replace(LEGACY_CLONE_SPAWN_REPLACEMENT, CLONE_SPAWN_REPLACEMENT);
        source = source.replace(
            '         var _loc56_:int = 0;',
            '         var _loc56_:int = 0;\n         var _loc57_:int = 0;'
        );
        changed = true;
    }

    if (source.includes(THREE_SKILL_CLONE_SPAWN_REPLACEMENT)) {
        source = source.replace(THREE_SKILL_CLONE_SPAWN_REPLACEMENT, CLONE_SPAWN_REPLACEMENT);
        changed = true;
    }

    if (source.includes(OLD_CLONE_GATE_CHECK)) {
        source = source.replace(OLD_CLONE_GATE_CHECK, CLONE_GATE_CHECK);
        changed = true;
    }

    if (!source.includes(CLONE_ROTATION_MARKER)) {
        const rotationCount = source.split(CLONE_ROTATION_ANCHOR).length - 1;
        const gateCount = source.split(CLONE_GATE_ANCHOR).length - 1;
        if (rotationCount !== 1) throw new Error(`CombatState clone rotation anchor matched ${rotationCount} times, expected 1.`);
        if (gateCount !== 1) throw new Error(`CombatState clone gate anchor matched ${gateCount} times, expected 1.`);
        source = source.replace(CLONE_ROTATION_ANCHOR, CLONE_ROTATION_REPLACEMENT);
        source = source.replace(CLONE_GATE_ANCHOR, CLONE_GATE_REPLACEMENT);
        changed = true;
    }

    if (source.includes(LEGACY_BOUND_DECOMPILED_REPLACEMENT)) {
        source = source.replace(LEGACY_BOUND_DECOMPILED_REPLACEMENT, REPLACEMENT);
        changed = true;
    } else if (source.includes(LEGACY_BOUND_REPLACEMENT)) {
        source = source.replace(LEGACY_BOUND_REPLACEMENT, REPLACEMENT);
        changed = true;
    } else if (source.includes(OLD_REPLACEMENT)) {
        source = source.replace(OLD_REPLACEMENT, REPLACEMENT);
        changed = true;
    } else if (!source.includes(MARKER)) {
        const count = source.split(ANCHOR).length - 1;
        if (count !== 1) throw new Error(`CombatState anchor matched ${count} times, expected 1.`);
        source = source.replace(ANCHOR, REPLACEMENT);
        changed = true;
    }
    if (!source.includes(CLONE_RANK_MARKER)) {
        const localsCount = source.split(CLONE_LOCALS_ANCHOR).length - 1;
        const spawnCount = source.split(CLONE_SPAWN_ANCHOR).length - 1;
        if (localsCount !== 1) throw new Error(`CombatState clone locals anchor matched ${localsCount} times, expected 1.`);
        if (spawnCount !== 1) throw new Error(`CombatState clone spawn anchor matched ${spawnCount} times, expected 1.`);
        source = source.replace(CLONE_LOCALS_ANCHOR, CLONE_LOCALS_REPLACEMENT);
        source = source.replace(CLONE_SPAWN_ANCHOR, CLONE_SPAWN_REPLACEMENT);
        changed = true;
    }
    if (!changed) {
        console.log(`Shadowstalker runtime balance changes already present in ${swf}`);
        return;
    }
    fs.writeFileSync(sourcePath, source);
    const output = path.join(work, 'DungeonBlitz.patched.swf');
    runFfdec(base, ffdec, ['-importScript', swf, output, path.join(work, 'scripts')]);
    if (!fs.existsSync(`${swf}.bak`)) fs.copyFileSync(swf, `${swf}.bak`);
    fs.copyFileSync(output, swf);
    console.log(`Patched Shadowstalker runtime balance changes in ${swf}`);
    console.log('NOTE: CombatState was recompiled; re-run the forge charm duration byte patch.');
}

main();
