import * as fs from "fs";
import * as path from "path";
import { ensureBackup, parseSwz, writeSwz } from "./swzPatchUtils";

/**
 * Plague Battalion never put its poison on anything (issue #668).
 *
 * The power reads correctly at a glance: TargetMethod UndeadPet, AoERadius 800, and
 * `AddTargetBuff>PlagueBattalion` on every rank, so the horde does receive a buff and the
 * a_LeechAura visual does play on each minion. What the buff has is a Duration and a GfxType and
 * nothing else -- no MeleeOverride, no RangedOverride -- so carrying it changes nothing about what
 * the minion's next swing or bolt does. That is exactly the report: the aura appears on the
 * minions, the hit lands, and no Poison is ever applied, on the boss or on anything else.
 *
 * The poison the description promises is authored and orphaned. Plagued1..10 exist with per-rank
 * DoTDamage (2.5 climbing to 3.3), Effect Poisoned and StackCount 4, and PowerModTypes lists them
 * among the poison buffs its talent stones scale -- but no power in the file applies any of them.
 * Nothing had to break for this to be dead; the wiring was never authored.
 *
 * A buff changing what its carrier attacks with is a well-worn shape here: 117 override pairs
 * already resolve, and Verdict1 is the same case rank for rank -- a ranked buff pointing at
 * VerdictMelee<n>/VerdictROR<n>, each a copy of the basic attack carrying BaseDamageMult 1 plus
 * the effect the buff is for. That is the template this follows, so the minion keeps its normal
 * damage and gains the poison rather than trading one for the other.
 *
 * Ranked buffs are the reason this inserts ten of them rather than editing the one that exists.
 * The single unranked PlagueBattalion buff cannot name a rank-specific override, and the poison
 * is rank-scaled; Verdict solves it the same way. The unranked buff still gets the rank-1 pair so
 * the rank-0 path is not left dead.
 *
 * The repeat counts in the power's own buff lists are preserved exactly as authored -- ranks 8-10
 * apply their buff three times where ranks 1-7 apply it once. Whatever that repetition means for
 * charges, it is the authors' and this change does not reinterpret it.
 */

const XML_DIR = path.resolve(__dirname, "..", "..", "client", "content", "xml");
const CBQ_DIR = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p", "cbq");

const RANKS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const FIRST_BUFF_ID = 743;
const FIRST_MELEE_POWER_ID = 7019;
const FIRST_ROR_POWER_ID = 7029;

function buffBlock(rank: number): string {
  return [
    `\t<BuffType BuffName="PlagueBattalion${rank}">`,
    `\t\t<BuffID>${FIRST_BUFF_ID + rank - 1}</BuffID>`,
    "\t\t<Attack>false</Attack>",
    "\t\t<Duration>10000</Duration>",
    `\t\t<RangedOverride>PlagueBattalionROR${rank}</RangedOverride>`,
    `\t\t<MeleeOverride>PlagueBattalionMelee${rank}</MeleeOverride>`,
    "\t\t<GfxType>",
    "\t\t\t<AnimScale>1.5</AnimScale>",
    "\t\t\t<AnimFile>SFX_1.swf</AnimFile>",
    "\t\t\t<AnimClass>a_LeechAura</AnimClass>",
    "\t\t</GfxType>",
    "\t</BuffType>",
  ].join("\n");
}

