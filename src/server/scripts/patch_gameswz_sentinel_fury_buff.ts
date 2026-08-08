import * as fs from "fs";
import * as path from "path";
import { ensureBackup, parseSwz, writeSwz } from "./swzPatchUtils";

/**
 * "SentinelFury" -- the low-energy half of Sentinel Form.
 *
 * While the form is running, the last 20 energy is a burn phase: the Sentinel turns red and
 * hits 60% harder until the bar empties and the form drops. This file is the *data* half --
 * the buff that carries the damage and the colour. The code half, which applies and removes
 * it from the energy bar every tick, is
 * `patch-dungeonblitz-sentinel-form-low-energy-fury.ts`; neither does anything alone.
 *
 * Why a buff rather than a bespoke multiplier: everything needed already exists on BuffType.
 *
 *   - `MeleeDamage` / `MagicDamage` are the same +% fields SentinelForm1-10 use for the
 *     form's own damage bonus, and CombatState aggregates them the same way. Sentinel Form
 *     overrides both the melee and the ranged attack (SFMelee* / SFRanged*), so both fields
 *     have to carry the 0.6 or the ranged half of the form gains nothing.
 *   - `EntTint` is the client's entity-wide colour multiply (BuffType.var_932, applied in
 *     Entity.method_1826 through SuperAnimInstance.method_325 and cleared when the buff
 *     leaves). MistArmor and FireArmor already use it for exactly this kind of "the armour
 *     went red" read, so the tint costs no new art and no new code.
 *   - `Duration` 0 means it lives until it is removed, like the form buff itself.
 *
 * `Attack` must stay false: AddBuff refuses a non-hostile buff aimed at an ally and a hostile
 * one aimed at yourself, and this is self-applied.
 *
 * BuffID 742 is the next free id -- 740/741 are the Viperblade pair added by
 * patch_gameswz_rogue_mastery_balance. Note AddBuff's `buffID >= 740` rule overwrites the
 * amount argument with the caster's meleeDamage; that only feeds DoT scaling, which this buff
 * does not have, so it is harmless here.
 *
 * The buff has to land in the served archives, not just the loose XML: the client reads
 * Game*.swz and never downloads src/client/content/xml.
 */

type PatchStats = {
  buffBlocks: number;
  changes: number;
};

const EMPTY_STATS: PatchStats = { buffBlocks: 0, changes: 0 };

const XML_DIR = path.resolve(__dirname, "..", "..", "client", "content", "xml");
const CBQ_DIR = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p", "cbq");
const BUFF_XML = path.join(XML_DIR, "PlayerBuffTypes.xml");

export const SENTINEL_FURY_BUFF_NAME = "SentinelFury";

/**
 * 0xFF3030 is a multiply, not a replace: red stays at full, green and blue drop to ~19%, so
 * the armour reads as glowing red while the silhouette and its details stay legible. The
 * 0x720000 the game uses for MistArmor crushes the character into a dark red slab, which is
 * fine on a boss and unreadable on the player you are steering.
 */
const BUFF_XML_BLOCK = [
  '<BuffType BuffName="SentinelFury">',
  "\t\t<BuffID>742</BuffID>",
  "\t\t<Attack>false</Attack>",
  "\t\t<Duration>0</Duration>",
  "\t\t<MagicDamage>0.6</MagicDamage>",
  "\t\t<MeleeDamage>0.6</MeleeDamage>",
  "\t\t<EntTint>0xFF3030</EntTint>",
  "\t\t<GfxType/>",
  "\t</BuffType>",
].join("\r\n\t");

function cloneStats(): PatchStats {
  return { ...EMPTY_STATS };
}

function mergeStats(...stats: PatchStats[]): PatchStats {
  return stats.reduce(
    (merged, item) => ({
      buffBlocks: merged.buffBlocks + item.buffBlocks,
      changes: merged.changes + item.changes,
    }),
    cloneStats(),
  );
}

export function patchPlayerBuffs(xml: string): { xml: string; stats: PatchStats } {
  const stats = cloneStats();

  if (xml.includes(`<BuffType BuffName="${SENTINEL_FURY_BUFF_NAME}">`)) {
    return { xml, stats };
  }

  const closing = xml.lastIndexOf("</PlayerBuffTypes>");
  if (closing < 0) {
    return { xml, stats };
  }

  stats.buffBlocks += 1;
  stats.changes += 1;
  return {
    xml: `${xml.slice(0, closing)}\t${BUFF_XML_BLOCK}\r\n${xml.slice(closing)}`,
    stats,
  };
}

function patchFile(filePath: string, verifyOnly: boolean): PatchStats {
  const original = fs.readFileSync(filePath, "utf8");
  const patched = patchPlayerBuffs(original);
  if (!verifyOnly && patched.xml !== original) {
    fs.writeFileSync(filePath, patched.xml, "utf8");
  }
  return patched.stats;
}

function patchSwz(swzPath: string, verifyOnly: boolean): PatchStats {
  const ctx = parseSwz(swzPath);
  const chunk = ctx.chunks.find((entry) => entry.xml.includes("<PlayerBuffTypes"));
  if (!chunk) {
    return cloneStats();
  }

  const patched = patchPlayerBuffs(chunk.xml);
  if (!verifyOnly && patched.xml !== chunk.xml) {
    chunk.xml = patched.xml;
    ensureBackup(swzPath);
    writeSwz(ctx);
  }

  return patched.stats;
}

export function patchConfiguredSentinelFuryBuff(verifyOnly: boolean): PatchStats {
  const swzPaths = ["Game.swz", "Game.en.swz", "Game.tr.swz"]
    .map((fileName) => path.join(CBQ_DIR, fileName))
    .filter(fs.existsSync);

  return mergeStats(
    patchFile(BUFF_XML, verifyOnly),
    ...swzPaths.map((swzPath) => patchSwz(swzPath, verifyOnly)),
  );
}

function main(): number {
  const verifyOnly = process.argv.includes("--verify") || process.argv.includes("--dry-run");
  try {
    const stats = patchConfiguredSentinelFuryBuff(verifyOnly);
    console.log(JSON.stringify({ verifyOnly, stats }, null, 2));
    console.log(stats.changes === 0 ? "No changes needed." : verifyOnly ? "Patch required." : "Patch apply complete.");
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[patch_gameswz_sentinel_fury_buff] ${message}`);
    return 1;
  }
}

if (require.main === module) {
  process.exit(main());
}
