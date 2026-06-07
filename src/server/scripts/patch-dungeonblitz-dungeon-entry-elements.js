#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const TARGET_SWF = path.join('src', 'client', 'content', 'localhost', 'p', 'cbp', 'DungeonBlitz.swf');
const CLASS_NAME = 'class_100';
const PATCH_MARKER = 'EnemyElements=';

function parseArgs(argv) {
    const args = {
        ffdec: '',
        swf: TARGET_SWF,
        verify: false
    };

    for (let index = 2; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === '--ffdec' || arg === '-f') {
            args.ffdec = argv[++index] || '';
            continue;
        }
        if (arg === '--swf' || arg === '-s') {
            args.swf = argv[++index] || TARGET_SWF;
            continue;
        }
        if (arg === '--verify') {
            args.verify = true;
            continue;
        }
        if (arg === '--help' || arg === '-h') {
            console.log('Usage: node src/server/scripts/patch-dungeonblitz-dungeon-entry-elements.js [--verify] [--swf <path>] [--ffdec <path>]');
            process.exit(0);
        }

        throw new Error(`Unknown argument: ${arg}`);
    }

    return args;
}

function resolveRepoRoot() {
    return path.resolve(__dirname, '..', '..', '..');
}

function resolvePath(repoRoot, value) {
    if (!value) {
        return '';
    }
    return path.isAbsolute(value) ? value : path.join(repoRoot, value);
}

function detectFfdec(repoRoot, preferred) {
    const candidates = [];
    if (preferred) {
        candidates.push(resolvePath(repoRoot, preferred));
    }

    candidates.push(
        path.join(repoRoot, 'build', 'ffdec', 'ffdec.sh'),
        path.join(repoRoot, 'build', 'ffdec', 'ffdec.jar'),
        path.join(repoRoot, 'build', 'ffdec', 'ffdec-cli.jar'),
        path.join(repoRoot, 'build', 'tools', 'ffdec_25.1.3', 'ffdec.sh'),
        path.join(repoRoot, 'build', 'tools', 'ffdec_25.1.3', 'ffdec.jar'),
        path.join(repoRoot, 'build', 'tools', 'ffdec_25.1.3', 'ffdec-cli.jar'),
        '/Applications/FFDec.app/Contents/Resources/ffdec.sh',
        '/Applications/FFDec.app/Contents/Resources/ffdec.jar',
        '/Applications/FFDec.app/Contents/Resources/ffdec-cli.jar'
    );

    for (const candidate of candidates) {
        if (candidate && fs.existsSync(candidate)) {
            return candidate;
        }
    }

    return '';
}

function runFfdec(ffdecPath, args) {
    const resolved = path.resolve(ffdecPath);
    const basename = path.basename(resolved).toLowerCase();

    if (basename.endsWith('.jar')) {
        execFileSync('java', ['-jar', resolved, '-cli', ...args], { stdio: 'inherit' });
        return;
    }

    execFileSync(resolved, ['-cli', ...args], { stdio: 'inherit' });
}

function exportClass(ffdecPath, workRoot, swfPath) {
    fs.rmSync(workRoot, { recursive: true, force: true });
    fs.mkdirSync(workRoot, { recursive: true });
    runFfdec(ffdecPath, ['-selectclass', CLASS_NAME, '-export', 'script', workRoot, swfPath]);

    const classPath = path.join(workRoot, 'scripts', `${CLASS_NAME}.as`);
    if (!fs.existsSync(classPath)) {
        throw new Error(`Exported ${CLASS_NAME}.as not found at ${classPath}`);
    }
    return classPath;
}

