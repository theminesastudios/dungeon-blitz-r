import * as path from "path";
import {
  applyPatchesToBody,
  BytePatch,
  classIndexByName,
  disassemble,
  ensureBackup,
  Instruction,
  methodIdxForTrait,
  parseAbc,
  parseSwf,
  PatchError,
  u30OperandName,
  writeSwf,
} from "./swfPatchUtils";

/**
 * Show the HP and Mana numbers without hovering the bars.
 *
 * The HUD (class_58, "a_Hud") already builds am_HPText, am_ManaText and am_ClassManaText,
 * and Tick rewrites all three every frame whether or not anyone can see them. They are
 * simply created with visible=false and flipped on by a ROLL_OVER listener, so the numbers
 * a player wants during a fight are exactly the numbers they cannot read while playing --
 * reading them means parking the cursor off the fight.
 *
 * So this flips the six `visible = false` writes that keep them hidden: three in
 * OnCreateScreen and one in each of the three ROLL_OUT handlers. Because Tick already
 * maintains the text, nothing else has to change.
 *
 * am_TempHPText is deliberately left alone. It is the shield overlay, and Tick drives its
 * visibility from whether a shield actually exists -- forcing it on would pin a stale
 * number to the bar whenever the player has no shield. Its own logic already reads
 * `if (am_HPText.visible) am_TempHPText.visible = true`, so it follows the HP number for
 * free once that is pinned.
 *
 * ponytail: pinned on rather than a toggle with its own UI and saved setting. A toggle
 * needs a stored boolean, a control to click and a new handler method, and adding a method
 * to a class in AVM2 by byte patching is a different order of surgery. The hover listeners
 * are untouched, so nothing is lost; if players want to hide the numbers again, that is
 * when to spend the toggle.
 *
 * Every edit is one byte, pushfalse (0x27) -> pushtrue (0x26), so the method bodies keep
 * their exact length and every branch offset in them stays valid.
 */

const DEFAULT_SWF = path.resolve(
  __dirname,
  "..",
  "..",
  "client",
  "content",
  "localhost",
  "p",
  "cbp",
  "DungeonBlitz.swf",
);

const HUD_CLASS = "class_58";
const PUSH_FALSE = 0x27;
const PUSH_TRUE = 0x26;
const OP_GETPROPERTY = 0x66;
const OP_SETPROPERTY = 0x61;

/** Method -> the vitals text fields whose `visible` write it should pin on. */
const TARGETS: Array<{ method: string; fields: string[] }> = [
  { method: "OnCreateScreen", fields: ["am_HPText", "am_ManaText", "am_ClassManaText"] },
  { method: "method_852", fields: ["am_HPText"] }, // HP bar ROLL_OUT
  { method: "method_717", fields: ["am_ManaText"] }, // Mana bar ROLL_OUT
  { method: "method_1230", fields: ["am_ClassManaText"] }, // Class mana bar ROLL_OUT
];

const EXPECTED_FLIPS = TARGETS.reduce((total, target) => total + target.fields.length, 0);

function parseArgs(argv: string[]): { swfPath: string; verify: boolean; revert: boolean } {
  let swfPath = DEFAULT_SWF;
  let verify = false;
  let revert = false;

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--swf" || arg === "-s") {
      swfPath = path.resolve(argv[++index] || "");
      continue;
    }
    if (arg === "--verify" || arg === "--dry-run") {
      verify = true;
      continue;
    }
    if (arg === "--revert") {
      revert = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log([
        "Usage:",
        "  ts-node src/server/scripts/patch-dungeonblitz-always-show-vitals.ts [--verify] [--swf <path>]",
        "",
        "Pins the HUD HP and Mana numbers on so they no longer need a mouse hover.",
        "",
        "  --revert   put the numbers back behind a mouse hover",
      ].join("\n"));
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { swfPath, verify, revert };
}

/**
 * The one shape worth matching, because `mouseEnabled` is written with an identical
 * getproperty/pushfalse pair two instructions earlier:
 *
 *   getproperty <field>   ; am_HPText & friends
 *   pushfalse
 *   setproperty visible
 *
 * Anchoring on the trailing `setproperty visible` is what separates the two.
 */