function meleePowerBlock(rank: number): string {
  return [
    `\t<Power PowerName="PlagueBattalionMelee${rank}">`,
    `\t\t<PowerID>${FIRST_MELEE_POWER_ID + rank - 1}</PowerID>`,
    "\t\t<TargetMethod>MeleeCombo</TargetMethod>",
    "\t\t<Range>120</Range>",
    "\t\t<CastAnim>Melee</CastAnim>",
    "\t\t<CastTime>65</CastTime>",
    "\t\t<RecoverTime>435</RecoverTime>",
    "\t\t<ManaCost>0</ManaCost>",
    "\t\t<BaseDamageMult>1</BaseDamageMult>",
    "\t\t<ProcModifier>1</ProcModifier>",
    "\t\t<DamageType>Dark</DamageType>",
    "\t\t<PowerGroup>PlagueBattalion</PowerGroup>",
    `\t\t<AddTargetBuff>Plagued${rank}</AddTargetBuff>`,
    "\t\t<BasePowerName>PlagueBattalionMelee</BasePowerName>",
    "\t\t<Description>Plague Battalion melee override power [Stats: x1 damage plus Plague]</Description>",
    "\t\t<CastGfx/>",
    "\t\t<FireGfx/>",
    "\t\t<HitAnimSource>TargetCenter</HitAnimSource>",
    "\t\t<HitGfx>",
    "\t\t\t<AnimFile>SFX_1.swf</AnimFile>",
    "\t\t\t<AnimClass>a_MeleeHitReact</AnimClass>",
    "\t\t\t<AnimScale>0.48</AnimScale>",
    "\t\t\t<FireAndForget>TRUE</FireAndForget>",
    "\t\t</HitGfx>",
    "\t\t<ProjGfx/>",
    "\t</Power>",
  ].join("\n");
}

function rangedPowerBlock(rank: number): string {
  return [
    `\t<Power PowerName="PlagueBattalionROR${rank}">`,
    `\t\t<PowerID>${FIRST_ROR_POWER_ID + rank - 1}</PowerID>`,
    "\t\t<TargetMethod>ProjectilePlayer</TargetMethod>",
    "\t\t<AoERadius>100</AoERadius>",
    "\t\t<CastAnim>Shoot</CastAnim>",
    "\t\t<CastTime>0</CastTime>",
    "\t\t<RecoverTime>500</RecoverTime>",
    "\t\t<ManaCost>0</ManaCost>",
    "\t\t<BaseDamageMult>1</BaseDamageMult>",
    "\t\t<ProcModifier>1</ProcModifier>",
    "\t\t<DamageType>Dark</DamageType>",
    "\t\t<PowerGroup>PlagueBattalion</PowerGroup>",
    `\t\t<AddTargetBuff>Plagued${rank}</AddTargetBuff>`,
    "\t\t<BasePowerName>PlagueBattalionROR</BasePowerName>",
    "\t\t<Description>Plague Battalion ranged override power. [Stats: x1 damage plus Plague]</Description>",
    "\t\t<CastGfx/>",
    "\t\t<FireGfx>",
    "\t\t\t<AnimFile>SFX_1.swf</AnimFile>",
    "\t\t\t<AnimClass>a_LeechAura</AnimClass>",
    "\t\t\t<AnimScale>1</AnimScale>",
    "\t\t\t<FireAndForget>TRUE</FireAndForget>",
    "\t\t</FireGfx>",
    "\t\t<HitGfx/>",
    "\t\t<ProjGfx>",
    "\t\t\t<AnimFile>SFX_1.swf</AnimFile>",
    "\t\t\t<AnimClass>a_LeechAura</AnimClass>",
    "\t\t\t<AnimScale>0.8</AnimScale>",
    "\t\t\t<FireAndForget>false</FireAndForget>",
    "\t\t</ProjGfx>",
    "\t</Power>",
  ].join("\n");
}

/** Ranked casts must hand the horde the ranked buff, or the overrides above are never reached. */
function repointPowerBuffLists(xml: string): { xml: string; changes: number } {
  let changes = 0;
  const patched = xml.replace(
    /<Power PowerName="PlagueBattalion(\d+)">[\s\S]*?<\/Power>/g,
    (block: string, rank: string) => {
      return block.replace(
        /<(AddTargetBuff|AddSelfBuff)>([^<]*)<\/\1>/g,
        (match: string, tag: string, list: string) => {
          // Repeat counts and the PlagueStackLimit companion stay exactly as authored.
          const next = list
            .split(",")
            .map((entry) => (entry.trim() === "PlagueBattalion" ? `PlagueBattalion${rank}` : entry.trim()))
            .join(",");
          if (next === list) {
            return match;
          }
          changes += 1;
          return `<${tag}>${next}</${tag}>`;
        },
      );
    },
  );
  return { xml: patched, changes };
}

