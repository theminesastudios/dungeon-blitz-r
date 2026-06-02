const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const CLASS_NAME = 'a_Room_GoblinBeachHard_02';
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
    '  node src/server/scripts/patch-levelsnr-hard-goblinbeach-room2-gate.js [--verify] [--swf <path>] [--ffdec <path>]',
    '',
    'Patches LevelsNR TutorialDungeonHard room 2 so the untouchable door-side',
    'am_Scout/GoblinArmorSwordHard cue is removed, while the remaining authored',
    'room enemies stay active and can open the gate when defeated.'
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

  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const removeScoutCall = '         this.RemoveRoomTwoDoorScout();' + eol;
  const constructorMarker = '         this.__setProp___id297__a_Room_GoblinBeachHard_02_Details();' + eol;

  if (
    source.includes(constructorMarker + removeScoutCall) &&
    source.includes('public function RemoveRoomTwoDoorScout() : void') &&
    source.includes('this.am_Scout.Remove();') &&
    source.includes('this.Script_Summon = ["1 SpawnCue Mage1","0 Mage1 <Board> The Curse of Zegl upon Ye!"];') &&
    source.includes('param1.RoomCleared() || this.RoomTwoGateCanOpen(param1)') &&
    source.includes('public function OpenRoomTwoGate(param1:a_GameHook) : void') &&
    source.includes('public function RoomTwoEnemyCleared(param1:*) : Boolean') &&
    source.includes('this.RoomTwoEnemyCleared(this.am_Mage1) && this.RoomTwoEnemyCleared(this.am_Add1) && this.RoomTwoEnemyCleared(this.am_Add2)') &&
    (source.match(/public function RoomTwoGateCanOpen/g) || []).length === 1 &&
    (source.match(/public function RemoveRoomTwoDoorScout/g) || []).length === 1 &&
    !source.includes('this.am_Scout.Aggro();') &&
    !source.includes('this.am_Scout.Defeated()')
  ) {
    verifyRoomSource(source, 'patched source', false);
    return source;
  }

  let patched = source;
  patched = patched.replace(
    /      public function RoomTwoGateCanOpen\(param1:a_GameHook\) : Boolean\r?\n      \{\r?\n         return .*?;\r?\n      \}\r?\n      \r?\n/g,
    ''
  );
  patched = patched.replace(
    /      public function RoomTwoEnemyCleared\(param1:\*\) : Boolean\r?\n      \{\r?\n[\s\S]*?\r?\n      \}\r?\n      \r?\n/g,
    ''
  );
  patched = patched.replace(
    /      public function OpenRoomTwoGate\(param1:a_GameHook\) : void\r?\n      \{\r?\n[\s\S]*?\r?\n      \}\r?\n      \r?\n/g,
    ''
  );
  patched = patched.replace(
    /      public function RemoveRoomTwoDoorScout\(\) : void\r?\n      \{\r?\n[\s\S]*?\r?\n      \}\r?\n      \r?\n/g,
    ''
  );
  for (const methodName of ['Aggro', 'AddBuff', 'RemoveBuff', 'DeepSleep']) {
    patched = patched.replace(
      new RegExp(`^\\s*this\\.am_Scout\\.${methodName}\\([^\\r\\n]*\\);\\r?\\n`, 'gm'),
      ''
    );
  }
  patched = patched.replace(
    'this.Script_Summon = ["1 Scout <Cheer> Now!!!","1 SpawnCue Mage1","0 Mage1 <Board> The Curse of Zegl upon Ye!"];',
    'this.Script_Summon = ["1 SpawnCue Mage1","0 Mage1 <Board> The Curse of Zegl upon Ye!"];'
  );

  const condition = '         if(param1.RoomCleared())';
  const replacement = '         if(param1.RoomCleared() || this.RoomTwoGateCanOpen(param1))';
  if (patched.includes(condition)) {
    patched = patched.replace(condition, replacement);
  } else if (!patched.includes(replacement)) {
    throw new Error('Could not find room 2 gate RoomCleared condition');
  }

  const helper = [
    '      public function RoomTwoGateCanOpen(param1:a_GameHook) : Boolean',
    '      {',
    '         return this.RoomTwoEnemyCleared(this.am_Mage1) && this.RoomTwoEnemyCleared(this.am_Add1) && this.RoomTwoEnemyCleared(this.am_Add2);',
    '      }',
    '      ',
    '      public function RoomTwoEnemyCleared(param1:*) : Boolean',
    '      {',
    '         return !param1 || param1.Defeated() || param1.Health() < 1;',
    '      }',
    '      ',
    '      public function OpenRoomTwoGate(param1:a_GameHook) : void',
    '      {',
    '         param1.CollisionOff("am_DynamicCollision_GateBlock");',
    '         param1.PlaySound("a_Sound_Fireball_Big");',
    '         param1.PlayScript(this.Script_Shake);',
    '         param1.Animate("am_Gate","Open",true);',
    '         param1.SetPhase(null);',
    '      }',
    '      ',
    '      public function RemoveRoomTwoDoorScout() : void',
    '      {',
    '         if(this.am_Scout)',
    '         {',
    '            this.am_Scout.Remove();',
    '            if(this.am_Scout.parent)',
    '            {',
    '               this.am_Scout.parent.removeChild(this.am_Scout);',
    '            }',
    '         }',
    '      }',
    '      '
  ].join(eol);

  const insertionPoint = '      internal function __setProp___id297__a_Room_GoblinBeachHard_02_Details()';
  if (!patched.includes(insertionPoint)) {
    throw new Error('Could not find room 2 helper insertion point');
  }

  const initMarker = '      public function InitRoom(param1:a_GameHook) : void' + eol + '      {' + eol;
  if (!patched.includes(initMarker)) {
    throw new Error('Could not find room 2 InitRoom body');
  }
  const initBodyStart = patched.indexOf(initMarker) + initMarker.length;
  if (!patched.slice(initBodyStart, initBodyStart + 80).includes('this.RemoveRoomTwoDoorScout();')) {
    patched = patched.replace(initMarker, initMarker + removeScoutCall);
  }

  if (!patched.includes(constructorMarker)) {
    throw new Error('Could not find room 2 constructor property setup');
  }
  if (!patched.includes(constructorMarker + removeScoutCall)) {
    patched = patched.replace(constructorMarker, constructorMarker + removeScoutCall);
  }

  patched = patched.replace(
    /         if\(param1\.RoomCleared\(\) \|\| this\.RoomTwoGateCanOpen\(param1\)\)\r?\n         \{\r?\n            param1\.CollisionOff\("am_DynamicCollision_GateBlock"\);\r?\n            param1\.PlaySound\("a_Sound_Fireball_Big"\);\r?\n            param1\.PlayScript\(this\.Script_Shake\);\r?\n            param1\.Animate\("am_Gate","Open",true\);\r?\n            param1\.SetPhase\(null\);\r?\n         \}/,
    [
      '         if(param1.RoomCleared() || this.RoomTwoGateCanOpen(param1))',
      '         {',
      '            this.OpenRoomTwoGate(param1);',
      '         }'
    ].join(eol)
  );
  patched = patched.replace(
    /         if\(param1\.OnTrigger\("am_Trigger_1"\)\)\r?\n         \{\r?\n            param1\.SetPhase\(this\.UpdateSummonWaveOne\);\r?\n         \}/,
    [
      '         if(this.RoomTwoGateCanOpen(param1))',
      '         {',
      '            this.OpenRoomTwoGate(param1);',
      '         }',
      '         if(param1.OnTrigger("am_Trigger_1"))',
      '         {',
      '            param1.SetPhase(this.UpdateSummonWaveOne);',
      '         }'
    ].join(eol)
  );

  patched = patched.replace(insertionPoint, `${helper}${insertionPoint}`);

  verifyRoomSource(patched, 'patched source', false);
  return patched;
}

