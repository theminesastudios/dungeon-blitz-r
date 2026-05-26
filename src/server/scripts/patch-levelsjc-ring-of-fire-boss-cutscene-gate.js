const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const CLASS_NAME = 'a_Room_JCMission11_09';
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
    '  node src/server/scripts/patch-levelsjc-ring-of-fire-boss-cutscene-gate.js [--verify] [--swf <path>] [--ffdec <path>]',
    '',
    'Patches LevelsJC a_Room_JCMission11_09 so the Ring Of Fire boss',
    'waits for the boss intro cutscene to finish before engaging.'
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
  let patched = source;

  if (!patched.includes('public var bBossIntroFinished:Boolean;')) {
    const marker = `      public var groups:Vector.<MovieClip>;${eol}`;
    if (!patched.includes(marker)) {
      throw new Error('Could not find Ring Of Fire boss intro field insertion point');
    }
    patched = patched.replace(
      marker,
      `${marker}      ${eol}      public var bBossIntroFinished:Boolean;${eol}`
    );
  }

  if (!patched.includes('this.am_Boss.bHoldEngage = true;')) {
    const marker = `         this.am_Boss.bHoldSpawn = true;${eol}`;
    if (!patched.includes(marker)) {
      throw new Error('Could not find Ring Of Fire boss hold insertion point');
    }
    patched = patched.replace(marker, `${marker}         this.am_Boss.bHoldEngage = true;${eol}`);
  }

  patched = replaceMethod(
    patched,
    'UpdateChooseWave',
    normalizeBlock(`
      public function UpdateChooseWave(param1:a_GameHook) : void
      {
         if(param1.AtTime(2000))
         {
            if(this.groupIndex <= this.NUMBER_GROUPS_TO_FIGHT)
            {
               this.activeGroup = this.groups[this.groupIndex];
               param1.Group(this.activeGroup).Spawn();
               ++this.groupIndex;
               this.am_Marker1.QuickFirePower("OasisTeleportEffectLarge");
               this.am_Marker2.QuickFirePower("OasisTeleportEffectLarge");
               param1.SetPhase(this.UpdateFightWave);
            }
            else
            {
               this.groups = null;
               this.activeGroup = null;
               this.bBossIntroFinished = false;
               this.am_Boss.Spawn();
               this.HoldBossIntro();
               this.am_Marker2.QuickFirePower("OasisTeleportEffectLarge");
               this.am_LastGuy.Kill();
               param1.bossFightPhase = this.UpdateBossIntroGate;
            }
         }
      }
    `, eol)
  );

  const holdMethod = normalizeBlock(`
      public function HoldBossIntro() : void
      {
         this.am_Boss.bHoldEngage = true;
         this.am_Boss.DeepSleep();
         this.am_Boss.ClearHate();
      }
  `, eol);

  const releaseMethod = normalizeBlock(`
      public function ReleaseBossIntro() : void
      {
         this.bBossIntroFinished = true;
         this.am_Boss.bHoldEngage = false;
         this.am_Boss.ClearHate();
         this.am_Boss.Aggro();
      }
  `, eol);

  const gateMethod = normalizeBlock(`
      public function UpdateBossIntroGate(param1:a_GameHook) : void
      {
         if(!this.bBossIntroFinished && !param1.OnScriptFinish(param1.cutSceneStartBoss) && !param1.AtTime(16000))
         {
            this.HoldBossIntro();
            return;
         }
         this.ReleaseBossIntro();
         param1.bossFightPhase = this.UpdateBossFight;
         param1.SetPhase(null);
      }
  `, eol);

  const marker = `      public function UpdateBossFight(param1:a_GameHook) : void${eol}`;
  if (!patched.includes(marker)) {
    throw new Error('Could not find UpdateBossFight insertion point');
  }

  if (patched.includes('public function HoldBossIntro(')) {
    patched = replaceMethod(patched, 'HoldBossIntro', holdMethod);
  } else {
    patched = patched.replace(marker, `${holdMethod}${eol}      ${eol}${marker}`);
  }

  if (patched.includes('public function ReleaseBossIntro(')) {
    patched = replaceMethod(patched, 'ReleaseBossIntro', releaseMethod);
  } else {
    patched = patched.replace(marker, `${releaseMethod}${eol}      ${eol}${marker}`);
  }

  if (patched.includes('public function UpdateBossIntroGate(')) {
    patched = replaceMethod(patched, 'UpdateBossIntroGate', gateMethod);
  } else {
    patched = patched.replace(marker, `${gateMethod}${eol}      ${eol}${marker}`);
  }

  verifyRoomSource(patched, 'patched source');
  return patched;
}

function verifyRoomSource(source, label) {
  const required = [
    'public var bBossIntroFinished:Boolean;',
    'this.am_Boss.bHoldEngage = true;',
    'this.bBossIntroFinished = false;',
    'this.HoldBossIntro();',
    'param1.bossFightPhase = this.UpdateBossIntroGate;',
    'public function HoldBossIntro() : void',
    'this.am_Boss.DeepSleep();',
    'this.am_Boss.ClearHate();',
    'public function ReleaseBossIntro() : void',
    'this.bBossIntroFinished = true;',
    'this.am_Boss.bHoldEngage = false;',
    'this.am_Boss.Aggro();',
    'public function UpdateBossIntroGate(param1:a_GameHook) : void',
    'param1.OnScriptFinish(param1.cutSceneStartBoss)',
    'param1.AtTime(16000)',
    'param1.bossFightPhase = this.UpdateBossFight;',
    'param1.SetPhase(null);'
  ];

  for (const marker of required) {
    if (!source.includes(marker)) {
      throw new Error(`${label} is missing required marker: ${marker}`);
    }
  }
}

function patchSwf(repoRoot, ffdecPath, swfPath) {
  const workRoot = path.join(repoRoot, 'build', 'ffdec-levelsjc-ring-of-fire-boss-cutscene-gate', path.basename(swfPath, path.extname(swfPath)));
  const patchedSwfPath = path.join(workRoot, `${path.basename(swfPath, path.extname(swfPath))}.patched.swf`);
  const roomPath = exportRoomScript(ffdecPath, workRoot, swfPath);
  const original = fs.readFileSync(roomPath, 'utf8');
  const patched = patchRoomSource(original);

  if (patched === original) {
    console.log(`SWF already contains the Ring Of Fire boss cutscene gate patch: ${swfPath}`);
    return;
  }

  fs.writeFileSync(roomPath, patched, 'utf8');
  runFfdec(ffdecPath, ['-importScript', swfPath, patchedSwfPath, path.dirname(roomPath)]);
  fs.copyFileSync(patchedSwfPath, swfPath);
  console.log(`Patched Ring Of Fire boss cutscene gate in ${swfPath}`);
}

function verifySwf(repoRoot, ffdecPath, swfPath) {
  const workRoot = path.join(repoRoot, 'build', 'ffdec-levelsjc-ring-of-fire-boss-cutscene-gate-verify', path.basename(swfPath, path.extname(swfPath)));
  const roomPath = exportRoomScript(ffdecPath, workRoot, swfPath);
  verifyRoomSource(fs.readFileSync(roomPath, 'utf8'), swfPath);
  console.log(`Verified Ring Of Fire boss cutscene gate in ${swfPath}`);
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
