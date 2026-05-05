#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DEFAULT_SWF = path.join('src', 'client', 'content', 'localhost', 'p', 'cbp', 'DungeonBlitz.swf');
const ROOM_BRIDGE_FLAG = 'public static var serverDungeonSpawnBridge:Boolean = false;';
const ROOM_BRIDGE_METHOD = 'public static function serverDungeonSpawnEnabled';
const OLD_ROOM_BRIDGE_FLAG = 'public static var derelictionServerSpawnBridge:Boolean = false;';
const LINKUPDATER_SUPPRESSOR = 'if(this.var_1.level.internalName.indexOf("BT_Mission4") == 0 && _loc8_ == Entity.BADGUY)';
const OLD_LINKUPDATER_BRIDGE_METHOD = 'private function method_derelictionServerSpawnBridge';
const OLD_LINKUPDATER_BRIDGE_CALL = 'this.method_derelictionServerSpawnBridge(_loc2_,_loc3_,_loc8_,_loc5_,_loc6_)';
const LINKUPDATER_BRIDGE_METHOD = 'private function method_serverDungeonSpawnBridge';
const LINKUPDATER_BRIDGE_CALL = 'this.method_serverDungeonSpawnBridge(_loc2_,_loc3_,_loc8_,_loc5_,_loc6_)';
const SERVER_SPAWN_EXCLUDED_LEVELS = new Set([
    'CraftTown',
    'CraftTownTutorial',
    'TutorialBoat',
    'TutorialDungeon',
    'TutorialDungeonHard'
]);

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

function readJson(filePath, fallback) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (_error) {
        return fallback;
    }
}

function parseLevelConfigEntry(value) {
    if (typeof value !== 'string') {
        return null;
    }

    const parts = value.split(' ');
    if (parts.length < 4) {
        return null;
    }

    const [swfAndSymbol] = parts;
    const symbolName = String(swfAndSymbol ?? '').split('/').pop() || '';

    return {
        symbolName,
        isDungeon: parts[3].toLowerCase() === 'true',
        isHard: parts.includes('Hard')
    };
}

function hasHostileNpcData(repoRoot, levelName) {
    const npcDir = path.join(repoRoot, 'src', 'server', 'data', 'npcs');
    const candidates = [levelName];
    if (levelName.endsWith('Hard')) {
        candidates.push(levelName.slice(0, -4));
    }

    for (const candidate of candidates) {
        const npcPath = path.join(npcDir, `${candidate}.json`);
        const npcs = readJson(npcPath, []);
        if (Array.isArray(npcs) && npcs.some((npc) => Number(npc?.team ?? 0) === 2)) {
            return true;
        }
    }

    return false;
}

function getServerDungeonSpawnLevels(repoRoot) {
    const levelConfig = readJson(path.join(repoRoot, 'src', 'server', 'data', 'level_config.json'), {});
    const names = new Set();

    for (const [levelName, spec] of Object.entries(levelConfig)) {
        const parsed = parseLevelConfigEntry(spec);
        if (
            parsed?.isDungeon &&
            !SERVER_SPAWN_EXCLUDED_LEVELS.has(levelName) &&
            hasHostileNpcData(repoRoot, levelName)
        ) {
            names.add(levelName);
            if (parsed.symbolName) {
                names.add(parsed.symbolName);
                names.add(parsed.symbolName.replace(/^a_Level_/, ''));
            }
        }
    }

    return Array.from(names).sort();
}

