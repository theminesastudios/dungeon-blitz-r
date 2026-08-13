#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

/**
 * Adds Rogue behavior that power XML cannot express: conditional Black Miasma and Bleed
 * damage, retuned Expertise damage against Bound targets, and owner-rank skill inheritance
 * for Shadow Legion clones.
 * CombatState.method_1393 already owns conditional flat-stat damage. _loc5_.var_1033 is
 * the target's cached Bound stack count, _loc7_ is flat damage, and magicDamage is the
 * caster's Expertise-derived stat.
 */

const TARGET_SWF = path.join('src', 'client', 'content', 'localhost', 'p', 'cbp', 'DungeonBlitz.swf');
const INDEX_HTML = path.join('src', 'client', 'content', 'localhost', 'index.html');
const OLD_MARKER = 'if(this.var_414 && (param2.basePowerName == "CrippleStrike" || param2.basePowerName == "WhitheringMist"))';
const LEGACY_BOUND_MARKER = 'param2.basePowerName == "CrippleStrike" ? 0.6 : 0.4';
const LEGACY_BLACK_MIASMA_MARKER = 'param2.basePowerName == "BlackStorm" ? 1.6 : 0.8';
const MARKER = 'param2.basePowerName == "BlackStorm" ? 0.9 : 0.4';
const VICIOUS_ASSAULT_MARKER = 'param2.var_7 >= 10 ? 0.02 : (param2.var_7 >= 7 ? 0.015 : 0.01)';
const CLONE_SCORPION_MARKER = 'param2.basePowerName == "CrippleStrike" || param2.basePowerName == "FalseScorpionSting"';
const CLONE_DARK_CHI_DAZE_MARKER = 'param1.basePowerName == "DarkChi" || param1.basePowerName == "FalseChi"';
const CLONE_DARK_CHI_PROJECTILE_MARKER = 'else if(this.powerType.basePowerName == "DarkChi" || this.powerType.basePowerName == "FalseChi")';
const CLONE_MIASMA_MARKER = 'this.powerType.basePowerName == "ShadowTendrilDash" || this.powerType.basePowerName == "FalseTendrilDash"';
const METHOD_1507_GUARD_MARKER = 'if(this.var_4)\n            {\n               this.var_4.var_997 = false;';
const METHOD_243_GUARD_MARKER = 'this.method_129();\n            return false;';
const EXPERTISE_MARKER = '_loc28_ = 2.25;';
const BLACK_MIASMA_FIELD = 'internal var _blackMiasma:Boolean = false;';
const BLEED_STACKS_FIELD = 'internal var _bleedStacks:int = 0;';
const CLONE_RANK_MARKER = '"FalseSaberMelee","FalseSaberMelee","FalseSaberMelee"';
const CLONE_ROTATION_MARKER = 'var _shadowLegionCompletedPower:PowerType = this.var_3.hudPowers.shift()';
const SAFE_CLONE_SKILL_MARKER = '_loc56_ > 0 ? "FalseTendrilDash" + String(_loc56_) : "FalseSaberMelee"';
const UNEQUIPPED_CLONE_SKILL_MARKER = '                     _loc55_ = param1.var_7;\n                     _loc56_ = param1.var_7;\n                     _loc57_ = param1.var_7;';
const EQUIPPED_ONLY_RANK_INIT = '                     _loc55_ = 0;\n                     _loc56_ = 0;\n                     _loc57_ = 0;';
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
const PREVIOUS_REPLACEMENT = [
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
const PREVIOUS_RUNTIME_REPLACEMENT = PREVIOUS_REPLACEMENT.replace(
    '         _loc6_ += _loc7_ / param1;',
    [
        '         if(_loc5_._blackMiasma && (param2.basePowerName == "HeartSeeker" || param2.basePowerName == "BlackStorm"))',
        '         {',
        '            _loc6_ += param2.basePowerName == "BlackStorm" ? 0.8 : 0.4;',
        '         }',
        '         if(param2.basePowerName == "AssassinateClose" && param2.var_7 >= 3 && _loc5_._bleedStacks > 0)',
        '         {',
        '            _loc6_ += (param2.var_7 >= 7 ? 0.015 : 0.01) * _loc5_._bleedStacks;',
        '         }',
        '         _loc6_ += _loc7_ / param1;'
    ].join('\n')
);
const REPLACEMENT = PREVIOUS_RUNTIME_REPLACEMENT
    .replace('param2.basePowerName == "BlackStorm" ? 0.8 : 0.4', 'param2.basePowerName == "BlackStorm" ? 0.9 : 0.4')
    .replace('param2.var_7 >= 7 ? 0.015 : 0.01', 'param2.var_7 >= 10 ? 0.02 : param2.var_7 >= 7 ? 0.015 : 0.01')
    .replace('param2.basePowerName == "CrippleStrike" && param2.var_7 >= 2', '(param2.basePowerName == "CrippleStrike" || param2.basePowerName == "FalseScorpionSting") && param2.var_7 >= 2')
    .replace('param2.basePowerName == "CrippleStrike" ? 0.7 : 0.3', 'param2.basePowerName == "CrippleStrike" || param2.basePowerName == "FalseScorpionSting" ? 0.7 : 0.3');
const PREVIOUS_RUNTIME_DECOMPILED_REPLACEMENT = PREVIOUS_RUNTIME_REPLACEMENT.replace(
    'if(_loc5_.var_1033 && ((param2.basePowerName == "CrippleStrike" && param2.var_7 >= 2) || (param2.basePowerName == "WhitheringMist" && param2.var_7 >= 3)))',
    'if(_loc5_.var_1033 && (param2.basePowerName == "CrippleStrike" && param2.var_7 >= 2 || param2.basePowerName == "WhitheringMist" && param2.var_7 >= 3))'
);
const PREVIOUS_DECOMPILED_REPLACEMENT = PREVIOUS_REPLACEMENT.replace(
    'if(_loc5_.var_1033 && ((param2.basePowerName == "CrippleStrike" && param2.var_7 >= 2) || (param2.basePowerName == "WhitheringMist" && param2.var_7 >= 3)))',
    'if(_loc5_.var_1033 && (param2.basePowerName == "CrippleStrike" && param2.var_7 >= 2 || param2.basePowerName == "WhitheringMist" && param2.var_7 >= 3))'
);

const STATE_FIELDS_ANCHOR = '      internal var var_1033:int = 0;';
const STATE_FIELDS_REPLACEMENT = [STATE_FIELDS_ANCHOR, `      ${BLACK_MIASMA_FIELD}`, `      ${BLEED_STACKS_FIELD}`].join('\n      \n');
const STATE_RESET_ANCHOR = '         this.var_1033 = 0;';
const STATE_RESET_REPLACEMENT = [STATE_RESET_ANCHOR, '         this._blackMiasma = false;', '         this._bleedStacks = 0;'].join('\n');
const BUFF_SWITCH_ANCHOR = [
    '                  case "Bound":',
    '                     this.var_1033 = _loc31_;',
    '                     break;'
].join('\n');
const BUFF_SWITCH_REPLACEMENT = [
    BUFF_SWITCH_ANCHOR,
    '                  case "Bleeding":',
    '                     this._bleedStacks = _loc31_;',
    '                     break;',
    '                  case "ShadowTendrilDamage":',
    '                  case "ShadowTendrilRank1":',
    '                  case "ShadowTendrilRank4":',
    '                  case "ShadowTendrilRank6":',
    '                  case "ShadowTendrilRank8":',
    '                  case "ShadowTendrilRank10":',
    '                     this._blackMiasma = true;',
    '                     break;'
].join('\n');
const OLD_SOULTHIEF_EXPERTISE = [
    '         if(param2.basePowerName == "Reaper" && Boolean(_loc5_.var_1033))',
    '         {',
    '            _loc27_ = 0;',
    '            if(param2.var_7 >= 10)',
    '            {',
    '               _loc27_ = 0.2;',
    '            }',
    '            else if(param2.var_7 >= 9)',
    '            {',
    '               _loc27_ = 0.15;',
    '            }',
    '            else if(param2.var_7 >= 7)',
    '            {',
    '               _loc27_ = 0.1;',
    '            }',
    '            else if(param2.var_7 >= 5)',
    '            {',
    '               _loc27_ = 0.05;',
    '            }',
    '            else',
    '            {',
    '               _loc27_ = 0.02;',
    '            }',
    '            _loc6_ += _loc27_;',
    '         }',
    '         if(param2.basePowerName == "PainBender" && Boolean(_loc5_.var_1033))',
    '         {',
    '            _loc28_ = 0;',
    '            if(param2.var_7 >= 10)',
    '            {',
    '               _loc28_ = 0.75;',
    '            }',
    '            else if(param2.var_7 >= 9)',
    '            {',
    '               _loc28_ = 0.6;',
    '            }',
    '            else if(param2.var_7 >= 7)',
    '            {',
    '               _loc28_ = 0.45;',
    '            }',
    '            else if(param2.var_7 >= 4)',
    '            {',
    '               _loc28_ = 0.3;',
    '            }',
    '            else',
    '            {',
    '               _loc28_ = 0.15;',
    '            }',
    '            _loc6_ += _loc28_;',
    '         }'
].join('\n');
const SOULTHIEF_EXPERTISE = OLD_SOULTHIEF_EXPERTISE
    .replaceAll('_loc27_ = 0.2;', '_loc27_ = 1.2;')
    .replaceAll('_loc27_ = 0.15;', '_loc27_ = 0.9;')
    .replaceAll('_loc27_ = 0.1;', '_loc27_ = 0.6;')
    .replaceAll('_loc27_ = 0.05;', '_loc27_ = 0.3;')
    .replaceAll('_loc27_ = 0.02;', '_loc27_ = 0.12;')
    .replaceAll('_loc28_ = 0.75;', '_loc28_ = 2.25;')
    .replaceAll('_loc28_ = 0.6;', '_loc28_ = 1.8;')
    .replaceAll('_loc28_ = 0.45;', '_loc28_ = 1.35;')
    .replaceAll('_loc28_ = 0.3;', '_loc28_ = 0.9;')
    .replaceAll('_loc28_ = 0.15;', '_loc28_ = 0.45;');
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
const UNSAFE_RANK_ZERO_CLONE_SPAWN_REPLACEMENT = [
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
const EQUIPPED_ONLY_CLONE_SPAWN_REPLACEMENT = UNSAFE_RANK_ZERO_CLONE_SPAWN_REPLACEMENT
    .replaceAll('"FalseTendrilDash" + (_loc56_ > 0 ? String(_loc56_) : "")', '(_loc56_ > 0 ? "FalseTendrilDash" + String(_loc56_) : "FalseSaberMelee")')
    .replaceAll('"FalseChi" + (_loc55_ > 0 ? String(_loc55_) : "")', '(_loc55_ > 0 ? "FalseChi" + String(_loc55_) : "FalseSaberMelee")')
    .replaceAll('"FalseScorpionSting" + (_loc57_ > 0 ? String(_loc57_) : "")', '(_loc57_ > 0 ? "FalseScorpionSting" + String(_loc57_) : "FalseSaberMelee")');
const CLONE_SPAWN_REPLACEMENT = EQUIPPED_ONLY_CLONE_SPAWN_REPLACEMENT;
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

function syncClientRevision(base, swf, verifyOnly) {
    if (verifyOnly) return;
    const servedSwf = absolute(base, TARGET_SWF);
    if (path.resolve(swf) !== path.resolve(servedSwf)) return;
    const indexPath = path.join(base, INDEX_HTML);
    const digest = crypto.createHash('sha1').update(fs.readFileSync(swf)).digest('hex').slice(0, 12);
    const expected = `clientrev=swf-${digest}`;
    const html = fs.readFileSync(indexPath, 'utf8');
    if (html.includes(expected)) return;
    const updated = html.replace(/clientrev=[^&`"'$]+/, expected);
    if (updated === html) throw new Error('index.html clientrev token not found.');
    fs.writeFileSync(indexPath, updated, 'utf8');
    console.log(`  index.html clientrev -> swf-${digest} (cache buster)`);
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
    runFfdec(base, ffdec, ['-selectclass', 'ActivePower', '-export', 'script', work, swf]);

    const sourcePath = path.join(work, 'scripts', 'CombatState.as');
    const activePowerPath = path.join(work, 'scripts', 'ActivePower.as');
    let source = fs.readFileSync(sourcePath, 'utf8').replace(/\r\n/g, '\n');
    let activePowerSource = fs.readFileSync(activePowerPath, 'utf8').replace(/\r\n/g, '\n');
    let activePowerChanged = false;
    if (args.verify) {
        if (!source.includes(MARKER)) throw new Error('DungeonBlitz.swf is missing the Black Miasma conditional damage bonuses.');
        if (!source.includes(VICIOUS_ASSAULT_MARKER)) throw new Error('DungeonBlitz.swf is missing the rank 10 Vicious Assault Bleed multiplier.');
        if (!source.includes(EXPERTISE_MARKER)) throw new Error('DungeonBlitz.swf is missing the Soulthief Expertise multiplier increases.');
        if (!source.includes(BLACK_MIASMA_FIELD) || !source.includes(BLEED_STACKS_FIELD)) throw new Error('DungeonBlitz.swf is missing Rogue target-state tracking.');
        if (source.includes(OLD_MARKER)) throw new Error('DungeonBlitz.swf still contains the old stealth-only Expertise bonus.');
        if (source.includes(LEGACY_BOUND_MARKER)) throw new Error('DungeonBlitz.swf still contains the old Bound-target Expertise values.');
        if (!source.includes(CLONE_RANK_MARKER)) throw new Error('DungeonBlitz.swf is missing Shadow Legion owner-rank skill inheritance.');
        if (!source.includes(CLONE_ROTATION_MARKER)) throw new Error('DungeonBlitz.swf is missing deterministic Shadow Legion skill rotation.');
        if (!source.includes(SAFE_CLONE_SKILL_MARKER)) throw new Error('DungeonBlitz.swf still assigns unlearned rank-zero skills to Shadow Legion clones.');
        if (!source.includes(EQUIPPED_ONLY_RANK_INIT)) throw new Error('DungeonBlitz.swf does not gate Shadow Legion skills by the owner equipped powers.');
        if (source.includes(UNEQUIPPED_CLONE_SKILL_MARKER)) throw new Error('DungeonBlitz.swf still provides Shadow Legion skills when they are unequipped.');
        if (!source.includes(CLONE_SCORPION_MARKER)) throw new Error('DungeonBlitz.swf is missing clone Scorpion Sting conditional damage.');
        if (!source.includes(CLONE_DARK_CHI_DAZE_MARKER)) throw new Error('DungeonBlitz.swf is missing clone Dark Chi Daze behavior.');
        if (!activePowerSource.includes(CLONE_DARK_CHI_PROJECTILE_MARKER)) throw new Error('DungeonBlitz.swf is missing clone Dark Chi projectile behavior.');
        if (!activePowerSource.includes(CLONE_MIASMA_MARKER)) throw new Error('DungeonBlitz.swf is missing clone Black Miasma field behavior.');
        if (!activePowerSource.includes(METHOD_1507_GUARD_MARKER)) throw new Error('DungeonBlitz.swf is missing the ActivePower.method_1507 null guard.');
        if (!activePowerSource.includes(METHOD_243_GUARD_MARKER)) throw new Error('DungeonBlitz.swf is missing the ActivePower.method_243 null guard.');
        syncClientRevision(base, swf, true);
        console.log(`Verified Shadowstalker runtime balance changes in ${swf}`);
        return;
    }

    let changed = false;

    if (source.includes(UNEQUIPPED_CLONE_SKILL_MARKER) && source.includes(SAFE_CLONE_SKILL_MARKER)) {
        const rankInitCount = source.split(UNEQUIPPED_CLONE_SKILL_MARKER).length - 1;
        if (rankInitCount !== 1) throw new Error(`CombatState clone rank initialization matched ${rankInitCount} times, expected 1.`);
        source = source.replace(UNEQUIPPED_CLONE_SKILL_MARKER, EQUIPPED_ONLY_RANK_INIT);
        changed = true;
    }

    if (!source.includes(CLONE_DARK_CHI_DAZE_MARKER)) {
        source = source.replace(
            'param1.basePowerName == "DarkChi" && param1.var_7 >= 10',
            '(param1.basePowerName == "DarkChi" || param1.basePowerName == "FalseChi") && param1.var_7 >= 10'
        );
        changed = true;
    }
    if (!source.includes(CLONE_SCORPION_MARKER)) {
        source = source
            .replace(
                'param2.basePowerName == "CrippleStrike" && param2.var_7 >= 2',
                '(param2.basePowerName == "CrippleStrike" || param2.basePowerName == "FalseScorpionSting") && param2.var_7 >= 2'
            )
            .replace(
                'param2.basePowerName == "CrippleStrike" ? 0.7 : 0.3',
                'param2.basePowerName == "CrippleStrike" || param2.basePowerName == "FalseScorpionSting" ? 0.7 : 0.3'
            );
        changed = true;
    }
    if (!activePowerSource.includes(CLONE_DARK_CHI_PROJECTILE_MARKER)) {
        activePowerSource = activePowerSource.replace(
            'else if(this.powerType.basePowerName == "DarkChi")',
            'else if(this.powerType.basePowerName == "DarkChi" || this.powerType.basePowerName == "FalseChi")'
        );
        activePowerChanged = true;
        changed = true;
    }
    if (!activePowerSource.includes(CLONE_MIASMA_MARKER)) {
        activePowerSource = activePowerSource.replace(
            'this.powerType.basePowerName == "ShadowTendrilDash"',
            '(this.powerType.basePowerName == "ShadowTendrilDash" || this.powerType.basePowerName == "FalseTendrilDash")'
        );
        activePowerChanged = true;
        changed = true;
    }
    if (!activePowerSource.includes(METHOD_1507_GUARD_MARKER)) {
        activePowerSource = activePowerSource.replace(
            '         catch(_loc_e_:*)\n         {\n            §§pop();\n            return;\n         }',
            '         catch(_loc_e_:*)\n         {\n            if(this.var_4)\n            {\n               this.var_4.var_997 = false;\n            }\n            return;\n         }'
        );
        activePowerChanged = true;
        changed = true;
    }
    if (!activePowerSource.includes(METHOD_243_GUARD_MARKER)) {
        activePowerSource = activePowerSource.replace(
            '         catch(_loc_e_:*)\n         {\n         }\n         return undefined;',
            '         catch(_loc_e_:*)\n         {\n            this.method_129();\n            return false;\n         }'
        );
        activePowerChanged = true;
        changed = true;
    }

    if (!source.includes(BLACK_MIASMA_FIELD)) {
        const fieldCount = source.split(STATE_FIELDS_ANCHOR).length - 1;
        const resetCount = source.split(STATE_RESET_ANCHOR).length - 1;
        const switchCount = source.split(BUFF_SWITCH_ANCHOR).length - 1;
        if (fieldCount !== 1) throw new Error(`CombatState state-field anchor matched ${fieldCount} times, expected 1.`);
        if (resetCount !== 1) throw new Error(`CombatState state-reset anchor matched ${resetCount} times, expected 1.`);
        if (switchCount !== 1) throw new Error(`CombatState buff-switch anchor matched ${switchCount} times, expected 1.`);
        source = source.replace(STATE_FIELDS_ANCHOR, STATE_FIELDS_REPLACEMENT);
        source = source.replace(STATE_RESET_ANCHOR, STATE_RESET_REPLACEMENT);
        source = source.replace(BUFF_SWITCH_ANCHOR, BUFF_SWITCH_REPLACEMENT);
        changed = true;
    }

    if (!source.includes(EXPERTISE_MARKER)) {
        const expertiseCount = source.split(OLD_SOULTHIEF_EXPERTISE).length - 1;
        if (expertiseCount !== 1) throw new Error(`CombatState Soulthief Expertise anchor matched ${expertiseCount} times, expected 1.`);
        source = source.replace(OLD_SOULTHIEF_EXPERTISE, SOULTHIEF_EXPERTISE);
        changed = true;
    }

    if (source.includes(UNSAFE_DARK_CHI_RANK_CHECK) || source.includes(UNSAFE_TENDRIL_RANK_CHECK)) {
        source = source
            .replace(UNSAFE_DARK_CHI_RANK_CHECK, SAFE_DARK_CHI_RANK_CHECK)
            .replace(UNSAFE_TENDRIL_RANK_CHECK, 'else if(_loc54_ && _loc54_.basePowerName == "ShadowTendrilDash")');
        changed = true;
    }

    if (source.includes(LEGACY_BLACK_MIASMA_MARKER)) {
        source = source.replace(LEGACY_BLACK_MIASMA_MARKER, MARKER);
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

    if (source.includes(UNSAFE_RANK_ZERO_CLONE_SPAWN_REPLACEMENT)) {
        source = source.replace(UNSAFE_RANK_ZERO_CLONE_SPAWN_REPLACEMENT, CLONE_SPAWN_REPLACEMENT);
        changed = true;
    } else if (source.includes(THREE_SKILL_CLONE_SPAWN_REPLACEMENT)) {
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

    if (source.includes(PREVIOUS_RUNTIME_DECOMPILED_REPLACEMENT)) {
        source = source.replace(PREVIOUS_RUNTIME_DECOMPILED_REPLACEMENT, REPLACEMENT);
        changed = true;
    } else if (source.includes(PREVIOUS_RUNTIME_REPLACEMENT)) {
        source = source.replace(PREVIOUS_RUNTIME_REPLACEMENT, REPLACEMENT);
        changed = true;
    } else if (source.includes(PREVIOUS_DECOMPILED_REPLACEMENT)) {
        source = source.replace(PREVIOUS_DECOMPILED_REPLACEMENT, REPLACEMENT);
        changed = true;
    } else if (source.includes(PREVIOUS_REPLACEMENT)) {
        source = source.replace(PREVIOUS_REPLACEMENT, REPLACEMENT);
        changed = true;
    } else if (source.includes(LEGACY_BOUND_DECOMPILED_REPLACEMENT)) {
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
        syncClientRevision(base, swf, false);
        console.log(`Shadowstalker runtime balance changes already present in ${swf}`);
        return;
    }
    fs.writeFileSync(sourcePath, source);
    if (activePowerChanged) fs.writeFileSync(activePowerPath, activePowerSource);
    else fs.rmSync(activePowerPath);
    const output = path.join(work, 'DungeonBlitz.patched.swf');
    runFfdec(base, ffdec, ['-importScript', swf, output, path.join(work, 'scripts')]);
    if (!fs.existsSync(`${swf}.bak`)) fs.copyFileSync(swf, `${swf}.bak`);
    fs.copyFileSync(output, swf);
    syncClientRevision(base, swf, false);
    console.log(`Patched Shadowstalker runtime balance changes in ${swf}`);
    console.log('NOTE: CombatState was recompiled; re-run the forge charm duration byte patch.');
}

main();
