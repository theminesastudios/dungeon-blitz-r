import * as path from "path";
import {
  applyPatchesToBody,
  BytePatch,
  classIndexByName,
  disassemble,
  ensureBackup,
  Instruction,
  parseAbc,
  parseSwf,
  PatchError,
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

// Issue #729: the Gear Manager rename prompt caps gear-set names at
// am_NameField.maxChars = 16 (ScreenArmory constructor), and GearSetHandler
// truncates to the same 16 server-side. Raise both to 32 so a longer name
// survives typing, the wire and a relog.
const OLD_NAME_LENGTH = 16;
const NEW_NAME_LENGTH = 32;

const OP_PUSHBYTE = 0x24;
const OP_SETPROPERTY = 0x61;

type Abc = ReturnType<typeof parseAbc>;

interface NameLengthSite {
  patch: BytePatch | null;
  current: number;
}

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
        "  ts-node src/server/scripts/patch-dungeonblitz-gear-set-name-length.ts [--verify] [--swf <path>]",
        "",
        `Raises the Gear Manager rename limit from ${OLD_NAME_LENGTH} to ${NEW_NAME_LENGTH} characters.`,
        "GearSetHandler.MAX_NAME_LENGTH on the server carries the same number.",
      ].join("\n"));
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { swfPath, verify };
}

function multinameOf(abc: Abc, inst: Instruction): string | null {
  const operand = inst.operands[0];
  if (!operand || operand[0] !== "u30") {
    return null;
  }
  return abc.multinameNames[operand[1]] ?? null;
}

function pushByteValue(inst: Instruction): number | null {
  const operand = inst.operands[0];
  if (inst.opcode !== OP_PUSHBYTE || !operand || operand[0] !== "s8") {
    return null;
  }
  return operand[1];
}

// maxChars is set exactly once, in the ScreenArmory constructor, as the pair
//
//   pushbyte <length>
//   setproperty maxChars
//
// so the site is located by that shape and asserted unique.
function nameLengthPatch(ctx: ReturnType<typeof parseSwf>, abc: Abc): NameLengthSite {
  const classIndex = classIndexByName(abc, "ScreenArmory");
  if (classIndex === null) {
    throw new PatchError("Could not find ScreenArmory class.");
  }

  const instance = abc.instances[classIndex];
  const methodIndices = new Set<number>([instance.iinitMethodIdx]);
  for (const trait of instance.traits) {
    if (trait.methodIdx !== null) {
      methodIndices.add(trait.methodIdx);
    }
  }
  for (const trait of abc.classTraits[classIndex] ?? []) {
    if (trait.methodIdx !== null) {
      methodIndices.add(trait.methodIdx);
    }
  }

  const sites: BytePatch[] = [];
  let current: number | null = null;
  for (const methodIdx of methodIndices) {
    const body = abc.methodBodies.get(methodIdx);
    if (!body) {
      continue;
    }
    const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
    let instructions: Instruction[];
    try {
      instructions = disassemble(code, `ScreenArmory#${methodIdx}`);
    } catch {
      continue;
    }

    for (let index = 0; index + 1 < instructions.length; index += 1) {
      const inst = instructions[index];
      const next = instructions[index + 1];
      const value = pushByteValue(inst);
      if (value === null || next.opcode !== OP_SETPROPERTY || multinameOf(abc, next) !== "maxChars") {
        continue;
      }

      current = value;
      sites.push({
        key: `ScreenArmory.maxChars@#${methodIdx}+${inst.offset}`,
        start: body.codeStart + inst.offset,
        end: body.codeStart + inst.offset + inst.size,
        data: Buffer.from([OP_PUSHBYTE, NEW_NAME_LENGTH]),
        detail: `allow ${NEW_NAME_LENGTH}-character gear-set names instead of ${OLD_NAME_LENGTH}`,
      });
    }
  }

  if (sites.length !== 1 || current === null) {
    throw new PatchError(`Expected exactly one maxChars assignment in ScreenArmory, found ${sites.length}.`);
  }
  if (current === NEW_NAME_LENGTH) {
    return { patch: null, current };
  }
  if (current !== OLD_NAME_LENGTH) {
    throw new PatchError(`am_NameField.maxChars is ${current}, expected ${OLD_NAME_LENGTH} or ${NEW_NAME_LENGTH}.`);
  }

  return { patch: sites[0], current };
}

function buildPatch(swfPath: string): NameLengthSite {
  const ctx = parseSwf(swfPath);
  return nameLengthPatch(ctx, parseAbc(ctx));
}

export function patchGearSetNameLength(swfPath: string, verifyOnly = false): void {
  const firstPass = buildPatch(swfPath);

  if (!verifyOnly && firstPass.patch) {
    const ctx = parseSwf(swfPath);
    ensureBackup(swfPath);
    const { body, delta } = applyPatchesToBody(ctx.body, [firstPass.patch]);
    writeSwf(ctx, body, delta);
  }

  const verifyPass = buildPatch(swfPath);
  if (verifyPass.current !== NEW_NAME_LENGTH) {
    throw new PatchError(`Gear set name verification failed: maxChars is ${verifyPass.current}`);
  }

  const verb = verifyOnly ? "Verified" : firstPass.patch ? "Patched" : "Already patched";
  console.log(`${verb} ${NEW_NAME_LENGTH}-character gear set names in ${swfPath}`);
}

if (require.main === module) {
  try {
    const { swfPath, verify } = parseArgs(process.argv);
    patchGearSetNameLength(swfPath, verify);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
