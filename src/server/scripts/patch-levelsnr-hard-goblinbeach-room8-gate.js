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

  if (source.includes('this.RoomEightGateCanOpen(param1)')) {
    verifyRoomSource(source, 'patched source', false);
    return source;
  }

  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const condition = '         if(param1.RoomCleared())';
  const replacement = '         if(param1.RoomCleared() || this.RoomEightGateCanOpen(param1))';
  if (!source.includes(condition)) {
    throw new Error('Could not find room 8 gate RoomCleared condition');
  }

  const helper = [
    '      public function RoomEightGateCanOpen(param1:a_GameHook) : Boolean',
    '      {',
    '         return this.am_Gob1.Defeated() && this.am_Gob2.Defeated() && this.am_Gob3.Defeated() && this.am_Mage1.Defeated() && this.am_Mage2.Defeated();',
    '      }',
    '      '
  ].join(eol);

  const insertionPoint = '      internal function __setProp___id279__a_Room_GoblinBeachHard_08_cues_0()';
  if (!source.includes(insertionPoint)) {
    throw new Error('Could not find room 8 helper insertion point');
  }

  const patched = source
    .replace(condition, replacement)
    .replace(insertionPoint, `${helper}${insertionPoint}`);

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
    'public function RoomEightGateCanOpen(param1:a_GameHook) : Boolean',
    'this.am_Gob1.Defeated() && this.am_Gob2.Defeated() && this.am_Gob3.Defeated() && this.am_Mage1.Defeated() && this.am_Mage2.Defeated()'
  ];

  const patched = patchedMarkers.every((marker) => source.includes(marker));
  if (!allowUnpatched && !patched) {
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
