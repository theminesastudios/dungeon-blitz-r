#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DEFAULT_SWF = path.join('src', 'client', 'content', 'localhost', 'p', 'cbp', 'DungeonBlitz.swf');
const TEAM_DUNGEON_JOINER_GUARD = 'if(!Room.serverDungeonSpawnBridge && this.bInstanced && this.var_1 && this.var_1.groupmates && this.var_1.groupmates.length && !this.var_1.bAmGroupLeader)';

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
            console.log('Usage: node src/server/scripts/patch-dungeonblitz-team-dungeon-spawns.js [--verify] [--swf <path>] [--ffdec <path>]');
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

function buildJoinerGuard(source) {
    return joinLines(source, [
        `         ${TEAM_DUNGEON_JOINER_GUARD}`,
        '         {',
        '            if(param1.team != "friend")',
        '            {',
        '               return null;',
        '            }',
        '         }'
    ]);
}

function patchRoom(source) {
    if (!source.includes('public static var serverDungeonSpawnBridge:Boolean = false;')) {
        throw new Error('Room.as is missing the server dungeon spawn bridge flag');
    }

    const patchedGuard = buildJoinerGuard(source);
    if (source.includes(TEAM_DUNGEON_JOINER_GUARD)) {
        return source;
    }

    const oldGuard = joinLines(source, [
        '         if(this.bInstanced && this.var_1.groupmates && this.var_1.groupmates.length && !this.var_1.bAmGroupLeader)',
        '         {',
        '            if(param1.team != "friend")',
        '            {',
        '               return null;',
        '            }',
        '         }'
    ]);
    if (source.includes(oldGuard)) {
        return source.replace(oldGuard, patchedGuard);
    }

    const marker = joinLines(source, [
        '         if(!_loc3_ || !_loc3_.entName.indexOf("EmberBush"))',
        '         {',
        '            return null;',
        '         }',
        '         if(param1.bRareSpawn)'
    ]);
    if (!source.includes(marker)) {
        throw new Error('Room.as SpawnCue insertion point was not found');
    }

    return source.replace(
        marker,
        joinLines(source, [
            '         if(!_loc3_ || !_loc3_.entName.indexOf("EmberBush"))',
            '         {',
            '            return null;',
            '         }',
            patchedGuard,
            '         if(param1.bRareSpawn)'
        ])
    );
}

function exportRoom(repoRoot, ffdecPath, swfPath, workRoot) {
    fs.rmSync(workRoot, { recursive: true, force: true });
    fs.mkdirSync(workRoot, { recursive: true });
    runFfdec(ffdecPath, ['-selectclass', 'Room', '-export', 'script', workRoot, swfPath]);

    const scriptsRoot = path.join(workRoot, 'scripts');
    const roomPath = path.join(scriptsRoot, 'Room.as');
    if (!fs.existsSync(roomPath)) {
        throw new Error(`FFDec export did not produce Room.as in ${scriptsRoot}`);
    }

    return { scriptsRoot, roomPath };
}

function verifyRoom(roomPath) {
    const source = fs.readFileSync(roomPath, 'utf8');
    if (!source.includes(TEAM_DUNGEON_JOINER_GUARD)) {
        throw new Error('Room.as is missing the team dungeon joiner spawn guard');
    }
}

function patchSwf(repoRoot, ffdecPath, swfPath) {
    const workRoot = path.join(repoRoot, 'build', 'ffdec-dungeonblitz-team-dungeon-spawns');
    const { scriptsRoot, roomPath } = exportRoom(repoRoot, ffdecPath, swfPath, workRoot);
    const original = fs.readFileSync(roomPath, 'utf8');
    const patched = patchRoom(original);

    if (patched === original) {
        verifyRoom(roomPath);
        console.log(`SWF already contains team dungeon spawn guard: ${swfPath}`);
        return;
    }

    fs.writeFileSync(roomPath, patched, 'utf8');
    verifyRoom(roomPath);

    const patchedSwfPath = path.join(workRoot, `${path.basename(swfPath, path.extname(swfPath))}.patched.swf`);
    runFfdec(ffdecPath, ['-importScript', swfPath, patchedSwfPath, scriptsRoot]);
    fs.copyFileSync(patchedSwfPath, swfPath);
    console.log(`Patched team dungeon spawn guard in ${swfPath}`);
}

function verifySwf(repoRoot, ffdecPath, swfPath) {
    const workRoot = path.join(repoRoot, 'build', 'ffdec-dungeonblitz-team-dungeon-spawns-verify');
    const { roomPath } = exportRoom(repoRoot, ffdecPath, swfPath, workRoot);
    verifyRoom(roomPath);
    console.log(`Verified team dungeon spawn guard in ${swfPath}`);
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
