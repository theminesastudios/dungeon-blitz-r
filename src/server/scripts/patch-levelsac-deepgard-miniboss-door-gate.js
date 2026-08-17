const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const CLASS_NAME = 'a_Room_ACM01DeepgardDragonMiniBoss';
const DEFAULT_SWF = path.join('src', 'client', 'content', 'localhost', 'p', 'cbp', 'LevelsAC.swf');

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
    '  node src/server/scripts/patch-levelsac-deepgard-miniboss-door-gate.js [--verify] [--swf <path>] [--ffdec <path>]',
    '',
    'Patches LevelsAC a_Room_ACM01DeepgardDragonMiniBoss (the first room of',
    'Castle Hocke / AC_Mission1) so the door past the courtyard opens when the',
    'mini-boss dragon dies, even if its intro cutscene was never activated.'
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
    path.join(repoRoot, 'build', 'ffdec_24.0.1', 'ffdec-cli.jar')
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

function replaceMethod(source, methodName, replacement) {
  const range = findMethodRange(source, methodName);
  return `${source.slice(0, range.start)}${replacement}${source.slice(range.end)}`;
}

function normalizeBlock(block, eol) {
  return block.trim().replace(/\n/g, eol);
}

function patchRoomSource(source) {
  try {
    verifyRoomSource(source, 'current source');
    return source;
  } catch (_error) {
    // Continue into the source patch path below.
  }

  const eol = source.includes('\r\n') ? '\r\n' : '\n';

  // The authored room waits in UpdateTrigger for the intro cutscene trigger and
  // only opens the door (am_DynamicCollision_CastleBlocker) from UpdateFight,
  // which is reached by the cutscene. If the mini-boss dragon dies before the
  // cutscene ever fires - a ranged kill from before the trigger line, or a party
  // member whose client never received the shared trigger - the phase never
  // advances and the first door stays locked forever. Open it on death instead:
  // the door opening is a consequence of the dragon's defeat, not of the script.
  const patched = replaceMethod(
    source,
    'UpdateTrigger',
    normalizeBlock(`
      public function UpdateTrigger(param1:a_GameHook) : void
      {
         if(this.am_MiniBoss.Defeated())
         {
            param1.CollisionOff("am_DynamicCollision_CastleBlocker");
            param1.SetPhase(this.CloseScene);
            return;
         }
         if(param1.OnTrigger("am_Trigger_Cutscene"))
         {
            param1.PlayCutScene(this.Script_PlayOnEntry);
            param1.SetPhase(this.UpdateFight);
         }
      }
    `, eol)
  );

  verifyRoomSource(patched, 'patched source');
  return patched;
}

function verifyRoomSource(source, label) {
  const required = [
    'public var am_MiniBoss:ac_AncientDragonGoldMini;',
    'public function UpdateTrigger(param1:a_GameHook) : void',
    'public function UpdateFight(param1:a_GameHook) : void',
    'public function CloseScene(param1:a_GameHook) : void',
    'param1.PlayCutScene(this.Script_PlayOnEntry);',
    'param1.SetPhase(this.UpdateFight);'
  ];

  for (const marker of required) {
    if (!source.includes(marker)) {
      throw new Error(`${label} is missing required marker: ${marker}`);
    }
  }

  // The authored UpdateFight already contains these strings, so verify the
  // door-open fallback specifically inside UpdateTrigger, where it belongs.
  const triggerSource = getMethodSource(source, 'UpdateTrigger');
  for (const marker of [
    'if(this.am_MiniBoss.Defeated())',
    'param1.CollisionOff("am_DynamicCollision_CastleBlocker");',
    'param1.SetPhase(this.CloseScene);'
  ]) {
    if (!triggerSource.includes(marker)) {
      throw new Error(`${label} UpdateTrigger is missing required marker: ${marker}`);
    }
  }
}

function getMethodSource(source, methodName) {
  const range = findMethodRange(source, methodName);
  return source.slice(range.start, range.end);
}

function patchSwf(repoRoot, ffdecPath, swfPath, verifyOnly) {
  const workRoot = path.join(repoRoot, 'build', 'ffdec-levelsac-deepgard-miniboss-door-gate');
  const roomPath = exportRoomScript(ffdecPath, workRoot, swfPath);
  const original = fs.readFileSync(roomPath, 'utf8');
  const patched = patchRoomSource(original);

  if (verifyOnly) {
    verifyRoomSource(patched, swfPath);
    console.log(`Verified Deepgard mini-boss door gate in ${swfPath}`);
    return;
  }

  if (patched === original) {
    console.log(`SWF already contains the Deepgard mini-boss door gate patch: ${swfPath}`);
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
  console.log(`Patched Deepgard mini-boss door gate in ${swfPath}`);
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

  patchSwf(repoRoot, ffdecPath, swfPath, args.verify);
}

try {
  main();
} catch (error) {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
}
