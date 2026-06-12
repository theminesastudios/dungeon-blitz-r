#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DEFAULT_SWF = path.join('src', 'client', 'content', 'localhost', 'p', 'cbp', 'DungeonBlitz.swf');
const CLEAN_CLASS_149_TEMPLATE = path.join('build', 'ffdec-all-loadfail', 'scripts', 'class_149.as');

function parseArgs(argv) {
    const args = {
        ffdec: '',
        swf: DEFAULT_SWF,
        verify: false
    };

    for (let index = 2; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--ffdec' || arg === '-f') {
            args.ffdec = argv[++index] || '';
            continue;
        }
        if (arg === '--swf' || arg === '-s') {
            args.swf = argv[++index] || '';
            continue;
        }
        if (arg === '--verify' || arg === '--dry-run') {
            args.verify = true;
            continue;
        }
        if (arg === '--help' || arg === '-h') {
            printHelp();
            process.exit(0);
        }

        throw new Error(`Unknown argument: ${arg}`);
    }

    return args;
}

function printHelp() {
    console.log([
        'Usage:',
        '  node src/server/scripts/patch-dungeonblitz-music-mute-position.js [--verify] [--swf <path>] [--ffdec <path>]',
        '',
        'Patches DungeonBlitz.swf so muting or setting music volume to 0 remembers',
        'the active loop position and resumes that position when audio is restored.'
    ].join('\n'));
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
        path.join(repoRoot, 'build', 'ffdec', 'ffdec.jar'),
        path.join(repoRoot, 'build', 'ffdec', 'ffdec-cli.jar'),
        path.join(repoRoot, 'build', 'ffdec', 'ffdec.sh'),
        path.join(repoRoot, 'build', 'tools', 'ffdec_25.1.3', 'ffdec.jar'),
        path.join(repoRoot, 'build', 'tools', 'ffdec_25.1.3', 'ffdec-cli.jar'),
        path.join(repoRoot, 'build', 'tools', 'ffdec_25.1.3', 'ffdec.sh'),
        '/Applications/FFDec.app/Contents/Resources/ffdec.jar',
        '/Applications/FFDec.app/Contents/Resources/ffdec-cli.jar',
        '/Applications/FFDec.app/Contents/Resources/ffdec.sh'
    );

    for (const candidate of candidates) {
        if (candidate && fs.existsSync(candidate)) {
            return candidate;
        }
    }
    return '';
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
    const basename = path.basename(resolved).toLowerCase();
    const ffdecHome = ensureFfdecHome(repoRoot);
    const env = {
        ...process.env,
        APPDATA: ffdecHome,
        HOME: ffdecHome,
        LOCALAPPDATA: path.join(ffdecHome, 'LocalAppData'),
        USERPROFILE: ffdecHome
    };

    if (basename.endsWith('.jar')) {
        execFileSync('java', [`-Duser.home=${ffdecHome}`, '-jar', resolved, '-cli', ...args], { env, stdio: 'inherit' });
        return;
    }

    execFileSync(resolved, ['-cli', ...args], { env, stdio: 'inherit' });
}

function exportClassScripts(repoRoot, ffdecPath, workRoot, swfPath, classes) {
    fs.rmSync(workRoot, { recursive: true, force: true });
    fs.mkdirSync(workRoot, { recursive: true });
    runFfdec(repoRoot, ffdecPath, ['-selectclass', classes.join(','), '-export', 'script', workRoot, swfPath]);
    for (const className of classes) {
        const classPath = path.join(workRoot, 'scripts', `${className}.as`);
        if (!fs.existsSync(classPath)) {
            throw new Error(`FFDec export did not produce ${classPath}`);
        }
    }
}

function replaceExact(source, needle, replacement, label) {
    if (source.includes(replacement)) {
        return source;
    }
    if (!source.includes(needle)) {
        throw new Error(`Could not find patch marker: ${label}`);
    }
    return source.replace(needle, replacement);
}

function patchClass149(source) {
    const eol = source.includes('\r\n') ? '\r\n' : '\n';
    const join = (lines) => lines.join(eol);

    let patched = source;
    patched = replaceExact(
        patched,
        '      internal var var_825:SoundChannel;',
        join([
            '      internal var var_825:SoundChannel;',
            '      ',
            '      internal var var_2982:Number = 0;'
        ]),
        'class_149 saved loop position field'
    );

    patched = replaceExact(
        patched,
        join([
            '         if(!this.var_1946)',
            '         {',
            '            this.var_739.stop();',
            '         }'
        ]),
        join([
            '         this.var_2982 = this.var_739.position;',
            '         if(this.var_1637 && this.var_1637.length > 0)',
            '         {',
            '            this.var_2982 %= this.var_1637.length;',
            '         }',
            '         if(!this.var_1946)',
            '         {',
            '            this.var_739.stop();',
            '         }'
        ]),
        'class_149 save SoundChannel.position before stopping loop'
    );

    return patched;
}

