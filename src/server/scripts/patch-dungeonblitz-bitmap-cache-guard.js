#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function parseArgs(argv) {
    const args = {
        ffdec: '',
        swf: path.join('src', 'client', 'content', 'localhost', 'p', 'cbp', 'DungeonBlitz.swf'),
        verify: false
    };

    for (let index = 2; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === '--ffdec' || arg === '-f') {
            args.ffdec = argv[++index] || '';
            continue;
        }
        if (arg === '--swf' || arg === '-s') {
            args.swf = argv[++index] || '';
            continue;
        }
        if (arg === '--verify') {
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
    console.log(
        [
            'Usage:',
            '  node src/server/scripts/patch-dungeonblitz-bitmap-cache-guard.js [--verify] [--swf <path>] [--ffdec <path>]',
            '',
            'Defaults:',
            '  patches Game in the served DungeonBlitz.swf',
            '  so bitmap cache failures no longer crash the client render loop.'
        ].join('\n')
    );
}

function resolveRepoRoot() {
    return path.resolve(__dirname, '..', '..', '..');
}

function resolvePath(repoRoot, value) {
    if (!value) {
        return '';
    }
    if (path.isAbsolute(value)) {
        return value;
    }
    return path.join(repoRoot, value);
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
        '/Applications/FFDec.app/Contents/Resources/ffdec-cli.jar',
        path.join(repoRoot, 'temp', 'jpexs_25_1_3', 'FFDec.app', 'Contents', 'Resources', 'ffdec.sh'),
        path.join(repoRoot, 'temp', 'jpexs_25_1_3', 'FFDec.app', 'Contents', 'Resources', 'ffdec.jar'),
        path.join(repoRoot, 'temp', 'jpexs_25_1_3', 'FFDec.app', 'Contents', 'Resources', 'ffdec-cli.jar')
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

function ensureCleanDir(dirPath) {
    fs.rmSync(dirPath, { recursive: true, force: true });
    fs.mkdirSync(dirPath, { recursive: true });
}

function exportGame(ffdecPath, workRoot, swfPath) {
    ensureCleanDir(workRoot);
    runFfdec(ffdecPath, ['-selectclass', 'Game', '-export', 'script', workRoot, swfPath]);
    const gamePath = path.join(workRoot, 'scripts', 'Game.as');
    if (!fs.existsSync(gamePath)) {
        throw new Error(`FFDec export did not produce ${path.relative(process.cwd(), gamePath)}`);
    }
    return gamePath;
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

function getTemplateGameSource(repoRoot) {
    const templatePath = path.join(repoRoot, 'build', 'ffdec-dungeonblitz-single-swf', 'scripts', 'Game.as');
    if (!fs.existsSync(templatePath)) {
        throw new Error(`Template Game.as not found: ${templatePath}`);
    }
    return fs.readFileSync(templatePath, 'utf8');
}

function patchGameSource(source) {
    const eol = source.includes('\r\n') ? '\r\n' : '\n';
    const join = (lines) => lines.join(eol);

    const fieldOriginal = join([
        '      internal var var_171:class_82;',
        '      ',
        '      internal var var_2560:Array;'
    ]);
    const fieldPatched = join([
        '      internal var var_171:class_82;',
        '      ',
        '      internal var var_2967:Boolean;',
        '      ',
        '      internal var var_2560:Array;'
    ]);

    const tickOriginal = join([
        '         this.var_77.method_1808();',
        '         this.var_171.method_1829();',
        '         if(this.var_107)'
    ]);
    const tickPatched = join([
        '         this.var_77.method_1808();',
        '         if(!this.var_2967)',
        '         {',
        '            try',
        '            {',
        '               this.var_171.method_1829();',
        '            }',
        '            catch(_loc1_:Error)',
        '            {',
        '               this.var_2967 = true;',
        '            }',
        '         }',
        '         if(this.var_107)'
    ]);

    let patched = source;
    patched = replaceExact(patched, fieldOriginal, fieldPatched, 'Game bitmap cache guard field');
    patched = replaceExact(patched, tickOriginal, tickPatched, 'Game bitmap cache guard tick wrapper');
    return patched;
}

function patchSwf(repoRoot, ffdecPath, swfPath) {
    const workRoot = path.join(repoRoot, 'build', 'ffdec-dungeonblitz-bitmap-cache-guard');
    const scriptsRoot = path.join(workRoot, 'scripts');
    ensureCleanDir(scriptsRoot);

    const original = getTemplateGameSource(repoRoot);
    const patched = patchGameSource(original);

    if (patched === original) {
        console.log('[bitmap-cache-guard] Game already patched');
        return;
    }

    const gamePath = path.join(scriptsRoot, 'Game.as');
    fs.writeFileSync(gamePath, patched, 'utf8');

    const patchedSwfPath = path.join(workRoot, path.basename(swfPath));
    runFfdec(ffdecPath, ['-importScript', swfPath, patchedSwfPath, scriptsRoot]);
    fs.copyFileSync(patchedSwfPath, swfPath);

    console.log(`[bitmap-cache-guard] patched ${path.relative(repoRoot, swfPath)}`);
}

function verifySwf(repoRoot, ffdecPath, swfPath) {
    const workRoot = path.join(repoRoot, 'build', 'ffdec-dungeonblitz-bitmap-cache-guard-verify');
    const gamePath = exportGame(ffdecPath, workRoot, swfPath);
    const source = fs.readFileSync(gamePath, 'utf8');

    const requiredSnippets = [
        'internal var var_2967:Boolean;',
        'if(!this.var_2967)',
        'catch(_loc1_:Error)',
        'this.var_2967 = true;'
    ];

    for (const snippet of requiredSnippets) {
        if (!source.includes(snippet)) {
            throw new Error(`Verification failed: missing snippet "${snippet}" in ${gamePath}`);
        }
    }

    console.log(`[bitmap-cache-guard] verified ${path.relative(repoRoot, swfPath)}`);
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
}

try {
    main();
} catch (error) {
    console.error('[bitmap-cache-guard] failed');
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
}
