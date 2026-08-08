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
 *
 * The second edit here is the matching exit: `EndSentinelForm`'s cast effect
 * (`a_SentinelFormEnd`) is cyan, which read as a blue flash at the end of a red burn phase.
 * GfxType's own `<Tint>` field recolours it -- the same field PoisonCloud uses to turn
 * a_SmokeBurst green.
 *
 * That tint is a **multiply** (SuperAnimData.method_200: `ColorTransform(r/256, g/256, b/256,
 * 1, 0,0,0,0)`, offsets pinned at zero), so it can only ever darken a channel. On cyan art
 * that means the reds it produces come out of the artwork's own red channel -- bright where
 * the effect is near-white, dark in the saturated cyan cores. There is no way to make a cyan
 * effect glow *brighter* red with this field; recolouring it is all that is on offer without
 * new art.
 */

type PatchStats = {
  buffBlocks: number;
  powerBlocks: number;
  changes: number;
};

const EMPTY_STATS: PatchStats = { buffBlocks: 0, powerBlocks: 0, changes: 0 };

const XML_DIR = path.resolve(__dirname, "..", "..", "client", "content", "xml");
const CBQ_DIR = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p", "cbq");
const BUFF_XML = path.join(XML_DIR, "PlayerBuffTypes.xml");
const POWER_XML = path.join(XML_DIR, "PlayerPowerTypes.xml");

export const SENTINEL_FURY_BUFF_NAME = "SentinelFury";
export const SENTINEL_FURY_TINT = "0xFF3030";

/** The power whose cast effect plays as the Sentinel drops back to normal. */
const END_FORM_POWER = "EndSentinelForm";

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
  `\t\t<EntTint>${SENTINEL_FURY_TINT}</EntTint>`,
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
      powerBlocks: merged.powerBlocks + item.powerBlocks,
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

/**
 * Recolours the return-to-normal effect.
 *
 * The tint goes on the CastGfx block of EndSentinelForm and nowhere else -- the enter effect
 * (a_SentinelFormCast, shared by all eleven rank entries) stays blue, because entering the
 * form is not the red moment.
 */
export function patchPlayerPowers(xml: string): { xml: string; stats: PatchStats } {
  const stats = cloneStats();

  const patched = xml.replace(/<Power PowerName="([^"]*)">[\s\S]*?<\/Power>/g, (block: string, powerName: string) => {
    if (powerName !== END_FORM_POWER) {
      return block;
    }

    const castGfx = block.match(/<CastGfx>[\s\S]*?<\/CastGfx>/)?.[0];
    if (!castGfx) {
      return block;
    }

    let nextGfx = castGfx;
    if (/<Tint>[^<]*<\/Tint>/.test(nextGfx)) {
      nextGfx = nextGfx.replace(/<Tint>[^<]*<\/Tint>/, `<Tint>${SENTINEL_FURY_TINT}</Tint>`);
    } else {
      // Reuse the line ending and indent of the entry above rather than assuming either: the
      // loose XML and the swz copy do not agree on CRLF.
      nextGfx = nextGfx.replace(
        /(\r?\n)([ \t]*)(<FireAndForget>[^<]*<\/FireAndForget>)/,
        `$1$2$3$1$2<Tint>${SENTINEL_FURY_TINT}</Tint>`,
      );
    }

    if (nextGfx === castGfx) {
      return block;
    }

    stats.powerBlocks += 1;
    stats.changes += 1;
    return block.replace(castGfx, nextGfx);
  });

  return { xml: patched, stats };
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
  const resources: Array<{ marker: string; patcher: Patcher }> = [
    { marker: "<PlayerBuffTypes", patcher: patchPlayerBuffs },
    { marker: "<PlayerPowerTypes", patcher: patchPlayerPowers },
  ];

  const collected: PatchStats[] = [];
  let changed = false;
  for (const resource of resources) {
    const chunk = ctx.chunks.find((entry) => entry.xml.includes(resource.marker));
    if (!chunk) {
      continue;
    }

    const patched = resource.patcher(chunk.xml);
    collected.push(patched.stats);
    if (patched.xml !== chunk.xml) {
      changed = true;
      if (!verifyOnly) {
        chunk.xml = patched.xml;
      }
    }
  }

  if (!verifyOnly && changed) {
    ensureBackup(swzPath);
    writeSwz(ctx);
  }

  return mergeStats(...collected);
}

export function patchConfiguredSentinelFuryBuff(verifyOnly: boolean): PatchStats {
  const swzPaths = ["Game.swz", "Game.en.swz", "Game.tr.swz"]
    .map((fileName) => path.join(CBQ_DIR, fileName))
    .filter(fs.existsSync);

  return mergeStats(
    patchFile(BUFF_XML, patchPlayerBuffs, verifyOnly),
    patchFile(POWER_XML, patchPlayerPowers, verifyOnly),
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
