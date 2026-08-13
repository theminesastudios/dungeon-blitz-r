#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const TARGET_SWF = path.join('src', 'client', 'content', 'localhost', 'p', 'cbp', 'DungeonBlitz.swf');
const INDEX_HTML = path.join('src', 'client', 'content', 'localhost', 'index.html');
const WORK_DIR = path.join('build', 'ffdec-talentstone-rework');

const WIND_CALL_OLD = '_loc30_ = param2.combatState.method_1552(param1);';
const WIND_CALL_NEW = '_loc30_ = param2.combatState.method_1552(this);';
const WIND_METHOD_OLD = [
    '      public function method_1552(param1:PowerType) : Number',
    '      {',
    '         var _loc2_:Number = NaN;',
    '         _loc2_ = 0;',
    '         if(param1.bIsProjectile && Boolean(this.var_1595))',
    '         {',
    '            _loc2_ += this.var_1595;',
    '         }',
    '         return _loc2_;',
    '      }'
].join('\n');
const WIND_METHOD_NEW = WIND_METHOD_OLD
    .replace('param1:PowerType', 'param1:CombatState')
    .replace('param1.bIsProjectile', 'param1.var_1033');

const CURSE_LOCAL_OLD = [
    '         var _loc36_:Number = NaN;',
    '         _loc4_ = param3.entType;'
].join('\n');
const CURSE_LOCAL_NEW = [
    '         var _loc36_:Number = NaN;',
    '         var _loc37_:Entity = null;',
    '         _loc4_ = param3.entType;'
].join('\n');
const CURSE_LOGIC_OLD = [
    '         if(this.var_963 && Boolean(_loc5_.var_971))',
    '         {',
    '            _loc6_ -= _loc5_.var_971;',
    '         }',
    '         if(param3.combatState.var_963 && Boolean(this.var_923))',
    '         {',
    '            _loc6_ += this.var_923;',
    '         }',
    '         if(this.var_1171 && param3.behaviorType && param3.behaviorType.var_679)',
    '         {',
    '            _loc6_ -= 0.04;',
    '         }',
    '         if(param3.combatState.var_1171 && this.var_3.behaviorType && this.var_3.behaviorType.var_679)',
    '         {',
    '            _loc6_ += 0.01;',
    '         }',
    '         if(this.var_1171 && Boolean(_loc5_.var_971))',
    '         {',
    '            _loc6_ -= _loc5_.var_971 / 5;',
    '         }',
    '         if(param3.combatState.var_1171 && Boolean(this.var_923))',
    '         {',
    '            _loc6_ += this.var_923 / 5;',
    '         }'
].join('\n');
const CURSE_LOGIC_NEW = [
    '         if(this.var_1171 && param3.behaviorType && param3.behaviorType.var_679)',
    '         {',
    '            _loc6_ -= 0.04;',
    '         }',
    '         if(param3.combatState.var_1171 && this.var_3.behaviorType && this.var_3.behaviorType.var_679)',
    '         {',
    '            _loc6_ += 0.01;',
    '         }',
    '         if(this.var_3.summonerId && this.var_3.behaviorType && this.var_3.behaviorType.var_679)',
    '         {',
    '            _loc37_ = this.var_1.GetEntFromID(this.var_3.summonerId);',
    '            if(_loc37_ && param3.combatState.var_963)',
    '            {',
    '               _loc6_ += _loc37_.combatState.var_971 + _loc37_.combatState.var_923;',
    '            }',
    '            else if(_loc37_ && param3.combatState.var_1171)',
    '            {',
    '               _loc6_ += (_loc37_.combatState.var_971 + _loc37_.combatState.var_923) / 5;',
    '            }',
    '         }',
    '         if(param3.summonerId && param3.behaviorType && param3.behaviorType.var_679 && (this.var_963 || this.var_1171))',
    '         {',
    '            _loc37_ = this.var_1.GetEntFromID(param3.summonerId);',
    '            if(_loc37_ && Boolean(_loc37_.combatState.var_923))',
    '            {',
    '               _loc6_ -= this.var_963 ? _loc37_.combatState.var_923 : _loc37_.combatState.var_923 / 5;',
    '            }',
    '         }'
].join('\n');

const CURSE_MARKER = '_loc37_.combatState.var_971 + _loc37_.combatState.var_923';

