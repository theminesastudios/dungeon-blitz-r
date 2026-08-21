import * as fs from "fs";
import * as path from "path";
import { ensureBackup, parseSwz, writeSwz } from "./swzPatchUtils";

/**
 * "ProcPartyArrival" -- the materialisation a party "Go to" arrival is drawn with.
 *
 * The server half is `EntityHandler.playPartyArrivalEffect`, which sends one power-cast packet
 * (0x09) naming this power on the traveller's own entity, to every screen in the scope. This
 * file is the *data* half; neither does anything alone.
 *
 * Why a power rather than a buff: a buff's `GfxType` is attached to the entity for the buff's
 * duration and has to be taken off again, which means a second packet, a duration to get wrong
 * and a stuck effect whenever the removal is lost. A power's `CastGfx` is played once and
 * detaches. The client already ships the artwork -- `a_TeleportEffect` in SFX_1.swf, a
 * white-blue column of water that rises into the shape of a body and breaks into sparks -- and
 * an unused `TeleportEffect` power (2078) that points at it.
 *
 * That existing power is deliberately *not* reused. Two things are wrong with it for this job:
 *
 *   - its `RecoverTime` is 1000ms. On the traveller's own screen `LinkUpdater.method_1902`
 *     parks the cast in `combatState.mActivePower`, so the effect would cost the arriving
 *     player a second of control -- and would be cancelled by, or cancel, the first thing they
 *     did on landing.
 *   - it is a plain name, and the client's fire-and-forget branch is keyed on the *name*:
 *     `PowerType.method_771` sets `var_301 = !powerName.indexOf("Proc")`, and the reader's
 *     `if(powerType.var_301)` branch builds the ActivePower, casts it and destroys it in the
 *     same frame, never touching `mActivePower`.
 *
 * So the new entry carries the same graphic under a `Proc` name with every timer at zero. The
 * client validates that combination itself -- "ProcPowers must not have a manaCost, castTime,
 * or recoverTime" -- so the three zeroes are required, not tidiness.
 *
 * `CastAnim` is deliberately absent: with one, the character would play a spellcasting pose as
 * it materialises. Absent, only the graphic plays and the body simply appears inside it.
 *
 * PowerID 4017 is the next free id -- MonsterPowerTypes stops at 4016 and PlayerPowerTypes owns
 * a disjoint range above 7000. `PowerType.method_18` loads both lists into one array indexed by
 * id and complains about a collision at load, so this must stay unique across *both* files.
 *
 * The power has to land in the served archives, not just the loose XML: the client reads
 * Game*.swz and never downloads src/client/content/xml.
 */

type PatchStats = {
  powerBlocks: number;
  changes: number;
};

const EMPTY_STATS: PatchStats = { powerBlocks: 0, changes: 0 };

const XML_DIR = path.resolve(__dirname, "..", "..", "client", "content", "xml");
const CBQ_DIR = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p", "cbq");
const MONSTER_POWER_XML = path.join(XML_DIR, "MonsterPowerTypes.xml");

export const PARTY_ARRIVAL_POWER_NAME = "ProcPartyArrival";
export const PARTY_ARRIVAL_POWER_ID = 4017;

const POWER_XML_BLOCK = [
  `<Power PowerName="${PARTY_ARRIVAL_POWER_NAME}">`,
  `\t\t<PowerID>${PARTY_ARRIVAL_POWER_ID}</PowerID>`,
  "\t\t<TargetMethod>Self</TargetMethod>",
  "\t\t<CastTime>0</CastTime>",
  "\t\t<RecoverTime>0</RecoverTime>",
  "\t\t<CoolDownTime>0</CoolDownTime>",
  "\t\t<ManaCost>0</ManaCost>",
  "\t\t<BaseDamageMult>0</BaseDamageMult>",
  "\t\t<DamageType>Physical</DamageType>",
  "\t\t<DisplayName>***Monster***</DisplayName>",
  // The stock TeleportEffect's sound. The graphic alone reads as a silent shimmer; this is the
  // half that makes an arrival land.
  "\t\t<CastSound>snd_pwr_aoe_fire</CastSound>",
  "\t\t<CastAnimSource>Feet</CastAnimSource>",
  "\t\t<CastGfx>",
  "\t\t\t<AnimFile>SFX_1.swf</AnimFile>",
  "\t\t\t<AnimClass>a_TeleportEffect</AnimClass>",
  "\t\t\t<AnimScale>1.2</AnimScale>",
  "\t\t\t<FireAndForget>true</FireAndForget>",
  "\t\t</CastGfx>",
  "\t\t<FireGfx/>",
  "\t\t<HitGfx/>",
  "\t\t<ProjGfx/>",
  "\t</Power>",
].join("\r\n");

