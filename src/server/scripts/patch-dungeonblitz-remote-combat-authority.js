#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DEFAULT_SWF = path.join('src', 'client', 'content', 'localhost', 'p', 'cbp', 'DungeonBlitz.swf');
const ACTIVE_POWER_CLASS = 'ActivePower';
const LINK_UPDATER_CLASS = 'LinkUpdater';
const REMOTE_DAMAGE_PATCH = 'this.var_536 = !this.var_240;';
const REMOTE_HIT_SEND_GUARD = 'if(Boolean(param1.var_20 & Entity.PLAYER) && !Boolean(param1.var_20 & Entity.LOCAL))';
const FFDEC_REMOTE_HIT_SEND_GUARD = 'if(Boolean(param1.var_20 & Entity.PLAYER) && !(Boolean(param1.var_20 & Entity.LOCAL)))';
const LEGACY_REMOTE_HIT_SEND_GUARD = 'if(Boolean(param1.var_20 & Entity.PLAYER) && param1.id != this.var_1.clientEntID)';

function parseArgs(argv) {
    const args = {
        swf: DEFAULT_SWF,
        ffdec: '',
        verify: false
    };

    for (let index = 2; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === '--swf' || arg === '-s') {
            args.swf = argv[++index] || DEFAULT_SWF;
            continue;
        }
        if (arg === '--ffdec' || arg === '-f') {
            args.ffdec = argv[++index] || '';
            continue;
        }
        if (arg === '--verify') {
            args.verify = true;
            continue;
        }
        if (arg === '--help' || arg === '-h') {
            console.log('Usage: node src/server/scripts/patch-dungeonblitz-remote-combat-authority.js [--verify] [--swf <path>] [--ffdec <path>]');
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
    return path.isAbsolute(value) ? value : path.join(repoRoot, value);
}

function detectFfdec(repoRoot, preferred) {
    const candidates = [];
    if (preferred) {
        candidates.push(resolvePath(repoRoot, preferred));
    }
    candidates.push(
        path.join(repoRoot, 'build', 'ffdec', 'ffdec.jar'),
        path.join(repoRoot, 'build', 'ffdec', 'ffdec.sh'),
        path.join(repoRoot, 'build', 'ffdec', 'ffdec-cli.jar')
    );
    return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || '';
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

function joinLines(source, lines) {
    const eol = source.includes('\r\n') ? '\r\n' : '\n';
    return lines.join(eol);
}

function exportScripts(ffdecPath, swfPath, workRoot) {
    fs.rmSync(workRoot, { recursive: true, force: true });
    fs.mkdirSync(workRoot, { recursive: true });
    runFfdec(ffdecPath, [
        '-selectclass',
        `${ACTIVE_POWER_CLASS},${LINK_UPDATER_CLASS}`,
        '-export',
        'script',
        workRoot,
        swfPath
    ]);

    const scriptsRoot = path.join(workRoot, 'scripts');
    const activePowerPath = path.join(scriptsRoot, `${ACTIVE_POWER_CLASS}.as`);
    const linkUpdaterPath = path.join(scriptsRoot, `${LINK_UPDATER_CLASS}.as`);
    if (!fs.existsSync(activePowerPath)) {
        throw new Error(`FFDec export did not produce ${activePowerPath}`);
    }
    if (!fs.existsSync(linkUpdaterPath)) {
        throw new Error(`FFDec export did not produce ${linkUpdaterPath}`);
    }

    return { scriptsRoot, activePowerPath, linkUpdaterPath };
}

function patchActivePower(source) {
    if (source.includes(REMOTE_DAMAGE_PATCH)) {
        return source;
    }

    const oldLine = 'this.var_536 = !this.var_240 && !this.powerType.var_275 || this.powerType.var_275 && this.var_240 || true;';
    if (!source.includes(oldLine)) {
        throw new Error('ActivePower.as remote damage authority line was not found');
    }

    return source.replace(oldLine, REMOTE_DAMAGE_PATCH);
}

function patchLinkUpdater(source) {
    if (source.includes(REMOTE_HIT_SEND_GUARD) || source.includes(FFDEC_REMOTE_HIT_SEND_GUARD)) {
        return source;
    }
    if (source.includes(LEGACY_REMOTE_HIT_SEND_GUARD)) {
        return source.replace(LEGACY_REMOTE_HIT_SEND_GUARD, REMOTE_HIT_SEND_GUARD);
    }

    const marker = joinLines(source, [
        '         var _loc8_:Packet = null;',
        '         _loc8_ = new Packet(PKTTYPE_ENT_POWER_HIT);'
    ]);
    if (!source.includes(marker)) {
        throw new Error('LinkUpdater.as method_1092 insertion point was not found');
    }

    return source.replace(
        marker,
        joinLines(source, [
            '         var _loc8_:Packet = null;',
            `         ${REMOTE_HIT_SEND_GUARD}`,
            '         {',
            '            return;',
            '         }',
            '         _loc8_ = new Packet(PKTTYPE_ENT_POWER_HIT);'
        ])
    );
}

function verifySources(activePowerPath, linkUpdaterPath) {
    const activePower = fs.readFileSync(activePowerPath, 'utf8');
    const linkUpdater = fs.readFileSync(linkUpdaterPath, 'utf8');
    if (!activePower.includes(REMOTE_DAMAGE_PATCH)) {
        throw new Error('ActivePower.as is missing the remote damage authority patch');
    }
    if (!linkUpdater.includes(REMOTE_HIT_SEND_GUARD) && !linkUpdater.includes(FFDEC_REMOTE_HIT_SEND_GUARD)) {
        throw new Error('LinkUpdater.as is missing the remote hit send guard');
    }
    if (linkUpdater.includes(LEGACY_REMOTE_HIT_SEND_GUARD)) {
        throw new Error('LinkUpdater.as still contains the old clientEntID hit send guard');
    }
}

function patchSwf(repoRoot, ffdecPath, swfPath) {
    const workRoot = path.join(repoRoot, 'build', 'ffdec-dungeonblitz-remote-combat-authority');
    const { scriptsRoot, activePowerPath, linkUpdaterPath } = exportScripts(ffdecPath, swfPath, workRoot);

    const originalActivePower = fs.readFileSync(activePowerPath, 'utf8');
    const patchedActivePower = patchActivePower(originalActivePower);
    if (patchedActivePower !== originalActivePower) {
        fs.writeFileSync(activePowerPath, patchedActivePower, 'utf8');
    }

    const originalLinkUpdater = fs.readFileSync(linkUpdaterPath, 'utf8');
    const patchedLinkUpdater = patchLinkUpdater(originalLinkUpdater);
    if (patchedLinkUpdater !== originalLinkUpdater) {
        fs.writeFileSync(linkUpdaterPath, patchedLinkUpdater, 'utf8');
    }

    verifySources(activePowerPath, linkUpdaterPath);
    if (patchedActivePower === originalActivePower && patchedLinkUpdater === originalLinkUpdater) {
        console.log(`SWF already contains remote combat authority patch: ${swfPath}`);
        return;
    }

    const patchedSwfPath = path.join(workRoot, `${path.basename(swfPath, path.extname(swfPath))}.patched.swf`);
    runFfdec(ffdecPath, ['-importScript', swfPath, patchedSwfPath, scriptsRoot]);
    fs.copyFileSync(patchedSwfPath, swfPath);
    console.log(`Patched remote combat authority in ${swfPath}`);
}

function verifySwf(repoRoot, ffdecPath, swfPath) {
    const workRoot = path.join(repoRoot, 'build', 'ffdec-dungeonblitz-remote-combat-authority-verify');
    const { activePowerPath, linkUpdaterPath } = exportScripts(ffdecPath, swfPath, workRoot);
    verifySources(activePowerPath, linkUpdaterPath);
    console.log(`Verified remote combat authority patch in ${swfPath}`);
}

function main() {
    const repoRoot = resolveRepoRoot();
    const args = parseArgs(process.argv);
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
    verifySwf(repoRoot, ffdecPath, swfPath);
}

try {
    main();
} catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
}
