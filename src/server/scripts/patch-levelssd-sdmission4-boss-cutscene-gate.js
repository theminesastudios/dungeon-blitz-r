const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const CLASS_NAME = 'a_Room_SDMission4_11';
const DEFAULT_SWF = path.join('src', 'client', 'content', 'localhost', 'p', 'cam', 'LevelsSD.swf');

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
    '  node src/server/scripts/patch-levelssd-sdmission4-boss-cutscene-gate.js [--verify] [--swf <path>] [--ffdec <path>]',
    '',
    'Patches LevelsSD a_Room_SDMission4_11 so the Goblin Diplomacy final boss',
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

  if (!patched.includes('public var bMainBossIntroFinished:Boolean;')) {
    const marker = `      public var bFirstYellow:Boolean;${eol}`;
    if (!patched.includes(marker)) {
      throw new Error('Could not find SD_Mission4 boss intro field insertion point');
    }
    patched = patched.replace(
      marker,
      `${marker}      ${eol}      public var bMainBossIntroFinished:Boolean;${eol}`
    );
  }

  if (!patched.includes('this.am_Boss.bHoldEngage = true;')) {
    const marker = `         this.am_Boss.bHoldSpawn = true;${eol}`;
    if (!patched.includes(marker)) {
      throw new Error('Could not find SD_Mission4 boss hold insertion point');
    }
    patched = patched.replace(marker, `${marker}         this.am_Boss.bHoldEngage = true;${eol}`);
  }

  patched = replaceMethod(
    patched,
    'StartMainBossFight',
    normalizeBlock(`
      public function StartMainBossFight(param1:a_GameHook) : void
      {
         if(param1.AtTime(0))
         {
            this.bMainBossIntroFinished = false;
            this.HoldMainBossIntro();
            this.am_Clone1.RemoveAllBuffs();
            this.am_Clone2.RemoveAllBuffs();
            this.am_Clone3.RemoveAllBuffs();
            this.am_Clone1.AddBuff("Ethereal");
            this.am_Clone2.AddBuff("Ethereal");
            this.am_Clone3.AddBuff("Ethereal");
            this.am_Clone1.AddBuff("MoveFast");
            this.am_Clone2.AddBuff("MoveFast");
            this.am_Clone3.AddBuff("MoveFast");
            this.am_Clone1.DeepSleep();
            this.am_Clone2.DeepSleep();
            this.am_Clone3.DeepSleep();
            param1.PlayScript(this.Script_MergeToCenter);
         }
         if(param1.OnScriptFinish(this.Script_MergeToCenter) || param1.AtTime(12000))
         {
            this.HoldMainBossIntro();
            this.am_LastMonster.Kill();
            param1.bossFightPhase = this.UpdateMainBossIntroGate;
            param1.SetPhase(null);
         }
      }
    `, eol)
  );

  const holdMethod = normalizeBlock(`
      public function HoldMainBossIntro() : void
      {
         this.am_Boss.bHoldEngage = true;
         this.am_Boss.DeepSleep();
         this.am_Boss.ClearHate();
      }
  `, eol);

  const releaseMethod = normalizeBlock(`
      public function ReleaseMainBossIntro() : void
      {
         this.bMainBossIntroFinished = true;
         this.am_Boss.bHoldEngage = false;
         this.am_Boss.ClearHate();
         this.am_Boss.Aggro();
      }
  `, eol);

  const gateMethod = normalizeBlock(`
      public function UpdateMainBossIntroGate(param1:a_GameHook) : void
      {
         if(!this.bMainBossIntroFinished && !param1.OnScriptFinish(param1.cutSceneStartBoss) && !param1.AtTime(30000))
         {
            this.HoldMainBossIntro();
            return;
         }
         this.ReleaseMainBossIntro();
         param1.bossFightPhase = this.UpdateMainBoss;
         param1.SetPhase(null);
      }
  `, eol);

  const marker = `      public function UpdateMainBoss(param1:a_GameHook) : void${eol}`;
  if (!patched.includes(marker)) {
    throw new Error('Could not find UpdateMainBoss insertion point');
  }

  if (patched.includes('public function HoldMainBossIntro(')) {
    patched = replaceMethod(patched, 'HoldMainBossIntro', holdMethod);
  } else {
    patched = patched.replace(marker, `${holdMethod}${eol}      ${eol}${marker}`);
  }

  if (patched.includes('public function ReleaseMainBossIntro(')) {
    patched = replaceMethod(patched, 'ReleaseMainBossIntro', releaseMethod);
  } else {
    patched = patched.replace(marker, `${releaseMethod}${eol}      ${eol}${marker}`);
  }

  if (patched.includes('public function UpdateMainBossIntroGate(')) {
    patched = replaceMethod(patched, 'UpdateMainBossIntroGate', gateMethod);
  } else {
    patched = patched.replace(marker, `${gateMethod}${eol}      ${eol}${marker}`);
  }

  verifyRoomSource(patched, 'patched source');
  return patched;
}