export function patchPlayerPowerTypes(xml: string): { xml: string; changes: number } {
  let next = xml;
  let changes = 0;

  if (!next.includes('<Power PowerName="PlagueBattalionMelee1">')) {
    const inserts = RANKS.map((rank) => `${meleePowerBlock(rank)}\n${rangedPowerBlock(rank)}`).join("\n");
    const closing = "</PlayerPowerTypes>";
    if (!next.includes(closing)) {
      throw new Error("PlayerPowerTypes.xml has no closing tag to insert before.");
    }
    next = next.replace(closing, `${inserts}\n${closing}`);
    changes += RANKS.length * 2;
  }

  const repointed = repointPowerBuffLists(next);
  return { xml: repointed.xml, changes: changes + repointed.changes };
}

export function patchPlayerBuffTypes(xml: string): { xml: string; changes: number } {
  let next = xml;
  let changes = 0;

  if (!next.includes('<BuffType BuffName="PlagueBattalion1">')) {
    const closing = "</PlayerBuffTypes>";
    if (!next.includes(closing)) {
      throw new Error("PlayerBuffTypes.xml has no closing tag to insert before.");
    }
    next = next.replace(closing, `${RANKS.map(buffBlock).join("\n")}\n${closing}`);
    changes += RANKS.length;
  }

  // The rank-0 buff keeps its own entry but stops being a dead end.
  next = next.replace(
    /<BuffType BuffName="PlagueBattalion">([\s\S]*?)<\/BuffType>/,
    (block: string, body: string) => {
      if (body.includes("MeleeOverride")) {
        return block;
      }
      changes += 1;
      return block.replace(
        "\t\t<GfxType>",
        [
          "\t\t<RangedOverride>PlagueBattalionROR1</RangedOverride>",
          "\t\t<MeleeOverride>PlagueBattalionMelee1</MeleeOverride>",
          "\t\t<GfxType>",
        ].join("\n"),
      );
    },
  );

  return { xml: next, changes };
}

function patchXmlFile(filePath: string, apply: (xml: string) => { xml: string; changes: number }, verifyOnly: boolean): number {
  const original = fs.readFileSync(filePath, "utf8");
  const patched = apply(original);
  if (!verifyOnly && patched.xml !== original) {
    fs.writeFileSync(filePath, patched.xml, "utf8");
  }
  return patched.changes;
}

function patchSwzFile(swzPath: string, verifyOnly: boolean): number {
  const ctx = parseSwz(swzPath);
  let changes = 0;
  let dirty = false;

  for (const [marker, apply] of [
    ["<PlayerPowerTypes", patchPlayerPowerTypes],
    ["<PlayerBuffTypes", patchPlayerBuffTypes],
  ] as const) {
    const chunk = ctx.chunks.find((entry) => entry.xml.includes(marker));
    if (!chunk) {
      continue;
    }
    const patched = apply(chunk.xml);
    changes += patched.changes;
    if (patched.xml !== chunk.xml) {
      chunk.xml = patched.xml;
      dirty = true;
    }
  }

  if (dirty && !verifyOnly) {
    ensureBackup(swzPath);
    writeSwz(ctx);
  }

  return changes;
}

export function patchPlagueBattalionOverrides(verifyOnly: boolean): number {
  let changes = 0;
  changes += patchXmlFile(path.join(XML_DIR, "PlayerPowerTypes.xml"), patchPlayerPowerTypes, verifyOnly);
  changes += patchXmlFile(path.join(XML_DIR, "PlayerBuffTypes.xml"), patchPlayerBuffTypes, verifyOnly);
  for (const fileName of ["Game.swz", "Game.en.swz", "Game.tr.swz"]) {
    const swzPath = path.join(CBQ_DIR, fileName);
    if (fs.existsSync(swzPath)) {
      changes += patchSwzFile(swzPath, verifyOnly);
    }
  }
  return changes;
}

if (require.main === module) {
  const verifyOnly = process.argv.includes("--verify");
  const changes = patchPlagueBattalionOverrides(verifyOnly);
  if (verifyOnly) {
    if (changes > 0) {
      console.error(`Plague Battalion override patch missing: ${changes} edit(s) outstanding.`);
      process.exit(1);
    }
    console.log("Plague Battalion overrides verified.");
  } else {
    console.log(`Plague Battalion overrides applied (${changes} edit(s)).`);
  }
}
