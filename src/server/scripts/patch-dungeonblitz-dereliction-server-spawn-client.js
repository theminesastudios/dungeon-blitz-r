#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DEFAULT_SWF = path.join('src', 'client', 'content', 'localhost', 'p', 'cbp', 'DungeonBlitz.swf');
const ROOM_BRIDGE_FLAG = 'public static var derelictionServerSpawnBridge:Boolean = false;';
const LINKUPDATER_SUPPRESSOR = 'if(this.var_1.level.internalName.indexOf("BT_Mission4") == 0 && _loc8_ == Entity.BADGUY)';
const LINKUPDATER_BRIDGE_METHOD = 'private function method_derelictionServerSpawnBridge';
const LINKUPDATER_BRIDGE_CALL = 'this.method_derelictionServerSpawnBridge(_loc2_,_loc3_,_loc8_,_loc5_,_loc6_)';

function parseArgs(argv) {
    const args = {
        ffdec: '',
        swf: DEFAULT_SWF,
        verify: false
    };

    for (let index = 2; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === '--ffdec' || arg === '-f') {
            args.ffdec = argv[++index] || '';
            continue;
        }
        if (arg === '--swf' || arg === '-s') {
            args.swf = argv[++index] || DEFAULT_SWF;
            continue;
        }
        if (arg === '--verify') {
            args.verify = true;
            continue;
        }
        if (arg === '--help' || arg === '-h') {
            console.log('Usage: node src/server/scripts/patch-dungeonblitz-dereliction-server-spawn-client.js [--verify] [--swf <path>] [--ffdec <path>]');
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
        path.join(repoRoot, 'build', 'ffdec', 'ffdec.sh'),
        path.join(repoRoot, 'build', 'ffdec', 'ffdec.jar'),
        path.join(repoRoot, 'build', 'ffdec', 'ffdec-cli.jar'),
        '/Applications/FFDec.app/Contents/Resources/ffdec.sh',
        '/Applications/FFDec.app/Contents/Resources/ffdec.jar',
        '/Applications/FFDec.app/Contents/Resources/ffdec-cli.jar'
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

function exportScripts(repoRoot, ffdecPath, swfPath, workRoot) {
    fs.rmSync(workRoot, { recursive: true, force: true });
    fs.mkdirSync(workRoot, { recursive: true });
    runFfdec(ffdecPath, ['-selectclass', 'Room,LinkUpdater', '-export', 'script', workRoot, swfPath]);

    const scriptsRoot = path.join(workRoot, 'scripts');
    const roomPath = path.join(scriptsRoot, 'Room.as');
    const linkUpdaterPath = path.join(scriptsRoot, 'LinkUpdater.as');
    if (!fs.existsSync(roomPath) || !fs.existsSync(linkUpdaterPath)) {
        throw new Error('FFDec export did not produce Room.as and LinkUpdater.as');
    }

    return { scriptsRoot, roomPath, linkUpdaterPath };
}

function findBlockEnd(source, openBraceIndex) {
    let depth = 0;
    for (let index = openBraceIndex; index < source.length; index++) {
        const char = source[index];
        if (char === '{') {
            depth++;
        } else if (char === '}') {
            depth--;
            if (depth === 0) {
                return index + 1;
            }
        }
    }

    throw new Error('Could not find matching brace while removing LinkUpdater Dereliction suppressor');
}

function removeDerelictionRemoteSuppressor(source) {
    const markerIndex = source.indexOf(LINKUPDATER_SUPPRESSOR);
    if (markerIndex === -1) {
        return source;
    }

    const lineStart = source.lastIndexOf('\n', markerIndex) + 1;
    const openBraceIndex = source.indexOf('{', markerIndex);
    const blockEnd = findBlockEnd(source, openBraceIndex);
    const lineEnd = source.indexOf('\n', blockEnd);
    return source.slice(0, lineStart) + source.slice(lineEnd === -1 ? blockEnd : lineEnd + 1);
}

function removeExistingDerelictionBridgeMethod(source) {
    const markerIndex = source.indexOf(LINKUPDATER_BRIDGE_METHOD);
    if (markerIndex === -1) {
        return source;
    }

    const lineStart = source.lastIndexOf('\n', markerIndex) + 1;
    const openBraceIndex = source.indexOf('{', markerIndex);
    const blockEnd = findBlockEnd(source, openBraceIndex);
    const lineEnd = source.indexOf('\n', blockEnd);
    return source.slice(0, lineStart) + source.slice(lineEnd === -1 ? blockEnd : lineEnd + 1);
}

function removeExistingDerelictionBridgeCall(source) {
    const markerIndex = source.indexOf(LINKUPDATER_BRIDGE_CALL);
    if (markerIndex === -1) {
        return source;
    }

    const ifStart = source.lastIndexOf('if(', markerIndex);
    if (ifStart === -1) {
        return source;
    }
    const lineStart = source.lastIndexOf('\n', ifStart) + 1;
    const openBraceIndex = source.indexOf('{', markerIndex);
    const blockEnd = findBlockEnd(source, openBraceIndex);
    const lineEnd = source.indexOf('\n', blockEnd);
    return source.slice(0, lineStart) + source.slice(lineEnd === -1 ? blockEnd : lineEnd + 1);
}

function patchScripts(roomPath, linkUpdaterPath) {
    let roomSource = fs.readFileSync(roomPath, 'utf8');
    roomSource = roomSource.replace('null.bDisabled = param3 != "On";', '_loc4_.bDisabled = param3 != "On";');
    roomSource = roomSource.replace('null.entState != Entity.const_6', '_loc5_.entState != Entity.const_6');
    roomSource = roomSource.replace('null.gfx.m_Seq.method_34(Seq.C_USEPOWER,param3,true);', '_loc5_.gfx.m_Seq.method_34(Seq.C_USEPOWER,param3,true);');
    roomSource = roomSource.replace('null.m_TheDO.x + 200 + Math.random() * 200;', '_loc34_.m_TheDO.x + 200 + Math.random() * 200;');
    roomSource = roomSource.replace(
        /\s*var _loc8_:\* = §§findproperty\(_loc6_\);\s*var _loc9_:Number = Number\(_loc8_\._loc6_\) \+ 1;\s*_loc8_\._loc6_ = _loc9_;/,
        '\n                  _loc3_.aggroTeamID = _loc3_.aggroTeamID;'
    );
    if (!roomSource.includes(ROOM_BRIDGE_FLAG)) {
        const classOpen = '   public class Room';
        const classIndex = roomSource.indexOf(classOpen);
        if (classIndex === -1) {
            throw new Error('Room.as class declaration was not found');
        }
        const braceIndex = roomSource.indexOf('{', classIndex);
        roomSource = roomSource.slice(0, braceIndex + 1) +
            `\n      ${ROOM_BRIDGE_FLAG}\n` +
            roomSource.slice(braceIndex + 1);
    }
    if (!roomSource.includes('this.var_1.level.internalName.indexOf("BT_Mission4") == 0')) {
        const insertionPoint = '         var _loc5_:class_37 = null;';
        if (!roomSource.includes(insertionPoint)) {
            throw new Error('Room.as insertion point for the Dereliction local SpawnCue blocker was not found');
        }
        roomSource = roomSource.replace(
            insertionPoint,
            [
                '         if(this.var_1.level.internalName.indexOf("BT_Mission4") == 0)',
                '         {',
                '            return null;',
                '         }',
                insertionPoint
            ].join('\n')
        );
    }
    roomSource = roomSource.replace(
        'if(this.var_1.level.internalName.indexOf("BT_Mission4") == 0)',
        'if(this.var_1.level.internalName.indexOf("BT_Mission4") == 0 && !Room.derelictionServerSpawnBridge)'
    );
    fs.writeFileSync(roomPath, roomSource);

    let linkSource = fs.readFileSync(linkUpdaterPath, 'utf8');
    linkSource = removeDerelictionRemoteSuppressor(linkSource);
    linkSource = removeExistingDerelictionBridgeMethod(linkSource);
    linkSource = removeExistingDerelictionBridgeCall(linkSource);

    const methodInsertionPoint = '      private function method_1615(param1:Packet) : void';
    if (!linkSource.includes(methodInsertionPoint)) {
        throw new Error('LinkUpdater.as insertion point for Dereliction server spawn bridge method was not found');
    }
    const bridgeMethod = [
        '      private function method_derelictionServerSpawnBridge(param1:uint, param2:String, param3:uint, param4:int, param5:int) : Boolean',
        '      {',
        '         var _loc6_:Room = null;',
        '         var _loc7_:a_Cue = null;',
        '         var _loc8_:Entity = null;',
        '         var _loc9_:Entity = null;',
        '         if(!this.var_1 || !this.var_1.level || this.var_1.level.internalName.indexOf("BT_Mission4") != 0 || param3 != Entity.BADGUY)',
        '         {',
        '            return false;',
        '         }',
        '         _loc8_ = this.var_1.GetEntFromID(param1);',
        '         if(Boolean(_loc8_) && Boolean(_loc8_.bIAmValid))',
        '         {',
        '            return true;',
        '         }',
        '         for each(_loc6_ in this.var_1.level.var_299)',
        '         {',
        '            for each(_loc7_ in _loc6_.var_460)',
        '            {',
        '               if(!_loc7_ || _loc7_.bSpawned || _loc7_.entType != param2)',
        '               {',
        '                  continue;',
        '               }',
        '               Room.derelictionServerSpawnBridge = true;',
        '               try',
        '               {',
        '                  _loc9_ = _loc6_.SpawnCue(_loc7_);',
        '               }',
        '               finally',
        '               {',
        '                  Room.derelictionServerSpawnBridge = false;',
        '               }',
        '               if(_loc9_)',
        '               {',
        '                  _loc9_.id = param1;',
        '                  _loc9_.team = param3;',
        '                  return true;',
        '               }',
        '            }',
        '         }',
        '         return false;',
        '      }',
        '      ',
        ''
    ].join('\n');
    linkSource = linkSource.replace(methodInsertionPoint, bridgeMethod + methodInsertionPoint);

    const callInsertionPoint = '         _loc34_ = param1.method_11();';
    if (!linkSource.includes(callInsertionPoint)) {
        throw new Error('LinkUpdater.as insertion point for Dereliction server spawn bridge call was not found');
    }
    linkSource = linkSource.replace(
        callInsertionPoint,
        [
            callInsertionPoint,
            '         if(_loc12_ != Entity.PLAYER && this.method_derelictionServerSpawnBridge(_loc2_,_loc3_,_loc8_,_loc5_,_loc6_))',
            '         {',
            '            return;',
            '         }'
        ].join('\n')
    );
    fs.writeFileSync(linkUpdaterPath, linkSource);
}

function verifyScripts(roomPath, linkUpdaterPath) {
    const roomSource = fs.readFileSync(roomPath, 'utf8');
    const linkSource = fs.readFileSync(linkUpdaterPath, 'utf8');

    if (!roomSource.includes('this.var_1.level.internalName.indexOf("BT_Mission4") == 0')) {
        throw new Error('Room.as does not block local BT_Mission4 room cue spawning');
    }
    if (!roomSource.includes(ROOM_BRIDGE_FLAG) || !roomSource.includes('&& !Room.derelictionServerSpawnBridge')) {
        throw new Error('Room.as does not expose the Dereliction server spawn bridge guard');
    }
    if (linkSource.includes(LINKUPDATER_SUPPRESSOR)) {
        throw new Error('LinkUpdater.as still blocks BT_Mission4 server-spawned enemies');
    }
    if (!linkSource.includes(LINKUPDATER_BRIDGE_METHOD) || !linkSource.includes(LINKUPDATER_BRIDGE_CALL)) {
        throw new Error('LinkUpdater.as does not authorize Dereliction cue spawning from server packets');
    }
    if (linkSource.includes('Math.abs(_loc8_.x - param4)')) {
        throw new Error('LinkUpdater.as still rejects Dereliction server spawns by fragile coordinate matching');
    }
    if (!linkSource.includes('GetEntFromID(param1)')) {
        throw new Error('LinkUpdater.as does not ignore repeated Dereliction server spawn retries for live ids');
    }
}

function patchSwf(repoRoot, ffdecPath, swfPath) {
    const workRoot = path.join(repoRoot, 'build', 'ffdec-dungeonblitz-dereliction-server-spawn-client');
    const { scriptsRoot, roomPath, linkUpdaterPath } = exportScripts(repoRoot, ffdecPath, swfPath, workRoot);
    patchScripts(roomPath, linkUpdaterPath);
    verifyScripts(roomPath, linkUpdaterPath);

    const patchedSwfPath = path.join(workRoot, `${path.basename(swfPath, path.extname(swfPath))}.patched.swf`);
    runFfdec(ffdecPath, ['-importScript', swfPath, patchedSwfPath, scriptsRoot]);
    fs.copyFileSync(patchedSwfPath, swfPath);
    console.log(`Patched Dereliction server-spawn bridge in ${swfPath}`);
}

function verifySwf(repoRoot, ffdecPath, swfPath) {
    const workRoot = path.join(repoRoot, 'build', 'ffdec-dungeonblitz-dereliction-server-spawn-client-verify');
    const { roomPath, linkUpdaterPath } = exportScripts(repoRoot, ffdecPath, swfPath, workRoot);
    verifyScripts(roomPath, linkUpdaterPath);
    console.log(`Verified Dereliction server-spawn bridge in ${swfPath}`);
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
    console.error(error);
    process.exitCode = 1;
}
