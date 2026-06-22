import * as fs from "fs";
import * as path from "path";
import { ensureBackup, parseSwz, SwzPatchError, writeSwz } from "./swzPatchUtils";

const FIRE_PIT_POWER = "FirePitMelee";
const TARGET_DAMAGE_MULT = "1";

type FirePitPatchStats = {
  updated: number;
  verified: number;
};

function defaultSourceXmlPath(): string {
  return path.resolve(__dirname, "..", "..", "client", "content", "xml", "MonsterPowerTypes.xml");
}

function defaultGameSwzPaths(): string[] {
  const cbqDir = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p", "cbq");
  return ["Game.swz", "Game.en.swz", "Game.tr.swz"]
    .map((name) => path.join(cbqDir, name))
    .filter((swzPath) => fs.existsSync(swzPath));
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

export function patchFirePitLavaDamageXml(xml: string): { xml: string; stats: FirePitPatchStats } {
  let updated = 0;
  let verified = 0;
  const blockPattern = new RegExp(
    `(<Power PowerName="${FIRE_PIT_POWER}">[\\s\\S]*?<BaseDamageMult>)([\\s\\S]*?)(<\\/BaseDamageMult>[\\s\\S]*?<\\/Power>)`
  );
  const patchedXml = xml.replace(blockPattern, (_block: string, prefix: string, currentValue: string, suffix: string) => {
    verified += 1;
    if (currentValue.trim() !== TARGET_DAMAGE_MULT) {
      updated += 1;
    }
    return `${prefix}${TARGET_DAMAGE_MULT}${suffix}`;
  });

  return {
    xml: patchedXml,
    stats: { updated, verified }
  };
}

function assertFirePitLavaDamageXml(xml: string, label: string): FirePitPatchStats {
  const patched = patchFirePitLavaDamageXml(xml);
  if (patched.stats.verified !== 1 || patched.stats.updated !== 0) {
    throw new SwzPatchError(`${label} ${FIRE_PIT_POWER} BaseDamageMult is not ${TARGET_DAMAGE_MULT}`);
  }
  return patched.stats;
}

function patchSourceXml(xmlPath: string, verifyOnly: boolean): FirePitPatchStats {
  const original = fs.readFileSync(xmlPath, "utf8");
  const patched = patchFirePitLavaDamageXml(original);
  if (patched.stats.verified !== 1) {
    throw new SwzPatchError(`source XML missing ${FIRE_PIT_POWER}`);
  }
  if (verifyOnly && patched.stats.updated !== 0) {
    throw new SwzPatchError(`source XML ${FIRE_PIT_POWER} BaseDamageMult is not ${TARGET_DAMAGE_MULT}`);
  }
  if (!verifyOnly && patched.xml !== original) {
    fs.writeFileSync(xmlPath, patched.xml, "utf8");
  }
  return verifyOnly ? assertFirePitLavaDamageXml(original, "source XML") : assertFirePitLavaDamageXml(patched.xml, "source XML");
}

function patchGameSwz(swzPath: string, verifyOnly: boolean): FirePitPatchStats {
  const ctx = parseSwz(swzPath);
  const chunk = ctx.chunks.find((entry) => entry.xml.includes("<MonsterPowerTypes"));
  if (!chunk) {
    throw new SwzPatchError(`${path.basename(swzPath)} missing MonsterPowerTypes`);
  }

  const original = chunk.xml;
  const patched = patchFirePitLavaDamageXml(original);
  if (patched.stats.verified !== 1) {
    throw new SwzPatchError(`${path.basename(swzPath)} missing ${FIRE_PIT_POWER}`);
  }
  if (verifyOnly && patched.stats.updated !== 0) {
    throw new SwzPatchError(`${path.basename(swzPath)} ${FIRE_PIT_POWER} BaseDamageMult is not ${TARGET_DAMAGE_MULT}`);
  }
  if (!verifyOnly && patched.xml !== original) {
    ensureBackup(swzPath);
    chunk.xml = patched.xml;
    writeSwz(ctx);
  }
  return verifyOnly ? assertFirePitLavaDamageXml(original, path.basename(swzPath)) : assertFirePitLavaDamageXml(patched.xml, path.basename(swzPath));
}

function main(): void {
  const args = process.argv.slice(2);
  const verifyOnly = args.includes("--verify");
  const xmlPath = resolveArgPath(args, "--xml-path", defaultSourceXmlPath());
  const swzPaths = resolveArgPaths(args, "--swz-path", defaultGameSwzPaths());

  console.log(`XML: ${xmlPath}`);
  console.log(JSON.stringify(patchSourceXml(xmlPath, verifyOnly)));
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
    console.error(`[patch_gameswz_firepit_lava_damage] ${message}`);
    process.exitCode = 1;
  }
}
