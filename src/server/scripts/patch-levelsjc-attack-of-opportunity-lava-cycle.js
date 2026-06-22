const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const CLASS_NAME = 'a_Room_JCMission8_10';
const DEFAULT_SWF = path.join('src', 'client', 'content', 'localhost', 'p', 'cbp', 'LevelsJC.swf');

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
    '  node src/server/scripts/patch-levelsjc-attack-of-opportunity-lava-cycle.js [--verify] [--swf <path>] [--ffdec <path>]',
    '',
    'Patches LevelsJC a_Room_JCMission8_10 so Attack Of Opportunity lava',
    'hazards are killed during the off cycle instead of only removed.'
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
    '/Applications/FFDec.app/Contents/Resources/ffdec-cli.jar',
    '/Applications/FFDec.app/Contents/Resources/ffdec.jar',
    '/Applications/FFDec.app/Contents/Resources/ffdec-cli.exe',
    '/Applications/FFDec.app/Contents/MacOS/FFDec'
  );

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function ensureFfdecHome(repoRoot) {
  const ffdecHome = path.join(repoRoot, 'build', 'ffdec-home');
  fs.mkdirSync(path.join(ffdecHome, 'JPEXS', 'FFDec', 'logs'), { recursive: true });
  fs.mkdirSync(path.join(ffdecHome, 'LocalAppData'), { recursive: true });
  fs.mkdirSync(path.join(ffdecHome, 'Library', 'Application Support', 'FFDec', 'logs'), { recursive: true });
  return ffdecHome;
}

function runFfdec(ffdecPath, args) {
  const resolved = path.resolve(ffdecPath);
  const basename = path.basename(resolved).toLowerCase();
  const repoRoot = resolveRepoRoot();
  const ffdecHome = ensureFfdecHome(repoRoot);
  const env = {
    ...process.env,
    APPDATA: ffdecHome,
    HOME: ffdecHome,
    LOCALAPPDATA: path.join(ffdecHome, 'LocalAppData'),
    USERPROFILE: ffdecHome
  };

  if (basename.endsWith('.jar')) {
    execFileSync('java', [`-Duser.home=${ffdecHome}`, '-jar', resolved, '-cli', ...args], { env, stdio: 'inherit' });
    return;
  }

  execFileSync(resolved, ['-cli', ...args], { env, stdio: 'inherit' });
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

function findMethodRange(source, methodName) {
  const marker = `public function ${methodName}(`;
  const start = source.indexOf(marker);
  if (start === -1) {
    throw new Error(`Could not find method ${methodName}`);
  }

  const braceStart = source.indexOf('{', start);
  if (braceStart === -1) {
    throw new Error(`Could not find method body for ${methodName}`);
  }

  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    const ch = source[index];
    if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return { start, end: index + 1 };
      }
    }
  }

  throw new Error(`Could not find end of method ${methodName}`);
}

function getMethodSource(source, methodName) {
  const range = findMethodRange(source, methodName);
  return source.slice(range.start, range.end);
}

function patchRoomSource(source) {
  try {
    verifyRoomSource(source, 'current source');
    return source;
  } catch (_error) {
    // Continue into the patch path below.
  }

  let patched = source;
  const before = 'param1.Group(this.am_FirePitGroup).Remove();';
  const after = 'param1.Group(this.am_FirePitGroup).Kill();';
  const phaseOne = getMethodSource(source, 'UpdatePhaseOne');

  if (phaseOne.includes(before)) {
    patched = patched.replace(before, after);
  } else if (!phaseOne.includes(after)) {
    throw new Error('Could not find Attack Of Opportunity lava off-cycle Remove call');
  }

  const phaseTwo = getMethodSource(patched, 'UpdatePhaseTwo');
  if (!phaseTwo.includes('param1.Group(this.am_FirePitGroup).Revive();') && phaseTwo.includes('param1.Group(this.am_FirePitGroup).Spawn();')) {
    patched = patched.replace(
      /([ \t]*)param1\.Group\(this\.am_FirePitGroup\)\.Spawn\(\);/,
      '$1param1.Group(this.am_FirePitGroup).Revive();\n$1param1.Group(this.am_FirePitGroup).Spawn();'
    );
  } else if (!phaseTwo.includes('param1.Group(this.am_FirePitGroup).Revive();')) {
    throw new Error('Could not find Attack Of Opportunity lava burn-phase Spawn call');
  }

  verifyRoomSource(patched, 'patched source');
  return patched;
}

