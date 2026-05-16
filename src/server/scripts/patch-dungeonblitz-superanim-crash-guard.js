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
            '  node src/server/scripts/patch-dungeonblitz-superanim-crash-guard.js [--verify] [--swf <path>] [--ffdec <path>]',
            '',
            'Defaults:',
            '  patches Game.method_1325 in the served DungeonBlitz.swf',
            '  so Invalid BitmapData failures inside SuperAnimInstance.method_105 do not crash the render tick.'
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
    return path.isAbsolute(value) ? value : path.join(repoRoot, value);
}

function detectFfdec(repoRoot, preferred) {
    const candidates = [];
    if (preferred) {
        candidates.push(resolvePath(repoRoot, preferred));
    }

    candidates.push(
        path.join(repoRoot, 'build', 'tools', 'ffdec_25.0.0', 'ffdec-cli.exe'),
        path.join(repoRoot, 'build', 'tools', 'ffdec_25.0.0', 'ffdec-cli.jar'),
        path.join(repoRoot, 'build', 'tools', 'ffdec_25.0.0', 'ffdec.sh'),
        path.join(repoRoot, 'build', 'ffdec_24.0.1', 'ffdec-cli.exe'),
        path.join(repoRoot, 'build', 'ffdec_24.0.1', 'ffdec-cli.jar'),
        path.join(repoRoot, 'build', 'ffdec_24.0.1', 'ffdec.sh'),
        path.join(repoRoot, 'build', 'ffdec', 'ffdec.sh'),
        path.join(repoRoot, 'build', 'ffdec', 'ffdec.jar'),
        path.join(repoRoot, 'build', 'ffdec', 'ffdec-cli.jar')
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

function exportGamePcode(ffdecPath, workRoot, swfPath) {
    ensureCleanDir(workRoot);
    runFfdec(ffdecPath, ['-format', 'script:pcode', '-selectclass', 'Game', '-export', 'script', workRoot, swfPath]);
    const pcodePath = path.join(workRoot, 'scripts', 'Game.pcode');
    if (!fs.existsSync(pcodePath)) {
        throw new Error(`FFDec export did not produce ${pcodePath}`);
    }
    return pcodePath;
}

function patchPcode(source) {
    if (/try from ofs008[cd] to ofs009c target ofs011[bc] type QName\(PackageNamespace\(""\),"Error"\)/.test(source)) {
        return source;
    }

    const methodStart = source.indexOf('public function method_1325() : void');
    if (methodStart < 0) {
        throw new Error('Could not find method_1325.');
    }

    const nextMethodStart = source.indexOf('public function method_789() : Boolean', methodStart);
    if (nextMethodStart < 0) {
        throw new Error('Could not find method_1325 end marker.');
    }

    const beforeMethod = source.slice(0, methodStart);
    const afterMethod = source.slice(nextMethodStart);
    let methodSource = source.slice(methodStart, nextMethodStart);

    const localCountNeedle = 'localcount 5';
    if (!methodSource.includes(localCountNeedle)) {
        throw new Error('Could not find method_1325 localcount marker.');
    }
    methodSource = methodSource.replace(localCountNeedle, 'localcount 6');

    const methodCallPattern = /ofs008c:\r?\n\s*label\r?\n\s*getlocal2\r?\n\s*callproperty QName\(PackageNamespace\(""\),"method_105"\), 0\r?\n\s*getlocal 4\r?\n\s*dup\r?\n\s*iffalse ofs009c\r?\n\s*pop\r?\n\s*getlocal2\r?\n\s*convert_b\r?\n\s*ofs009c:/;
    if (!methodCallPattern.test(methodSource)) {
        throw new Error('Could not find method_1325 method_105 block.');
    }

    const jumpNeedle = /ofs00ce:\r?\n\s*jump ofs008c/;
    if (!jumpNeedle.test(methodSource)) {
        throw new Error('Could not find method_1325 loop jump marker.');
    }

    const endCodePattern = /(ofs011a:\r?\n\s*returnvoid\r?\n\s*returnvoid\r?\n)(\s*end ; code\r?\n)(\s*end ; body)/;
    if (!endCodePattern.test(methodSource)) {
        throw new Error('Could not find method_1325 try insertion marker.');
    }

    methodSource = methodSource.replace(
        endCodePattern,
        [
            '$1',
            '                                                                                                                                                                                                                                                                                                                                                                                                               ofs011b:',
            '                                                                                                                                                                                                                                                                                                                                                                                                                        newcatch 0',
            '                                                                                                                                                                                                                                                                                                                                                                                                                        dup',
            '                                                                                                                                                                                                                                                                                                                                                                                                                        setlocal 5',
            '                                                                                                                                                                                                                                                                                                                                                                                                                        dup',
            '                                                                                                                                                                                                                                                                                                                                                                                                                        pushscope',
            '                                                                                                                                                                                                                                                                                                                                                                                                                        swap',
            '                                                                                                                                                                                                                                                                                                                                                                                                                        setslot 1',
            '                                                                                                                                                                                                                                                                                                                                                                                                                        popscope',
            '                                                                                                                                                                                                                                                                                                                                                                                                                        kill 5',
            '                                                                                                                                                                                                                                                                                                                                                                                                                        getlocal2',
            '                                                                                                                                                                                                                                                                                                                                                                                                                        pushtrue',
            '                                                                                                                                                                                                                                                                                                                                                                                                                        setproperty QName(PackageInternalNs(""),"m_bFinished")',
            '                                                                                                                                                                                                                                                                                                                                                                                                                        pushtrue',
            '                                                                                                                                                                                                                                                                                                                                                                                                                        jump ofs00a1',
            '$2',
            '                                                                                                                                                                                                                                                                                                                                                                                                                  try from ofs008c to ofs009c target ofs011b type QName(PackageNamespace(""),"Error") name QName(PackageNamespace(""),"error") end',
            '$3'
        ].join('\r\n')
    );

    return `${beforeMethod}${methodSource}${afterMethod}`;
}

function patchSwf(repoRoot, ffdecPath, swfPath) {
    const workRoot = path.join(repoRoot, 'build', 'ffdec-dungeonblitz-superanim-crash-guard');
    const pcodePath = exportGamePcode(ffdecPath, workRoot, swfPath);
    const original = fs.readFileSync(pcodePath, 'utf8');
    const patched = patchPcode(original);

    if (patched === original) {
        console.log('[superanim-crash-guard] Game already patched');
        return;
    }

    fs.writeFileSync(pcodePath, patched, 'utf8');
    const patchedSwfPath = path.join(workRoot, path.basename(swfPath));
    runFfdec(ffdecPath, ['-importScript', swfPath, patchedSwfPath, path.dirname(pcodePath)]);
    fs.copyFileSync(patchedSwfPath, swfPath);
    console.log(`[superanim-crash-guard] patched ${path.relative(repoRoot, swfPath)}`);
}

function verifySwf(repoRoot, ffdecPath, swfPath) {
    const workRoot = path.join(repoRoot, 'build', 'ffdec-dungeonblitz-superanim-crash-guard-verify');
    const pcodePath = exportGamePcode(ffdecPath, workRoot, swfPath);
    const source = fs.readFileSync(pcodePath, 'utf8');
    const requiredSnippets = [
        'localcount 6',
        'newcatch 0',
        'setproperty QName(PackageInternalNs(""),"m_bFinished")'
    ];

    for (const snippet of requiredSnippets) {
        if (!source.includes(snippet)) {
            throw new Error(`Verification failed: missing snippet "${snippet}" in ${pcodePath}`);
        }
    }

    if (!/try from ofs008[cd] to ofs009c target ofs011[bc] type QName\(PackageNamespace\(""\),"Error"\)/.test(source)) {
        throw new Error(`Verification failed: missing method_1325 SuperAnim try/catch in ${pcodePath}`);
    }

    console.log(`[superanim-crash-guard] verified ${path.relative(repoRoot, swfPath)}`);
}

function main() {
    const args = parseArgs(process.argv);
    const repoRoot = resolveRepoRoot();
    const ffdecPath = detectFfdec(repoRoot, args.ffdec);
    if (!ffdecPath) {
        throw new Error('FFDec not found. Pass --ffdec or restore the repo-bundled FFDec tool.');
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
    console.error('[superanim-crash-guard] failed');
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
}
