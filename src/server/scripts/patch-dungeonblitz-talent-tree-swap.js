#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function repoRoot() {
    return path.resolve(__dirname, '..', '..', '..');
}

function resolvePath(root, value) {
    return path.isAbsolute(value) ? value : path.join(root, value);
}

function detectFfdec(root, preferred) {
    const candidates = [];
    if (preferred) {
        candidates.push(resolvePath(root, preferred));
    }

    candidates.push(
        path.join(root, 'build', 'tools', 'ffdec_26.0.0', 'ffdec.jar'),
        path.join(root, 'build', 'tools', 'ffdec_25.1.3', 'ffdec.jar'),
        path.join(root, 'build', 'ffdec', 'ffdec.jar'),
        path.join(root, 'build', 'ffdec', 'ffdec-cli.jar')
    );

    for (const candidate of candidates) {
        if (candidate && fs.existsSync(candidate)) {
            return candidate;
        }
    }

    return '';
}

function parseArgs(argv) {
    const args = {
        ffdec: '',
        swf: path.join('src', 'client', 'content', 'localhost', 'p', 'cbp', 'DungeonBlitz.swf'),
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
        if (arg === '--verify') {
            args.verify = true;
            continue;
        }
        throw new Error(`Unknown argument: ${arg}`);
    }

    return args;
}

function runFfdec(ffdecPath, args) {
    const basename = path.basename(ffdecPath).toLowerCase();
    if (basename.endsWith('.jar')) {
        execFileSync('java', ['-jar', ffdecPath, '-cli', ...args], { stdio: 'inherit' });
        return;
    }

    execFileSync(ffdecPath, ['-cli', ...args], { stdio: 'inherit' });
}

function cleanDir(dirPath) {
    fs.rmSync(dirPath, { recursive: true, force: true });
    fs.mkdirSync(dirPath, { recursive: true });
}

function exportLinkUpdater(ffdecPath, workRoot, swfPath) {
    cleanDir(workRoot);
    runFfdec(ffdecPath, ['-selectclass', 'LinkUpdater', '-export', 'script', workRoot, swfPath]);

    const linkUpdaterPath = path.join(workRoot, 'scripts', 'LinkUpdater.as');
    if (!fs.existsSync(linkUpdaterPath)) {
        throw new Error(`FFDec export did not produce ${linkUpdaterPath}`);
    }

    return linkUpdaterPath;
}

function patchSource(source) {
    const eol = source.includes('\r\n') ? '\r\n' : '\n';
    const original = [
        '               var _loc7_:uint = class_118.method_277(_loc6_);',
        '               var _loc8_:uint = 1;',
        '               var _loc9_:uint = param1.method_6(class_118.const_127);',
        '               _loc8_ = 0 + param1.method_6(0);',
        '               var _loc10_:class_22 = class_14.var_368[_loc4_][0];',
        '               _loc5_.var_58[_loc6_] = new class_148(null,0);'
    ].join(eol);
    const patched = [
        '               var _loc7_:uint = class_118.method_277(_loc6_);',
        '               var _loc8_:uint = 1;',
        '               var _loc9_:uint = param1.method_6(class_118.const_127);',
        '               _loc8_ += param1.method_6(_loc7_);',
        '               var _loc10_:class_22 = class_14.var_368[_loc4_][_loc9_];',
        '               _loc5_.var_58[_loc6_] = new class_148(_loc10_,_loc8_);'
    ].join(eol);

    if (source.includes(patched)) {
        return source;
    }
    if (!source.includes(original)) {
        throw new Error('Could not find LinkUpdater.method_1914 talent decode block');
    }

    return source.replace(original, patched);
}

function verifySource(source) {
    const required = [
        '_loc8_ += param1.method_6(_loc7_);',
        'class_14.var_368[_loc4_][_loc9_]',
        'new class_148(_loc10_,_loc8_)'
    ];

    for (const snippet of required) {
        if (!source.includes(snippet)) {
            throw new Error(`Verification missing snippet: ${snippet}`);
        }
    }
}

function ensureBackup(swfPath) {
    const backupPath = `${swfPath}.bak`;
    if (!fs.existsSync(backupPath)) {
        fs.copyFileSync(swfPath, backupPath);
    }
}

function main() {
    const root = repoRoot();
    const args = parseArgs(process.argv);
    const ffdecPath = detectFfdec(root, args.ffdec);
    if (!ffdecPath) {
        throw new Error('FFDec not found. Pass --ffdec if it is outside build/tools.');
    }

    const swfPath = resolvePath(root, args.swf);
    const workRoot = path.join(root, 'build', args.verify ? 'ffdec-talent-tree-swap-verify' : 'ffdec-talent-tree-swap');
    const linkUpdaterPath = exportLinkUpdater(ffdecPath, workRoot, swfPath);
    const source = fs.readFileSync(linkUpdaterPath, 'utf8');

    if (args.verify) {
        verifySource(source);
        console.log(`[talent-tree-swap] verified ${path.relative(root, swfPath)}`);
        return;
    }

    const patched = patchSource(source);
    verifySource(patched);
    if (patched === source) {
        console.log(`[talent-tree-swap] already patched ${path.relative(root, swfPath)}`);
        return;
    }

    fs.writeFileSync(linkUpdaterPath, patched, 'utf8');
    const patchedSwfPath = path.join(workRoot, path.basename(swfPath));
    ensureBackup(swfPath);
    runFfdec(ffdecPath, ['-importScript', swfPath, patchedSwfPath, path.dirname(linkUpdaterPath)]);
    fs.copyFileSync(patchedSwfPath, swfPath);
    console.log(`[talent-tree-swap] patched ${path.relative(root, swfPath)}`);
}

main();
