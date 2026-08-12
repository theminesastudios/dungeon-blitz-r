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
const FIRST_MINION_BUFF_ID = 753;
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

/**
 * The horde's own buff, and the reason it is a second BuffType rather than the one the caster
 * gets: Call the Horde raises melee minions. They have no ranged attack at all, so handing their
 * buff a RangedOverride did not decorate an existing bolt -- it gave a melee-only minion a bolt it
 * never had, which is why the horde was seen lobbing plague. AddSelfBuff and AddTargetBuff are
 * separate fields, so the caster can keep both overrides while the horde gets melee only.
 */
function minionBuffBlock(rank: number): string {
  return [
    `\t<BuffType BuffName="PlagueBattalionMinion${rank}">`,
    `\t\t<BuffID>${FIRST_MINION_BUFF_ID + rank - 1}</BuffID>`,
    "\t\t<Attack>false</Attack>",
    "\t\t<Duration>10000</Duration>",
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
    // A faithful LichShot clone, because that is the shot this replaces: same ProjectileCombo
    // targeting, same mana return, same NecroBolt art, and MinorCurse kept alongside the plague
    // so overriding the shot does not quietly cost the Necromancer its third-shot debuff. Only
    // the caster ever holds this -- the horde's buff has no ranged override.
    "\t\t<TargetMethod>ProjectileCombo</TargetMethod>",
    "\t\t<CastAnim>Shoot</CastAnim>",
    "\t\t<CastTime>0</CastTime>",
    "\t\t<RecoverTime>500</RecoverTime>",
    "\t\t<ManaCost>0,5</ManaCost>",
    "\t\t<BaseDamageMult>1</BaseDamageMult>",
    "\t\t<ProcModifier>1</ProcModifier>",
    "\t\t<DamageType>Dark</DamageType>",
    "\t\t<PowerGroup>PlagueBattalion</PowerGroup>",
    `\t\t<AddTargetBuff>MinorCurse,Plagued${rank}</AddTargetBuff>`,
    "\t\t<BasePowerName>PlagueBattalionROR</BasePowerName>",
    "\t\t<Description>Plague Battalion ranged override power. [Stats: x1 damage plus Plague]</Description>",
    // LichShot's own art, so the caster's shot still reads as a Lich Shot. Emptying ProjGfx to
    // change how it looked is what stopped Game.swz loading: of the 1711 authored powers not one
    // projectile entry ships an empty <ProjGfx/>. The tag is required; the art is how you change
    // the look.
    "\t\t<CastSound>snd_pwr_range_poison_shoot_01</CastSound>",
    "\t\t<CastGfx/>",
    "\t\t<FireSound>snd_pwr_range_poison_imp</FireSound>",
    "\t\t<FireGfx>",
    "\t\t\t<AnimFile>SFX_1.swf</AnimFile>",
    "\t\t\t<AnimClass>a_NecroBolt_Impact</AnimClass>",
    "\t\t\t<AnimScale>.7</AnimScale>",
    "\t\t\t<FireAndForget>true</FireAndForget>",
    "\t\t</FireGfx>",
    "\t\t<HitGfx/>",
    "\t\t<ProjGfx>",
    "\t\t\t<AnimFile>SFX_1.swf</AnimFile>",
    "\t\t\t<AnimClass>a_NecroBolt_Hand,a_NecroBolt_Face</AnimClass>",
    "\t\t\t<AnimScale>.7</AnimScale>",
    "\t\t\t<FireAndForget>FALSE</FireAndForget>",
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
          // The horde gets the melee-only buff, the caster keeps the one with both overrides.
          // Repeat counts and the PlagueStackLimit companion stay exactly as authored.
          const replacement =
            tag === "AddTargetBuff" ? `PlagueBattalionMinion${rank}` : `PlagueBattalion${rank}`;
          const next = list
            .split(",")
            .map((entry) => {
              const trimmed = entry.trim();
              return /^PlagueBattalion(?:Minion)?\d*$/.test(trimmed) ? replacement : trimmed;
            })
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

  // Drop any blocks a previous run wrote before re-inserting, so the generators above stay the
  // single source of truth and a changed block (the projectile art, say) actually converges
  // instead of being skipped as "already present".
  const stale = new RegExp(
    `\\n?\\t<Power PowerName="PlagueBattalion(?:Melee|ROR)\\d+">[\\s\\S]*?<\\/Power>`,
    "g",
  );
  const withoutStale = next.replace(stale, "");
  const inserts = RANKS.map((rank) => `${meleePowerBlock(rank)}\n${rangedPowerBlock(rank)}`).join("\n");
  const closing = "</PlayerPowerTypes>";
  if (!withoutStale.includes(closing)) {
    throw new Error("PlayerPowerTypes.xml has no closing tag to insert before.");
  }
  const rebuilt = withoutStale.replace(closing, `${inserts}\n${closing}`);
  if (rebuilt !== next) {
    changes += RANKS.length * 2;
  }
  next = rebuilt;

  const repointed = repointPowerBuffLists(next);
  return { xml: repointed.xml, changes: changes + repointed.changes };
}

/**
 * One stack of Plague on a target, not four.
 *
 * Plagued1..10 author StackCount 4 and rank 1's UpgradeDescription still says "Place up to four
 * stacks of Plague", so four was the authors' intent -- but nothing had ever applied a single one
 * of them, so that intent had never actually been played. With the horde applying it on every
 * swing and every bolt, four stacks per target landed far above the rest of the kit. Capped at
 * one by product decision; the authored text is left alone so the original intent stays visible.
 */
function capPlagueStacks(xml: string): { xml: string; changes: number } {
  let changes = 0;
  const patched = xml.replace(
    /<BuffType BuffName="Plagued\d+">[\s\S]*?<\/BuffType>/g,
    (block: string) =>
      block.replace(/<StackCount>([^<]*)<\/StackCount>/, (match: string, value: string) => {
        if (value.trim() === "1") {
          return match;
        }
        changes += 1;
        return "<StackCount>1</StackCount>";
      }),
  );
  return { xml: patched, changes };
}

export function patchPlayerBuffTypes(xml: string): { xml: string; changes: number } {
  let next = xml;
  let changes = 0;

  const capped = capPlagueStacks(next);
  next = capped.xml;
  changes += capped.changes;

  // Same rewrite-rather-than-skip rule as the powers, so a changed block converges.
  const staleBuffs = new RegExp(
    `\\n?\\t<BuffType BuffName="PlagueBattalion(?:Minion)?\\d+">[\\s\\S]*?<\\/BuffType>`,
    "g",
  );
  const withoutStaleBuffs = next.replace(staleBuffs, "");
  const buffClosing = "</PlayerBuffTypes>";
  if (!withoutStaleBuffs.includes(buffClosing)) {
    throw new Error("PlayerBuffTypes.xml has no closing tag to insert before.");
  }
  const buffBlocks = [...RANKS.map(buffBlock), ...RANKS.map(minionBuffBlock)].join("\n");
  const rebuiltBuffs = withoutStaleBuffs.replace(buffClosing, `${buffBlocks}\n${buffClosing}`);
  if (rebuiltBuffs !== next) {
    changes += RANKS.length * 2;
  }
  next = rebuiltBuffs;

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