function patchClass100(source) {
    const eol = source.includes('\r\n') ? '\r\n' : '\n';
    let patched = source;
    const arrayDeclaration = '         var _loc8_:Array = null;';
    if (!patched.includes(arrayDeclaration)) {
        const stringDeclaration = '         var _loc7_:String = null;';
        if (patched.includes(stringDeclaration)) {
            patched = patched.replace(stringDeclaration, `${stringDeclaration}${eol}${arrayDeclaration}`);
        }
    }

    const oldTwoLine = [
        '            for each(_loc6_ in _loc2_.var_1550)',
        '            {',
        '               if(_loc6_.indexOf("EnemyElements=") == 0)',
        '               {',
        '                  _loc7_ = _loc6_.substr(14).split("|").join(", ");',
        '                  break;',
        '               }',
        '            }',
        '            _loc6_ = "Dungeon Level: " + _loc5_;',
        '            if(_loc7_)',
        '            {',
        '               _loc6_ += "\\nEnemy Elements: " + _loc7_;',
        '            }',
        '            MathUtil.method_2(this.var_1413.am_Text,_loc6_);'
    ].join(eol);

    const oldOneLine = [
        '            for each(_loc6_ in _loc2_.var_1550)',
        '            {',
        '               if(_loc6_.indexOf("EnemyElements=") == 0)',
        '               {',
        '                  _loc7_ = _loc6_.substr(14).split("|").join(", ") + " Creatures";',
        '                  break;',
        '               }',
        '            }',
        '            _loc6_ = "Dungeon Level: " + _loc5_;',
        '            if(_loc7_)',
        '            {',
        '               _loc6_ += " - " + _loc7_;',
        '            }',
        '            MathUtil.method_2(this.var_1413.am_Text,_loc6_);'
    ].join(eol);

    const oldOneLineSource = [
        '            for each(_loc6_ in _loc2_.var_1550)',
        '            {',
        '               if(_loc6_.indexOf("EnemyElements=") == 0)',
        '               {',
        '                  _loc7_ = _loc6_.substr("EnemyElements=".length).split("|").join(", ") + " Creatures";',
        '                  break;',
        '               }',
        '            }',
        '            _loc6_ = "Dungeon Level: " + _loc5_;',
        '            if(_loc7_)',
        '            {',
        '               _loc6_ += " - " + _loc7_;',
        '            }',
        '            MathUtil.method_2(this.var_1413.am_Text,_loc6_);'
    ].join(eol);

    const oldTwoElementFormatter = [
        '            for each(_loc6_ in _loc2_.var_1550)',
        '            {',
        '               if(_loc6_.indexOf("EnemyElements=") == 0)',
        '               {',
        '                  _loc8_ = _loc6_.substr(14).split("|");',
        '                  _loc7_ = _loc8_.length == 2 ? _loc8_[0] + " and " + _loc8_[1] + " Creatures" : _loc8_.join(", ") + " Creatures";',
        '                  break;',
        '               }',
        '            }',
        '            _loc6_ = "Dungeon Level: " + _loc5_;',
        '            if(_loc7_)',
        '            {',
        '               _loc6_ += " - " + _loc7_;',
        '            }',
        '            MathUtil.method_2(this.var_1413.am_Text,_loc6_);'
    ].join(eol);

    const oldTwoElementFormatterSource = [
        '            for each(_loc6_ in _loc2_.var_1550)',
        '            {',
        '               if(_loc6_.indexOf("EnemyElements=") == 0)',
        '               {',
        '                  _loc8_ = _loc6_.substr("EnemyElements=".length).split("|");',
        '                  _loc7_ = _loc8_.length == 2 ? _loc8_[0] + " and " + _loc8_[1] + " Creatures" : _loc8_.join(", ") + " Creatures";',
        '                  break;',
        '               }',
        '            }',
        '            _loc6_ = "Dungeon Level: " + _loc5_;',
        '            if(_loc7_)',
        '            {',
        '               _loc6_ += " - " + _loc7_;',
        '            }',
        '            MathUtil.method_2(this.var_1413.am_Text,_loc6_);'
    ].join(eol);

    const oldTwoLineSource = [
        '            for each(_loc6_ in _loc2_.var_1550)',
        '            {',
        '               if(_loc6_.indexOf("EnemyElements=") == 0)',
        '               {',
        '                  _loc7_ = _loc6_.substr("EnemyElements=".length).split("|").join(", ");',
        '                  break;',
        '               }',
        '            }',
        '            _loc6_ = "Dungeon Level: " + _loc5_;',
        '            if(_loc7_)',
        '            {',
        '               _loc6_ += "\\nEnemy Elements: " + _loc7_;',
        '            }',
        '            MathUtil.method_2(this.var_1413.am_Text,_loc6_);'
    ].join(eol);

    const oneLinePatch = [
        '            for each(_loc6_ in _loc2_.var_1550)',
        '            {',
        '               if(_loc6_.indexOf("EnemyElements=") == 0)',
        '               {',
        '                  _loc8_ = _loc6_.substr("EnemyElements=".length).split("|");',
        '                  if(_loc8_.length == 1)',
        '                  {',
        '                     _loc7_ = _loc8_[0] + " Creatures";',
        '                  }',
        '                  else if(_loc8_.length == 2)',
        '                  {',
        '                     _loc7_ = _loc8_[0] + " and " + _loc8_[1] + " Creatures";',
        '                  }',
        '                  else',
        '                  {',
        '                     _loc7_ = _loc8_.slice(0,_loc8_.length - 1).join(", ") + ", and " + _loc8_[_loc8_.length - 1] + " Creatures";',
        '                  }',
        '                  break;',
        '               }',
        '            }',
        '            _loc6_ = "Dungeon Level: " + _loc5_;',
        '            if(_loc7_)',
        '            {',
        '               _loc6_ += " - " + _loc7_;',
        '            }',
        '            MathUtil.method_2(this.var_1413.am_Text,_loc6_);'
    ].join(eol);

    const oneLinePatchCompiled = oneLinePatch.replace('"EnemyElements=".length', '14');

    if (patched.includes(oneLinePatch) || patched.includes(oneLinePatchCompiled)) {
        return patched;
    }

    if (patched.includes(oldOneLine)) {
        return patched.replace(oldOneLine, oneLinePatch);
    }

    if (patched.includes(oldOneLineSource)) {
        return patched.replace(oldOneLineSource, oneLinePatch);
    }

    if (patched.includes(oldTwoElementFormatter)) {
        return patched.replace(oldTwoElementFormatter, oneLinePatch);
    }

    if (patched.includes(oldTwoElementFormatterSource)) {
        return patched.replace(oldTwoElementFormatterSource, oneLinePatch);
    }

    if (patched.includes(oldTwoLine)) {
        return patched.replace(oldTwoLine, oneLinePatch);
    }

    if (patched.includes(oldTwoLineSource)) {
        return patched.replace(oldTwoLineSource, oneLinePatch);
    }

    const declaration = '         var _loc5_:uint = 0;';
    const patchedDeclaration = [
        declaration,
        '         var _loc6_:String = null;',
        '         var _loc7_:String = null;',
        '         var _loc8_:Array = null;'
    ].join(eol);

    const levelText = '            MathUtil.method_2(this.var_1413.am_Text,"Dungeon Level: " + _loc5_);';
    if (!patched.includes(declaration)) {
        throw new Error('Could not find class_100 local declaration marker.');
    }
    if (!patched.includes(levelText)) {
        throw new Error('Could not find class_100 dungeon level text marker.');
    }

    return patched
        .replace(declaration, patchedDeclaration)
        .replace(levelText, oneLinePatch);
}