function findVisibilityPushes(
  code: Buffer,
  instructions: Instruction[],
  multinameNames: string[],
  fields: string[],
  wanted: number,
): number[] {
  const offsets: number[] = [];

  for (let index = 0; index + 2 < instructions.length; index += 1) {
    const [get, push, set] = [instructions[index], instructions[index + 1], instructions[index + 2]];
    if (get.opcode !== OP_GETPROPERTY || set.opcode !== OP_SETPROPERTY) {
      continue;
    }
    if (push.opcode !== PUSH_FALSE && push.opcode !== PUSH_TRUE) {
      continue;
    }
    if (u30OperandName(set, multinameNames) !== "visible") {
      continue;
    }

    const field = u30OperandName(get, multinameNames);
    if (!field || !fields.includes(field)) {
      continue;
    }

    if (code[push.offset] === wanted) {
      offsets.push(push.offset);
    }
  }

  return offsets;
}

function collectPatches(
  swfPath: string,
  revert: boolean,
): { ctx: ReturnType<typeof parseSwf>; patches: BytePatch[]; alreadyDone: number } {
  const from = revert ? PUSH_TRUE : PUSH_FALSE;
  const to = revert ? PUSH_FALSE : PUSH_TRUE;
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);
  const classIndex = classIndexByName(abc, HUD_CLASS);
  if (classIndex === null) {
    throw new PatchError(`Could not find the HUD class ${HUD_CLASS}.`);
  }

  const patches: BytePatch[] = [];
  let alreadyDone = 0;

  for (const target of TARGETS) {
    const methodIdx = methodIdxForTrait(abc.instances[classIndex].traits, abc, target.method);
    if (methodIdx === null) {
      throw new PatchError(`Could not find ${HUD_CLASS}.${target.method}.`);
    }

    const methodBody = abc.methodBodies.get(methodIdx);
    if (!methodBody) {
      throw new PatchError(`Could not find a method body for ${HUD_CLASS}.${target.method}.`);
    }

    const code = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
    const instructions = disassemble(code, `${HUD_CLASS}.${target.method}`);
    const offsets = findVisibilityPushes(code, instructions, abc.multinameNames, target.fields, from);

    // Every field this method touches is either still hidden or already pinned. Anything
    // else means the HUD was rebuilt and the shape this relies on is gone.
    const doneHere = target.fields.length - offsets.length;
    if (doneHere < 0) {
      throw new PatchError(
        `${HUD_CLASS}.${target.method}: found ${offsets.length} visibility writes for ${target.fields.length} fields.`,
      );
    }
    alreadyDone += doneHere;

    for (const offset of offsets) {
      patches.push({
        key: `${HUD_CLASS}.${target.method}@${offset}`,
        start: methodBody.codeStart + offset,
        end: methodBody.codeStart + offset + 1,
        data: Buffer.from([to]),
        detail: `${revert ? "unpin" : "pin"} ${target.fields.join("/")} visible in ${target.method}`,
      });
    }
  }

  return { ctx, patches, alreadyDone };
}

function patchSwf(swfPath: string, verify: boolean, revert: boolean): void {
  const { ctx, patches, alreadyDone } = collectPatches(swfPath, revert);

  if (patches.length === 0) {
    if (alreadyDone !== EXPECTED_FLIPS) {
      throw new PatchError(
        `${swfPath}: expected ${EXPECTED_FLIPS} vitals visibility writes, found ${alreadyDone}.`,
      );
    }
    console.log(
      `${swfPath}: already ${revert ? "reverted (HUD vitals numbers need a hover again)" : "patched (HUD vitals numbers pinned on)"}.`,
    );
    return;
  }

  // --verify only ever asks the forward question: is the patch still applied? Reverting is
  // a deliberate act, so it is never something the build should fail over.
  if (verify && !revert) {
    throw new PatchError(
      `${swfPath}: verify failed; ${patches.length} HUD vitals visibility write(s) still hide the numbers.`,
    );
  }
  if (verify) {
    console.log(`${swfPath}: ${patches.length} vitals write(s) would be reverted.`);
    return;
  }

  ensureBackup(swfPath);
  const { body, delta } = applyPatchesToBody(ctx.body, patches);
  if (delta !== 0) {
    throw new PatchError(`${swfPath}: single-byte flips changed the body length by ${delta}.`);
  }
  writeSwf(ctx, body, delta);
  console.log(
    `${swfPath}: ${revert ? "reverted" : "pinned"} ${patches.length} HUD vitals number(s)${revert ? " back behind a hover" : " on"}.`,
  );
}

const { swfPath, verify, revert } = parseArgs(process.argv);
patchSwf(swfPath, verify, revert);
