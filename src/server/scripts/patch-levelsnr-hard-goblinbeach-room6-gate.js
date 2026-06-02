const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const CLASS_NAME = 'a_Room_GoblinBeachHard_06';
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
    '  node src/server/scripts/patch-levelsnr-hard-goblinbeach-room6-gate.js [--verify] [--swf <path>] [--ffdec <path>]',
    '',
    'Patches LevelsNR TutorialDungeonHard room 6 so the spike gate opens',
    'when the ambush group is cleared, even if the authored Group().Defeated()',
    'state misses hard-mode client-spawned cue state.'
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
    source.includes('this.StartRoomSixAmbush(param1);') &&
    source.includes('public function RoomSixChestBroken() : Boolean') &&
    source.includes('this.OpenRoomSixGate(param1);') &&
    source.includes('public function RoomSixAmbushCleared() : Boolean') &&
    source.includes('public function RoomSixEnemyCleared(param1:*) : Boolean') &&
    source.includes('public function OpenRoomSixGate(param1:a_GameHook) : void') &&
    source.includes('this.bRoomSixAmbushSpawned = true;') &&
    source.includes('this.am_Scout.Aggro();') &&
    source.includes('return Boolean(param1) && param1.Defeated();') &&
    source.includes('param1.Group(this.am_AmbushGrp).Defeated() || this.RoomSixAmbushCleared()')
  ) {
    verifyRoomSource(source, 'patched source', false);
    return source;
  }

  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  let patched = source;

  patched = patched.replace(
    /      public function RoomSixChestBroken\(\) : Boolean\r?\n      \{\r?\n[\s\S]*?\r?\n      \}\r?\n      \r?\n/g,
    ''
  );
  patched = patched.replace(
    /      public function StartRoomSixAmbush\(param1:a_GameHook\) : void\r?\n      \{\r?\n[\s\S]*?\r?\n      \}\r?\n      \r?\n/g,
    ''
  );
  patched = patched.replace(
    /      public function RoomSixAmbushCleared\(\) : Boolean\r?\n      \{\r?\n[\s\S]*?\r?\n      \}\r?\n      \r?\n/g,
    ''
  );
  patched = patched.replace(
    /      public function RoomSixEnemyCleared\(param1:\*\) : Boolean\r?\n      \{\r?\n[\s\S]*?\r?\n      \}\r?\n      \r?\n/g,
    ''
  );
  patched = patched.replace(
    /      public function OpenRoomSixGate\(param1:a_GameHook\) : void\r?\n      \{\r?\n[\s\S]*?\r?\n      \}\r?\n      \r?\n/g,
    ''
  );
  patched = patched.replace(
    /      public var bRoomSixAmbushSpawned:Boolean;\r?\n      \r?\n/g,
    ''
  );

  patched = patched.replace(
    /         if\(param1\.OnTrigger\("am_Trigger_1"\)\)\r?\n         \{\r?\n            param1\.PlayScript\(this\.Script_OpeningScene\);\r?\n            param1\.SetPhase\(this\.UpdateAmbush\);\r?\n         \}/,
    [
      '         if(param1.OnTrigger("am_Trigger_1") || this.RoomSixChestBroken())',
      '         {',
      '            this.StartRoomSixAmbush(param1);',
      '         }'
    ].join(eol)
  );
  patched = patched.replace(
    /            param1\.Group\(this\.am_AmbushGrp\)\.Spawn\(\);\r?\n/,
    [
      '            param1.Group(this.am_AmbushGrp).Spawn();',
      '            this.bRoomSixAmbushSpawned = true;'
    ].join(eol) + eol
  );
  patched = patched.replace(
    '         if(param1.Group(this.am_AmbushGrp).Defeated())',
    '         if(param1.Group(this.am_AmbushGrp).Defeated() || this.RoomSixAmbushCleared())'
  );
  patched = patched.replace(
    /            param1\.PlayScript\(this\.Script_RoomCleared\);\r?\n            param1\.SetPhase\(this\.UpdateEndEvent\);/,
    [
      '            param1.PlayScript(this.Script_RoomCleared);',
      '            this.OpenRoomSixGate(param1);'
    ].join(eol)
  );
  patched = patched.replace(
    /            this\.am_Scout\.RemoveBuff\("NephitSleep"\);\r?\n            this\.am_Scout\.Aggro\(\);\r?\n            param1\.CollisionOff\("am_DynamicCollision_Gate"\);\r?\n            param1\.Animate\("am_Gate","Open",true\);\r?\n            param1\.SetPhase\(null\);/,
    '            this.OpenRoomSixGate(param1);'
  );

  const helpers = [
    '      public function RoomSixChestBroken() : Boolean',
    '      {',
    '         return !this.am_Chest || this.am_Chest.Defeated() || this.am_Chest.Health() < 1;',
    '      }',
    '      ',
    '      public function StartRoomSixAmbush(param1:a_GameHook) : void',
    '      {',
    '         param1.PlayScript(this.Script_OpeningScene);',
    '         param1.SetPhase(this.UpdateAmbush);',
    '      }',
    '      ',
    '      public function RoomSixAmbushCleared() : Boolean',
    '      {',
    '         return this.bRoomSixAmbushSpawned && this.RoomSixEnemyCleared(this.am_AmbushGrp.am_Mob1) && this.RoomSixEnemyCleared(this.am_AmbushGrp.am_Mob2) && this.RoomSixEnemyCleared(this.am_AmbushGrp.am_Mob3) && this.RoomSixEnemyCleared(this.am_AmbushGrp.am_Mob4) && this.RoomSixEnemyCleared(this.am_AmbushGrp.am_Mob5) && this.RoomSixEnemyCleared(this.am_AmbushGrp.am_Mob6);',
    '      }',
    '      ',
    '      public function RoomSixEnemyCleared(param1:*) : Boolean',
    '      {',
    '         return Boolean(param1) && param1.Defeated();',
    '      }',
    '      ',
    '      public function OpenRoomSixGate(param1:a_GameHook) : void',
    '      {',
    '         if(this.am_Scout)',
    '         {',
    '            this.am_Scout.RemoveBuff("NephitSleep");',
    '            this.am_Scout.Aggro();',
    '         }',
    '         param1.CollisionOff("am_DynamicCollision_Gate");',
    '         param1.Animate("am_Gate","Open",true);',
    '         param1.SetPhase(null);',
    '      }',
    '      '
  ].join(eol);

  const insertionPoint = '      internal function __setProp_am_Chest_a_Room_GoblinBeachHard_06_Cues_0()';
  if (!patched.includes(insertionPoint)) {
    throw new Error('Could not find room 6 helper insertion point');
  }
  const varInsertionPoint = '      public var Script_OpeningScene:Array;' + eol;
  if (!patched.includes(varInsertionPoint)) {
    throw new Error('Could not find room 6 variable insertion point');
  }
  patched = patched.replace(varInsertionPoint, `${varInsertionPoint}      public var bRoomSixAmbushSpawned:Boolean;${eol}      ${eol}`);
  patched = patched.replace(insertionPoint, `${helpers}${insertionPoint}`);
  patched = patched.replace(
    /         this\.Script_OpeningScene = /,
    [
      '         this.bRoomSixAmbushSpawned = false;',
      '         this.Script_OpeningScene = '
    ].join(eol)
  );

  verifyRoomSource(patched, 'patched source', false);
  return patched;
}

