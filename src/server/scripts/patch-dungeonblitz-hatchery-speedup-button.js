#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DEFAULT_SWF = path.join('src', 'client', 'content', 'localhost', 'p', 'cbp', 'DungeonBlitz.swf');

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
                '  node src/server/scripts/patch-dungeonblitz-hatchery-speedup-button.js [--verify] [--swf <path>] [--ffdec <path>]',
                '',
                'Patches class_99 so hatchery Speed Up stays usable during active and free tutorial egg timers.'
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
        path.join(repoRoot, 'build', 'tools', 'ffdec_26.0.0', 'ffdec.jar'),
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
    runFfdec(repoRoot, ffdecPath, ['-selectclass', 'class_99', '-export', 'script', workRoot, swfPath]);

    const classPath = path.join(workRoot, 'scripts', 'class_99.as');
    if (!fs.existsSync(classPath)) {
        throw new Error(`FFDec export did not produce ${classPath}`);
    }

    return classPath;
}

function patchSource(source) {
    const eol = source.includes('\r\n') ? '\r\n' : '\n';
    const marker = '            this.var_1324.EnableButton();';
    const patchedTimerPanelBlock = [
        '            this.var_1134.Show();',
        marker,
        '            this.var_190.Show();'
    ].join(eol);

    let patched = source;

    const originalTimerPanelBlock = [
        '            this.var_1134.Show();',
        '            this.var_190.Show();'
    ].join(eol);

    if (!patched.includes(patchedTimerPanelBlock)) {
        if (!patched.includes(originalTimerPanelBlock)) {
            throw new Error('Could not find class_99 active timer speed-up panel block.');
        }
        patched = patched.replace(originalTimerPanelBlock, patchedTimerPanelBlock);
    }

    const patchedFreeSpeedupBlock = [
        '         this.var_190.mHealthPerc = 0;',
        '         if(_loc5_ > 0)',
        '         {',
        '            this.var_1324.DisableButton("Inactive");',
        '         }',
        '         _loc3_.method_9(_loc5_);',
        '         var_1.serverConn.SendPacket(_loc3_);',
        '         if(_loc5_ == 0 && _loc2_.mEggStatus == class_81.const_131)',
        '         {',
        '            _loc2_.SetEggData(_loc2_.mIncubatingEggID,0);',
        '            Refresh();',
        '         }',
        '         this.ResetSelectors();'
    ].join(eol);

    if (patched.includes(patchedFreeSpeedupBlock)) {
        return patched;
    }

    const originalFreeSpeedupBlock = [
        '         this.var_190.mHealthPerc = 0;',
        '         this.var_1324.DisableButton("Inactive");',
        '         _loc3_.method_9(_loc5_);',
        '         var_1.serverConn.SendPacket(_loc3_);',
        '         this.ResetSelectors();'
    ].join(eol);

    if (!patched.includes(originalFreeSpeedupBlock)) {
        throw new Error('Could not find class_99 speed-up click handler send block.');
    }

    return patched.replace(originalFreeSpeedupBlock, patchedFreeSpeedupBlock);
}

function verifySource(source) {
    if (!source.includes('this.var_1134.Show();') || !source.includes('this.var_1324.EnableButton();')) {
        throw new Error('Missing hatchery speed-up button enable marker.');
    }

    const expected = /this\.var_1134\.Show\(\);\s*this\.var_1324\.EnableButton\(\);\s*this\.var_190\.Show\(\);/;
    if (!expected.test(source)) {
        throw new Error('class_99 speed-up button enable marker is not in the active timer panel block.');
    }

    const freeSpeedupExpected = /if\(_loc5_ > 0\)\s*\{\s*this\.var_1324\.DisableButton\("Inactive"\);\s*\}\s*_loc3_\.method_9\(_loc5_\);\s*var_1\.serverConn\.SendPacket\(_loc3_\);\s*if\(_loc5_ == 0 && _loc2_\.mEggStatus == class_81\.const_131\)\s*\{\s*_loc2_\.SetEggData\(_loc2_\.mIncubatingEggID,0\);\s*Refresh\(\);\s*\}/;
    if (!freeSpeedupExpected.test(source)) {
        throw new Error('class_99 free egg speed-up handler patch is missing.');
    }
}

function ensureBackup(swfPath) {
    const backupPath = `${swfPath}.bak`;
    if (!fs.existsSync(backupPath)) {
        fs.copyFileSync(swfPath, backupPath);
    }
}

function patchSwf(repoRoot, ffdecPath, swfPath) {
    const workRoot = path.join(repoRoot, 'build', 'ffdec-dungeonblitz-hatchery-speedup-button');
    const classPath = exportScripts(repoRoot, ffdecPath, workRoot, swfPath);
    const patched = patchSource(fs.readFileSync(classPath, 'utf8'));
    fs.writeFileSync(classPath, patched, 'utf8');
    verifySource(patched);

    const patchedSwfPath = `${swfPath}.patched`;
    fs.rmSync(patchedSwfPath, { force: true });
    ensureBackup(swfPath);
    runFfdec(repoRoot, ffdecPath, ['-importScript', swfPath, patchedSwfPath, path.join(workRoot, 'scripts')]);
    fs.renameSync(patchedSwfPath, swfPath);
}

function verifySwf(repoRoot, ffdecPath, swfPath) {
    const workRoot = path.join(repoRoot, 'build', 'ffdec-dungeonblitz-hatchery-speedup-button-verify');
    const classPath = exportScripts(repoRoot, ffdecPath, workRoot, swfPath);
    verifySource(fs.readFileSync(classPath, 'utf8'));
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
    console.log(`${args.verify ? 'Verified' : 'Patched'} hatchery Speed Up button state in ${swfPath}`);
}

main();
