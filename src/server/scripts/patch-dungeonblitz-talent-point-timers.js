#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DEFAULT_SWF = path.join('src', 'client', 'content', 'localhost', 'p', 'cbp', 'DungeonBlitz.swf');
const TALENT_TIMES_ZERO = `[${Array.from({ length: 51 }, () => 0).join(',')}]`;
const SELECTED_CLASSES = ['class_66', 'class_69', 'LinkUpdater'];

function parseArgs(argv) {
    const args = {
        swf: DEFAULT_SWF,
        ffdec: '',
        verify: false
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--swf') {
            args.swf = argv[++index] || '';
        } else if (arg === '--ffdec' || arg === '-f') {
            args.ffdec = argv[++index] || '';
        } else if (arg === '--verify') {
            args.verify = true;
        } else if (arg === '--help' || arg === '-h') {
            console.log([
                'Usage:',
                '  node src/server/scripts/patch-dungeonblitz-talent-point-timers.js [--verify] [--swf <path>] [--ffdec <path>]',
                '',
                'Patches DungeonBlitz.swf Talent Point timers:',
                '  class_66.const_527 training times => all zero',
                '  class_69 Train Talent Point UI => hide timer display',
                '  class_69 TrainTalentPoint => wait for server completion before granting locally',
                '  LinkUpdater Talent Point completion => retain the completed discipline index'
            ].join('\n'));
            process.exit(0);
        } else {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }

    return args;
}

function detectFfdec(repoRoot, explicitPath) {
    const candidates = [
        explicitPath,
        path.join(repoRoot, 'build', 'ffdec', 'ffdec.sh'),
        path.join(repoRoot, 'build', 'ffdec', 'ffdec.jar'),
        path.join(repoRoot, 'build', 'ffdec', 'ffdec-cli.jar'),
        path.join(repoRoot, 'build', 'tools', 'ffdec_25.1.3', 'ffdec.sh'),
        path.join(repoRoot, 'build', 'tools', 'ffdec_25.1.3', 'ffdec.jar'),
        path.join(repoRoot, 'build', 'tools', 'ffdec_25.1.3', 'ffdec-cli.jar'),
        '/Applications/FFDec.app/Contents/Resources/ffdec.sh',
        '/Applications/FFDec.app/Contents/Resources/ffdec.jar',
        '/Applications/FFDec.app/Contents/Resources/ffdec-cli.jar'
    ].filter(Boolean);

    return candidates.find((candidate) => fs.existsSync(path.resolve(candidate))) || '';
}

function ensureFfdecHome(repoRoot) {
    const ffdecHome = path.join(repoRoot, 'build', 'ffdec-home');
    fs.mkdirSync(path.join(ffdecHome, 'Library', 'Application Support', 'FFDec', 'logs'), { recursive: true });
    fs.mkdirSync(path.join(ffdecHome, 'JPEXS', 'FFDec', 'logs'), { recursive: true });
    fs.mkdirSync(path.join(ffdecHome, 'LocalAppData'), { recursive: true });
    return ffdecHome;
}

function runFfdec(repoRoot, ffdecPath, args) {
    const resolved = path.resolve(ffdecPath);
    const ffdecHome = ensureFfdecHome(repoRoot);
    const env = {
        ...process.env,
        APPDATA: ffdecHome,
        HOME: ffdecHome,
        LOCALAPPDATA: path.join(ffdecHome, 'LocalAppData'),
        USERPROFILE: ffdecHome
    };

    if (resolved.endsWith('.jar')) {
        execFileSync('java', [`-Duser.home=${ffdecHome}`, '-jar', resolved, '-cli', ...args], { env, stdio: 'inherit' });
        return;
    }

    execFileSync(resolved, ['-cli', ...args], { env, stdio: 'inherit' });
}

