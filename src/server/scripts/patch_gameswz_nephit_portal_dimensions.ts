import * as fs from "fs";
import * as path from "path";
import { ensureBackup, parseSwz, SwzPatchError, writeSwz } from "./swzPatchUtils";

const ROOT = path.resolve(__dirname, "..", "..");
const ENT_XML = path.join(ROOT, "client", "content", "xml", "EntTypes.xml");
const ENT_JSON = path.join(ROOT, "server", "data", "EntTypes.json");
const LOGIN_SWZ = path.join(ROOT, "client", "content", "localhost", "p", "cbq", "Login.swz");

const TARGET_PORTALS = ["NephitPortal", "NephitPortalHard"];
const EXPECTED_WIDTH = "200";
const EXPECTED_HEIGHT = "250";

type PatchStats = {
  verified: number;
  updated: number;
};

function parseArgs(argv: string[]): { verify: boolean; swzPaths: string[] } {
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
        throw new SwzPatchError("--swz-path requires a value");
      }
      swzPaths.push(path.resolve(process.cwd(), value));
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log([
        "Usage:",
        "  ts-node src/server/scripts/patch_gameswz_nephit_portal_dimensions.ts [--verify] [--swz-path <path>...]",
        "",
        "Gives Nephit's spirit portals real bounds so their summons appear at the urn.",
      ].join("\n"));
      process.exit(0);
    }
    throw new SwzPatchError(`Unknown argument: ${arg}`);
  }

  return {
    verify,
    swzPaths: swzPaths.length ? swzPaths : [LOGIN_SWZ].filter(fs.existsSync),
  };
}

function entBlock(xml: string, entName: string): { start: number; end: number; block: string } {
  const match = new RegExp(`<EntType EntName="${entName}"[^>]*>[\\s\\S]*?<\\/EntType>`).exec(xml);
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

function setTag(block: string, tag: string, expectedValue: string): { block: string; changed: boolean } {
  const current = tagValue(block, tag);
  if (current === null) {
    throw new SwzPatchError(`EntType is missing ${tag}`);
  }
  if (current === expectedValue) {
    return { block, changed: false };
  }

  return {
    block: block.replace(new RegExp(`<${tag}>[\\s\\S]*?<\\/${tag}>`), `<${tag}>${expectedValue}</${tag}>`),
    changed: true,
  };
}

export function patchEntTypesXml(xml: string): { xml: string; stats: PatchStats } {
  let nextXml = xml;
  let updated = 0;
  let verified = 0;

  for (const entName of TARGET_PORTALS) {
    const found = entBlock(nextXml, entName);
    let nextBlock = found.block;
    const width = setTag(nextBlock, "Width", EXPECTED_WIDTH);
    nextBlock = width.block;
    const height = setTag(nextBlock, "Height", EXPECTED_HEIGHT);
    nextBlock = height.block;

    verified += 1;
    if (width.changed || height.changed) {
      updated += 1;
    }
    nextXml = `${nextXml.slice(0, found.start)}${nextBlock}${nextXml.slice(found.end)}`;
  }

  return {
    xml: nextXml,
    stats: { verified, updated },
  };
}

function assertPatched(stats: PatchStats, label: string): void {
  if (stats.verified !== TARGET_PORTALS.length) {
    throw new SwzPatchError(`${label} is missing one or more Nephit portal entries`);
  }
  if (stats.updated !== 0) {
    throw new SwzPatchError(`${label} still has zero-sized Nephit portal bounds`);
  }
}

function patchLooseXml(verifyOnly: boolean): PatchStats {
  const original = fs.readFileSync(ENT_XML, "utf8");
  const patched = patchEntTypesXml(original);
  if (verifyOnly) {
    assertPatched(patched.stats, "EntTypes.xml");
    console.log("EntTypes.xml: ok");
    return { verified: patched.stats.verified, updated: 0 };
  }

  if (patched.xml !== original) {
    fs.writeFileSync(ENT_XML, patched.xml, "utf8");
    console.log("EntTypes.xml: patched Nephit portal bounds");
  } else {
    console.log("EntTypes.xml: already patched");
  }

  const verified = patchEntTypesXml(patched.xml).stats;
  assertPatched(verified, "EntTypes.xml");
  return patched.stats;
}

function patchServerJson(verifyOnly: boolean): PatchStats {
  const original = fs.readFileSync(ENT_JSON, "utf8");
  const hasBom = original.charCodeAt(0) === 0xfeff;
  const data = JSON.parse(hasBom ? original.slice(1) : original);
  const entTypes = Array.isArray(data?.EntTypes?.EntType) ? data.EntTypes.EntType : [];
  let verified = 0;
  let updated = 0;

  for (const entName of TARGET_PORTALS) {
    const entry = entTypes.find((candidate: { EntName?: string }) => candidate.EntName === entName);
    if (!entry) {
      throw new SwzPatchError(`EntTypes.json is missing ${entName}`);
    }

    verified += 1;
    if (entry.Width !== EXPECTED_WIDTH || entry.Height !== EXPECTED_HEIGHT) {
      updated += 1;
      entry.Width = EXPECTED_WIDTH;
      entry.Height = EXPECTED_HEIGHT;
    }
  }

  const stats = { verified, updated };
  if (verifyOnly) {
    assertPatched(stats, "EntTypes.json");
    console.log("EntTypes.json: ok");
    return { verified, updated: 0 };
  }

  if (updated !== 0) {
    fs.writeFileSync(ENT_JSON, `${hasBom ? "\ufeff" : ""}${JSON.stringify(data, null, 2)}\n`, "utf8");
    console.log("EntTypes.json: patched Nephit portal bounds");
  } else {
    console.log("EntTypes.json: already patched");
  }

  return stats;
}

function patchSwz(swzPath: string, verifyOnly: boolean): PatchStats {
  const ctx = parseSwz(swzPath);
  const entTypes = ctx.chunks.find((chunk) => chunk.xml.match(/<EntTypes[>\s]/));
  if (!entTypes) {
    throw new SwzPatchError(`${path.basename(swzPath)} is missing EntTypes`);
  }

  const patched = patchEntTypesXml(entTypes.xml);
  if (verifyOnly) {
    assertPatched(patched.stats, path.basename(swzPath));
    console.log(`${path.basename(swzPath)}: ok`);
    return { verified: patched.stats.verified, updated: 0 };
  }

  if (patched.xml !== entTypes.xml) {
    entTypes.xml = patched.xml;
    ensureBackup(swzPath);
    writeSwz(ctx);
    console.log(`${path.basename(swzPath)}: patched Nephit portal bounds`);
  } else {
    console.log(`${path.basename(swzPath)}: already patched`);
  }

  const verified = patchEntTypesXml(patched.xml).stats;
  assertPatched(verified, path.basename(swzPath));
  return patched.stats;
}

function main(): void {
  const { swzPaths, verify } = parseArgs(process.argv);
  if (!swzPaths.length) {
    throw new SwzPatchError("No EntTypes SWZ files found");
  }

  const results = [
    patchLooseXml(verify),
    patchServerJson(verify),
    ...swzPaths.map((swzPath) => patchSwz(swzPath, verify)),
  ];
  if (!verify) {
    const updated = results.reduce((total, stats) => total + stats.updated, 0);
    console.log(`Updated ${updated} surface(s).`);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[patch_gameswz_nephit_portal_dimensions] ${message}`);
    process.exitCode = 1;
  }
}