function verifyRoomSource(source, label, allowUnpatched) {
  const required = [
    'param1.CollisionOff("am_DynamicCollision_Gate");',
    'param1.Group(this.am_AmbushGrp).Spawn();',
    'param1.Group(this.am_AmbushGrp).Defeated()',
    'this.am_AmbushGrp.am_Mob1',
    'this.am_AmbushGrp.am_Mob6',
    'param1.Animate("am_Gate","Open",true);'
  ];

  for (const marker of required) {
    if (!source.includes(marker)) {
      throw new Error(`${label} is missing expected marker: ${marker}`);
    }
  }

  const patchedMarkers = [
    'param1.OnTrigger("am_Trigger_1") || this.RoomSixChestBroken()',
    'this.StartRoomSixAmbush(param1);',
    'public function RoomSixChestBroken() : Boolean',
    'public function StartRoomSixAmbush(param1:a_GameHook) : void',
    'param1.Group(this.am_AmbushGrp).Defeated() || this.RoomSixAmbushCleared()',
    'this.OpenRoomSixGate(param1);',
    'public function RoomSixAmbushCleared() : Boolean',
    'public function RoomSixEnemyCleared(param1:*) : Boolean',
    'public function OpenRoomSixGate(param1:a_GameHook) : void',
    'this.bRoomSixAmbushSpawned = true;',
    'return this.bRoomSixAmbushSpawned && this.RoomSixEnemyCleared',
    'this.am_Scout.Aggro();',
    'return Boolean(param1) && param1.Defeated();',
    'param1.CollisionOff("am_DynamicCollision_Gate");',
    'param1.Animate("am_Gate","Open",true);',
    'param1.SetPhase(null);'
  ];

  const patched = patchedMarkers.every((marker) => source.includes(marker));
  if (!allowUnpatched && !patched) {
    throw new Error(`${label} is missing hard room 6 gate fallback`);
  }
}

function patchSwf(repoRoot, ffdecPath, swfPath, verifyOnly) {
  const workRoot = path.join(repoRoot, 'build', 'ffdec-levelsnr-hard-goblinbeach-room6-gate');
  const roomPath = exportRoomScript(ffdecPath, workRoot, swfPath);
  const original = fs.readFileSync(roomPath, 'utf8');
  const patched = patchRoomSource(original);

  if (verifyOnly) {
    verifyRoomSource(patched, swfPath, false);
    console.log(`[hard-goblinbeach-room6-gate] verified ${path.relative(repoRoot, swfPath)}`);
    return;
  }

  if (patched === original) {
    console.log(`[hard-goblinbeach-room6-gate] no changes needed in ${path.relative(repoRoot, swfPath)}`);
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
  console.log(`[hard-goblinbeach-room6-gate] patched ${path.relative(repoRoot, swfPath)}`);
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
