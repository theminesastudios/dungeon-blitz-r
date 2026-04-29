#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const CLASS_NAME = "a_Room_Tutorial_04";
const DEFAULT_SWF = path.join("src", "client", "content", "localhost", "p", "cbp", "LevelsNR.swf");

function parseArgs(argv) {
  const args = { ffdec: "", swf: DEFAULT_SWF, verify: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--ffdec" || arg === "-f") {
      args.ffdec = argv[++i] || "";
      continue;
    }
    if (arg === "--swf" || arg === "--swf-path") {
      args.swf = argv[++i] || "";
      continue;
    }
    if (arg === "--verify" || arg === "--dry-run") {
      args.verify = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log("node src/server/scripts/patch_levelsnr_room4_jump_training_rewrite.js [--verify] [--swf <path>] [--ffdec <path>]");
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function repoRoot() {
  return path.resolve(__dirname, "..", "..", "..");
}

function resolvePath(root, value) {
  return path.isAbsolute(value) ? value : path.join(root, value);
}

function detectFfdec(root, preferred) {
  const candidates = [];
  if (preferred) {
    candidates.push(resolvePath(root, preferred));
  }
  candidates.push(
    path.join(root, "build", "tools", "ffdec_25.0.0", "ffdec-cli.exe"),
    path.join(root, "build", "tools", "ffdec_25.0.0", "ffdec-cli.jar"),
    path.join(root, "build", "tools", "ffdec_25.0.0", "ffdec.bat"),
  );
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || "";
}

function runFfdec(ffdecPath, args) {
  const resolved = path.resolve(ffdecPath);
  const basename = path.basename(resolved).toLowerCase();
  if (basename.endsWith(".jar")) {
    execFileSync("java", ["-jar", resolved, "-cli", ...args], { stdio: "inherit" });
    return;
  }
  if (basename.endsWith(".bat")) {
    execFileSync("cmd.exe", ["/c", resolved, "-cli", ...args], { stdio: "inherit" });
    return;
  }
  execFileSync(resolved, ["-cli", ...args], { stdio: "inherit" });
}

function replaceExact(source, needle, replacement, label) {
  if (!source.includes(needle)) {
    throw new Error(`Could not find ${label} in ${CLASS_NAME}.as`);
  }
  return source.replace(needle, replacement);
}

function patchSource(source) {
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const join = (lines) => lines.join(eol);

  if (source.includes("public function OnJumpTrainingEnterFrame")) {
    return source;
  }

  source = replaceExact(
    source,
    "      public var Script_FindDoor:Array;",
    join([
      "      public var Script_FindDoor:Array;",
      "",
      "      public var roomHook:a_GameHook;",
      "",
      "      public var trackedPlayer:Object;",
      "",
      "      public var jumpPhaseState:String;",
      "",
      "      public var wasOnGround:Boolean;",
      "",
      "      public var jumpStarted:Boolean;",
      "",
      "      public var jumpCompleted:Boolean;",
      "",
      "      public var jumpGroundY:Number;",
      "",
      "      public var jumpGroundedEpsilon:Number = 1;",
    ]),
    "state field block",
  );

  source = replaceExact(
    source,
    join([
      "      public function InitRoom(param1:a_GameHook) : void",
      "      {",
      "         param1.initialPhase = this.FirstTick;",
      "      }",
    ]),
    join([
      "      public function InitRoom(param1:a_GameHook) : void",
      "      {",
      "         this.roomHook = param1;",
      "         this.trackedPlayer = null;",
      "         this.jumpPhaseState = \"IDLE\";",
      "         this.wasOnGround = false;",
      "         this.jumpStarted = false;",
      "         this.jumpCompleted = false;",
      "         this.jumpGroundY = NaN;",
      "         if(!this.hasEventListener(Event.ENTER_FRAME))",
      "         {",
      "            this.addEventListener(Event.ENTER_FRAME,this.OnJumpTrainingEnterFrame);",
      "         }",
      "         param1.initialPhase = this.FirstTick;",
      "      }",
    ]),
    "InitRoom",
  );

  source = replaceExact(
    source,
    join([
      "      public function WaitingForJump(param1:a_GameHook) : void",
      "      {",
      "         if(param1.OnScriptFinish(this.Script_OpeningScene))",
      "         {",
      "            param1.Animate(\"am_JumpTut\",\"Show\",true);",
      "         }",
      "         if(param1.OnTrigger(\"am_Trigger_Fall2\"))",
      "         {",
      "            param1.PlayScript(this.Script_Fall);",
      "         }",
      "         if(param1.OnTrigger(\"am_Trigger_2\"))",
      "         {",
      "            param1.Animate(\"am_JumpTut\",\"Remove\",true);",
      "            param1.Animate(\"am_DropTut\",\"Show\",true);",
      "            param1.CancelScript(this.Script_OpeningScene);",
      "            param1.CancelScript(this.Script_Fall);",
      "            if(param1.GetTime() < 3000)",
      "            {",
      "               param1.PlayScript(this.Script_JumpFast);",
      "            }",
      "            else",
      "            {",
      "               param1.PlayScript(this.Script_JumpSlow);",
      "            }",
      "            param1.SetPhase(this.WaitingForDrop);",
      "         }",
      "      }",
    ]),
    join([
      "      public function WaitingForJump(param1:a_GameHook) : void",
      "      {",
      "         if(param1.OnScriptFinish(this.Script_OpeningScene))",
      "         {",
      "            param1.Animate(\"am_JumpTut\",\"Show\",true);",
      "            if(this.jumpPhaseState == \"IDLE\")",
      "            {",
      "               this.BeginJumpTracking();",
      "            }",
      "         }",
      "         if(param1.OnTrigger(\"am_Trigger_Fall2\"))",
      "         {",
      "            param1.PlayScript(this.Script_Fall);",
      "         }",
      "         if(this.jumpPhaseState == \"JUMP\" && this.jumpCompleted)",
      "         {",
      "            this.CompleteJumpTutorial(param1);",
      "         }",
      "      }",
    ]),
    "WaitingForJump",
  );

  source = replaceExact(
    source,
    join([
      "      public function WaitingOnDoor(param1:a_GameHook) : void",
      "      {",
      "         if(param1.AtTime(15000))",
      "         {",
      "            param1.Animate(\"am_DoorTut\",\"Remove\",true);",
      "            param1.SetPhase(null);",
      "         }",
      "      }",
    ]),
    join([
      "      public function WaitingOnDoor(param1:a_GameHook) : void",
      "      {",
      "         if(param1.AtTime(15000))",
      "         {",
      "            this.jumpPhaseState = \"DONE\";",
      "            param1.Animate(\"am_DoorTut\",\"Remove\",true);",
      "            param1.SetPhase(null);",
      "         }",
      "      }",
    ]),
    "WaitingOnDoor",
  );

  source = replaceExact(
    source,
    "      internal function __setProp___id426__a_Room_Tutorial_04_cues_0() : *",
    join([
      "      public function ResolveTrackedPlayer() : Object",
      "      {",
      "         var _loc1_:Object = null;",
      "         _loc1_ = this.roomHook != null ? this.roomHook.linkToRoom as Room : null;",
      "         if(_loc1_ && _loc1_.var_1 && _loc1_.var_1.clientEnt && _loc1_.var_1.clientEnt.currRoom == _loc1_)",
      "         {",
      "            return _loc1_.var_1.clientEnt;",
      "         }",
      "         return null;",
      "      }",
      "",
      "      public function GetTrackedPlayerGrounded(param1:Object) : Boolean",
      "      {",
      "         if(!param1)",
      "         {",
      "            return false;",
      "         }",
      "         if(param1.cue && param1.cue.bDidGroundSnap)",
      "         {",
      "            this.jumpGroundY = Number(param1.physPosY);",
      "            return true;",
      "         }",
      "         if(isNaN(this.jumpGroundY) || Number(param1.physPosY) > this.jumpGroundY)",
      "         {",
      "            this.jumpGroundY = Number(param1.physPosY);",
      "         }",
      "         return Number(param1.physPosY) >= this.jumpGroundY - this.jumpGroundedEpsilon;",
      "      }",
      "",
      "      public function BeginJumpTracking() : void",
      "      {",
      "         this.trackedPlayer = this.ResolveTrackedPlayer();",
      "         if(!this.trackedPlayer)",
      "         {",
      "            return;",
      "         }",
      "         this.jumpPhaseState = \"JUMP\";",
      "         this.jumpStarted = false;",
      "         this.jumpCompleted = false;",
      "         this.wasOnGround = this.GetTrackedPlayerGrounded(this.trackedPlayer);",
      "         if(this.wasOnGround)",
      "         {",
      "            this.jumpGroundY = Number(this.trackedPlayer.physPosY);",
      "         }",
      "      }",
      "",
      "      public function CompleteJumpTutorial(param1:a_GameHook) : void",
      "      {",
      "         this.jumpPhaseState = \"DROPPING\";",
      "         param1.Animate(\"am_JumpTut\",\"Remove\",true);",
      "         param1.Animate(\"am_DropTut\",\"Show\",true);",
      "         param1.CancelScript(this.Script_OpeningScene);",
      "         param1.CancelScript(this.Script_Fall);",
      "         if(param1.GetTime() < 3000)",
      "         {",
      "            param1.PlayScript(this.Script_JumpFast);",
      "         }",
      "         else",
      "         {",
      "            param1.PlayScript(this.Script_JumpSlow);",
      "         }",
      "         param1.SetPhase(this.WaitingForDrop);",
      "      }",
      "",
      "      public function OnJumpTrainingEnterFrame(param1:Event) : void",
      "      {",
      "         var _loc2_:Boolean = false;",
      "         if(this.jumpPhaseState != \"JUMP\" || this.jumpCompleted || !this.roomHook)",
      "         {",
      "            return;",
      "         }",
      "         this.trackedPlayer = this.ResolveTrackedPlayer();",
      "         if(!this.trackedPlayer)",
      "         {",
      "            return;",
      "         }",
      "         _loc2_ = this.GetTrackedPlayerGrounded(this.trackedPlayer);",
      "         if(this.wasOnGround && !_loc2_)",
      "         {",
      "            this.jumpStarted = true;",
      "         }",
      "         else if(this.jumpStarted && _loc2_)",
      "         {",
      "            this.jumpCompleted = true;",
      "         }",
      "         this.wasOnGround = _loc2_;",
      "      }",
      "",
      "      internal function __setProp___id426__a_Room_Tutorial_04_cues_0() : *",
    ]),
    "helper insertion point",
  );

  return source;
}

function verifyPatchedSource(source) {
  if (!source.includes("public function OnJumpTrainingEnterFrame")) {
    throw new Error("Patched source is missing the ENTER_FRAME tracker.");
  }
  if (!source.includes("this.roomHook != null ? this.roomHook.linkToRoom : null")) {
    throw new Error("Patched source is missing Room-based player resolution.");
  }
  if (!source.includes("bDidGroundSnap")) {
    throw new Error("Patched source is missing grounded flag detection.");
  }
  if (source.includes("Key.isDown(")) {
    throw new Error("Patched source unexpectedly uses Key.isDown.");
  }
  const jumpStart = source.indexOf("public function WaitingForJump");
  const dropStart = source.indexOf("public function WaitingForDrop");
  if (jumpStart === -1 || dropStart === -1) {
    throw new Error("Could not isolate WaitingForJump source.");
  }
  const waitingForJump = source.slice(jumpStart, dropStart);
  if (waitingForJump.includes("OnTrigger(\"am_Trigger_2\")")) {
    throw new Error("WaitingForJump still depends on am_Trigger_2.");
  }
}

function exportSource(ffdecPath, workRoot, swfPath) {
  fs.rmSync(workRoot, { recursive: true, force: true });
  fs.mkdirSync(workRoot, { recursive: true });
  runFfdec(ffdecPath, ["-selectclass", CLASS_NAME, "-export", "script", workRoot, swfPath]);
  const scriptPath = path.join(workRoot, "scripts", `${CLASS_NAME}.as`);
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`FFDec export did not create ${CLASS_NAME}.as`);
  }
  return scriptPath;
}

