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
  writeSwf,
  writeU30,
} from "./swfPatchUtils";

/**
 * Make the Bone Daggers' poison (DaggerPoison) show the dagger icon under poisoned targets.
 *
 * The entity status readout (Entity.method_1667) draws one icon per status category the
 * target carries. Categories are fixed bits: BuffType.method_553 splits <BuffIcon> on ","
 * and BuffType.method_1328 ORs one category bit into BuffType.var_76 for each recognised
 * a_StatusIcon_* name; CombatState.method_322 merges every active buff's var_76 into its
 * own var_1176; and the readout asks BuffType.method_1811(category) for the icon class name
 * and instantiates it by name (class_4.method_16: hasDefinition ? new getDefinition(name)
 * : new MovieClip()).
 *
 * So the drawn sprite is chosen by method_1811's hardcoded category -> class-name table,
 * never by the BuffIcon string itself. An unknown BuffIcon lands on the table's default
 * case, which returns null -- an empty MovieClip, i.e. nothing visible. That is why the
 * original <BuffIcon>a_PowerIcon_PoisonDagger</BuffIcon> did not show anything.
 *
 * The data half (patch_gameswz_dagger_poison.ts) therefore points DaggerPoison's BuffIcon
 * at a_StatusIcon_AttackUp -- a real category that no buff in the data uses, so its bit is
 * otherwise never set -- and this script repoints that one category's icon at the dagger:
 *
 *   BuffType.method_1811, AttackUp case:  pushstring "<status icon class>"
 *
 * The icon class the readout resolves lives in UI_1.swf, which the game loads at the Core
 * stage, and class_4 resolves it by name across loaded domains. The scaled clone is made by
 * patch-dungeonblitz-ui1-dagger-icon-scale.ts; this script only needs the class name in
 * DungeonBlitz.swf's ABC string pool so the pushstring can reference it.
 *
 * History (all states this script understands):
 *   v0 vanilla      AttackUp case pushes "a_StatusIcon_AttackUp"; pool has neither dagger
 *                   name. Append "a_StatusIcon_PoisonDagger" to the pool and swap the
 *                   operand (index 1173 -> pool length, both 2-byte u30).
 *   v1 first pass   AttackUp case pushes "a_PowerIcon_PoisonDagger" -- the full-size power
 *                   icon, oversized next to the ~19px status icons. The name sits at the
 *                   very end of the pool. Replace that pool entry with
 *                   "a_StatusIcon_PoisonDagger" in place: same index, so the pushstring
 *                   operand does not move at all, and the pool grows by the 2 extra bytes
 *                   (24 -> 26 chars, both one-byte u30 length prefixes).
 *   v2 done         AttackUp case pushes "a_StatusIcon_PoisonDagger", the scaled clone.
 *
 * The pool edits are plain inserts/replacements at known positions -- the same shape as
 * patch-dungeonblitz-clear-bandits-npc-marker.ts -- and every operand swap keeps the
 * pushstring instruction's byte width, so no code_length changes and no branch offsets
 * move in this obfuscated method. The patch refuses to run if any width invariant breaks.
 *
 * Everything else about a category sharing AttackUp's bit is a non-issue: the data guard in
 * dagger_poison_regression.ts fails if any other buff ever uses a_StatusIcon_AttackUp.
 */

const DEFAULT_SWF = path.resolve(
  __dirname, "..", "..", "client", "content", "localhost", "p", "cbp", "DungeonBlitz.swf",
);

const DAGGER_ICON_CLASS = "a_StatusIcon_PoisonDagger";
const LEGACY_ICON_CLASS = "a_PowerIcon_PoisonDagger";
const ATTACK_UP_ICON = "a_StatusIcon_AttackUp";

const OP_PUSHSTRING = 0x2c;

function parseArgs(argv: string[]): { swfPath: string; verify: boolean } {
  let swfPath = DEFAULT_SWF;
  let verify = false;
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--swf" || arg === "-s") swfPath = path.resolve(argv[++index] || "");
    else if (arg === "--verify" || arg === "--dry-run") verify = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: ts-node patch-dungeonblitz-dagger-poison-icon.ts [--verify] [--swf <path>]\n" +
          "Lets the entity status readout render the scaled dagger icon for DaggerPoison by\n" +
          "repointing method_1811's AttackUp category at a_StatusIcon_PoisonDagger.",
      );
      process.exit(0);
    } else throw new PatchError(`Unknown argument: ${arg}`);
  }
  return { swfPath, verify };
}

/** Every pushstring in a method's code, keyed by the string it references. */
function pushstringSites(instructions: Instruction[], strings: string[]): Map<string, Instruction[]> {
  const sites = new Map<string, Instruction[]>();
  for (const instruction of instructions) {
    if (instruction.opcode !== OP_PUSHSTRING || instruction.operands[0]?.[0] !== "u30") continue;
    const index = instruction.operands[0][1];
    if (index >= strings.length) continue;
    const key = strings[index];
    if (!key.startsWith("a_")) continue;
    const list = sites.get(key) ?? [];
    list.push(instruction);
    sites.set(key, list);
  }
  return sites;
}