function exportScripts(repoRoot, ffdecPath, workRoot, swfPath) {
    fs.rmSync(workRoot, { recursive: true, force: true });
    fs.mkdirSync(workRoot, { recursive: true });
    runFfdec(repoRoot, ffdecPath, ['-selectclass', SELECTED_CLASSES.join(','), '-export', 'script', workRoot, swfPath]);
    const scriptsRoot = path.join(workRoot, 'scripts');

    for (const className of SELECTED_CLASSES) {
        const classPath = path.join(scriptsRoot, `${className}.as`);
        if (!fs.existsSync(classPath)) {
            throw new Error(`FFDec export did not produce ${classPath}`);
        }
    }

    return scriptsRoot;
}

function patchClass66(source) {
    return source.replace(
        /internal static const const_527:Array = \[[^\]]+\];/,
        `internal static const const_527:Array = ${TALENT_TIMES_ZERO};`
    );
}

function patchClass69(source) {
    let patched = source;

    if (!patched.includes('_loc21_.am_Time.visible = false;')) {
        patched = patched.replace(
            /(\s+_loc21_ = this\.var_1545\.mMovieClip;\r?\n)/,
            '$1            _loc21_.am_Time.visible = false;\n'
        );
    }

    patched = patched.replace(
        '               MathUtil.method_8(_loc21_.am_Time,"--",ScreenArmory.const_9,ScreenArmory.const_17);',
        '               MathUtil.method_8(_loc21_.am_Time,"",ScreenArmory.const_9,ScreenArmory.const_17);'
    );
    patched = patched.replace(
        '                  MathUtil.method_8(_loc21_.am_Time,"--",ScreenArmory.const_9,ScreenArmory.const_17);',
        '                  MathUtil.method_8(_loc21_.am_Time,"",ScreenArmory.const_9,ScreenArmory.const_17);'
    );
    patched = patched.replace(
        '                  MathUtil.method_8(_loc21_.am_Time,Game.method_70(class_66.const_527[_loc22_],true),ScreenArmory.const_11,ScreenArmory.const_47);',
        '                  MathUtil.method_8(_loc21_.am_Time,"",ScreenArmory.const_9,ScreenArmory.const_17);'
    );
    patched = patched.replace(
        '               var_1.mMasterClassTower.SetCurrentResearch(_loc6_,_loc12_);',
        '               _loc12_ = 0;'
    );
    patched = patched.replace(
        '               var_1.mMasterClassTower.SetCurrentResearch(_loc6_,0);',
        '               _loc12_ = 0;'
    );

    return patched;
}

function patchLinkUpdater(source) {
    let patched = source.replace(
        /         if\(this\.var_1\.mMasterClassTower\)\r?\n         \{\r?\n            this\.var_1\.mMasterClassTower\.mStatus = class_66\.const_534;\r?\n            this\.var_1\.mMasterClassTower\.method_469\(\);\r?\n         \}/,
        [
            '         if(this.var_1.mMasterClassTower)',
            '         {',
            '            this.var_1.mMasterClassTower.SetCurrentResearch(_loc2_,0);',
            '            this.var_1.mMasterClassTower.GiveNewResearchPoint();',
            '            this.var_1.mMasterClassTower.method_469();',
            '         }'
        ].join('\n')
    );

    if (!patched.includes('this.var_1.mMasterClassTower.GiveNewResearchPoint();')) {
        patched = patched.replace(
            /(            this\.var_1\.mMasterClassTower\.SetCurrentResearch\(_loc2_,0\);\r?\n)(            this\.var_1\.mMasterClassTower\.method_469\(\);)/,
            '$1            this.var_1.mMasterClassTower.GiveNewResearchPoint();\n$2'
        );
    }

    return patched;
}