function parseArgs(argv) {
    const args = { swf: TARGET_SWF, ffdec: '', verify: false };
    for (let i = 2; i < argv.length; i++) {
        if (argv[i] === '--swf' || argv[i] === '-s') args.swf = argv[++i] || '';
        else if (argv[i] === '--ffdec' || argv[i] === '-f') args.ffdec = argv[++i] || '';
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
        const found = fs.readdirSync(bundled)
            .map((name) => path.join(bundled, name, 'bin', 'java.exe'))
            .find(fs.existsSync);
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
    if (path.resolve(swf) !== path.resolve(absolute(base, TARGET_SWF))) return;
    const indexPath = absolute(base, INDEX_HTML);
    const digest = crypto.createHash('sha256').update(fs.readFileSync(swf)).digest('hex').slice(0, 12);
    const expected = `clientrev=swf-${digest}`;
    const html = fs.readFileSync(indexPath, 'utf8');
    if (html.includes(expected)) return;
    if (verifyOnly) throw new Error(`index.html is missing ${expected}.`);
    const updated = html.replace(/clientrev=[^&`"'$]+/, expected);
    if (updated === html) throw new Error('index.html clientrev token not found.');
    fs.writeFileSync(indexPath, updated, 'utf8');
}

function requireCount(source, marker, expected, label) {
    const count = source.split(marker).length - 1;
    if (count !== expected) throw new Error(`${label} matched ${count} times, expected ${expected}.`);
}

function verifySource(source) {
    if (!source.includes(WIND_CALL_NEW) || !source.includes(WIND_METHOD_NEW)) {
        throw new Error('Wind Cloak is not conditioned on a Bound attacker.');
    }
    if (!source.includes(CURSE_MARKER) || !source.includes('param3.summonerId && param3.behaviorType')) {
        throw new Error('Cursed Sword/Armor minion effects are missing.');
    }
    if (source.includes(WIND_CALL_OLD) || source.includes(WIND_METHOD_OLD) || source.includes(CURSE_LOGIC_OLD)) {
        throw new Error('Legacy Talentstone runtime logic remains.');
    }
}

function main() {
    const base = root();
    const args = parseArgs(process.argv);
    const swf = absolute(base, args.swf);
    const ffdec = detectFfdec(base, args.ffdec);
    if (!ffdec) throw new Error('FFDec not found. Pass --ffdec or restore the bundled FFDec tool.');
    if (!fs.existsSync(swf)) throw new Error(`SWF not found: ${swf}`);

    const work = absolute(base, args.verify ? `${WORK_DIR}-verify` : WORK_DIR);
    fs.rmSync(work, { recursive: true, force: true });
    fs.mkdirSync(work, { recursive: true });
    runFfdec(base, ffdec, ['-selectclass', 'CombatState', '-export', 'script', work, swf]);
    const sourcePath = path.join(work, 'scripts', 'CombatState.as');
    let source = fs.readFileSync(sourcePath, 'utf8').replace(/\r\n/g, '\n');

    if (args.verify) {
        verifySource(source);
        syncClientRevision(base, swf, true);
        console.log(`Verified Talentstone runtime rework in ${swf}`);
        return;
    }

    if (source.includes(WIND_CALL_NEW) && source.includes(WIND_METHOD_NEW) && source.includes(CURSE_MARKER)) {
        verifySource(source);
        syncClientRevision(base, swf, false);
        console.log(`Talentstone runtime rework already present in ${swf}`);
        return;
    }

    requireCount(source, WIND_CALL_OLD, 1, 'Wind Cloak call anchor');
    requireCount(source, WIND_METHOD_OLD, 1, 'Wind Cloak method anchor');
    requireCount(source, CURSE_LOCAL_OLD, 1, 'curse local anchor');
    requireCount(source, CURSE_LOGIC_OLD, 1, 'curse logic anchor');
    source = source
        .replace(WIND_CALL_OLD, WIND_CALL_NEW)
        .replace(WIND_METHOD_OLD, WIND_METHOD_NEW)
        .replace(CURSE_LOCAL_OLD, CURSE_LOCAL_NEW)
        .replace(CURSE_LOGIC_OLD, CURSE_LOGIC_NEW);
    verifySource(source);

    fs.writeFileSync(sourcePath, source, 'utf8');
    const output = path.join(work, 'DungeonBlitz.patched.swf');
    runFfdec(base, ffdec, ['-importScript', swf, output, path.join(work, 'scripts')]);
    if (!fs.existsSync(`${swf}.bak`)) fs.copyFileSync(swf, `${swf}.bak`);
    fs.copyFileSync(output, swf);
    syncClientRevision(base, swf, false);
    console.log(`Patched Talentstone runtime rework in ${swf}`);
}

main();
