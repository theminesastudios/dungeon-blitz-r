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
    '  node src/server/scripts/patch-levelsac-deepgard-miniboss-late-join-gate.js [--verify] [--swf <path>] [--ffdec <path>]',
    '',
    'Patches LevelsAC a_Room_ACM01DeepgardDragonMiniBoss (Castle Hocke gate dragon)',
    'so a client that enters after the mini-boss already died in the shared',
    'dungeon instance skips the intro cutscene, removes the dragon cue, and',
    'clears the castle gate blocker. The server reports the already-dead state',
    'with the remote room trigger am_Trigger_MiniBossDone, and the room script',
    'latches it into the ACM01MiniBossDone game var so room resets stay quiet.'
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
    '/Applications/FFDec.app/Contents/Resources/ffdec.jar'
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

function getMethodSource(source, methodName) {
  const range = findMethodRange(source, methodName);
  return source.slice(range.start, range.end);
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
  let patched = source;

  patched = replaceMethod(
    patched,
    'UpdateTrigger',
    normalizeBlock(`
      public function UpdateTrigger(param1:a_GameHook) : void
      {
         if(param1.OnTrigger("am_Trigger_MiniBossDone"))
         {
            param1.SetVar("ACM01MiniBossDone","1");
         }
         if(param1.GetVar("ACM01MiniBossDone") == "1")
         {
            this.am_MiniBoss.Remove();
            param1.CollisionOff("am_DynamicCollision_CastleBlocker");
            param1.SetPhase(null);
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

  patched = replaceMethod(
    patched,
    'UpdateFight',
    normalizeBlock(`
      public function UpdateFight(param1:a_GameHook) : void
      {
         if(param1.OnTrigger("am_Trigger_MiniBossDone"))
         {
            param1.SetVar("ACM01MiniBossDone","1");
         }
         if(param1.GetVar("ACM01MiniBossDone") == "1" && !this.am_MiniBoss.Defeated())
         {
            param1.CancelScript(this.Script_PlayOnEntry);
            this.am_MiniBoss.Remove();
            param1.CollisionOff("am_DynamicCollision_CastleBlocker");
            param1.SetPhase(null);
            return;
         }
         if(param1.AtTime(29000))
         {
            this.am_MiniBoss.Aggro();
         }
         if(this.am_MiniBoss.Defeated())
         {
            param1.SetVar("ACM01MiniBossDone","1");
            param1.CollisionOff("am_DynamicCollision_CastleBlocker");
            param1.SetPhase(this.CloseScene);
         }
      }
    `, eol)
  );

  verifyRoomSource(patched, 'patched source');
  return patched;
}

function verifyRoomSource(source, label) {
  const required = [
    'param1.OnTrigger("am_Trigger_MiniBossDone")',
    'param1.SetVar("ACM01MiniBossDone","1");',
    'param1.GetVar("ACM01MiniBossDone") == "1"',
    'this.am_MiniBoss.Remove();',
    'param1.OnTrigger("am_Trigger_Cutscene")',
    'param1.PlayCutScene(this.Script_PlayOnEntry);'
  ];

  for (const marker of required) {
    if (!source.includes(marker)) {
      throw new Error(`${label} is missing required marker: ${marker}`);
    }
  }

  const triggerSource = getMethodSource(source, 'UpdateTrigger');
  if (
    triggerSource.indexOf('param1.GetVar("ACM01MiniBossDone")') >
    triggerSource.indexOf('param1.OnTrigger("am_Trigger_Cutscene")')
  ) {
    throw new Error(`${label} must check the already-defeated state before the cutscene trigger`);
  }
  if (!triggerSource.includes('param1.CollisionOff("am_DynamicCollision_CastleBlocker");')) {
    throw new Error(`${label} does not clear the castle gate blocker for late joiners`);
  }
  if (!triggerSource.includes('param1.SetPhase(null);')) {
    throw new Error(`${label} does not park the room phase after the late-join skip`);
  }

  const fightSource = getMethodSource(source, 'UpdateFight');
  if (!fightSource.includes('param1.SetVar("ACM01MiniBossDone","1");')) {
    throw new Error(`${label} does not latch the local defeat into the ACM01MiniBossDone game var`);
  }
  if (!fightSource.includes('param1.OnTrigger("am_Trigger_MiniBossDone")')) {
    throw new Error(`${label} does not consume the remote already-defeated trigger during the fight phase`);
  }
  if (!fightSource.includes('param1.CancelScript(this.Script_PlayOnEntry);')) {
    throw new Error(`${label} does not cancel an in-flight intro cutscene when the boss is already dead`);
  }
  if (!fightSource.includes('!this.am_MiniBoss.Defeated()')) {
    throw new Error(`${label} must only abort the fight when the local mini-boss was not defeated locally`);
  }
  if (!fightSource.includes('param1.SetPhase(this.CloseScene);')) {
    throw new Error(`${label} no longer plays the boss-death close scene after a live kill`);
  }
}

function patchSwf(repoRoot, ffdecPath, swfPath) {
  const workRoot = path.join(repoRoot, 'build', 'ffdec-levelsac-deepgard-miniboss-late-join-gate', path.basename(swfPath, path.extname(swfPath)));
  const patchedSwfPath = path.join(workRoot, `${path.basename(swfPath, path.extname(swfPath))}.patched.swf`);
  const roomPath = exportRoomScript(ffdecPath, workRoot, swfPath);
  const original = fs.readFileSync(roomPath, 'utf8');
  const patched = patchRoomSource(original);

  if (patched === original) {
    console.log(`SWF already contains the Deepgard mini-boss late-join gate patch: ${swfPath}`);
    return;
  }

  fs.writeFileSync(roomPath, patched, 'utf8');
  runFfdec(ffdecPath, ['-importScript', swfPath, patchedSwfPath, path.dirname(roomPath)]);
  fs.copyFileSync(patchedSwfPath, swfPath);
  console.log(`Patched Deepgard mini-boss late-join gate in ${swfPath}`);
}

function verifySwf(repoRoot, ffdecPath, swfPath) {
  const workRoot = path.join(repoRoot, 'build', 'ffdec-levelsac-deepgard-miniboss-late-join-gate-verify', path.basename(swfPath, path.extname(swfPath)));
  const roomPath = exportRoomScript(ffdecPath, workRoot, swfPath);
  verifyRoomSource(fs.readFileSync(roomPath, 'utf8'), swfPath);
  console.log(`Verified Deepgard mini-boss late-join gate in ${swfPath}`);
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
