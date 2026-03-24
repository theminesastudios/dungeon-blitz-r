import * as path from "path";
import {
  applyPatchesToBody,
  BytePatch,
  defaultLevelsNrPath,
  ensureBackup,
  parseAbc,
  parseSwf,
  PatchError,
  writeSwf,
  writeU30,
} from "./swfPatchUtils";

const LINE_REPLACEMENTS = [
  {
    current: "4 Boss <Goto Red 1>You're the one that killed our Kraken!",
    target: "4 Boss <Run Loop><Goto Red 1>You're the one that killed our Kraken!",
    detail: "Force looping Run emote during boss walk-in line",
  },
  {
    current: "8 Boss That was the last of our Monster Fleet!",
    target: "8 Boss <End>That was the last of our Monster Fleet!",
    detail: "Explicitly end boss run emote before final taunt",
  },
] as const;

function resolveSwfPath(args: string[]): string {
  const idx = args.indexOf("--swf-path");
  if (idx !== -1 && idx + 1 < args.length) {
    return path.resolve(args[idx + 1]);
  }
  return defaultLevelsNrPath();
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function findLinePatches(swfPath: string): { ctx: ReturnType<typeof parseSwf>; patches: BytePatch[]; statuses: string[] } {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);
  const patches: BytePatch[] = [];
  const statuses: string[] = [];

  for (const replacement of LINE_REPLACEMENTS) {
    if (abc.stringValues.includes(replacement.target)) {
      statuses.push(`Current line: ${replacement.target}`);
      continue;
    }

    const candidates = [
      replacement.current,
      replacement.current.includes("<Goto Red 1>")
        ? replacement.current.replace("<Goto Red 1>", "<Charge><Goto Red 1>")
        : replacement.current.replace("Boss ", "Boss <Charge><Goto Red 1>"),
      replacement.current.includes("<Goto Red 1>")
        ? replacement.current.replace("<Goto Red 1>", "<Run><Goto Red 1>")
        : replacement.current.replace("Boss ", "Boss <Run><Goto Red 1>"),
      replacement.current.includes("<Goto Red 1>")
        ? replacement.current.replace("<Goto Red 1>", "<Run Loop><Goto Red 1>")
        : replacement.current.replace("Boss ", "Boss <Run Loop><Goto Red 1>"),
      replacement.current.includes("<Goto Red 1>")
        ? replacement.current.replace("<Goto Red 1>", "<Run><Goto Red 2>")
        : replacement.current.replace("Boss ", "Boss <Run><Goto Red 2>"),
      replacement.current.includes("<Goto Red 1>")
        ? replacement.current.replace("<Goto Red 1>", "<Run Loop><Goto Red 2>")
        : replacement.current.replace("Boss ", "Boss <Run Loop><Goto Red 2>"),
      replacement.current.includes("<Goto Red 1>")
        ? replacement.current.replace("<Goto Red 1>", "<Charge><Goto Red 2>")
        : replacement.current.replace("Boss ", "Boss <Charge><Goto Red 2>"),
      replacement.current.includes("<Goto Red 1>")
        ? replacement.current.replace("<Goto Red 1>", "<Goto Red 2>")
        : replacement.current.replace("Boss ", "Boss <Goto Red 2>"),
    ];
    const idx = candidates
      .map((candidate) => abc.stringValues.indexOf(candidate))
      .find((candidateIdx) => candidateIdx !== -1) ?? -1;
    if (idx === -1) {
      throw new PatchError(`Goblin boss intro line not found in ABC string pool: ${replacement.current}`);
    }

    const lenPos = abc.stringLenPositions[idx];
    const dataPos = abc.stringDataPositions[idx];
    const currentValue = abc.stringValues[idx];
    const oldBytes = Buffer.from(currentValue, "utf8");
    const newBytes = Buffer.from(replacement.target, "utf8");
    patches.push({
      key: `levelsnr_goblin_boss_intro_${patches.length}`,
      start: lenPos,
      end: dataPos + oldBytes.length,
      data: Buffer.concat([writeU30(newBytes.length), newBytes]),
      detail: replacement.detail,
    });
    statuses.push(`Current line: ${currentValue}`);
  }

  return { ctx, patches, statuses };
}

function main(): number {
  const args = process.argv.slice(2);
  const swfPath = resolveSwfPath(args);
  const verifyOnly = hasFlag(args, "--verify") || hasFlag(args, "--dry-run");

  try {
    const { ctx, patches, statuses } = findLinePatches(swfPath);
    console.log(`SWF: ${swfPath}`);
    for (let i = 0; i < LINE_REPLACEMENTS.length; i += 1) {
      console.log(statuses[i]);
      console.log(`Replacement:  ${LINE_REPLACEMENTS[i].target}`);
    }

    if (patches.length === 0) {
      console.log("No changes needed.");
      return 0;
    }

    for (const patch of patches) {
      console.log(`Patch: ${patch.detail}`);
    }
    if (verifyOnly) {
      return 0;
    }

    ensureBackup(swfPath);
    const { body, delta } = applyPatchesToBody(ctx.body, patches);
    writeSwf(ctx, body, delta);
    console.log("Patch apply complete.");
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Patch error: ${message}`);
    return 1;
  }
}

process.exit(main());