/** Matches an already-installed block, so a re-run replaces it instead of refusing. */
const EXISTING_BLOCK = new RegExp(
  `[ \\t]*<Power PowerName="${PARTY_ARRIVAL_POWER_NAME}">[\\s\\S]*?</Power>\\r?\\n`,
);

function cloneStats(): PatchStats {
  return { ...EMPTY_STATS };
}

function mergeStats(...entries: PatchStats[]): PatchStats {
  return entries.reduce<PatchStats>(
    (total, entry) => ({
      powerBlocks: total.powerBlocks + entry.powerBlocks,
      changes: total.changes + entry.changes,
    }),
    cloneStats(),
  );
}

export function patchMonsterPowers(xml: string): { xml: string; stats: PatchStats } {
  const stats = cloneStats();

  // Re-running replaces the entry rather than skipping it, so a changed graphic or scale in
  // this file reaches an archive that already carries an older copy.
  const stripped = xml.replace(EXISTING_BLOCK, "");

  // A collision here is a load-time error in the client, not a silent overwrite, so refuse
  // rather than ship an archive that breaks every power.
  if (new RegExp(`<PowerID>\\s*${PARTY_ARRIVAL_POWER_ID}\\s*</PowerID>`).test(stripped)) {
    throw new Error(`PowerID ${PARTY_ARRIVAL_POWER_ID} is already taken in this power list`);
  }

  const closing = stripped.lastIndexOf("</MonsterPowerTypes>");
  if (closing < 0) {
    return { xml, stats };
  }

  const next = `${stripped.slice(0, closing)}\t${POWER_XML_BLOCK}\r\n${stripped.slice(closing)}`;
  if (next === xml) {
    return { xml, stats };
  }

  stats.powerBlocks += 1;
  stats.changes += 1;
  return { xml: next, stats };
}

type Patcher = (xml: string) => { xml: string; stats: PatchStats };

function patchFile(filePath: string, patcher: Patcher, verifyOnly: boolean): PatchStats {
  const original = fs.readFileSync(filePath, "utf8");
  const patched = patcher(original);
  if (!verifyOnly && patched.xml !== original) {
    fs.writeFileSync(filePath, patched.xml, "utf8");
  }
  return patched.stats;
}

function patchSwz(swzPath: string, verifyOnly: boolean): PatchStats {
  const ctx = parseSwz(swzPath);
  const chunk = ctx.chunks.find((entry) => entry.xml.includes("<MonsterPowerTypes"));
  if (!chunk) {
    return cloneStats();
  }

  const patched = patchMonsterPowers(chunk.xml);
  if (!verifyOnly && patched.xml !== chunk.xml) {
    chunk.xml = patched.xml;
    ensureBackup(swzPath);
    writeSwz(ctx);
  }

  return patched.stats;
}

export function patchConfiguredPartyArrivalEffect(verifyOnly: boolean): PatchStats {
  const swzPaths = ["Game.swz", "Game.en.swz", "Game.tr.swz"]
    .map((fileName) => path.join(CBQ_DIR, fileName))
    .filter(fs.existsSync);

  return mergeStats(
    patchFile(MONSTER_POWER_XML, patchMonsterPowers, verifyOnly),
    ...swzPaths.map((swzPath) => patchSwz(swzPath, verifyOnly)),
  );
}

function main(): number {
  const verifyOnly = process.argv.includes("--verify") || process.argv.includes("--dry-run");
  try {
    const stats = patchConfiguredPartyArrivalEffect(verifyOnly);
    console.log(JSON.stringify({ verifyOnly, stats }, null, 2));
    console.log(stats.changes === 0 ? "No changes needed." : verifyOnly ? "Patch required." : "Patch apply complete.");
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[patch_gameswz_party_arrival_effect] ${message}`);
    return 1;
  }
}

if (require.main === module) {
  process.exit(main());
}
