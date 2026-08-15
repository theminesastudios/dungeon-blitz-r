import * as fs from "fs";
import * as path from "path";
import { ensureBackup, parseSwz, writeSwz } from "./swzPatchUtils";

/**
 * Sentinel Form's cooldown is a 30-second budget at every rank.
 *
 * The authored cooldown was a rank curve -- 60s at ranks 1-4, 40s at 5-9, 30s at rank 10 --
 * and the client stamps it at the cast (CombatState.method_51). That was the whole lockout,
 * and it stopped working the moment the form outlived it: the form has no Duration, it runs
 * until the mana bar cannot pay for the next swing, and the per-swing cost has since been cut
 * twice (patch_gameswz_form_stance_balance, then patch_gameswz_paladin_mastery_balance) to 3
 * mana at rank 10. A form that lasts minutes leaves its own cooldown expired long before the
 * Sentinel drops out of it, so leaving and re-entering costs nothing at all.
 *
 * Two halves fix that and they are deliberately split:
 *
 *   this file                                     what the budget is -- 30s, every rank. This
 *                                                 is the cast-time stamp AND the cap on the
 *                                                 exit cooldown below.
 *   patch-dungeonblitz-sentinel-form-exit-cooldown what the wait actually is -- re-stamped
 *                                                 when the form ends, scaled to the energy the
 *                                                 form spent (each swing drains the mana bar),
 *                                                 floored at 10s so a tap cannot be spammed
 *                                                 and capped at this file's 30s.
 *
 * Values are absolute, not multipliers applied to whatever is in the file, because this runs
 * on every prebuild.
 *
 * ponytail: flattening the curve is what takes ranks 5 and 10 down to 30s along with everyone
 * else, and both of those ranks were sold on the cooldown reduction alone. Rank 5 in particular
 * now buys nothing -- if that matters, give it a benefit here rather than putting the curve
 * back, because a rank-1 Sentinel waiting 60s was the version nobody could play.
 */

type PatchStats = {
  powerBlocks: number;
  changes: number;
};

const EMPTY_STATS: PatchStats = { powerBlocks: 0, changes: 0 };

const XML_DIR = path.resolve(__dirname, "..", "..", "client", "content", "xml");
const CBQ_DIR = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p", "cbq");
const POWER_XML = path.join(XML_DIR, "PlayerPowerTypes.xml");

const COOLDOWN_MS = "30000";

// The base entry plus every rank. EndSentinelForm is left at 0 on purpose -- it is the cancel,
// and giving it a cooldown of its own would lock a Sentinel inside the form.
const SENTINEL_FORM_POWERS = new Set<string>([
  "SentinelForm", //   60000
  "SentinelForm1", //  60000
  "SentinelForm2", //  60000
  "SentinelForm3", //  60000
  "SentinelForm4", //  60000
  "SentinelForm5", //  40000
  "SentinelForm6", //  40000
  "SentinelForm7", //  40000
  "SentinelForm8", //  40000
  "SentinelForm9", //  40000
  "SentinelForm10", // 30000
]);

/**
 * Both ranks that advertised a cooldown reduction now describe the rule that replaced it.
 * Leaving them alone would have rank 5 promising 40 seconds it no longer has, and neither
 * line mentioned the part players actually trip over -- that the wait starts when you leave
 * the form and scales with the energy the form spent (every swing drains the mana bar).
 *
 * Ordered whole-phrase replacements, both languages: Game.tr.swz carries its own translated
 * copy of the same string, so an English-only rewrite leaves Turkish players reading the old
 * number. Turkish here matches the machine-translated house style already in that file
 * (ASCII-folded, "bekleme" for cooldown).
 *
 * The FROM list includes every wording this file has shipped: the authored lines, the first
 * attack-free-time cut, and the attack-penalty cut that the previous release carried, so an
 * SWF built from any of them converges on the energy wording. The trailing pair in each list
 * is a fragment upgrade, not a whole phrase: it rewrites any leftover "(max 30 seconds)" span
 * to "(min 10, max 30 seconds)" so a tooltip that missed a whole-phrase rewrite still picks up
 * the floor. "(min 10, max 30 seconds)" does not contain "(max 30 seconds)", so re-running is
 * a no-op.
 */