function verifySources(scriptsRoot) {
    const class66 = fs.readFileSync(path.join(scriptsRoot, 'class_66.as'), 'utf8');
    const class69 = fs.readFileSync(path.join(scriptsRoot, 'class_69.as'), 'utf8');
    const linkUpdater = fs.readFileSync(path.join(scriptsRoot, 'LinkUpdater.as'), 'utf8');

    if (!class66.includes(`internal static const const_527:Array = ${TALENT_TIMES_ZERO};`)) {
        throw new Error('class_66.const_527 is not patched to zero Talent Point training times');
    }
    if (!class69.includes('_loc21_.am_Time.visible = false;')) {
        throw new Error('class_69 Train Talent Point timer field is not hidden');
    }
    if (!class69.includes('MathUtil.method_8(_loc21_.am_Time,"",ScreenArmory.const_9,ScreenArmory.const_17);')) {
        throw new Error('class_69 Train Talent Point timer text is not blanked');
    }
    if (class69.includes('Game.method_70(class_66.const_527[_loc22_],true)')) {
        throw new Error('class_69 still renders the Talent Point training duration');
    }
    if (class69.includes('var_1.mMasterClassTower.SetCurrentResearch(_loc6_,_loc12_);')) {
        throw new Error('class_69 still creates local timed Talent Point research');
    }
    if (class69.includes('var_1.mMasterClassTower.SetCurrentResearch(_loc6_,0);')) {
        throw new Error('class_69 grants a local Talent Point before the server completion packet');
    }
    if (!class69.includes('_loc12_ = 0;')) {
        throw new Error('class_69 does not suppress local Talent Point research before server completion');
    }
    if (!linkUpdater.includes('this.var_1.mMasterClassTower.SetCurrentResearch(_loc2_,0);')) {
        throw new Error('LinkUpdater does not retain the completed Talent Point research index');
    }
    if (!linkUpdater.includes('this.var_1.mMasterClassTower.GiveNewResearchPoint();')) {
        throw new Error('LinkUpdater does not immediately apply the completed Talent Point');
    }
    if (linkUpdater.includes('this.var_1.mMasterClassTower.mStatus = class_66.const_534;')) {
        throw new Error('LinkUpdater still marks Talent Point completion without setting the research index');
    }
}

function patchSwf(repoRoot, ffdecPath, swfPath) {
    const workRoot = path.join(repoRoot, 'build', 'ffdec-dungeonblitz-talent-point-timers');
    const scriptsRoot = exportScripts(repoRoot, ffdecPath, workRoot, swfPath);
    const class66Path = path.join(scriptsRoot, 'class_66.as');
    const class69Path = path.join(scriptsRoot, 'class_69.as');
    const linkUpdaterPath = path.join(scriptsRoot, 'LinkUpdater.as');

    fs.writeFileSync(class66Path, patchClass66(fs.readFileSync(class66Path, 'utf8')), 'utf8');
    fs.writeFileSync(class69Path, patchClass69(fs.readFileSync(class69Path, 'utf8')), 'utf8');
    fs.writeFileSync(linkUpdaterPath, patchLinkUpdater(fs.readFileSync(linkUpdaterPath, 'utf8')), 'utf8');
    verifySources(scriptsRoot);

    const patchedSwfPath = `${swfPath}.patched`;
    fs.rmSync(patchedSwfPath, { force: true });
    runFfdec(repoRoot, ffdecPath, ['-importScript', swfPath, patchedSwfPath, scriptsRoot]);
    fs.renameSync(patchedSwfPath, swfPath);
}

function verifySwf(repoRoot, ffdecPath, swfPath) {
    const workRoot = path.join(repoRoot, 'build', 'ffdec-dungeonblitz-talent-point-timers-verify');
    const scriptsRoot = exportScripts(repoRoot, ffdecPath, workRoot, swfPath);
    verifySources(scriptsRoot);
}

function main() {
    const repoRoot = path.resolve(__dirname, '..', '..', '..');
    const args = parseArgs(process.argv.slice(2));
    const swfPath = path.resolve(repoRoot, args.swf);
    const ffdecPath = detectFfdec(repoRoot, args.ffdec);

    if (!ffdecPath) {
        throw new Error('FFDec not found. Pass --ffdec or install JPEXS FFDec.');
    }
    if (!fs.existsSync(swfPath)) {
        throw new Error(`SWF not found: ${swfPath}`);
    }

    if (!args.verify) {
        patchSwf(repoRoot, ffdecPath, swfPath);
    }
    verifySwf(repoRoot, ffdecPath, swfPath);
    console.log(`${args.verify ? 'Verified' : 'Patched'} DungeonBlitz Talent Point timers in ${swfPath}`);
}

main();