function verifyRoomSource(source, label, allowUnpatched) {
  const required = [
    'param1.CollisionOff("am_DynamicCollision_GateBlock");',
    'this.am_Scout',
    'this.am_Mage1',
    'this.am_Add1',
    'this.am_Add2'
  ];

  for (const marker of required) {
    if (!source.includes(marker)) {
      throw new Error(`${label} is missing expected marker: ${marker}`);
    }
  }

  const patchedMarkers = [
    'this.RemoveRoomTwoDoorScout();',
    'public function RemoveRoomTwoDoorScout() : void',
    'this.am_Scout.Remove();',
    'this.am_Scout.parent.removeChild(this.am_Scout);',
    'this.Script_Summon = ["1 SpawnCue Mage1","0 Mage1 <Board> The Curse of Zegl upon Ye!"];',
    'param1.RoomCleared() || this.RoomTwoGateCanOpen(param1)',
    'this.OpenRoomTwoGate(param1);',
    'public function OpenRoomTwoGate(param1:a_GameHook) : void',
    'public function RoomTwoEnemyCleared(param1:*) : Boolean',
    'public function RoomTwoGateCanOpen(param1:a_GameHook) : Boolean',
    'this.RoomTwoEnemyCleared(this.am_Mage1) && this.RoomTwoEnemyCleared(this.am_Add1) && this.RoomTwoEnemyCleared(this.am_Add2)'
  ];

  const patched = patchedMarkers.every((marker) => source.includes(marker));
  if (!allowUnpatched && !patched) {
    throw new Error(`${label} is missing hard room 2 gate fallback`);
  }
  if (!allowUnpatched && (source.includes('this.am_Scout.Aggro();') || source.includes('this.am_Scout.Defeated()'))) {
    throw new Error(`${label} still treats room 2 am_Scout as an active gate enemy`);
  }
}

function patchSwf(repoRoot, ffdecPath, swfPath, verifyOnly) {
  const workRoot = path.join(repoRoot, 'build', 'ffdec-levelsnr-hard-goblinbeach-room2-gate');
  const roomPath = exportRoomScript(ffdecPath, workRoot, swfPath);
  const original = fs.readFileSync(roomPath, 'utf8');
  const patched = patchRoomSource(original);

  if (verifyOnly) {
    verifyRoomSource(patched, swfPath, false);
    console.log(`[hard-goblinbeach-room2-gate] verified ${path.relative(repoRoot, swfPath)}`);
    return;
  }

  if (patched === original) {
    console.log(`[hard-goblinbeach-room2-gate] no changes needed in ${path.relative(repoRoot, swfPath)}`);
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
  console.log(`[hard-goblinbeach-room2-gate] patched ${path.relative(repoRoot, swfPath)}`);
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