const SENTINEL_TOOLTIPS = new Map<string, Array<[string, string]>>([
  [
    "SentinelForm5",
    [
      ["Cooldown decreased to 40 seconds.", "Cooldown after leaving grows with the energy spent in the form (min 10, max 30 seconds)."],
      ["30 second Cooldown, starting when you leave the form.", "Cooldown after leaving grows with the energy spent in the form (min 10, max 30 seconds)."],
      ["Cooldown after leaving equals time spent in form, up to 30 seconds.", "Cooldown after leaving grows with the energy spent in the form (min 10, max 30 seconds)."],
      ["If no attack is made, cooldown after leaving equals time spent in form (max 30 seconds). Attacking causes a 30-second cooldown.", "Cooldown after leaving grows with the energy spent in the form (min 10, max 30 seconds)."],
      ["Bekleme decreased 40 saniye.", "Formdan sonraki bekleme, formda harcanan enerjiyle artar (en az 10, en fazla 30 saniye)."],
      ["Formdan cikinca baslayan 30 saniyelik bekleme.", "Formdan sonraki bekleme, formda harcanan enerjiyle artar (en az 10, en fazla 30 saniye)."],
      ["Formdan sonraki bekleme, formda gecirilen sure kadardir; en fazla 30 saniye.", "Formdan sonraki bekleme, formda harcanan enerjiyle artar (en az 10, en fazla 30 saniye)."],
      ["Hic saldiri yapilmazsa formdan sonraki bekleme, formda gecirilen sure kadardir (en fazla 30 saniye). Saldiri yapmak 30 saniye bekleme uygular.", "Formdan sonraki bekleme, formda harcanan enerjiyle artar (en az 10, en fazla 30 saniye)."],
      ["(max 30 seconds)", "(min 10, max 30 seconds)"],
      ["(en fazla 30 saniye)", "(en az 10, en fazla 30 saniye)"],
    ],
  ],
  [
    "SentinelForm10",
    [
      [
        "Reduced Cooldown to 30 seconds. +5% Sentinel attack Damage.",
        "Cooldown after leaving grows with the energy spent in the form (min 10, max 30 seconds). +5% Sentinel attack Damage.",
      ],
      [
        "30 second Cooldown, starting when you leave the form. +5% Sentinel attack Damage.",
        "Cooldown after leaving grows with the energy spent in the form (min 10, max 30 seconds). +5% Sentinel attack Damage.",
      ],
      [
        "Cooldown after leaving equals time spent in form, up to 30 seconds. +5% Sentinel attack Damage.",
        "Cooldown after leaving grows with the energy spent in the form (min 10, max 30 seconds). +5% Sentinel attack Damage.",
      ],
      [
        "If no attack is made, cooldown after leaving equals time spent in form (max 30 seconds). Attacking causes a 30-second cooldown. +5% Sentinel attack Damage.",
        "Cooldown after leaving grows with the energy spent in the form (min 10, max 30 seconds). +5% Sentinel attack Damage.",
      ],
      [
        "Reduced bekleme 30 saniye. +5% nobetci saldiri hasar.",
        "Formdan sonraki bekleme, formda harcanan enerjiyle artar (en az 10, en fazla 30 saniye). +5% nobetci saldiri hasar.",
      ],
      [
        "Formdan cikinca baslayan 30 saniyelik bekleme. +5% nobetci saldiri hasar.",
        "Formdan sonraki bekleme, formda harcanan enerjiyle artar (en az 10, en fazla 30 saniye). +5% nobetci saldiri hasar.",
      ],
      [
        "Formdan sonraki bekleme, formda gecirilen sure kadardir; en fazla 30 saniye. +5% nobetci saldiri hasar.",
        "Formdan sonraki bekleme, formda harcanan enerjiyle artar (en az 10, en fazla 30 saniye). +5% nobetci saldiri hasar.",
      ],
      [
        "Hic saldiri yapilmazsa formdan sonraki bekleme, formda gecirilen sure kadardir (en fazla 30 saniye). Saldiri yapmak 30 saniye bekleme uygular. +5% nobetci saldiri hasar.",
        "Formdan sonraki bekleme, formda harcanan enerjiyle artar (en az 10, en fazla 30 saniye). +5% nobetci saldiri hasar.",
      ],
      ["(max 30 seconds)", "(min 10, max 30 seconds)"],
      ["(en fazla 30 saniye)", "(en az 10, en fazla 30 saniye)"],
    ],
  ],
]);