function ensureBackup(filePath) {
  const backupPath = `${filePath}.bak`;
  if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(filePath, backupPath);
  }
}

function applyPatch(root, ffdecPath, swfPath) {
  const workRoot = path.join(root, "build", "ffdec-levelsnr-room4-jump-training");
  const outputSwfPath = path.join(workRoot, "LevelsNR.patched.swf");
  const scriptPath = exportSource(ffdecPath, workRoot, swfPath);
  const patchedSource = patchSource(fs.readFileSync(scriptPath, "utf8"));
  verifyPatchedSource(patchedSource);
  fs.writeFileSync(scriptPath, patchedSource, "utf8");
  runFfdec(ffdecPath, ["-importScript", swfPath, outputSwfPath, path.join(workRoot, "scripts")]);
  ensureBackup(swfPath);
  fs.copyFileSync(outputSwfPath, swfPath);
  console.log(`Patched jump training rewrite into ${swfPath}`);
}

function verifyPatch(root, ffdecPath, swfPath) {
  const workRoot = path.join(root, "build", "ffdec-levelsnr-room4-jump-training-verify");
  const scriptPath = exportSource(ffdecPath, workRoot, swfPath);
  verifyPatchedSource(fs.readFileSync(scriptPath, "utf8"));
  console.log(`Verified jump training rewrite markers in ${swfPath}`);
}

function main() {
  const args = parseArgs(process.argv);
  const root = repoRoot();
  const ffdecPath = detectFfdec(root, args.ffdec);
  const swfPath = resolvePath(root, args.swf);
  if (!ffdecPath) {
    throw new Error("FFDec not found. Pass --ffdec or install JPEXS FFDec.");
  }
  if (!fs.existsSync(swfPath)) {
    throw new Error(`SWF not found: ${swfPath}`);
  }
  if (args.verify) {
    verifyPatch(root, ffdecPath, swfPath);
    return;
  }
  applyPatch(root, ffdecPath, swfPath);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
