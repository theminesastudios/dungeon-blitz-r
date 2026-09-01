import type { RogueGearRuneEffect } from "./rogueGearRuneEffects";

export const PALADIN_GEAR_EFFECT_PROPERTY = "SpawnLimit";

export const SHOCKWAVE_DEFENSE_BUFF = "GearShockwaveDefense";

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
};

const SHOCKWAVE_BUFF_XML = [
  `\t<BuffType BuffName="${SHOCKWAVE_DEFENSE_BUFF}">`,
  "\t\t<BuffID>749</BuffID>",
  "\t\t<Attack>false</Attack>",
  "\t\t<Duration>5000</Duration>",
  "\t\t<MagicDefense>0.3</MagicDefense>",
  "\t\t<MeleeDefense>0.3</MeleeDefense>",
  "\t\t<GfxType/>",
  "\t</BuffType>",
].join("\n");

export function ensurePaladinGearBuffs(xml: string): { xml: string; changed: number } {
  const eol = xml.includes("\r\n") ? "\r\n" : "\n";
  const expected = SHOCKWAVE_BUFF_XML.replace(/\n/g, eol);
  const pattern = new RegExp(`\\t<BuffType BuffName="${SHOCKWAVE_DEFENSE_BUFF}">[\\s\\S]*?</BuffType>`);
  const current = xml.match(pattern)?.[0];
  if (current === expected) return { xml, changed: 0 };
  if (current) return { xml: xml.replace(pattern, expected), changed: 1 };
  const close = xml.lastIndexOf("</PlayerBuffTypes>");
  if (close < 0) throw new Error("No </PlayerBuffTypes> close tag.");
  return { xml: `${xml.slice(0, close)}${expected}${eol}${xml.slice(close)}`, changed: 1 };
}

export function paladinGearRuneEffect(powerName: string): RogueGearRuneEffect | undefined {
  return PALADIN_GEAR_RUNE_EFFECTS[powerName];
}
