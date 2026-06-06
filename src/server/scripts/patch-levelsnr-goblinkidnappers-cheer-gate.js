const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const CLASS_NAME = 'a_Room_NRIMR03';

function parseArgs(argv) {
  const args = {
    swf: path.join('src', 'client', 'content', 'localhost', 'p', 'cbp', 'LevelsNR.swf'),
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
    '  node src/server/scripts/patch-levelsnr-goblinkidnappers-cheer-gate.js [--verify] [--swf <path>] [--ffdec <path>]',
    '',
    'Patches LevelsNR a_Room_NRIMR03 so the password skit starts on the goblin trigger,',
    'keeps the authored parrot movement, then waits for the player Cheer emote before opening.'
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
    execFileSync('java', ['-jar', resolved, '-cli', ...args], {
      stdio: 'inherit'
    });
    return;
  }

  execFileSync(resolved, ['-cli', ...args], {
    stdio: 'inherit'
  });
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

function insertBeforeMethod(source, methodName, insertion) {
  const marker = `      public function ${methodName}(`;
  const start = source.indexOf(marker);
  if (start === -1) {
    throw new Error(`Could not find insertion point before ${methodName}`);
  }
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  return `${source.slice(0, start)}${insertion}${eol}      ${eol}${source.slice(start)}`;
}

function replaceExact(source, needle, replacement, label) {
  if (!source.includes(needle)) {
    throw new Error(`Could not find patch marker: ${label}`);
  }
  return source.replace(needle, replacement);
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

  if (!patched.includes('public var bOpenDoorScriptStarted:Boolean;')) {
    patched = replaceExact(
      patched,
      `      public var bEmoteTutorialShown:Boolean;${eol}`,
      `      public var bEmoteTutorialShown:Boolean;${eol}      ${eol}      public var bOpenDoorScriptStarted:Boolean;${eol}`,
      'open-door skit state field'
    );
  }

  if (!patched.includes('this.bOpenDoorScriptStarted = false;')) {
    patched = replaceExact(
      patched,
      `         this.bEmoteTutorialShown = false;${eol}`,
      `         this.bEmoteTutorialShown = false;${eol}         this.bOpenDoorScriptStarted = false;${eol}`,
      'open-door skit state init'
    );
  }

  patched = replaceMethod(
    patched,
    'FirstTick',
    normalizeBlock(`
      public function FirstTick(param1:a_GameHook) : void
      {
         param1.Animate("am_Glow1","Off",true);
         param1.Animate("am_Torch1","Off",true);
         this.am_Parrot.Spawn();
         this.am_Parrot.Goto("Red 20");
         param1.SetPhase(this.ClearRoomTick);
         param1.PlayScript(this.Script_OpeningScene);
      }
    `, eol)
  );

  patched = replaceMethod(
    patched,
    'ClearRoomTick',
    normalizeBlock(`
      public function ClearRoomTick(param1:a_GameHook) : void
      {
         if(param1.OnTrigger("am_Trigger_Goblin"))
         {
            param1.CollisionOff("am_DynamicCollision_PathBlock01");
            this.StartGoblinPrompt(param1);
         }
         else if(this.am_Goblin1.Defeated() && this.am_Goblin2.Defeated() && this.am_Goblin3.Defeated() && this.am_Goblin4.Defeated() && this.am_Goblin5.Defeated())
         {
            param1.CollisionOff("am_DynamicCollision_PathBlock01");
            param1.SetPhase(this.WaitingOnGoblin);
         }
      }
    `, eol)
  );

  const startGoblinPrompt = normalizeBlock(`
      public function StartGoblinPrompt(param1:a_GameHook) : void
      {
         if(!this.bGoblinPromptStarted)
         {
            this.bGoblinPromptStarted = true;
            this.bOpenDoorScriptStarted = false;
            this.am_Parrot.Spawn();
            this.am_Parrot.Goto("Red 21");
            param1.SetPhase(this.WaitingOnParrotAtGoblinTick);
         }
      }
    `, eol);

  if (patched.includes('public function StartGoblinPrompt(')) {
    patched = replaceMethod(patched, 'StartGoblinPrompt', startGoblinPrompt);
  } else {
    patched = insertBeforeMethod(patched, 'WaitingOnGoblin', startGoblinPrompt);
  }

  const waitingOnGoblin = normalizeBlock(`
      public function WaitingOnGoblin(param1:a_GameHook) : void
      {
         if(!this.bGoblinPromptStarted && (param1.OnTrigger("am_Trigger_Goblin") || param1.AtTime(2500)))
         {
            this.StartGoblinPrompt(param1);
         }
      }
    `, eol);

  const waitingOnParrotAtGoblinTick = normalizeBlock(`
      public function WaitingOnParrotAtGoblinTick(param1:a_GameHook) : void
      {
         if(param1.AtTimeRepeat(800) && !this.am_Parrot.HasArrived())
         {
            this.am_Parrot.Spawn();
            this.am_Parrot.Goto("Red 21");
         }
         if(!this.bOpenDoorScriptStarted && (this.am_Parrot.HasArrived() || param1.AtTime(7000)))
         {
            this.bOpenDoorScriptStarted = true;
            param1.PlayScript(this.Script_OpenDoor);
         }
         if(this.bOpenDoorScriptStarted && param1.OnScriptFinish(this.Script_OpenDoor))
         {
            param1.Animate("am_Gate","Open",true);
            param1.PlayScript(this.Script_Shake);
            param1.PlayScript(this.Script_AdvanceGoblin);
         }
         if(param1.OnScriptFinish(this.Script_AdvanceGoblin))
         {
            param1.Animate("am_Gate","Close",true);
            param1.PlayScript(this.Script_DelayShake);
            param1.PlayScript(this.Script_Password);
            param1.SetPhase(this.WaitingOnEmoteTick);
         }
      }
    `, eol);

  if (patched.includes('public function WaitingOnParrotAtGoblinTick(')) {
    patched = replaceMethod(patched, 'WaitingOnGoblin', waitingOnGoblin);
    patched = replaceMethod(patched, 'WaitingOnParrotAtGoblinTick', waitingOnParrotAtGoblinTick);
  } else {
    patched = replaceMethod(patched, 'WaitingOnGoblin', waitingOnGoblin);
  }

  patched = replaceMethod(
    patched,
    'WaitingOnEmoteTick',
    normalizeBlock(`
      public function WaitingOnEmoteTick(param1:a_GameHook) : void
      {
         if(param1.AtTime(6300))
         {
            this.bEmoteTutorialShown = true;
            param1.ShowTutorial("am_HighlighterEmote");
         }
         if(param1.OnScriptFinish(this.Script_Password))
         {
            param1.PlayScript(this.Script_LetMeTry);
         }
         if(this.bEmoteTutorialShown && (param1.OnEmote("Cheer L") || param1.ActiveEmote("Cheer L") || param1.OnEmote("Cheer") || param1.ActiveEmote("Cheer")))
         {
            param1.HideTutorial("am_HighlighterEmote");
            param1.CancelScript(this.Script_Password);
            param1.CancelScript(this.Script_LetMeTry);
            param1.Animate("am_Glow1","Off",false);
            param1.Animate("am_Torch1","Off",false);
            param1.PlaySound("a_Sound_Fireball_Big");
            param1.PlayScript(this.Script_GoodJobEmote);
            param1.CollisionOff("am_DynamicCollision_PathBlock02");
            param1.PlayScript(this.Script_Shake);
            param1.Animate("am_Gate","Open",true);
            param1.SetPhase(null);
         }
      }
    `, eol)
  );

  patched = patched.replace(
    'this.Script_OpeningScene = ["0 Parrot Lets go!","4 Parrot <Goto Red 20>"];',
    'this.Script_OpeningScene = ["0 Parrot Lets go!"];'
  );
  patched = patched.replace(
    'this.Script_OpenDoor = ["0 Parrot <Goto Red 21>","2 Goblin Now what was that PASSWORD?","8 Goblin Oh yeah! You have to CHEER in front of the door.","6 Goblin <Cheer>","4 End"];',
    'this.Script_OpenDoor = ["0 Parrot <Goto Red 21>","2 Goblin Now what was that PASSWORD?","8 Goblin Oh yeah! You have to CHEER in front of the door.","6 Goblin <Cheer>","4 End"];'
  );
  patched = patched.replace(
    'this.Script_OpenDoor = ["0 Parrot <Panic>","2 Goblin Now what was that PASSWORD?","8 Goblin Oh yeah! You have to CHEER in front of the door.","6 Goblin <Cheer>","4 End"];',
    'this.Script_OpenDoor = ["0 Parrot <Goto Red 21>","2 Goblin Now what was that PASSWORD?","8 Goblin Oh yeah! You have to CHEER in front of the door.","6 Goblin <Cheer>","4 End"];'
  );
  patched = patched.replace(
    'this.Script_GoodJobEmote = ["4 Parrot <Panic>Woo hoo!","6 Player She can\\\'t be much further.","2 Parrot <Goto Red 23>","9 RemoveCue Parrot"];',
    'this.Script_GoodJobEmote = ["4 Parrot <Panic>Woo hoo!","6 Player She can\\\'t be much further.","2 Parrot <Goto Red 23>","9 RemoveCue Parrot"];'
  );
  patched = patched.replace(
    'this.Script_GoodJobEmote = ["4 Parrot <Panic>Woo hoo!","6 Player She can\\\'t be much further.","9 RemoveCue Parrot"];',
    'this.Script_GoodJobEmote = ["4 Parrot <Panic>Woo hoo!","6 Player She can\\\'t be much further.","2 Parrot <Goto Red 23>","9 RemoveCue Parrot"];'
  );

  verifyRoomSource(patched, 'patched source');
  return patched;
}

function verifyRoomSource(source, label) {
  const required = [
    'public var bOpenDoorScriptStarted:Boolean;',
    'this.bOpenDoorScriptStarted = false;',
    'this.am_Parrot.Goto("Red 20");',
    'this.am_Parrot.Goto("Red 21");',
    'public function StartGoblinPrompt(param1:a_GameHook) : void',
    'param1.OnTrigger("am_Trigger_Goblin") || param1.AtTime(2500)',
    'public function ClearRoomTick(param1:a_GameHook) : void',
    'param1.SetPhase(this.WaitingOnParrotAtGoblinTick);',
    'this.am_Parrot.HasArrived() || param1.AtTime(7000)',
    'param1.PlayScript(this.Script_OpenDoor);',
    'param1.OnEmote("Cheer L")',
    'param1.ActiveEmote("Cheer L")',
    'param1.OnEmote("Cheer")',
    'param1.ActiveEmote("Cheer")',
    'this.Script_OpeningScene = ["0 Parrot Lets go!"];',
    'this.Script_OpenDoor = ["0 Parrot <Goto Red 21>"',
    'this.Script_GoodJobEmote = ["4 Parrot <Panic>Woo hoo!","6 Player She can\\\'t be much further.","2 Parrot <Goto Red 23>","9 RemoveCue Parrot"];'
  ];

  const forbidden = [
    'param1.OnEmote(null)',
    'param1.ActiveEmote(null)',
    'this.bEmoteTutorialShown && (param1.OnEmote("Cheer") || param1.ActiveEmote("Cheer"))',
    'param1.OnScriptFinish(this.Script_LetMeTry) || param1.AtTime(28000)',
    '|| param1.AtTime(40000)',
    'this.am_Parrot.x = this.am_Goblin.x - 90;',
    'this.am_Parrot.y = this.am_Goblin.y - 110;',
    'this.Script_OpenDoor = ["0 Parrot <Panic>"'
  ];

  for (const marker of required) {
    if (!source.includes(marker)) {
      throw new Error(`${label} is missing required marker: ${marker}`);
    }
  }

  for (const marker of forbidden) {
    if (source.includes(marker)) {
      throw new Error(`${label} still contains forbidden marker: ${marker}`);
    }
  }
}

function patchSwf(repoRoot, ffdecPath, swfPath) {
  const workRoot = path.join(repoRoot, 'build', 'ffdec-goblinkidnappers-cheer-gate', path.basename(swfPath, path.extname(swfPath)));
  const patchedSwfPath = path.join(workRoot, `${path.basename(swfPath, path.extname(swfPath))}.patched.swf`);
  const roomPath = exportRoomScript(ffdecPath, workRoot, swfPath);
  const original = fs.readFileSync(roomPath, 'utf8');
  const patched = patchRoomSource(original);

  if (patched === original) {
    console.log(`SWF already contains the cheer gate patch: ${swfPath}`);
    return;
  }

  fs.writeFileSync(roomPath, patched, 'utf8');
  runFfdec(ffdecPath, ['-importScript', swfPath, patchedSwfPath, path.dirname(roomPath)]);
  fs.copyFileSync(patchedSwfPath, swfPath);
  console.log(`Patched cheer gate flow in ${swfPath}`);
}

function verifySwf(repoRoot, ffdecPath, swfPath) {
  const workRoot = path.join(repoRoot, 'build', 'ffdec-goblinkidnappers-cheer-gate-verify', path.basename(swfPath, path.extname(swfPath)));
  const roomPath = exportRoomScript(ffdecPath, workRoot, swfPath);
  verifyRoomSource(fs.readFileSync(roomPath, 'utf8'), swfPath);
  console.log(`Verified cheer gate flow in ${swfPath}`);
}

function main() {
  const repoRoot = resolveRepoRoot();
  const args = parseArgs(process.argv);
  const swfPath = resolvePath(repoRoot, args.swf);
  const ffdecPath = detectFfdec(repoRoot, args.ffdec);

  if (!ffdecPath) {
    throw new Error('FFDec not found. Pass --ffdec or restore the repo-bundled FFDec tool.');
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
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