function formatActionScriptString(value) {
    return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function buildServerDungeonSpawnMethod(serverDungeonLevels) {
    const condition = serverDungeonLevels.length
        ? serverDungeonLevels.map((levelName) => `_loc2_ == "${formatActionScriptString(levelName)}"`).join(' || ')
        : 'false';

    return [
        '      public static function serverDungeonSpawnEnabled(param1:Game) : Boolean',
        '      {',
        '         if(!param1 || !param1.level || !param1.level.internalName)',
        '         {',
        '            return false;',
        '         }',
        '         var _loc2_:String = param1.level.internalName;',
        `         return ${condition};`,
        '      }'
    ].join('\n');
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

function removeExistingBridgeMethod(source, marker) {
    const markerIndex = source.indexOf(marker);
    if (markerIndex === -1) {
        return source;
    }

    const lineStart = source.lastIndexOf('\n', markerIndex) + 1;
    const openBraceIndex = source.indexOf('{', markerIndex);
    const blockEnd = findBlockEnd(source, openBraceIndex);
    const lineEnd = source.indexOf('\n', blockEnd);
    return source.slice(0, lineStart) + source.slice(lineEnd === -1 ? blockEnd : lineEnd + 1);
}

function removeExistingBridgeCall(source, marker) {
    const markerIndex = source.indexOf(marker);
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

function patchScripts(repoRoot, roomPath, linkUpdaterPath) {
    const serverDungeonLevels = getServerDungeonSpawnLevels(repoRoot);
    if (serverDungeonLevels.length === 0) {
        throw new Error('No dungeon levels with hostile NPC data were found for server spawn bridging');
    }

    let roomSource = fs.readFileSync(roomPath, 'utf8');
    roomSource = roomSource.replace('null.bDisabled = param3 != "On";', '_loc4_.bDisabled = param3 != "On";');
    roomSource = roomSource.replace('null.entState != Entity.const_6', '_loc5_.entState != Entity.const_6');
    roomSource = roomSource.replace('null.gfx.m_Seq.method_34(Seq.C_USEPOWER,param3,true);', '_loc5_.gfx.m_Seq.method_34(Seq.C_USEPOWER,param3,true);');
    roomSource = roomSource.replace('null.m_TheDO.x + 200 + Math.random() * 200;', '_loc34_.m_TheDO.x + 200 + Math.random() * 200;');
    roomSource = roomSource.replace(
        /\s*var _loc8_:\* = §§findproperty\(_loc6_\);\s*var _loc9_:Number = Number\(_loc8_\._loc6_\) \+ 1;\s*_loc8_\._loc6_ = _loc9_;/,
        '\n                  _loc3_.aggroTeamID = _loc3_.aggroTeamID;'
    );
    roomSource = roomSource.replace(OLD_ROOM_BRIDGE_FLAG, ROOM_BRIDGE_FLAG);
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
    if (!roomSource.includes(ROOM_BRIDGE_METHOD)) {
        roomSource = roomSource.replace(
            ROOM_BRIDGE_FLAG,
            `${ROOM_BRIDGE_FLAG}\n      ${buildServerDungeonSpawnMethod(serverDungeonLevels)}`
        );
    } else {
        const markerIndex = roomSource.indexOf(ROOM_BRIDGE_METHOD);
        const lineStart = roomSource.lastIndexOf('\n', markerIndex) + 1;
        const openBraceIndex = roomSource.indexOf('{', markerIndex);
        const blockEnd = findBlockEnd(roomSource, openBraceIndex);
        const lineEnd = roomSource.indexOf('\n', blockEnd);
        roomSource = roomSource.slice(0, lineStart) +
            buildServerDungeonSpawnMethod(serverDungeonLevels) +
            roomSource.slice(lineEnd === -1 ? blockEnd : lineEnd);
    }

    roomSource = roomSource.replace(
        'if(this.var_1.level.internalName.indexOf("BT_Mission4") == 0 && !Room.derelictionServerSpawnBridge)',
        'if(Room.serverDungeonSpawnEnabled(this.var_1) && !Room.serverDungeonSpawnBridge)'
    );
    roomSource = roomSource.replace(
        'if(this.var_1.level.internalName.indexOf("BT_Mission4") == 0 && !Room.serverDungeonSpawnBridge)',
        'if(Room.serverDungeonSpawnEnabled(this.var_1) && !Room.serverDungeonSpawnBridge)'
    );
    if (!roomSource.includes('Room.serverDungeonSpawnEnabled(this.var_1) && !Room.serverDungeonSpawnBridge')) {
        const insertionPoint = '         var _loc5_:class_37 = null;';
        if (!roomSource.includes(insertionPoint)) {
            throw new Error('Room.as insertion point for the server dungeon local SpawnCue blocker was not found');
        }
        roomSource = roomSource.replace(
            insertionPoint,
            [
                '         if(Room.serverDungeonSpawnEnabled(this.var_1) && !Room.serverDungeonSpawnBridge)',
                '         {',
                '            return null;',
                '         }',
                insertionPoint
            ].join('\n')
        );
    }
    fs.writeFileSync(roomPath, roomSource);

    let linkSource = fs.readFileSync(linkUpdaterPath, 'utf8');
    linkSource = removeDerelictionRemoteSuppressor(linkSource);
    linkSource = removeExistingBridgeMethod(linkSource, OLD_LINKUPDATER_BRIDGE_METHOD);
    linkSource = removeExistingBridgeMethod(linkSource, LINKUPDATER_BRIDGE_METHOD);
    linkSource = removeExistingBridgeCall(linkSource, OLD_LINKUPDATER_BRIDGE_CALL);
    linkSource = removeExistingBridgeCall(linkSource, LINKUPDATER_BRIDGE_CALL);
    linkSource = linkSource.replace('if(!this.var_1.serverConn)', 'if(!this.var_1 || !this.var_1.serverConn)');
    linkSource = linkSource.replace(
        /         if\(!_loc3_\)\r?\n         \{\r?\n            return;\r?\n         \}\r?\n         _loc4_ = param1\.method_45\(\);/,
        '         if(!_loc3_ || !_loc3_.var_38 || !_loc3_.velocity)\n         {\n            return;\n         }\n         _loc4_ = param1.method_45();'
    );
    linkSource = linkSource.replace(
        '            _loc3_.gfx.m_TheDO.visible = true;',
        '            if(Boolean(_loc3_.gfx) && Boolean(_loc3_.gfx.m_TheDO))\n            {\n               _loc3_.gfx.m_TheDO.visible = true;\n            }'
    );

    const methodInsertionPoint = '      private function method_1615(param1:Packet) : void';
    if (!linkSource.includes(methodInsertionPoint)) {
        throw new Error('LinkUpdater.as insertion point for server dungeon spawn bridge method was not found');
    }
    const bridgeMethod = [
        '      private function method_serverDungeonSpawnBridge(param1:uint, param2:String, param3:uint, param4:int, param5:int) : Boolean',
        '      {',
        '         var _loc6_:Room = null;',
        '         var _loc7_:a_Cue = null;',
        '         var _loc8_:Entity = null;',
        '         var _loc9_:Entity = null;',
        '         if(!Room.serverDungeonSpawnEnabled(this.var_1) || param3 != Entity.BADGUY)',
        '         {',
        '            return false;',
        '         }',
        '         if(!this.var_1.level.var_299)',
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
        '               Room.serverDungeonSpawnBridge = true;',
        '               try',
        '               {',
        '                  _loc9_ = _loc6_.SpawnCue(_loc7_);',
        '               }',
        '               finally',
        '               {',
        '                  Room.serverDungeonSpawnBridge = false;',
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
        throw new Error('LinkUpdater.as insertion point for server dungeon spawn bridge call was not found');
    }
    linkSource = linkSource.replace(
        callInsertionPoint,
        [
            callInsertionPoint,
            '         if(_loc12_ != Entity.PLAYER && this.method_serverDungeonSpawnBridge(_loc2_,_loc3_,_loc8_,_loc5_,_loc6_))',
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

    if (!roomSource.includes(ROOM_BRIDGE_METHOD)) {
        throw new Error('Room.as does not expose the server dungeon spawn level predicate');
    }
    if (!roomSource.includes(ROOM_BRIDGE_FLAG) || !roomSource.includes('Room.serverDungeonSpawnEnabled(this.var_1) && !Room.serverDungeonSpawnBridge')) {
        throw new Error('Room.as does not expose the server dungeon spawn bridge guard');
    }
    if (roomSource.includes('derelictionServerSpawnBridge')) {
        throw new Error('Room.as still uses the Dereliction-only spawn bridge flag');
    }
    if (linkSource.includes(LINKUPDATER_SUPPRESSOR)) {
        throw new Error('LinkUpdater.as still blocks BT_Mission4 server-spawned enemies');
    }
    if (linkSource.includes(OLD_LINKUPDATER_BRIDGE_METHOD) || linkSource.includes(OLD_LINKUPDATER_BRIDGE_CALL)) {
        throw new Error('LinkUpdater.as still uses the Dereliction-only server spawn bridge');
    }
    if (!linkSource.includes(LINKUPDATER_BRIDGE_METHOD) || !linkSource.includes(LINKUPDATER_BRIDGE_CALL)) {
        throw new Error('LinkUpdater.as does not authorize dungeon cue spawning from server packets');
    }
    if (!linkSource.includes('Room.serverDungeonSpawnEnabled(this.var_1)')) {
        throw new Error('LinkUpdater.as bridge is not scoped by the server dungeon spawn predicate');
    }
    if (!linkSource.includes('GetEntFromID(param1)')) {
        throw new Error('LinkUpdater.as does not ignore repeated dungeon server spawn retries for live ids');
    }
    if (!linkSource.includes('!_loc3_.var_38 || !_loc3_.velocity')) {
        throw new Error('LinkUpdater.as does not guard incremental updates for partially spawned entities');
    }
}

function patchSwf(repoRoot, ffdecPath, swfPath) {
    const workRoot = path.join(repoRoot, 'build', 'ffdec-dungeonblitz-dereliction-server-spawn-client');
    const { scriptsRoot, roomPath, linkUpdaterPath } = exportScripts(repoRoot, ffdecPath, swfPath, workRoot);
    patchScripts(repoRoot, roomPath, linkUpdaterPath);
    verifyScripts(roomPath, linkUpdaterPath);

    const patchedSwfPath = path.join(workRoot, `${path.basename(swfPath, path.extname(swfPath))}.patched.swf`);
    runFfdec(ffdecPath, ['-importScript', swfPath, patchedSwfPath, scriptsRoot]);
    fs.copyFileSync(patchedSwfPath, swfPath);
    console.log(`Patched dungeon server-spawn bridge in ${swfPath}`);
}

function verifySwf(repoRoot, ffdecPath, swfPath) {
    const workRoot = path.join(repoRoot, 'build', 'ffdec-dungeonblitz-dereliction-server-spawn-client-verify');
    const { roomPath, linkUpdaterPath } = exportScripts(repoRoot, ffdecPath, swfPath, workRoot);
    verifyScripts(roomPath, linkUpdaterPath);
    console.log(`Verified dungeon server-spawn bridge in ${swfPath}`);
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
