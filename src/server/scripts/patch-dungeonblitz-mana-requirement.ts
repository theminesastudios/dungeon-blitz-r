import * as fs from "fs";
import * as path from "path";
import {
  applyPatchesToBody,
  BytePatch,
  disassemble,
  ensureBackup,
  Instruction,
  parseAbc,
  parseSwf,
  PatchError,
  writeSwf,
  writeU30,
} from "./swfPatchUtils";

// PowerType's XML loader reads <ManaRequirement> into a local and then throws it away:
//
//     _loc9_ = uint(attributeValue);
//     powerType.manaRequirement = 0;          // <- pushbyte 0
//     ...
//     if(!powerType.manaRequirement) { powerType.manaRequirement = powerType.manaCost; }
//
// Because the field is always left at 0 it falls back to ManaCost, so every discipline
// power asks for exactly what it spends. Charon's Blades 10 and Pyromania 10 spend 10
// mastery mana, so they became castable at 10 discipline mana instead of the authored 40.
// Swapping the `pushbyte 0` for `getlocal <n>` stores the parsed value instead. Both are
// two bytes, so nothing downstream of the instruction moves.
const DEFAULT_SWF_CANDIDATES = [
  path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p", "cbp", "DungeonBlitz.swf"),
  path.resolve(__dirname, "..", "..", "..", "client", "content", "localhost", "p", "cbp", "DungeonBlitz.swf"),
];
const DEFAULT_SWF = DEFAULT_SWF_CANDIDATES.find((candidate) => fs.existsSync(candidate)) ?? DEFAULT_SWF_CANDIDATES[0];

const OP_PUSHSTRING = 0x2c;
const OP_PUSHBYTE = 0x24;
const OP_GETLOCAL = 0x62;
const OP_SETLOCAL = 0x63;
const OP_GETLOCAL_3 = 0xd3;
const OP_SETPROPERTY = 0x61;
const SETLOCAL_0 = 0xd4;
const SETLOCAL_3 = 0xd7;
// The requirement is compared against the master-mana pool within ~20 instructions of the
// pushstring, so a tight window keeps the match anchored to this one XML branch.
const SEARCH_WINDOW = 24;

type Located = {
  ctx: ReturnType<typeof parseSwf>;
  codeStart: number;
  target: Instruction;
  register: number;
  alreadyPatched: boolean;
};

function parseArgs(argv: string[]): { swfPath: string; verify: boolean } {
  let swfPath = DEFAULT_SWF;
  let verify = false;

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
    if (arg === "--help" || arg === "-h") {
      console.log([
        "Usage:",
        "  ts-node src/server/scripts/patch-dungeonblitz-mana-requirement.ts [--verify] [--swf <path>]",
        "",
        "Patches DungeonBlitz.swf so PowerType keeps the <ManaRequirement> it parses instead",
        "of zeroing it and falling back to <ManaCost>. Restores the authored discipline-mana",
        "gate on every mastery power (Charon's Blades, Pyromania, ...).",
      ].join("\n"));
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { swfPath, verify };
}

function setLocalRegister(inst: Instruction): number | null {
  if (inst.opcode >= SETLOCAL_0 && inst.opcode <= SETLOCAL_3) {
    return inst.opcode - SETLOCAL_0;
  }
  const operand = inst.operands[0];
  if (inst.opcode !== OP_SETLOCAL || !operand || operand[0] !== "u30") {
    return null;
  }
  return operand[1];
}

function getLocalRegister(inst: Instruction): number | null {
  const operand = inst.operands[0];
  if (inst.opcode !== OP_GETLOCAL || !operand || operand[0] !== "u30") {
    return null;
  }
  return operand[1];
}

function locate(swfPath: string): Located {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);

  const manaRequirementIdx = abc.stringValues.indexOf("ManaRequirement");
  if (manaRequirementIdx < 0) {
    throw new PatchError('Could not find the "ManaRequirement" string constant.');
  }

  const found: Located[] = [];
  for (const [, body] of abc.methodBodies) {
    const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
    let instructions: Instruction[];
    try {
      instructions = disassemble(code, `methodBody@${body.codeStart}`);
    } catch {
      continue;
    }

    for (let index = 0; index < instructions.length; index += 1) {
      const inst = instructions[index];
      if (inst.opcode !== OP_PUSHSTRING || inst.operands[0]?.[1] !== manaRequirementIdx) {
        continue;
      }

      const window = instructions.slice(index + 1, index + 1 + SEARCH_WINDOW);
      // The parsed value is stashed by the only setlocal in the branch; the store into the
      // field is the getlocal_3 / <value> / setproperty triple right after it.
      const storeIdx = window.findIndex(
        (item, itemIndex) =>
          item.opcode === OP_GETLOCAL_3 &&
          window[itemIndex + 2]?.opcode === OP_SETPROPERTY &&
          (window[itemIndex + 1]?.opcode === OP_PUSHBYTE || getLocalRegister(window[itemIndex + 1]) !== null),
      );
      if (storeIdx < 0) {
        continue;
      }

      const value = window[storeIdx + 1];
      const registers = window
        .slice(0, storeIdx)
        .map(setLocalRegister)
        .filter((register): register is number => register !== null);
      if (registers.length !== 1) {
        continue;
      }

      const register = registers[0];
      const patchedRegister = getLocalRegister(value);
      if (patchedRegister !== null && patchedRegister !== register) {
        throw new PatchError(
          `ManaRequirement is stored from register ${patchedRegister} but parsed into ${register}.`,
        );
      }

      found.push({
        ctx,
        codeStart: body.codeStart,
        target: value,
        register,
        alreadyPatched: patchedRegister === register,
      });
    }
  }

  if (found.length !== 1) {
    throw new PatchError(`Expected exactly one ManaRequirement parse site, found ${found.length}.`);
  }

  const site = found[0];
  if (!site.alreadyPatched && site.target.opcode !== OP_PUSHBYTE) {
    throw new PatchError(`Unexpected opcode 0x${site.target.opcode.toString(16)} at the ManaRequirement store.`);
  }

  return site;
}

function buildPatch(site: Located): BytePatch | null {
  if (site.alreadyPatched) {
    return null;
  }

  const replacement = Buffer.concat([Buffer.from([OP_GETLOCAL]), writeU30(site.register)]);
  if (replacement.length !== site.target.size) {
    throw new PatchError(
      `getlocal ${site.register} is ${replacement.length} bytes but only ${site.target.size} are available.`,
    );
  }

  return {
    key: "PowerType.LoadXml.manaRequirement",
    start: site.codeStart + site.target.offset,
    end: site.codeStart + site.target.offset + site.target.size,
    data: replacement,
    detail: `store the parsed <ManaRequirement> (register ${site.register}) instead of 0`,
  };
}

export function patchManaRequirement(swfPath: string, verifyOnly = false): void {
  const site = locate(swfPath);
  const patch = buildPatch(site);

  if (!verifyOnly && patch) {
    ensureBackup(swfPath);
    const { body, delta } = applyPatchesToBody(site.ctx.body, [patch]);
    writeSwf(site.ctx, body, delta);
  }

  const verifySite = locate(swfPath);
  if (!verifySite.alreadyPatched) {
    throw new PatchError("ManaRequirement is still discarded after patching.");
  }

  const state = verifyOnly ? "Verified" : patch ? "Patched" : "Already patched";
  console.log(`${state} PowerType <ManaRequirement> handling in ${swfPath}`);
}

if (require.main === module) {
  const { swfPath, verify } = parseArgs(process.argv);
  patchManaRequirement(swfPath, verify);
}
