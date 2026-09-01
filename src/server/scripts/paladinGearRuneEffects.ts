import type { RogueGearRuneEffect } from "./rogueGearRuneEffects";

export const PALADIN_GEAR_EFFECT_PROPERTY = "SpawnLimit";

export const SHOCKWAVE_DEFENSE_BUFF = "GearShockwaveDefense";
export const LIGHTNING_STORM_DEFENSE_BUFF = "GearLightningStormDefense";

export const PALADIN_GEAR_RUNE_EFFECTS: Readonly<Record<string, RogueGearRuneEffect>> = {
  ShieldFlurryStrike: {
    kind: "power",
    property: "AddTargetBuff",
    value: "Append:ArmorBane",
    description: "Shield Flurry adds Armor Bane",
    tr: "Kalkan Saldirisi Zirh Kiran ekler.",
  },
  RollingSmash: {
    kind: "conditional",
    marker: 20,
    description: "+10% Holy Smash damage vs Staggered",
    tr: "Kutsal Darbe Sendelenmis hedeflere %10 fazla hasar verir.",
  },
  JuggernautCharge: {
    kind: "power",
    property: "AddTargetBuff",
    value: "Append:Weakened",
    description: "Juggernaut adds Weaken",
    tr: "Ezici Guc Zayiflatma ekler.",
  },
  SecondWind: {
    kind: "buffEntries",
    entries: [
      { buffName: "SecondWind", property: "DoTDamage", value: -1.47 },
      { buffName: "SecondWind1", property: "DoTDamage", value: -1.05 },
      { buffName: "SecondWind2", property: "DoTDamage", value: -1.2 },
      { buffName: "SecondWind3", property: "DoTDamage", value: -1.35 },
      { buffName: "SecondWind4", property: "DoTDamage", value: -1.5 },
      { buffName: "SecondWind6", property: "DoTDamage", value: -1.6125 },
      { buffName: "SecondWind7", property: "DoTDamage", value: -1.6725 },
      { buffName: "SecondWind8", property: "DoTDamage", value: -1.7625 },
      { buffName: "SecondWind9", property: "DoTDamage", value: -1.845 },
    ],
    description: "+15% Second Wind healing power",
    tr: "Ikinci Nefes iyilestirme gucu %15 artar.",
  },
  Shockwave: {
    kind: "power",
    property: "AddSelfBuff",
    value: `Append:${SHOCKWAVE_DEFENSE_BUFF}`,
    description: "+30% Shockwave defense boost",
    tr: "Sok Dalgasi savunmayi %30 artirir.",
  },
  Retribution: {
    kind: "conditional",
    marker: 5,
    description: "+5 Retribution maximum hits",
    tr: "Intikam azami vurus sayisini 5 artirir.",
  },
  FlameAxe: {
    kind: "conditional",
    marker: 21,
    description: "+15% Flame Axe damage vs Ignited",
    tr: "Alev Baltasi Tutusturulmus hedeflere %15 fazla hasar verir.",
  },
  FuriousAssault: {
    kind: "conditional",
    marker: 22,
    description: "+10% Furious Assault damage vs Ignited",
    tr: "Ofkeli Saldiri Tutusturulmus hedeflere %10 fazla hasar verir.",
  },
  JusticeFist: {
    kind: "conditional",
    marker: 22,
    description: "+10% Justice Fist damage vs Ignited",
    tr: "Adalet Yumrugu Tutusturulmus hedeflere %10 fazla hasar verir.",
  },
  Harm: {
    kind: "power",
    property: "AddTargetBuff",
    value: "Append:Ignite",
    description: "Harm adds 1 stack of Ignite",
    tr: "Zarar 1 Tutusturma yiggini ekler.",
  },
  LightningStorm: {
    kind: "power",
    property: "AddSelfBuff",
    value: `Append:${LIGHTNING_STORM_DEFENSE_BUFF}`,
    description: "+20% Lightning Storm defense boost",
    tr: "Simsek Firtinasi savunmayi %20 artirir.",
  },
  CleavingBlows: {
    kind: "buff",
    buffNames: ["HeavyBlows"],
    properties: [{ name: "Duration", value: 3000 }],
    description: "+3 second Cleaving Blows duration",
    tr: "Yaran Darbeler suresi 3 saniye artar.",
  },
  Subjugate: {
    kind: "conditional",
    marker: 23,
    description: "+15% Subjugate damage vs blind/holy",
    tr: "Boyun Egdirme Kor veya Kutsal Ates altindaki hedeflere %15 fazla hasar verir.",
  },
  DivineWord: {
    kind: "power",
    property: "AddTargetBuff",
    value: "Append:HolyFire1",
    description: "Divine Word adds 1 stack of Holy Fire",
    tr: "Ilahi Soz 1 Kutsal Ates yiggini ekler.",
  },
  Penance: {
    kind: "conditional",
    marker: 24,
    description: "+10% Penance damage vs blind/holy",
    tr: "Kefaret Kor veya Kutsal Ates altindaki hedeflere %10 fazla hasar verir.",
  },
  FountainOfLife: {
    kind: "damage",
    pct: 0.1,
    description: "+10% Hallowed Reckoning healing power",
    tr: "Kutsal Hesaplasma iyilestirme gucu %10 artar.",
  },
  CelestialLance: {
    kind: "conditional",
    marker: 23,
    description: "+15% Celestial Lance damage vs blind/holy",
    tr: "Semavi Mizrak Kor veya Kutsal Ates altindaki hedeflere %15 fazla hasar verir.",
  },
  VerdictROR: {
    kind: "power",
    property: "RecoverTime",
    value: "-25",
    powerBases: ["VerdictROR", "VerdictMelee"],
    description: "+5% Verdict attack speed",
    tr: "Hukum saldiri hizi %5 artar.",
  },
};

