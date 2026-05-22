const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const CLASS_NAME = 'a_Room_JCMission2_08';
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
    '  node src/server/scripts/patch-levelsjc-back-alley-boss-intro-autostart.js [--verify] [--swf <path>] [--ffdec <path>]',
    '',
    'Patches LevelsJC a_Room_JCMission2_08 so the Back Alley Deals boss intro',
    'starts even if the one-tick am_Trigger_Boss event is missed.'
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
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  let patched = source;

  if (!patched.includes('public var bBossIntroStarted:Boolean;')) {
    const marker = `      public var bBossIntroFinished:Boolean;${eol}`;
    if (!patched.includes(marker)) {
      throw new Error('Could not find Back Alley boss intro field insertion point');
    }
    patched = patched.replace(marker, `${marker}      ${eol}      public var bBossIntroStarted:Boolean;${eol}`);
  }

  if (!patched.includes('public function StartBossIntro(')) {
    const marker = `      public function HoldBossIntroActors() : void${eol}`;
    if (!patched.includes(marker)) {
      throw new Error('Could not find HoldBossIntroActors insertion point');
    }
    const startMethod = normalizeBlock(`
      public function StartBossIntro(param1:a_GameHook) : void
      {
         this.bBossIntroStarted = true;
         this.bBossIntroFinished = false;
         this.bBossIntroActorsSpawned = false;
         this.bBossIntroBuffsApplied = false;
         this.bBossIntroMeleeBuffApplied = false;
         this.bBossIntroCasterBuffApplied = false;
         this.HoldBossIntroActors();
         param1.bDoubleBossFight = true;
         param1.bossFightBeginsWhenThisGuyIsDead = null;
         param1.bossFightPhase = null;
         this.am_LastGuy.Remove();
         param1.PlayCutScene(param1.cutSceneStartBoss);
         param1.SetPhase(this.UpdateBossIntroGate);
      }
    `, eol);
    patched = patched.replace(marker, `${startMethod}${eol}      ${eol}${marker}`);
  }

  patched = replaceMethod(
    patched,
    'UpdateInitialWait',
    normalizeBlock(`
      public function UpdateInitialWait(param1:a_GameHook) : void
      {
         if(param1.AtTime(0))
         {
            this.bBossIntroStarted = false;
            this.am_LastGuy.AddBuff("DefectorMove");
            this.am_LastGuy.DeepSleep();
            this.am_Mage.AddBuff("DefectorMove");
            this.am_Mage.DeepSleep();
         }
         if(!this.bBossIntroStarted && (param1.OnTrigger("am_Trigger_Boss") || param1.AtTime(750)))
         {
            this.StartBossIntro(param1);
         }
      }
    `, eol)
  );

  verifyRoomSource(patched, 'patched source');
  return patched;
}

function verifyRoomSource(source, label) {
  const required = [
    'public var bBossIntroStarted:Boolean;',
    'public function StartBossIntro(param1:a_GameHook) : void',
    'this.bBossIntroStarted = true;',
    'this.bBossIntroFinished = false;',
    'this.HoldBossIntroActors();',
    'param1.PlayCutScene(param1.cutSceneStartBoss);',
    'param1.SetPhase(this.UpdateBossIntroGate);',
    'if(!this.bBossIntroStarted && (param1.OnTrigger("am_Trigger_Boss") || param1.AtTime(750)))',
    'this.StartBossIntro(param1);',
    'this.am_Boss.bHoldEngage = true;',
    'this.am_Boss2.bHoldEngage = true;',
    'param1.bossFightBeginsWhenThisGuyIsDead = null;',
    'param1.bossFightPhase = null;'
  ];

  for (const marker of required) {
    if (!source.includes(marker)) {
      throw new Error(`${label} is missing required marker: ${marker}`);
    }
  }

  const forbidden = [
    'param1.bossFightBeginsWhenThisGuyIsDead = "am_LastGuy";',
    'param1.bossFightPhase = this.UpdatePhaseOne;'
  ];
  for (const marker of forbidden) {
    if (source.includes(marker)) {
      throw new Error(`${label} still contains unsafe boss intro marker: ${marker}`);
    }
  }
}

function patchSwf(repoRoot, ffdecPath, swfPath) {
  const workRoot = path.join(repoRoot, 'build', 'ffdec-levelsjc-back-alley-boss-intro-autostart', path.basename(swfPath, path.extname(swfPath)));
  const patchedSwfPath = path.join(workRoot, `${path.basename(swfPath, path.extname(swfPath))}.patched.swf`);
  const roomPath = exportRoomScript(ffdecPath, workRoot, swfPath);
  const original = fs.readFileSync(roomPath, 'utf8');
  const patched = patchRoomSource(original);

  if (patched === original) {
    console.log(`SWF already contains the Back Alley boss intro autostart patch: ${swfPath}`);
    return;
  }

  fs.writeFileSync(roomPath, patched, 'utf8');
  runFfdec(ffdecPath, ['-importScript', swfPath, patchedSwfPath, path.dirname(roomPath)]);
  fs.copyFileSync(patchedSwfPath, swfPath);
  console.log(`Patched Back Alley boss intro autostart in ${swfPath}`);
}

function verifySwf(repoRoot, ffdecPath, swfPath) {
  const workRoot = path.join(repoRoot, 'build', 'ffdec-levelsjc-back-alley-boss-intro-autostart-verify', path.basename(swfPath, path.extname(swfPath)));
  const roomPath = exportRoomScript(ffdecPath, workRoot, swfPath);
  verifyRoomSource(fs.readFileSync(roomPath, 'utf8'), swfPath);
  console.log(`Verified Back Alley boss intro autostart in ${swfPath}`);
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
