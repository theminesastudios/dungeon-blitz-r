/**
 * Tanja's clones vanish after five seconds, and `SpawnDuration 0` is why after all.
 *
 * The sibling patch (patch_gameswz_shadowpuppet_spawnlimit.ts) says `SpawnDuration 0` is not the
 * problem because every other summon power in the table uses 0 too. That reading was wrong: the
 * client's expiry test is not `age > SpawnDuration`, it is `age > SpawnDuration + 5000`. From the
 * P-code of the summon upkeep loop in Entity:
 *
 *     this.var_99.var_1962            // powerType.SpawnDuration
 *     getlocal 4                      // 5000
 *     add
 *     this.var_1.mTimeThisTick
 *     this.var_1459                   // the spawn timestamp, set at construction
 *     subtract
 *     lessthan                        // (SpawnDuration + 5000) < age  ->  retire
 *
 * The same expression appears in class_129, which force-expires a player's summons on an ability
 * swap by BACK-DATING them exactly that far: `var_1459 = mTimeThisTick - (var_1962 + 5000)`. So
 * zero does not mean "no limit", it means the floor -- five seconds. Every other summon in the
 * game is a pet or a short-lived add, so nobody noticed.
 *
 * A day is used rather than a sentinel because there is no sentinel: the comparison is plain
 * arithmetic on a uint, so "forever" has to be a number bigger than any fight. The clones now stay
 * up until somebody kills them.
 *
 * `SpawnLimit` is the OTHER thing that removes a live clone, and it is deliberately left alone:
 * `SummonStealth` lists two puppets and caps concurrent puppets at 2, so with a 7s cooldown each
 * recast still culls the previous pair to make room. The project chose that rhythm on purpose --
 * retune it in the sibling script's TARGET_LIMIT, not here.
 *
 * MonsterPowerTypes lives in Game.swz (EntTypes is the one in Login.swz). Only p/cbq/Game.swz is
 * live here; the .en/.tr copies are backups. `src/client/content/xml/MonsterPowerTypes.xml` is the
 * loose server-side copy and is kept in step by this script too -- the two sides drifting apart is
 * exactly what the ShadowPuppet level fix had to go back and repair.
 */
import * as fs from "fs";
import * as path from "path";
import { ensureBackup, parseSwz, SwzPatchError, writeSwz } from "./swzPatchUtils";

const POWER_NAME = "SummonStealth";
// 24 hours in milliseconds. Longer than any dungeon run, far short of a uint.
const TARGET_DURATION = "86400000";

function defaultGameSwzPath(): string {
  return path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p", "cbq", "Game.swz");
}

function looseXmlPath(): string {
  return path.resolve(__dirname, "..", "..", "client", "content", "xml", "MonsterPowerTypes.xml");
}

function readPowerBlock(xml: string): { start: number; end: number; block: string; current: string } {
  const start = xml.indexOf(`<Power PowerName="${POWER_NAME}"`);
  if (start === -1) {
    throw new SwzPatchError(`${POWER_NAME} block not found`);
  }
  const end = xml.indexOf("</Power>", start);
  if (end === -1) {
    throw new SwzPatchError(`${POWER_NAME} closing tag not found`);
  }

  const block = xml.slice(start, end);
  const match = /<SpawnDuration>([^<]*)<\/SpawnDuration>/.exec(block);
  if (!match) {
    throw new SwzPatchError(`${POWER_NAME} has no SpawnDuration`);
  }

  return { start, end, block, current: match[1].trim() };
}

function patchBlock(block: string): string {
  return block.replace(
    /<SpawnDuration>[^<]*<\/SpawnDuration>/,
    `<SpawnDuration>${TARGET_DURATION}</SpawnDuration>`
  );
}

function patchLooseXml(verifyOnly: boolean): boolean {
  const filePath = looseXmlPath();
  if (!fs.existsSync(filePath)) {
    console.log(`Loose XML: ${filePath} (missing, skipped)`);
    return false;
  }

  const xml = fs.readFileSync(filePath, "utf8");
  const { start, end, block, current } = readPowerBlock(xml);
  console.log(`Loose XML: ${filePath}`);
  console.log(`${POWER_NAME}: SpawnDuration ${current} -> ${TARGET_DURATION}`);
  if (current === TARGET_DURATION) {
    console.log("No changes needed.");
    return false;
  }
  if (verifyOnly) {
    console.log("Patch required.");
    return true;
  }

  fs.writeFileSync(filePath, xml.slice(0, start) + patchBlock(block) + xml.slice(end));
  return true;
}

function main(): number {
  const args = process.argv.slice(2);
  const verifyOnly = args.includes("--verify");
  const idx = args.indexOf("--swz-path");
  const swzPath = idx !== -1 && idx + 1 < args.length ? path.resolve(args[idx + 1]) : defaultGameSwzPath();

  try {
    const ctx = parseSwz(swzPath);
    const chunk = ctx.chunks.find((candidate) => candidate.xml.includes(`PowerName="${POWER_NAME}"`));
    if (!chunk) {
      throw new SwzPatchError(`no chunk carries ${POWER_NAME}`);
    }

    const { start, end, block, current } = readPowerBlock(chunk.xml);
    console.log(`SWZ: ${swzPath}`);
    console.log(`${POWER_NAME}: SpawnDuration ${current} -> ${TARGET_DURATION}`);

    let changed = false;
    if (current === TARGET_DURATION) {
      console.log("No changes needed.");
    } else if (verifyOnly) {
      console.log("Patch required.");
      changed = true;
    } else {
      ensureBackup(swzPath);
      chunk.xml = chunk.xml.slice(0, start) + patchBlock(block) + chunk.xml.slice(end);
      writeSwz(ctx);
      changed = true;
    }

    patchLooseXml(verifyOnly);
    if (changed && !verifyOnly) {
      console.log("Patch apply complete.");
      // No clientrev bump: StaticServer serves .swz with `no-cache` and an mtime/size ETag,
      // so a patched Game.swz is revalidated and picked up on the next load. The token in
      // index.html busts DungeonBlitz.swf only -- the SWF never appends it to its asset URLs
      // (ResourceManager.method_1071 reads `fv` for the folder and nothing else).
    }
    return 0;
  } catch (error) {
    console.error(`Patch error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

process.exit(main());