function patchSwf(repoRoot, ffdecPath, swfPath) {
    const workRoot = path.join(repoRoot, 'build', 'ffdec-dungeon-entry-elements');
    const classPath = exportClass(ffdecPath, workRoot, swfPath);
    const patched = patchClass100(fs.readFileSync(classPath, 'utf8'));
    fs.writeFileSync(classPath, patched);

    const patchedSwfPath = path.join(workRoot, path.basename(swfPath));
    runFfdec(ffdecPath, ['-importScript', swfPath, patchedSwfPath, path.dirname(classPath)]);
    fs.copyFileSync(patchedSwfPath, swfPath);
}

function verifySwf(repoRoot, ffdecPath, swfPath) {
    const workRoot = path.join(repoRoot, 'build', 'ffdec-dungeon-entry-elements-verify');
    const classPath = exportClass(ffdecPath, workRoot, swfPath);
    const source = fs.readFileSync(classPath, 'utf8');
    if (!source.includes(PATCH_MARKER) || !source.includes(' Creatures') || !source.includes(' - ')) {
        throw new Error('Served DungeonBlitz.swf is missing the dungeon entry element display patch.');
    }
    console.log('dungeon entry element display patch verified');
}

function main() {
    const args = parseArgs(process.argv);
    const repoRoot = resolveRepoRoot();
    const ffdecPath = detectFfdec(repoRoot, args.ffdec);
    if (!ffdecPath) {
        throw new Error('FFDec not found. Pass --ffdec or install JPEXS FFDec.');
    }

    const swfPath = resolvePath(repoRoot, args.swf);
    if (args.verify) {
        verifySwf(repoRoot, ffdecPath, swfPath);
    } else {
        patchSwf(repoRoot, ffdecPath, swfPath);
        verifySwf(repoRoot, ffdecPath, swfPath);
    }
}

main();
