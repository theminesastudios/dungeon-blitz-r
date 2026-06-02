const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const CLASS_NAME = 'a_Room_GoblinBeachHard_08';
const DEFAULT_SWF = path.join('src', 'client', 'content', 'localhost', 'p', 'cbp', 'LevelsNR.swf');

function parseArgs(argv) {
  const args = {
    swf: DEFAULT_SWF,
    ffdec: '',
    verify: false
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--swf' || arg === '--swf-path') {
      args.swf = argv[++index] || args.swf;
    } else if (arg === '--ffdec' || arg === '-f') {
      args.ffdec = argv[++index] || '';
    } else if (arg === '--verify' || arg === '--dry-run') {
      args.verify = true;
    } else if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function usage() {
  console.log([
    'Usage:',
    '  node src/server/scripts/patch-levelsnr-hard-goblinbeach-room8-gate.js [--verify] [--swf <path>] [--ffdec <path>]',
    '',
    'Patches LevelsNR TutorialDungeonHard room 8 so the right-side path blocker',
    'opens when the authored gate enemies are defeated, even if RoomCleared() misses',
    'hard-mode client-spawned cue state.'
  ].join('\n'));
}

function resolveRepoRoot() {
  return path.resolve(__dirname, '..', '..', '..');
}

function resolvePath(repoRoot, maybeRelative) {
  return path.isAbsolute(maybeRelative) ? maybeRelative : path.join(repoRoot, maybeRelative);
}

function detectFfdec(repoRoot, preferred) {
  const candidates = [];
  if (preferred) {
    candidates.push(resolvePath(repoRoot, preferred));
  }

  candidates.push(
    path.join(repoRoot, 'build', 'tools', 'ffdec_25.0.0', 'ffdec-cli.exe'),
    path.join(repoRoot, 'build', 'tools', 'ffdec_25.0.0', 'ffdec-cli.jar'),
    path.join(repoRoot, 'build', 'tools', 'ffdec_25.0.0', 'ffdec.jar'),
    path.join(repoRoot, 'build', 'ffdec_24.0.1', 'ffdec-cli.exe'),
    path.join(repoRoot, 'build', 'ffdec_24.0.1', 'ffdec-cli.jar'),
    '/Applications/FFDec.app/Contents/Resources/ffdec.sh',
    '/Applications/FFDec.app/Contents/Resources/ffdec.jar',
    '/Applications/FFDec.app/Contents/Resources/ffdec-cli.jar'
  );

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
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

function exportRoomScript(ffdecPath, workRoot, swfPath) {
  fs.rmSync(workRoot, { recursive: true, force: true });
  fs.mkdirSync(workRoot, { recursive: true });
  runFfdec(ffdecPath, ['-selectclass', CLASS_NAME, '-export', 'script', workRoot, swfPath]);

  const roomPath = path.join(workRoot, 'scripts', `${CLASS_NAME}.as`);
  if (!fs.existsSync(roomPath)) {
    throw new Error(`FFDec export did not produce ${roomPath}`);
  }

  return roomPath;
}

function patchRoomSource(source) {
  verifyRoomSource(source, 'current source', true);

  if (
    source.includes('this.RemoveRoomEightPedestalGoblin();') &&
    source.includes('public function RemoveRoomEightPedestalGoblin() : void') &&
    source.includes('this.am_Gob1.Remove();') &&
    source.includes('this.RoomEightGateCanOpen(param1)') &&
    source.includes('this.StartRoomEightMages();') &&
    source.includes('public function RoomEightFrontLineCleared() : Boolean') &&
    source.includes('this.bRoomEightAmbushStarted = true;') &&
    source.includes('return this.RoomEightActiveEnemiesCleared();') &&
    source.includes('this.Script_Ambush = ["2 SpawnCue Mage1","0 Mage1 <Board>","2 SpawnCue Mage2","0 Mage2 <Board>"];') &&
    source.includes('public function RoomEightEnemyCleared(param1:*) : Boolean') &&
    !source.includes('this.WakeRoomEightGoblin();') &&
    !source.includes('this.RoomEightEnemyCleared(this.am_Gob1)') &&
    !source.includes('0 Gob1 <PullLever>') &&
    !source.includes('this.bRoomEightAmbushStarted = true;\r\n            this.bRoomEightAmbushStarted = true;') &&
    !source.includes('this.bRoomEightAmbushStarted = true;\n            this.bRoomEightAmbushStarted = true;') &&
    !source.includes('this.bRoomEightAmbushStarted = false;\r\n         this.bRoomEightAmbushStarted = false;') &&
    !source.includes('this.bRoomEightAmbushStarted = false;\n         this.bRoomEightAmbushStarted = false;') &&
    !source.includes('this.StartRoomEightMages();\r\n            this.StartRoomEightMages();') &&
    !source.includes('this.StartRoomEightMages();\n            this.StartRoomEightMages();')
  ) {
    verifyRoomSource(source, 'patched source', false);
    return source;
  }

  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  let patched = source;

  patched = patched.replace(
    /      public function WakeRoomEightGoblin\(\) : void\r?\n      \{\r?\n[\s\S]*?\r?\n      \}\r?\n      \r?\n/g,
    ''
  );
  patched = patched.replace(
    /      public function RemoveRoomEightPedestalGoblin\(\) : void\r?\n      \{\r?\n[\s\S]*?\r?\n      \}\r?\n      \r?\n/g,
    ''
  );
  patched = patched.replace(
    /      public function StartRoomEightMages\(\) : void\r?\n      \{\r?\n[\s\S]*?\r?\n      \}\r?\n      \r?\n/g,
    ''
  );
  patched = patched.replace(
    /      public function RoomEightActiveEnemiesCleared\(\) : Boolean\r?\n      \{\r?\n[\s\S]*?\r?\n      \}\r?\n      \r?\n/g,
    ''
  );
  patched = patched.replace(
    /      public function RoomEightFrontLineCleared\(\) : Boolean\r?\n      \{\r?\n[\s\S]*?\r?\n      \}\r?\n      \r?\n/g,
    ''
  );
  patched = patched.replace(
    /      public function RoomEightGateCanOpen\(param1:a_GameHook\) : Boolean\r?\n      \{\r?\n[\s\S]*?\r?\n      \}\r?\n      \r?\n/g,
    ''
  );
  patched = patched.replace(
    /      public function RoomEightEnemyCleared\(param1:\*\) : Boolean\r?\n      \{\r?\n[\s\S]*?\r?\n      \}\r?\n      \r?\n/g,
    ''
  );
  patched = patched.replace(
    /      public var bRoomEightAmbushStarted:Boolean;\r?\n      \r?\n/g,
    ''
  );
  for (const methodName of ['Aggro', 'AddBuff', 'RemoveBuff', 'DeepSleep']) {
    patched = patched.replace(
      new RegExp(`^\\s*this\\.am_Gob1\\.${methodName}\\([^\\r\\n]*\\);\\r?\\n`, 'gm'),
      ''
    );
  }

  const condition = '         if(param1.RoomCleared())';
  const replacement = '         if(param1.RoomCleared() || this.RoomEightGateCanOpen(param1))';
  if (!patched.includes(condition) && !patched.includes(replacement)) {
    throw new Error('Could not find room 8 gate RoomCleared condition');
  }
  patched = patched.replace(condition, replacement);

  patched = patched.replace(
    /            param1\.PlayScript\(this\.Script_Ambush\);\r?\n/,
    [
      '            this.bRoomEightAmbushStarted = true;',
      '            param1.PlayScript(this.Script_Ambush);'
    ].join(eol) + eol
  );
  patched = patched.replace(
    /            this\.am_Gob1\.RemoveBuff\("NephitSleep"\);\r?\n            this\.am_Gob1\.Aggro\(\);/,
    ''
  );
  patched = patched.replace(
    /            this\.WakeRoomEightGoblin\(\);\r?\n/g,
    ''
  );
  patched = patched.replace(
    /         if\(this\.bRoomEightAmbushStarted && !this\.RoomEightEnemyCleared\(this\.am_Gob1\) && this\.RoomEightActiveEnemiesCleared\(\)\)\r?\n         \{\r?\n\s*         \}\r?\n/g,
    ''
  );
  patched = patched.replace(
    /            this\.am_Gob2\.Aggro\(\);\r?\n            this\.am_Gob3\.Aggro\(\);/,
    [
      '            this.am_Gob2.Aggro();',
      '            this.am_Gob3.Aggro();',
      '            this.StartRoomEightMages();'
    ].join(eol)
  );

  const wakeFallback = [
    '         if(this.bRoomEightAmbushStarted && this.RoomEightActiveEnemiesCleared())',
    '         {',
    '            this.RemoveRoomEightPedestalGoblin();',
    '         }'
  ].join(eol);
  const gateCondition = '         if(param1.RoomCleared() || this.RoomEightGateCanOpen(param1))';
  if (!patched.includes(wakeFallback)) {
    patched = patched.replace(gateCondition, `${wakeFallback}${eol}${gateCondition}`);
  }
  const mageFallback = [
    '         if(this.bRoomEightAmbushStarted && this.RoomEightFrontLineCleared() && (!this.RoomEightEnemyCleared(this.am_Mage1) || !this.RoomEightEnemyCleared(this.am_Mage2)))',
    '         {',
    '            this.StartRoomEightMages();',
    '         }'
  ].join(eol);
  if (!patched.includes(mageFallback)) {
    patched = patched.replace(wakeFallback, `${mageFallback}${eol}${wakeFallback}`);
  }

  const helper = [
    '      public function RemoveRoomEightPedestalGoblin() : void',
    '      {',
    '         if(this.am_Gob1)',
    '         {',
    '            this.am_Gob1.Remove();',
    '            if(this.am_Gob1.parent)',
    '            {',
    '               this.am_Gob1.parent.removeChild(this.am_Gob1);',
    '            }',
    '         }',
    '      }',
    '      ',
    '      public function StartRoomEightMages() : void',
    '      {',
    '         if(this.am_Mage1)',
    '         {',
    '            this.am_Mage1.Aggro();',
    '         }',
    '         if(this.am_Mage2)',
    '         {',
    '            this.am_Mage2.Aggro();',
    '         }',
    '      }',
    '      ',
    '      public function RoomEightFrontLineCleared() : Boolean',
    '      {',
    '         return this.RoomEightEnemyCleared(this.am_Gob2) && this.RoomEightEnemyCleared(this.am_Gob3);',
    '      }',
    '      ',
    '      public function RoomEightActiveEnemiesCleared() : Boolean',
    '      {',
    '         return this.RoomEightEnemyCleared(this.am_Gob2) && this.RoomEightEnemyCleared(this.am_Gob3) && this.RoomEightEnemyCleared(this.am_Mage1) && this.RoomEightEnemyCleared(this.am_Mage2);',
    '      }',
    '      ',
    '      public function RoomEightGateCanOpen(param1:a_GameHook) : Boolean',
    '      {',
    '         return this.RoomEightActiveEnemiesCleared();',
    '      }',
    '      ',
    '      public function RoomEightEnemyCleared(param1:*) : Boolean',
    '      {',
    '         return Boolean(param1) && (param1.Defeated() || param1.Health() < 1);',
    '      }',
    '      '
  ].join(eol);

  const insertionPoint = '      internal function __setProp___id279__a_Room_GoblinBeachHard_08_cues_0()';
  if (!source.includes(insertionPoint)) {
    throw new Error('Could not find room 8 helper insertion point');
  }

  const varInsertionPoint = '      public var Script_Ambush:Array;' + eol;
  if (!patched.includes(varInsertionPoint)) {
    throw new Error('Could not find room 8 variable insertion point');
  }
  patched = patched.replace(varInsertionPoint, `${varInsertionPoint}      public var bRoomEightAmbushStarted:Boolean;${eol}      ${eol}`);
  patched = patched.replace(insertionPoint, `${helper}${insertionPoint}`);

  const removeGoblinCall = '         this.RemoveRoomEightPedestalGoblin();' + eol;
  const constructorMarker = '         this.__setProp___id279__a_Room_GoblinBeachHard_08_cues_0();' + eol;
  if (!patched.includes(constructorMarker)) {
    throw new Error('Could not find room 8 constructor property setup');
  }
  if (!patched.includes(constructorMarker + removeGoblinCall)) {
    patched = patched.replace(constructorMarker, constructorMarker + removeGoblinCall);
  }

  const initMarker = '      public function InitRoom(param1:a_GameHook) : void' + eol + '      {' + eol;
  if (!patched.includes(initMarker)) {
    throw new Error('Could not find room 8 InitRoom body');
  }
  const initBodyStart = patched.indexOf(initMarker) + initMarker.length;
  if (!patched.slice(initBodyStart, initBodyStart + 120).includes('this.RemoveRoomEightPedestalGoblin();')) {
    patched = patched.replace(initMarker, initMarker + removeGoblinCall);
  }

  patched = patched.replace(
    /         this\.Script_Ambush = /,
    [
      '         this.bRoomEightAmbushStarted = false;',
      '         this.Script_Ambush = '
    ].join(eol)
  );
  patched = patched.replace(
    /this\.Script_Ambush = \["0 Gob1 <PullLever> Coming here was an idiotic mistake, human!","2 SpawnCue Mage1","0 Mage1 <Board>","2 SpawnCue Mage2","0 Mage2 <Board>"\];/,
    'this.Script_Ambush = ["2 SpawnCue Mage1","0 Mage1 <Board>","2 SpawnCue Mage2","0 Mage2 <Board>"];'
  );
  patched = patched.replace(
    /(            this\.bRoomEightAmbushStarted = true;\r?\n)(?:            this\.bRoomEightAmbushStarted = true;\r?\n)+/g,
    '$1'
  );
  patched = patched.replace(
    /(         this\.bRoomEightAmbushStarted = false;\r?\n)(?:         this\.bRoomEightAmbushStarted = false;\r?\n)+/g,
    '$1'
  );
  patched = patched.replace(
    /(            this\.StartRoomEightMages\(\);\r?\n)(?:            this\.StartRoomEightMages\(\);\r?\n)+/g,
    '$1'
  );

  verifyRoomSource(patched, 'patched source', false);
  return patched;
}

function verifyRoomSource(source, label, allowUnpatched) {
  const required = [
    'param1.CollisionOff("am_DynamicCollision_PathBlock02");',
    'this.am_Gob1',
    'this.am_Gob2',
    'this.am_Gob3',
    'this.am_Mage1',
    'this.am_Mage2'
  ];

  for (const marker of required) {
    if (!source.includes(marker)) {
      throw new Error(`${label} is missing expected marker: ${marker}`);
    }
  }

  const patchedMarkers = [
    'param1.RoomCleared() || this.RoomEightGateCanOpen(param1)',
    'this.RemoveRoomEightPedestalGoblin();',
    'public function RemoveRoomEightPedestalGoblin() : void',
    'this.am_Gob1.Remove();',
    'public function StartRoomEightMages() : void',
    'public function RoomEightFrontLineCleared() : Boolean',
    'public function RoomEightActiveEnemiesCleared() : Boolean',
    'public function RoomEightGateCanOpen(param1:a_GameHook) : Boolean',
    'public function RoomEightEnemyCleared(param1:*) : Boolean',
    'this.bRoomEightAmbushStarted = true;',
    'this.StartRoomEightMages();',
    'return this.RoomEightActiveEnemiesCleared();',
    'this.Script_Ambush = ["2 SpawnCue Mage1","0 Mage1 <Board>","2 SpawnCue Mage2","0 Mage2 <Board>"];',
    'return Boolean(param1) && (param1.Defeated() || param1.Health() < 1);'
  ];

  const patched = patchedMarkers.every((marker) => source.includes(marker));
  const staleMarkers = [
    'this.WakeRoomEightGoblin();',
    'this.RoomEightEnemyCleared(this.am_Gob1)',
    '0 Gob1 <PullLever>'
  ];
  const stale = staleMarkers.some((marker) => source.includes(marker));
  if (!allowUnpatched && (!patched || stale)) {
    throw new Error(`${label} is missing hard room 8 gate fallback`);
  }
}

function patchSwf(repoRoot, ffdecPath, swfPath, verifyOnly) {
  const workRoot = path.join(repoRoot, 'build', 'ffdec-levelsnr-hard-goblinbeach-room8-gate');
  const roomPath = exportRoomScript(ffdecPath, workRoot, swfPath);
  const original = fs.readFileSync(roomPath, 'utf8');
  const patched = patchRoomSource(original);

  if (verifyOnly) {
    verifyRoomSource(patched, swfPath, false);
    console.log(`[hard-goblinbeach-room8-gate] verified ${path.relative(repoRoot, swfPath)}`);
    return;
  }

  if (patched === original) {
    console.log(`[hard-goblinbeach-room8-gate] no changes needed in ${path.relative(repoRoot, swfPath)}`);
    return;
  }

  const backupPath = `${swfPath}.bak`;
  if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(swfPath, backupPath);
  }

  fs.writeFileSync(roomPath, patched, 'utf8');
  const patchedSwfPath = path.join(workRoot, path.basename(swfPath));
  runFfdec(ffdecPath, ['-importScript', swfPath, patchedSwfPath, path.dirname(roomPath)]);
  fs.copyFileSync(patchedSwfPath, swfPath);
  console.log(`[hard-goblinbeach-room8-gate] patched ${path.relative(repoRoot, swfPath)}`);
}

function main() {
  const repoRoot = resolveRepoRoot();
  const args = parseArgs(process.argv);
  const ffdecPath = detectFfdec(repoRoot, args.ffdec);
  if (!ffdecPath) {
    throw new Error('FFDec not found. Pass --ffdec or install FFDec.');
  }

  const swfPath = resolvePath(repoRoot, args.swf);
  if (!fs.existsSync(swfPath)) {
    throw new Error(`SWF not found: ${swfPath}`);
  }

  patchSwf(repoRoot, ffdecPath, swfPath, args.verify);
}

try {
  main();
} catch (error) {
  console.error(`Patch error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