function patchSoundManager(source) {
    const eol = source.includes('\r\n') ? '\r\n' : '\n';
    const join = (lines) => lines.join(eol);

    if (
        source.includes('var _loc7_:String = _loc4_.var_2255;') &&
        source.includes('method_185(_loc5_,uint(_loc8_),true)')
    ) {
        return source;
    }

    const original = join([
        '         _loc4_.method_487();',
        '         _loc4_.var_2255 = param2;',
        '         _loc4_.var_2702 = param3;',
        '         if(!param2 || _loc4_.var_370 <= 0 || var_804)',
        '         {',
        '            return;',
        '         }',
        '         var _loc5_:Sound = method_311(param2);',
        '         var _loc6_:SoundChannel = method_185(_loc5_,0,true);'
    ]);
    const replacement = join([
        '         var _loc7_:String = _loc4_.var_2255;',
        '         _loc4_.method_487();',
        '         var _loc8_:Number = _loc7_ == param2 ? _loc4_.var_2982 : 0;',
        '         if(_loc7_ != param2)',
        '         {',
        '            _loc4_.var_2982 = 0;',
        '         }',
        '         _loc4_.var_2255 = param2;',
        '         _loc4_.var_2702 = param3;',
        '         if(!param2 || _loc4_.var_370 <= 0 || var_804)',
        '         {',
        '            return;',
        '         }',
        '         var _loc5_:Sound = method_311(param2);',
        '         var _loc6_:SoundChannel = method_185(_loc5_,uint(_loc8_),true);'
    ]);

    return replaceExact(source, original, replacement, 'SoundManager loop resume start position');
}

function preparePatchedScripts(repoRoot, ffdecPath, swfPath, workRoot) {
    const currentRoot = path.join(workRoot, 'current');
    const scriptsRoot = path.join(workRoot, 'import', 'scripts');
    exportClassScripts(repoRoot, ffdecPath, currentRoot, swfPath, ['SoundManager', 'class_149']);
    fs.rmSync(scriptsRoot, { recursive: true, force: true });
    fs.mkdirSync(scriptsRoot, { recursive: true });

    const soundManagerSource = fs.readFileSync(path.join(currentRoot, 'scripts', 'SoundManager.as'), 'utf8');
    const cleanClass149Path = resolvePath(repoRoot, CLEAN_CLASS_149_TEMPLATE);
    if (!fs.existsSync(cleanClass149Path)) {
        throw new Error(`Clean class_149 template not found: ${cleanClass149Path}`);
    }
    const class149Source = fs.readFileSync(cleanClass149Path, 'utf8');

    fs.writeFileSync(path.join(scriptsRoot, 'SoundManager.as'), patchSoundManager(soundManagerSource), 'utf8');
    fs.writeFileSync(path.join(scriptsRoot, 'class_149.as'), patchClass149(class149Source), 'utf8');
    return scriptsRoot;
}

function patchSwf(repoRoot, ffdecPath, swfPath) {
    const workRoot = path.join(repoRoot, 'build', 'ffdec-dungeonblitz-music-mute-position', path.basename(swfPath, path.extname(swfPath)));
    const scriptsRoot = preparePatchedScripts(repoRoot, ffdecPath, swfPath, workRoot);
    const patchedSwfPath = path.join(path.dirname(swfPath), `${path.basename(swfPath, path.extname(swfPath))}.music-mute-position.swf`);
    runFfdec(repoRoot, ffdecPath, ['-importScript', swfPath, patchedSwfPath, scriptsRoot]);
    fs.copyFileSync(patchedSwfPath, swfPath);
    fs.rmSync(patchedSwfPath, { force: true });
}

function verifyScriptSource(source, snippets, label) {
    for (const snippet of snippets) {
        if (!source.includes(snippet)) {
            throw new Error(`${label} missing required snippet: ${snippet}`);
        }
    }
}

function verifySwf(repoRoot, ffdecPath, swfPath) {
    const workRoot = path.join(repoRoot, 'build', 'ffdec-dungeonblitz-music-mute-position-verify', path.basename(swfPath, path.extname(swfPath)));
    exportClassScripts(repoRoot, ffdecPath, workRoot, swfPath, ['SoundManager', 'class_149']);
    const soundManagerSource = fs.readFileSync(path.join(workRoot, 'scripts', 'SoundManager.as'), 'utf8');
    const class149Source = fs.readFileSync(path.join(workRoot, 'scripts', 'class_149.as'), 'utf8');

    verifyScriptSource(class149Source, [
        'internal var var_2982:Number = 0;',
        'this.var_2982 = this.var_739.position;',
        'this.var_2982 %= this.var_1637.length;'
    ], 'class_149');
    verifyScriptSource(soundManagerSource, [
        'var _loc7_:String = _loc4_.var_2255;',
        'var _loc8_:Number = Number(_loc7_ == param2 ? _loc4_.var_2982 : 0);',
        '_loc4_.var_2982 = 0;',
        'method_185(_loc5_,uint(_loc8_),true)'
    ], 'SoundManager');
}

function main() {
    const args = parseArgs(process.argv);
    const repoRoot = resolveRepoRoot();
    const ffdecPath = detectFfdec(repoRoot, args.ffdec);
    if (!ffdecPath) {
        throw new Error('FFDec not found. Pass --ffdec or restore the repo-bundled FFDec app.');
    }
    const swfPath = resolvePath(repoRoot, args.swf);
    if (!fs.existsSync(swfPath)) {
        throw new Error(`SWF not found: ${swfPath}`);
    }

    if (args.verify) {
        verifySwf(repoRoot, ffdecPath, swfPath);
        return;
    }

    patchSwf(repoRoot, ffdecPath, swfPath);
    verifySwf(repoRoot, ffdecPath, swfPath);
}

try {
    main();
} catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
}
