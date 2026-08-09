import * as fs from "fs";
import * as path from "path";
import { ensureBackup, parseSwz, SwzPatchError, writeSwz } from "./swzPatchUtils";

const ROOT = path.resolve(__dirname, "..", "..");
const ENT_XML = path.join(ROOT, "client", "content", "xml", "EntTypes.xml");
const LOGIN_SWZ = path.join(ROOT, "client", "content", "localhost", "p", "cbq", "Login.swz");

const EXPECTED_RANGED_POWER = new Map<string, string>([
  ["DemonReaper", "BruteShot"],
  ["DemonReaperHard", "BruteShot"],
]);

function defaultEntSwzPaths(): string[] {
  return fs.existsSync(LOGIN_SWZ) ? [LOGIN_SWZ] : [];
}

function parseArgs(argv: string[]): { swzPaths: string[]; verify: boolean } {
  const swzPaths: string[] = [];
  let verify = false;

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--verify" || arg === "--dry-run") {
      verify = true;
      continue;
    }
    if (arg === "--swz-path") {
      const value = argv[++index];
      if (!value) {
        throw new Error("--swz-path requires a value");
      }
      swzPaths.push(path.resolve(process.cwd(), value));
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log([
        "Usage:",
        "  ts-node src/server/scripts/patch_gameswz_valhaven_demon_reaper_shot.ts [--verify] [--swz-path <path>...]",
        "",
        "Makes Valhaven Demon Reapers use the single-shot Brute projectile in EntTypes.",
      ].join("\n"));
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    swzPaths: swzPaths.length ? swzPaths : defaultEntSwzPaths(),
    verify,
  };
}

function entBlock(xml: string, entName: string): { start: number; end: number; block: string } {
  const pattern = new RegExp(`<EntType EntName="${entName}"[^>]*>[\\s\\S]*?<\\/EntType>`);
  const match = pattern.exec(xml);
  if (!match || match.index === undefined) {
    throw new SwzPatchError(`EntTypes is missing ${entName}`);
  }

  return {
    start: match.index,
    end: match.index + match[0].length,
    block: match[0],
  };
}

function tagValue(block: string, tag: string): string | null {
  return block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`))?.[1]?.trim() ?? null;
}

function setRangedPower(block: string, entName: string, expectedPower: string): { block: string; changed: boolean } {
  const currentPower = tagValue(block, "RangedPower");
  if (currentPower === expectedPower) {
    return { block, changed: false };
  }
  if (currentPower === null) {
    throw new SwzPatchError(`${entName} is missing RangedPower`);
  }

  return {
    block: block.replace(/<RangedPower>[\s\S]*?<\/RangedPower>/, `<RangedPower>${expectedPower}</RangedPower>`),
    changed: true,
  };
}

export function patchEntTypes(xml: string): { xml: string; changed: boolean } {
  let nextXml = xml;
  let changed = false;

  for (const [entName, expectedPower] of EXPECTED_RANGED_POWER) {
    const found = entBlock(nextXml, entName);
    const patched = setRangedPower(found.block, entName, expectedPower);
    nextXml = `${nextXml.slice(0, found.start)}${patched.block}${nextXml.slice(found.end)}`;
    changed = changed || patched.changed;
  }

  return { xml: nextXml, changed };
}

function patchLooseXml(verifyOnly: boolean): boolean {
  const xml = fs.readFileSync(ENT_XML, "utf8");
  const patched = patchEntTypes(xml);
  if (verifyOnly) {
    if (patched.changed) {
      throw new SwzPatchError("loose EntTypes.xml still gives DemonReaper the two-shot BruteShot2 power");
    }
    console.log("EntTypes.xml: ok");
    return false;
  }

  if (!patched.changed) {
    console.log("EntTypes.xml: already patched");
    return false;
  }

  fs.writeFileSync(ENT_XML, patched.xml);
  console.log("EntTypes.xml: patched Valhaven Demon Reaper ranged power");
  return true;
}

function patchSwz(swzPath: string, verifyOnly: boolean): boolean {
  const ctx = parseSwz(swzPath);
  const entTypes = ctx.chunks.find((chunk) => chunk.xml.match(/<EntTypes[>\s]/));
  if (!entTypes) {
    throw new SwzPatchError(`${path.basename(swzPath)} is missing EntTypes`);
  }

  const patched = patchEntTypes(entTypes.xml);
  if (verifyOnly) {
    if (patched.changed) {
      throw new SwzPatchError(`${path.basename(swzPath)} still gives DemonReaper the two-shot BruteShot2 power`);
    }
    console.log(`${path.basename(swzPath)}: ok`);
    return false;
  }

  if (!patched.changed) {
    console.log(`${path.basename(swzPath)}: already patched`);
    return false;
  }

  entTypes.xml = patched.xml;
  ensureBackup(swzPath);
  writeSwz(ctx);
  console.log(`${path.basename(swzPath)}: patched Valhaven Demon Reaper ranged power`);
  return true;
}

function main(): void {
  const { swzPaths, verify } = parseArgs(process.argv);
  if (!swzPaths.length) {
    throw new SwzPatchError("No EntTypes SWZ files found");
  }

  let changed = patchLooseXml(verify) ? 1 : 0;
  for (const swzPath of swzPaths) {
    changed += patchSwz(swzPath, verify) ? 1 : 0;
  }
  if (!verify) {
    console.log(`Updated ${changed} file(s).`);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[patch_gameswz_valhaven_demon_reaper_shot] ${message}`);
    process.exitCode = 1;
  }
}
