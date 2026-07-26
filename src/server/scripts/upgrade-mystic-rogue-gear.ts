import * as fs from "fs";
import * as path from "path";

/**
 * Promotes owned copies of the six Rogue lockbox items from Legendary (tier 2) to Mystic (tier 3).
 *
 * There is deliberately no drop or forge path for Mystic yet, so this is how a character gets one.
 * Gear tier already travels in 2 bits, so tier 3 needs no protocol change; the client resolves it
 * through `Game.method_110` to the `"<gearID>Y"` entry added by `patch-mystic-rogue-gear-data.ts`.
 * Run those patches first — without them the client falls back to the Magic entry for tier 3.
 *
 * Only tier 2 is promoted: a Magic or Rare copy is a genuinely lesser item and silently jumping it
 * two grades would be a different change than the one this script advertises.
 */
const MYSTIC_GEAR_IDS = [1171, 1172, 1173, 1174, 1175, 1176];
const LEGENDARY_TIER = 2;
const MYSTIC_TIER = 3;

const SAVES_DIR = path.resolve(__dirname, "..", "data", "saves");

interface Gear {
  gearID?: number;
  tier?: number;
}

interface Character {
  name?: string;
  class?: string;
  equippedGears?: Gear[];
  inventoryGears?: Gear[];
}

interface Save {
  user_id?: number;
  characters?: Character[];
}

function parseArgs(argv: string[]): { character: string | null; userId: number | null; savesDir: string; verify: boolean; downgrade: boolean } {
  let character: string | null = null;
  let userId: number | null = null;
  let savesDir = SAVES_DIR;
  let verify = false;
  let downgrade = false;

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--character" || arg === "-c") {
      character = argv[++index] ?? null;
      continue;
    }
    if (arg === "--user-id" || arg === "-u") {
      // Character names are not unique across accounts, so this is how you disambiguate.
      userId = Number(argv[++index]);
      if (!Number.isFinite(userId)) throw new Error("--user-id needs a number.");
      continue;
    }
    if (arg === "--saves-dir") {
      savesDir = path.resolve(argv[++index] || "");
      continue;
    }
    if (arg === "--verify" || arg === "--dry-run") {
      verify = true;
      continue;
    }
    if (arg === "--downgrade") {
      downgrade = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log([
        "Usage:",
        "  npx ts-node src/server/scripts/upgrade-mystic-rogue-gear.ts [--character <name>] [--verify] [--downgrade]",
        "",
        "Promotes owned Legendary copies of the six Rogue lockbox items (GearID 1171-1176) to Mystic.",
        "",
        "  --character <name>  Only this character; default is every character in every save.",
        "  --user-id <id>      Only this account. Character names are not unique across accounts.",
        "  --verify            Report what would change without writing.",
        "  --downgrade         Reverse: put Mystic copies back to Legendary.",
        "",
        "The server must not be running: it holds characters in memory and would overwrite the file.",
      ].join("\n"));
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { character, userId, savesDir, verify, downgrade };
}

function promote(gears: Gear[] | undefined, from: number, to: number): number {
  let changed = 0;
  for (const gear of gears ?? []) {
    if (!gear || typeof gear.gearID !== "number") continue;
    if (!MYSTIC_GEAR_IDS.includes(gear.gearID)) continue;
    if (Number(gear.tier ?? 0) !== from) continue;
    gear.tier = to;
    changed += 1;
  }
  return changed;
}

function run(): void {
  const { character, userId, savesDir, verify, downgrade } = parseArgs(process.argv);
  const from = downgrade ? MYSTIC_TIER : LEGENDARY_TIER;
  const to = downgrade ? LEGENDARY_TIER : MYSTIC_TIER;

  if (!fs.existsSync(savesDir)) {
    throw new Error(`Saves directory not found: ${savesDir}`);
  }

  const files = fs.readdirSync(savesDir).filter((name) => /^\d+\.json$/.test(name));
  let totalChanged = 0;
  let matchedCharacter = false;

  for (const file of files) {
    const filePath = path.join(savesDir, file);
    let save: Save;
    try {
      save = JSON.parse(fs.readFileSync(filePath, "utf8")) as Save;
    } catch (error) {
      console.warn(`  skipping ${file}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    if (userId !== null && Number(save.user_id) !== userId) continue;

    let fileChanged = 0;
    for (const entry of save.characters ?? []) {
      if (character !== null && entry.name !== character) continue;
      matchedCharacter = true;

      const changed = promote(entry.equippedGears, from, to) + promote(entry.inventoryGears, from, to);
      if (changed > 0) {
        console.log(`  ${file} user_id=${save.user_id} ${entry.name} (${entry.class ?? "?"}): ${changed} item(s) -> tier ${to}`);
        fileChanged += changed;
      }
    }

    if (fileChanged > 0 && !verify) {
      // The save is the only copy of a character's inventory, so keep one timestamped backup.
      const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15);
      fs.copyFileSync(filePath, `${filePath}.backup-${stamp}`);
      fs.writeFileSync(filePath, `${JSON.stringify(save, null, 4)}\n`, "utf8");
    }
    totalChanged += fileChanged;
  }

  if (character !== null && !matchedCharacter) {
    throw new Error(`No character named ${JSON.stringify(character)} found in ${savesDir}.`);
  }
  if (totalChanged === 0) {
    console.log(`Nothing to do — no tier ${from} copies of GearID ${MYSTIC_GEAR_IDS.join("/")} found.`);
    return;
  }
  console.log(`${verify ? "WOULD UPGRADE" : "Upgraded"} ${totalChanged} item(s) from tier ${from} to tier ${to}.`);
}

run();