function cloneStats(): PatchStats {
  return { ...EMPTY_STATS };
}

function mergeStats(...stats: PatchStats[]): PatchStats {
  return stats.reduce(
    (merged, item) => ({
      powerBlocks: merged.powerBlocks + item.powerBlocks,
      changes: merged.changes + item.changes,
    }),
    cloneStats(),
  );
}

function replaceTag(block: string, tag: string, value: string, stats: PatchStats): string {
  const expected = `<${tag}>${value}</${tag}>`;
  const pattern = new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`);
  if (!pattern.test(block)) {
    return block;
  }

  return block.replace(pattern, (match: string) => {
    if (match === expected) {
      return match;
    }
    stats.changes += 1;
    return expected;
  });
}

export function patchSentinelFormCooldowns(xml: string): { xml: string; stats: PatchStats } {
  const stats = cloneStats();
  const patched = xml.replace(/<Power PowerName="([^"]+)">[\s\S]*?<\/Power>/g, (block: string, powerName: string) => {
    const tooltips = SENTINEL_TOOLTIPS.get(powerName);
    if (!SENTINEL_FORM_POWERS.has(powerName) && !tooltips) {
      return block;
    }

    let next = block;
    if (SENTINEL_FORM_POWERS.has(powerName)) {
      stats.powerBlocks += 1;
      next = replaceTag(next, "CoolDownTime", COOLDOWN_MS, stats);
    }
    for (const [from, to] of tooltips ?? []) {
      if (!next.includes(from)) {
        continue;
      }
      stats.changes += 1;
      next = next.split(from).join(to);
    }
    return next;
  });

  return { xml: patched, stats };
}

function patchFile(filePath: string, verifyOnly: boolean): PatchStats {
  const original = fs.readFileSync(filePath, "utf8");
  const patched = patchSentinelFormCooldowns(original);
  if (!verifyOnly && patched.xml !== original) {
    fs.writeFileSync(filePath, patched.xml, "utf8");
  }
  return patched.stats;
}

function patchSwz(swzPath: string, verifyOnly: boolean): PatchStats {
  const ctx = parseSwz(swzPath);
  const chunk = ctx.chunks.find((entry) => entry.xml.includes("<PlayerPowerTypes"));
  if (!chunk) {
    return cloneStats();
  }

  const patched = patchSentinelFormCooldowns(chunk.xml);
  if (!verifyOnly && patched.xml !== chunk.xml) {
    chunk.xml = patched.xml;
    ensureBackup(swzPath);
    writeSwz(ctx);
  }

  return patched.stats;
}

export function patchConfiguredSentinelFormCooldown(verifyOnly: boolean): PatchStats {
  const swzPaths = ["Game.swz", "Game.en.swz", "Game.tr.swz"]
    .map((fileName) => path.join(CBQ_DIR, fileName))
    .filter(fs.existsSync);

  return mergeStats(patchFile(POWER_XML, verifyOnly), ...swzPaths.map((swzPath) => patchSwz(swzPath, verifyOnly)));
}

function main(): number {
  const verifyOnly = process.argv.includes("--verify") || process.argv.includes("--dry-run");
  try {
    const stats = patchConfiguredSentinelFormCooldown(verifyOnly);
    console.log(JSON.stringify({ verifyOnly, stats }, null, 2));
    console.log(stats.changes === 0 ? "No changes needed." : verifyOnly ? "Patch required." : "Patch apply complete.");
    return verifyOnly && stats.changes > 0 ? 1 : 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[patch_gameswz_sentinel_form_cooldown] ${message}`);
    return 1;
  }
}

if (require.main === module) {
  process.exit(main());
}