interface StringEntry {
  index: number;
  start: number;
  end: number;
}

/**
 * Byte range of one ABC string-pool entry (length prefix + data), or null when the
 * value is not in the pool. Index 0 is the implicit empty string with no bytes.
 */
function stringEntryFor(abc: ReturnType<typeof parseAbc>, value: string): StringEntry | null {
  const index = abc.stringValues.indexOf(value);
  if (index <= 0) return null;
  return {
    index,
    start: abc.stringLenPositions[index],
    end: abc.stringDataPositions[index] + Buffer.byteLength(value, "utf8"),
  };
}

function patchDungeonBlitzDaggerPoisonIcon(swfPath: string, verifyOnly: boolean): number {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);

  const attackUpIndex = abc.stringValues.indexOf(ATTACK_UP_ICON);
  if (attackUpIndex < 0) {
    throw new PatchError(`"${ATTACK_UP_ICON}" is missing from the ABC string pool`);
  }

  const classIdx = classIndexByName(abc, "BuffType");
  if (classIdx === null) throw new PatchError("BuffType class not found");
  const traits = [...abc.instances[classIdx].traits, ...(abc.classTraits[classIdx] ?? [])];
  const methodIdx = methodIdxForTrait(traits, abc, "method_1811");
  if (methodIdx === null) throw new PatchError("BuffType.method_1811 not found");
  const body = abc.methodBodies.get(methodIdx);
  if (!body) throw new PatchError("No method body for BuffType.method_1811");

  const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
  const sites = pushstringSites(disassemble(code, "BuffType.method_1811"), abc.stringValues);

  const daggerSites = sites.get(DAGGER_ICON_CLASS) ?? [];
  const legacySites = sites.get(LEGACY_ICON_CLASS) ?? [];
  const attackUpSites = sites.get(ATTACK_UP_ICON) ?? [];

  const daggerIndex = abc.stringValues.indexOf(DAGGER_ICON_CLASS);
  const legacyIndex = abc.stringValues.indexOf(LEGACY_ICON_CLASS);

  // Exactly one state must hold. Anything else is a half-applied or drifted swf and must
  // not be silently "fixed".
  const isDone = daggerSites.length === 1 && legacySites.length === 0 && attackUpSites.length === 0;
  const isV1 = daggerSites.length === 0 && legacySites.length === 1 && attackUpSites.length === 0;
  const isV0 = daggerSites.length === 0 && legacySites.length === 0 && attackUpSites.length === 1;

  if (isDone) {
    if (daggerIndex < 0) {
      throw new PatchError(`"${DAGGER_ICON_CLASS}" is referenced by method_1811 but missing from the pool`);
    }
    console.log(JSON.stringify({ verify: verifyOnly, swf: swfPath, alreadyPatched: true }, null, 2));
    console.log("No changes needed.");
    return 0;
  }

  if (!isV1 && !isV0) {
    throw new PatchError(
      `Inconsistent method_1811 icon state: ${attackUpSites.length} pushstring(s) of "${ATTACK_UP_ICON}", ` +
        `${legacySites.length} of "${LEGACY_ICON_CLASS}", ${daggerSites.length} of "${DAGGER_ICON_CLASS}"`,
    );
  }

  const patches: BytePatch[] = [];

  if (isV1) {
    // The readout already pushes the dagger name -- but the full-size power icon. Rewrite
    // that pool entry to the scaled clone's class in place (same index, no operand change).
    if (legacyIndex < 0) throw new PatchError(`"${LEGACY_ICON_CLASS}" is pushed but missing from the pool`);
    if (daggerIndex >= 0) {
      throw new PatchError(`"${DAGGER_ICON_CLASS}" is already in the pool; refusing to migrate a half-patched swf`);
    }

    const entry = stringEntryFor(abc, LEGACY_ICON_CLASS);
    if (!entry || entry.end !== abc.stringPoolEnd) {
      throw new PatchError(
        `"${LEGACY_ICON_CLASS}" must be the last string in the pool to rename it in place (found ${entry ? "mid-pool" : "nowhere"})`,
      );
    }
    const newEntry = Buffer.concat([
      writeU30(Buffer.byteLength(DAGGER_ICON_CLASS, "utf8")),
      Buffer.from(DAGGER_ICON_CLASS, "utf8"),
    ]);
    patches.push({
      key: "dagger-icon-slot-rename",
      start: entry.start,
      end: entry.end,
      data: newEntry,
      detail: `rename the appended pool entry ${LEGACY_ICON_CLASS} -> ${DAGGER_ICON_CLASS}`,
    });

    console.log(JSON.stringify(
      {
        verify: verifyOnly,
        swf: swfPath,
        method_1811: { methodIdx },
        migration: { from: LEGACY_ICON_CLASS, to: DAGGER_ICON_CLASS, poolIndex: legacyIndex },
      },
      null,
      2,
    ));
  } else {
    // v0 vanilla: swap the AttackUp-case operand onto a freshly appended pool entry.
    if (daggerIndex >= 0 || legacyIndex >= 0) {
      throw new PatchError(
        `a dagger icon name is already in the pool but no longer referenced where the AttackUp case ` +
          "used to be; the swf is in an inconsistent half-patched state",
      );
    }

    const site = attackUpSites[0];
    const oldOperand = writeU30(attackUpIndex);
    const newOperand = writeU30(abc.stringValues.length);
    if (newOperand.length !== oldOperand.length) {
      throw new PatchError(
        `The ${DAGGER_ICON_CLASS} index needs a ${newOperand.length}-byte u30 but the AttackUp index uses ` +
          `${oldOperand.length}; growing the pushstring would move branch offsets in this obfuscated method`,
      );
    }
    patches.push({
      key: "BuffType.method_1811.attackUpIcon",
      start: body.codeStart + site.offset + 1, // past the pushstring opcode, onto the pool-index operand
      end: body.codeStart + site.offset + site.size,
      data: newOperand,
      detail: `AttackUp case returns ${DAGGER_ICON_CLASS} instead of ${ATTACK_UP_ICON}`,
    });
    patches.push({
      key: "dagger-icon-string-count",
      start: abc.stringCountPos,
      end: abc.stringCountEnd,
      data: writeU30(abc.stringValues.length + 1),
      detail: `reserve the ${DAGGER_ICON_CLASS} string`,
    });
    const encoded = Buffer.concat([
      writeU30(Buffer.byteLength(DAGGER_ICON_CLASS, "utf8")),
      Buffer.from(DAGGER_ICON_CLASS, "utf8"),
    ]);
    patches.push({
      key: "dagger-icon-string-value",
      start: abc.stringPoolEnd,
      end: abc.stringPoolEnd,
      data: encoded,
      detail: `add ${DAGGER_ICON_CLASS} to the ABC string pool`,
    });

    console.log(JSON.stringify(
      {
        verify: verifyOnly,
        swf: swfPath,
        method_1811: { methodIdx, attackUpPushstring: site.offset, poolIndex: abc.stringValues.length },
      },
      null,
      2,
    ));
  }

  if (verifyOnly) {
    console.log("Patch required.");
    return 1;
  }

  const { body: outBody, delta } = applyPatchesToBody(ctx.body, patches);
  const expectedDelta = isV1
    ? Buffer.byteLength(DAGGER_ICON_CLASS, "utf8") - Buffer.byteLength(LEGACY_ICON_CLASS, "utf8")
    : Buffer.byteLength(DAGGER_ICON_CLASS, "utf8") + 1; // 1-byte u30 length prefix
  if (delta !== expectedDelta) {
    throw new PatchError(`Unexpected ABC delta ${delta}; refusing to write.`);
  }

  ensureBackup(swfPath);
  writeSwf(ctx, outBody, delta);

  // Re-read and prove the patch landed before reporting success.
  const verifiedCtx = parseSwf(swfPath);
  const verified = parseAbc(verifiedCtx);
  const verifiedIndex = verified.stringValues.indexOf(DAGGER_ICON_CLASS);
  if (verifiedIndex < 0) {
    throw new PatchError(`Failed to add ${DAGGER_ICON_CLASS} to the string pool`);
  }
  const verifiedBody = verified.methodBodies.get(methodIdx);
  if (!verifiedBody) throw new PatchError("BuffType.method_1811 vanished after patching");
  const verifiedCode = verifiedCtx.body.subarray(verifiedBody.codeStart, verifiedBody.codeStart + verifiedBody.codeLen);
  const verifiedSites = pushstringSites(disassemble(verifiedCode, "BuffType.method_1811.verify"), verified.stringValues);
  const dagger = verifiedSites.get(DAGGER_ICON_CLASS) ?? [];
  const legacy = verifiedSites.get(LEGACY_ICON_CLASS) ?? [];
  const attackUp = verifiedSites.get(ATTACK_UP_ICON) ?? [];
  if (dagger.length !== 1 || legacy.length !== 0 || attackUp.length !== 0) {
    throw new PatchError("method_1811 no longer maps the AttackUp category to the scaled dagger icon");
  }

  console.log("Patch apply complete.");
  return 0;
}

function main(): number {
  const { swfPath, verify } = parseArgs(process.argv);
  try {
    return patchDungeonBlitzDaggerPoisonIcon(swfPath, verify);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[patch-dungeonblitz-dagger-poison-icon] ${message}`);
    return 1;
  }
}

if (require.main === module) {
  process.exit(main());
}
