#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DEFAULT_SWF = path.join('src', 'client', 'content', 'localhost', 'p', 'cbp', 'DungeonBlitz.swf');
const ORIGINAL = [
    '            else if(_loc56_ == "ProcMassiveTime")',
    '            {',
    '               _loc3_.var_470 = true;',
    '            }'
].join('\n');
const PATCHED = [
    ORIGINAL,
    '            else if(_loc56_ == "ProcCriticalHit")',
    '            {',
    '               _loc3_.var_470 = true;',
    '            }'
].join('\n');

function repoRoot() {
    return path.resolve(__dirname, '..', '..', '..');
}

function parseArgs(argv) {
    const args = { swf: DEFAULT_SWF, ffdec: '', verify: false };
    for (let index = 2; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--swf' || arg === '-s') args.swf = argv[++index] || '';
        else if (arg === '--ffdec' || arg === '-f') args.ffdec = argv[++index] || '';
        else if (arg === '--verify') args.verify = true;
        else throw new Error(`Unknown argument: ${arg}`);
    }
    return args;
}

function resolveFromRoot(root, value) {
    return path.isAbsolute(value) ? value : path.join(root, value);
}

function detectFfdec(root, preferred) {
    const candidates = [
        preferred && resolveFromRoot(root, preferred),
        path.join(root, 'build', 'ffdec', 'ffdec.jar'),
        '/Applications/FFDec.app/Contents/Resources/ffdec.jar'
    ];
    return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || '';
}

function runFfdec(ffdecPath, args) {
    if (ffdecPath.toLowerCase().endsWith('.jar')) {
        execFileSync('java', ['-jar', ffdecPath, '-cli', ...args], { stdio: 'inherit' });
    } else {
        execFileSync(ffdecPath, ['-cli', ...args], { stdio: 'inherit' });
    }
}

function exportPowerType(ffdecPath, workRoot, swfPath) {
    fs.rmSync(workRoot, { recursive: true, force: true });
    fs.mkdirSync(workRoot, { recursive: true });
    runFfdec(ffdecPath, ['-selectclass', 'PowerType', '-export', 'script', workRoot, swfPath]);
    const classPath = path.join(workRoot, 'scripts', 'PowerType.as');
    if (!fs.existsSync(classPath)) throw new Error(`FFDec did not export ${classPath}`);
    return classPath;
}

function verifySource(source, swfPath) {
    const normalized = source.replace(/\r\n/g, '\n');
    if (!normalized.includes(PATCHED)) {
        throw new Error(`${swfPath}: ProcCriticalHit is not marked as critical-power-scaled`);
    }
}

function main() {
    const root = repoRoot();
    const args = parseArgs(process.argv);
    const swfPath = resolveFromRoot(root, args.swf);
    const ffdecPath = detectFfdec(root, args.ffdec);
    if (!ffdecPath) throw new Error('FFDec not found; pass --ffdec <path>.');
    if (!fs.existsSync(swfPath)) throw new Error(`SWF not found: ${swfPath}`);

    const workRoot = path.join(root, 'build', args.verify ? 'ffdec-critical-power-verify' : 'ffdec-critical-power');
    const classPath = exportPowerType(ffdecPath, workRoot, swfPath);
    let source = fs.readFileSync(classPath, 'utf8').replace(/\r\n/g, '\n');

    if (args.verify) {
        verifySource(source, swfPath);
        console.log('Critical power patch verified.');
        return;
    }
    if (!source.includes(PATCHED)) {
        if (!source.includes(ORIGINAL)) throw new Error(`${swfPath}: unexpected PowerType proc classification block`);
        source = source.replace(ORIGINAL, PATCHED);
        fs.writeFileSync(classPath, source);
        const patchedSwf = path.join(workRoot, 'DungeonBlitz.patched.swf');
        runFfdec(ffdecPath, ['-importScript', swfPath, patchedSwf, path.dirname(classPath)]);
        fs.copyFileSync(patchedSwf, swfPath);
    }

    const verifyRoot = `${workRoot}-postverify`;
    const verifyPath = exportPowerType(ffdecPath, verifyRoot, swfPath);
    verifySource(fs.readFileSync(verifyPath, 'utf8'), swfPath);
    console.log('Critical power patch applied.');
}

main();
