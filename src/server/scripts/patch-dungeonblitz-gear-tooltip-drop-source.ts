import * as path from "path";
import {
  classIndexByName,
  disassemble,
  ensureBackup,
  Instruction,
  methodIdxForTrait,
  parseAbc,
  parseSwf,
  writeSwf,
} from "./swfPatchUtils";

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

// ScreenArmory.method_426 builds the gear tooltip. Locals 23/24 hold the
// "Drops From" and "Dungeon" lines; both are seeded with the grey "??"
// constants (const_678/const_708) and then overwritten with the real names
// whenever the boss/realm lookup resolves. A trailing
//   if (!owned) { local23 = const_678; local24 = const_708; }
// re-masks them for gear the player has never picked up. Dropping that mask
// is safe precisely because the "??" seeding happens earlier, so entries that
// genuinely fail to resolve still render "??".
const OWNED_LOCAL = 13;
const MONSTER_LOCAL = 23;

export type Mode = "unmask" | "restore";

function parseArgs(argv: string[]): { swfPath: string; verify: boolean; mode: Mode } {
  let swfPath = DEFAULT_SWF;
  let verify = false;
  let mode: Mode = "unmask";

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--swf" || arg === "-s") {
      swfPath = path.resolve(argv[++index] || "");
      continue;
    }
    if (arg === "--verify") {
      verify = true;
      continue;
    }
    if (arg === "--restore") {
      mode = "restore";
      continue;
    }
    if (arg === "--unmask") {
      mode = "unmask";
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log([
        "Usage:",
        "  npx ts-node src/server/scripts/patch-dungeonblitz-gear-tooltip-drop-source.ts [--verify] [--restore] [--swf <path>]",
        "",
        "Shows the gear tooltip 'Drops From' and 'Dungeon' lines for gear the",
        "player does not own, instead of masking both with '??'.",
        "",
        "Modes:",
        "  --unmask   (default) always show the resolved mob and dungeon.",
        "  --restore  put the ownership mask back.",
      ].join("\n"));
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { swfPath, verify, mode };
}

function localIndex(inst: Instruction | undefined, opcode: number): number | null {
  if (!inst || inst.opcode !== opcode) {
    return null;
  }
  const operand = inst.operands[0];
  return operand?.[0] === "u30" ? operand[1] : null;
}

function getTooltipMethod(swfPath: string) {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);

  const classIndex = classIndexByName(abc, "ScreenArmory");
  if (classIndex === null) {
    throw new Error("Could not find ScreenArmory class.");
  }

  const methodIdx = methodIdxForTrait(abc.instances[classIndex].traits, abc, "method_426");
  if (methodIdx === null) {
    throw new Error("Could not find ScreenArmory.method_426.");
  }

  const methodBody = abc.methodBodies.get(methodIdx);
  if (!methodBody) {
    throw new Error(`Could not find method body for ScreenArmory.method_426 (${methodIdx}).`);
  }

  const code = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
  const instructions = disassemble(code, `ScreenArmory.method_426:${methodIdx}`);
  return { ctx, methodBody, instructions };
}

/**
 * Locates `getlocal owned; <gate>; <branch>; getlex; coerce_s; setlocal 23`.
 * `gate`/`branch` are 0x96/0x12 (not/iffalse) before patching and 0x29/0x10
 * (pop/jump) afterwards, so the same matcher recognises both directions.
 */
function findMaskSite(instructions: Instruction[], gate: number, branch: number): number | null {
  for (let index = 0; index + 5 < instructions.length; index += 1) {
    if (
      localIndex(instructions[index], 0x62) === OWNED_LOCAL &&
      instructions[index + 1].opcode === gate &&
      instructions[index + 2].opcode === branch &&
      instructions[index + 3].opcode === 0x60 &&
      instructions[index + 4].opcode === 0x85 &&
      localIndex(instructions[index + 5], 0x63) === MONSTER_LOCAL
    ) {
      return index;
    }
  }
  return null;
}

export function patchSwf(swfPath: string, verify: boolean, mode: Mode): void {
  const { ctx, methodBody, instructions } = getTooltipMethod(swfPath);
  const masked = findMaskSite(instructions, 0x96, 0x12); // not / iffalse
  const unmasked = findMaskSite(instructions, 0x29, 0x10); // pop / jump

  const wanted = mode === "unmask" ? unmasked : masked;
  const current = mode === "unmask" ? masked : unmasked;

  if (wanted !== null) {
    console.log(
      mode === "unmask"
        ? `${swfPath}: already patched (tooltips always show drop source).`
        : `${swfPath}: already original (tooltips mask unowned drop source).`,
    );
    return;
  }
  if (current === null) {
    throw new Error("Could not find ScreenArmory.method_426 drop-source mask bytecode.");
  }
  if (verify) {
    throw new Error(
      mode === "unmask"
        ? `${swfPath}: verify failed; gear tooltips still mask drop source for unowned gear.`
        : `${swfPath}: verify failed; gear tooltips still show drop source for unowned gear.`,
    );
  }

  const gate = instructions[current + 1];
  const branch = instructions[current + 2];
  if (gate.size !== 1 || branch.size !== 4) {
    throw new Error("Unexpected ScreenArmory.method_426 mask byte width.");
  }

  ensureBackup(swfPath);
  const gateOffset = methodBody.codeStart + gate.offset;
  const branchOffset = methodBody.codeStart + branch.offset;

  if (mode === "unmask") {
    // `not` consumed the owned flag; `pop` discards it so the stack stays
    // balanced, then the conditional branch becomes unconditional.
    ctx.body[gateOffset] = 0x29; // pop
    ctx.body[branchOffset] = 0x10; // jump
  } else {
    ctx.body[gateOffset] = 0x96; // not
    ctx.body[branchOffset] = 0x12; // iffalse
  }

  writeSwf(ctx, ctx.body, 0);
  console.log(
    mode === "unmask"
      ? `${swfPath}: gear tooltips now always show the drop source mob and dungeon.`
      : `${swfPath}: restored the unowned-gear drop source mask.`,
  );
}

if (require.main === module) {
  const { swfPath, verify, mode } = parseArgs(process.argv);
  patchSwf(swfPath, verify, mode);
}