const GEAR_DEFENSE_BUFFS = [
  { name: SHOCKWAVE_DEFENSE_BUFF, id: 749, defense: 0.3 },
  { name: LIGHTNING_STORM_DEFENSE_BUFF, id: 750, defense: 0.2 },
] as const;

function defenseBuffXml(name: string, id: number, defense: number): string {
  return [
    `\t<BuffType BuffName="${name}">`,
    `\t\t<BuffID>${id}</BuffID>`,
    "\t\t<Attack>false</Attack>",
    "\t\t<Duration>5000</Duration>",
    `\t\t<MagicDefense>${defense}</MagicDefense>`,
    `\t\t<MeleeDefense>${defense}</MeleeDefense>`,
    "\t\t<GfxType/>",
    "\t</BuffType>",
  ].join("\n");
}

export function ensurePaladinGearBuffs(xml: string): { xml: string; changed: number } {
  const eol = xml.includes("\r\n") ? "\r\n" : "\n";
  let updated = xml;
  let changed = 0;
  for (const buff of GEAR_DEFENSE_BUFFS) {
    const expected = defenseBuffXml(buff.name, buff.id, buff.defense).replace(/\n/g, eol);
    const pattern = new RegExp(`\\t<BuffType BuffName="${buff.name}">[\\s\\S]*?</BuffType>`);
    const current = updated.match(pattern)?.[0];
    if (current === expected) continue;
    if (current) updated = updated.replace(pattern, expected);
    else {
      const close = updated.lastIndexOf("</PlayerBuffTypes>");
      if (close < 0) throw new Error("No </PlayerBuffTypes> close tag.");
      updated = `${updated.slice(0, close)}${expected}${eol}${updated.slice(close)}`;
    }
    changed += 1;
  }
  return { xml: updated, changed };
}

export function paladinGearRuneEffect(powerName: string): RogueGearRuneEffect | undefined {
  return PALADIN_GEAR_RUNE_EFFECTS[powerName];
}
