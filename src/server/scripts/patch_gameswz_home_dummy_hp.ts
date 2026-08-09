import * as fs from "fs";
import * as path from "path";
import { ensureBackup, parseSwz, SwzPatchError, writeSwz } from "./swzPatchUtils";

const TARGET_HP = "1000000";
const TARGET_DUMMIES = ["HomeDummy1", "HomeDummy2", "HomeDummy3"];

type HomeDummyHpStats = {
  updated: number;
  verified: number;
};

function defaultSourceXmlPath(): string {
  return path.resolve(__dirname, "..", "..", "client", "content", "xml", "EntTypes.xml");
}

function defaultServerJsonPath(): string {
  return path.resolve(__dirname, "..", "data", "EntTypes.json");
}

function defaultGameSwzPaths(): string[] {
  const loginSwzPath = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p", "cbq", "Login.swz");
  const cbqDir = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p", "cbq");
  return [loginSwzPath, ...["Game.swz", "Game.en.swz", "Game.tr.swz"]
    .map((name) => path.join(cbqDir, name))
    .filter((swzPath) => fs.existsSync(swzPath))]
    .filter((swzPath) => {
      try {
        return parseSwz(swzPath).chunks.some((entry) => entry.xml.includes("<EntTypes"));
      } catch {
        return false;
      }
    });
}

function resolveArgPaths(args: string[], flag: string, defaults: string[]): string[] {
  const resolved: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== flag) {
      continue;
    }
    const value = args[index + 1];
    if (!value) {
      throw new SwzPatchError(`Missing value for ${flag}`);
    }
    resolved.push(path.resolve(process.cwd(), value));
    index += 1;
  }
  return resolved.length > 0 ? resolved : defaults;
}

function resolveArgPath(args: string[], flag: string, defaultPath: string): string {
  const index = args.indexOf(flag);
  if (index < 0) {
    return defaultPath;
  }
  const value = args[index + 1];
  if (!value) {
    throw new SwzPatchError(`Missing value for ${flag}`);
  }
  return path.resolve(process.cwd(), value);
}

export function patchHomeDummyHpXml(xml: string): { xml: string; stats: HomeDummyHpStats } {
  let updated = 0;
  let verified = 0;
  let patchedXml = xml;

  for (const entName of TARGET_DUMMIES) {
    const blockPattern = new RegExp(
      `(<EntType EntName="${entName}"[^>]*>[\\s\\S]*?<HitPoints>)(\\d+)(<\\/HitPoints>[\\s\\S]*?<\\/EntType>)`
    );
    patchedXml = patchedXml.replace(blockPattern, (block: string, prefix: string, hp: string, suffix: string) => {
      verified += 1;
      if (hp !== TARGET_HP) {
        updated += 1;
      }
      return `${prefix}${TARGET_HP}${suffix}`;
    });
  }

  return {
    xml: patchedXml,
    stats: {
      updated,
      verified
    }
  };
}

function assertHomeDummyHpXml(xml: string, label: string): HomeDummyHpStats {
  const patched = patchHomeDummyHpXml(xml);
  if (patched.stats.verified !== TARGET_DUMMIES.length || patched.stats.updated !== 0) {
    throw new SwzPatchError(`${label} HomeDummy hit points are not all ${TARGET_HP}`);
  }
  return patched.stats;
}

function patchSourceXml(xmlPath: string, verifyOnly: boolean): HomeDummyHpStats {
  const original = fs.readFileSync(xmlPath, "utf8");
  const patched = patchHomeDummyHpXml(original);
  if (patched.stats.verified !== TARGET_DUMMIES.length) {
    throw new SwzPatchError("source XML missing one or more HomeDummy entries");
  }
  if (!verifyOnly && patched.xml !== original) {
    fs.writeFileSync(xmlPath, patched.xml, "utf8");
  }
  return verifyOnly ? assertHomeDummyHpXml(original, "source XML") : assertHomeDummyHpXml(patched.xml, "source XML");
}

function patchServerJson(jsonPath: string, verifyOnly: boolean): HomeDummyHpStats {
  const original = fs.readFileSync(jsonPath, "utf8");
  const hasBom = original.charCodeAt(0) === 0xfeff;
  const data = JSON.parse(hasBom ? original.slice(1) : original);
  const entTypes = Array.isArray(data?.EntTypes?.EntType) ? data.EntTypes.EntType : [];
  let updated = 0;
  let verified = 0;

  for (const entName of TARGET_DUMMIES) {
    const entry = entTypes.find((candidate: { EntName?: string }) => candidate.EntName === entName);
    if (!entry) {
      throw new SwzPatchError(`server JSON missing ${entName}`);
    }
    verified += 1;
    if (entry.HitPoints !== TARGET_HP) {
      updated += 1;
      entry.HitPoints = TARGET_HP;
    }
  }

  if (verifyOnly && updated !== 0) {
    throw new SwzPatchError(`server JSON HomeDummy hit points are not all ${TARGET_HP}`);
  }
  if (!verifyOnly && updated !== 0) {
    fs.writeFileSync(jsonPath, `${hasBom ? "\ufeff" : ""}${JSON.stringify(data, null, 2)}\n`, "utf8");
  }
  return {
    updated: verifyOnly ? 0 : updated,
    verified
  };
}

function patchGameSwz(swzPath: string, verifyOnly: boolean): HomeDummyHpStats {
  const ctx = parseSwz(swzPath);
  const chunk = ctx.chunks.find((entry) => entry.xml.includes("<EntTypes"));
  if (!chunk) {
    throw new SwzPatchError(`${path.basename(swzPath)} missing EntTypes`);
  }

  const original = chunk.xml;
  const patched = patchHomeDummyHpXml(original);
  if (patched.stats.verified !== TARGET_DUMMIES.length) {
    throw new SwzPatchError(`${path.basename(swzPath)} missing one or more HomeDummy entries`);
  }
  if (verifyOnly && patched.stats.updated !== 0) {
    throw new SwzPatchError(`${path.basename(swzPath)} HomeDummy hit points are not all ${TARGET_HP}`);
  }
  if (!verifyOnly && patched.xml !== original) {
    ensureBackup(swzPath);
    chunk.xml = patched.xml;
    writeSwz(ctx);
  }
  return verifyOnly ? assertHomeDummyHpXml(original, path.basename(swzPath)) : assertHomeDummyHpXml(patched.xml, path.basename(swzPath));
}

function main(): void {
  const args = process.argv.slice(2);
  const verifyOnly = args.includes("--verify");
  const xmlPath = resolveArgPath(args, "--xml-path", defaultSourceXmlPath());
  const jsonPath = resolveArgPath(args, "--json-path", defaultServerJsonPath());
  const swzPaths = resolveArgPaths(args, "--swz-path", defaultGameSwzPaths());

  console.log(`XML: ${xmlPath}`);
  console.log(JSON.stringify(patchSourceXml(xmlPath, verifyOnly)));
  console.log(`JSON: ${jsonPath}`);
  console.log(JSON.stringify(patchServerJson(jsonPath, verifyOnly)));

  for (const swzPath of swzPaths) {
    console.log(`SWZ: ${swzPath}`);
    console.log(JSON.stringify(patchGameSwz(swzPath, verifyOnly)));
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[patch_gameswz_home_dummy_hp] ${message}`);
    process.exitCode = 1;
  }
}