function countOccurrences(source, marker) {
  let count = 0;
  let index = 0;
  while (true) {
    index = source.indexOf(marker, index);
    if (index === -1) {
      return count;
    }
    count += 1;
    index += marker.length;
  }
}

function verifyRoomSource(source, label) {
  const phaseOne = getMethodSource(source, 'UpdatePhaseOne');
  const phaseTwo = getMethodSource(source, 'UpdatePhaseTwo');

  if (!phaseOne.includes('if(param1.AtTime(6000))')) {
    throw new Error(`${label} is missing the lava off-cycle timer`);
  }
  if (!phaseOne.includes('param1.Group(this.am_FirePitGroup).Kill();')) {
    throw new Error(`${label} does not kill Attack Of Opportunity lava hazards during the off cycle`);
  }
  if (phaseOne.includes('param1.Group(this.am_FirePitGroup).Remove();')) {
    throw new Error(`${label} still removes Attack Of Opportunity lava hazards without killing them`);
  }
  if (!phaseTwo.includes('param1.Group(this.am_FirePitGroup).Spawn();')) {
    throw new Error(`${label} no longer spawns Attack Of Opportunity lava hazards during the burn phase`);
  }
  if (!phaseTwo.includes('param1.Group(this.am_FirePitGroup).Revive();')) {
    throw new Error(`${label} does not revive Attack Of Opportunity lava hazards before respawning them`);
  }
  if (phaseTwo.indexOf('param1.Group(this.am_FirePitGroup).Revive();') > phaseTwo.indexOf('param1.Group(this.am_FirePitGroup).Spawn();')) {
    throw new Error(`${label} respawns Attack Of Opportunity lava hazards before reviving them`);
  }
  if (countOccurrences(phaseTwo, 'param1.Group(this.am_FirePitGroup).Kill();') < 2) {
    throw new Error(`${label} no longer clears Attack Of Opportunity lava hazards on defeat and phase end`);
  }
}

function patchSwf(repoRoot, ffdecPath, swfPath) {
  const workRoot = path.join(repoRoot, 'build', 'ffdec-levelsjc-attack-of-opportunity-lava-cycle', path.basename(swfPath, path.extname(swfPath)));
  const patchedSwfPath = path.join(workRoot, `${path.basename(swfPath, path.extname(swfPath))}.patched.swf`);
  const roomPath = exportRoomScript(ffdecPath, workRoot, swfPath);
  const original = fs.readFileSync(roomPath, 'utf8');
  const patched = patchRoomSource(original);

  if (patched === original) {
    console.log(`SWF already contains the Attack Of Opportunity lava cycle patch: ${swfPath}`);
    return;
  }

  fs.writeFileSync(roomPath, patched, 'utf8');
  runFfdec(ffdecPath, ['-importScript', swfPath, patchedSwfPath, path.dirname(roomPath)]);
  fs.copyFileSync(patchedSwfPath, swfPath);
  console.log(`Patched Attack Of Opportunity lava cycle in ${swfPath}`);
}

function verifySwf(repoRoot, ffdecPath, swfPath) {
  const workRoot = path.join(repoRoot, 'build', 'ffdec-levelsjc-attack-of-opportunity-lava-cycle-verify', path.basename(swfPath, path.extname(swfPath)));
  const roomPath = exportRoomScript(ffdecPath, workRoot, swfPath);
  verifyRoomSource(fs.readFileSync(roomPath, 'utf8'), swfPath);
  console.log(`Verified Attack Of Opportunity lava cycle in ${swfPath}`);
}

function main() {
  const repoRoot = resolveRepoRoot();
  const args = parseArgs(process.argv);
  const swfPath = resolvePath(repoRoot, args.swf);
  const ffdecPath = detectFfdec(repoRoot, args.ffdec);

  if (!ffdecPath) {
    throw new Error('FFDec not found. Pass --ffdec or restore the repo-bundled FFDec tool.');
  }

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
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
}
