/**
 * `SpawnLimit` is the headroom for a summon cast, and it is what keeps a live clone alive.
 *
 * The original note here said the cap CULLS live puppets to make room on every recast. It does
 * not. From `CombatState`, the spawn loop:
 *
 *     alive    = Game.GetSummonedCreatures(caster.id, power);   // non-dead summons of this power
 *     headroom = power.SpawnLimit + talentBonus - alive.length;
 *     count    = min(spawnedMonsters.length, headroom);
 *     while (i < count) { ...spawn... }
 *
 * Nothing is removed. A cast with no headroom simply spawns ZERO puppets -- Tanja still plays the
 * animation and still takes `CritterStealth`, and the clones already on the floor are untouched.
 * `GetSummonedCreatures` skips anything in the dead state, so headroom reopens the moment the
 * player kills them and the next cast off the 7s cooldown brings a fresh pair.
 *
 * So `SpawnLimit` 2 with two puppets per cast IS the "never summon while a clone is alive" rule,
 * exactly as authored. `talentBonus` is a power-mod lookup off `var_18`, which a monster does not
 * have, so it is 0 here.
 *
 * What actually made the clones "die when she summons again" was the five-second lifetime:
 * `SpawnDuration 0` means `SpawnDuration + 5000`, not unlimited. The pair evaporated at 5s and she
 * recast at 7s, so a new pair appeared two seconds later and it read as a replacement. See
 * patch_gameswz_shadowpuppet_duration.ts, which is the fix; the paragraph that used to sit here
 * clearing SpawnDuration of blame was wrong.
 *
 * TARGET_LIMIT stays at the authored 2. Raising it does not make the clones live longer -- it lets
 * a recast stack MORE of them on the floor while the first pair is still up, which with a 7s
 * cooldown and no timeout is unbounded growth. Retune only if that is what is wanted.
 *
 * MonsterPowerTypes lives in Game.swz (EntTypes is the one in Login.swz). Only p/cbq/Game.swz is
 * live here; the .en/.tr copies are backups.
 */
import * as path from "path";
import { ensureBackup, parseSwz, SwzPatchError, writeSwz } from "./swzPatchUtils";

const POWER_NAME = "SummonStealth";
const TARGET_LIMIT = "2";

function defaultGameSwzPath(): string {
  return path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p", "cbq", "Game.swz");
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

    const start = chunk.xml.indexOf(`<Power PowerName="${POWER_NAME}"`);
    const end = chunk.xml.indexOf("</Power>", start);
    if (start === -1 || end === -1) {
      throw new SwzPatchError(`${POWER_NAME} block not found`);
    }

    const block = chunk.xml.slice(start, end);
    const match = /<SpawnLimit>([^<]*)<\/SpawnLimit>/.exec(block);
    if (!match) {
      throw new SwzPatchError(`${POWER_NAME} has no SpawnLimit`);
    }

    console.log(`SWZ: ${swzPath}`);
    console.log(`${POWER_NAME}: SpawnLimit ${match[1].trim()} -> ${TARGET_LIMIT}`);
    if (match[1].trim() === TARGET_LIMIT) {
      console.log("No changes needed.");
      return 0;
    }
    if (verifyOnly) {
      console.log("Patch required.");
      return 0;
    }

    ensureBackup(swzPath);
    chunk.xml = chunk.xml.slice(0, start) +
      block.replace(match[0], `<SpawnLimit>${TARGET_LIMIT}</SpawnLimit>`) +
      chunk.xml.slice(end);
    writeSwz(ctx);
    console.log("Patch apply complete.");
    return 0;
  } catch (error) {
    console.error(`Patch error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

process.exit(main());