function verifyRoomSource(source, label) {
  const required = [
    'public var bMainBossIntroFinished:Boolean;',
    'this.am_Boss.bHoldEngage = true;',
    'this.bMainBossIntroFinished = false;',
    'this.HoldMainBossIntro();',
    'param1.OnScriptFinish(this.Script_MergeToCenter) || param1.AtTime(12000)',
    'param1.bossFightPhase = this.UpdateMainBossIntroGate;',
    'public function HoldMainBossIntro() : void',
    'this.am_Boss.DeepSleep();',
    'this.am_Boss.ClearHate();',
    'public function ReleaseMainBossIntro() : void',
    'this.bMainBossIntroFinished = true;',
    'this.am_Boss.bHoldEngage = false;',
    'this.am_Boss.Aggro();',
    'public function UpdateMainBossIntroGate(param1:a_GameHook) : void',
    'param1.OnScriptFinish(param1.cutSceneStartBoss)',
    'param1.AtTime(30000)',
    'param1.bossFightPhase = this.UpdateMainBoss;',
    'param1.SetPhase(null);'
  ];

  for (const marker of required) {
    if (!source.includes(marker)) {
      throw new Error(`${label} is missing required marker: ${marker}`);
    }
  }
}

function patchSwf(repoRoot, ffdecPath, swfPath) {
  const workRoot = path.join(repoRoot, 'build', 'ffdec-levelssd-sdmission4-boss-cutscene-gate', path.basename(swfPath, path.extname(swfPath)));
  const patchedSwfPath = path.join(workRoot, `${path.basename(swfPath, path.extname(swfPath))}.patched.swf`);
  const roomPath = exportRoomScript(ffdecPath, workRoot, swfPath);
  const original = fs.readFileSync(roomPath, 'utf8');
  const patched = patchRoomSource(original);

  if (patched === original) {
    console.log(`SWF already contains the SD_Mission4 boss cutscene gate patch: ${swfPath}`);
    return;
  }

  fs.writeFileSync(roomPath, patched, 'utf8');
  runFfdec(ffdecPath, ['-importScript', swfPath, patchedSwfPath, path.dirname(roomPath)]);
  fs.copyFileSync(patchedSwfPath, swfPath);
  console.log(`Patched SD_Mission4 boss cutscene gate in ${swfPath}`);
}

function verifySwf(repoRoot, ffdecPath, swfPath) {
  const workRoot = path.join(repoRoot, 'build', 'ffdec-levelssd-sdmission4-boss-cutscene-gate-verify', path.basename(swfPath, path.extname(swfPath)));
  const roomPath = exportRoomScript(ffdecPath, workRoot, swfPath);
  verifyRoomSource(fs.readFileSync(roomPath, 'utf8'), swfPath);
  console.log(`Verified SD_Mission4 boss cutscene gate in ${swfPath}`);
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
