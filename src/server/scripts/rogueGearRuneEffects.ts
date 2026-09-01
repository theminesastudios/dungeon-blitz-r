// Conditional skills do not spawn entities, so SpawnLimit is a harmless numeric marker that the
// existing PowerMod runtime already knows how to store and expose without adding a new SWF string.
export const ROGUE_GEAR_EFFECT_PROPERTY = "SpawnLimit";

export type RogueGearRuneEffect =
  | { kind: "conditional"; marker: number; description: string; tr: string }
  | { kind: "damage"; pct: number; targetBase?: string; description: string; tr: string }
  | { kind: "power"; property: string; value: string; powerBases?: string[]; description: string; tr: string }
  | {
      kind: "buffEntries";
      entries: Array<{ buffName: string; property: string; value: number }>;
      description: string;
      tr: string;
    }
  | {
      kind: "buff";
      buffNames: string[];
      properties: Array<{ name: string; value: number }>;
      description: string;
      tr: string;
    };

const TENDRIL_BUFFS = [
  "ShadowTendril",
  "ShadowTendrilRank1",
  "ShadowTendrilRank4",
  "ShadowTendrilRank6",
  "ShadowTendrilRank8",
  "ShadowTendrilRank10",
];

/**
 * First staged Rogue effect batch shared by the Legendary and Mystic generators.
 * Skills absent from this table retain their existing generic damage bonus.
 */
export const ROGUE_GEAR_RUNE_EFFECTS: Readonly<Record<string, RogueGearRuneEffect>> = {
  WitherStrike: {
    kind: "power",
    property: "AddTargetBuff",
    value: "Append:Bleeding,Append:Bleeding",
    description: "Withering Impact adds 2 stacks of Bleed",
    tr: "Soldurucu Darbe 2 Kanama yigi ekler.",
  },
  SeverStrike: {
    kind: "conditional",
    marker: 1,
    description: "+10% Severing Strike damage vs Poison/Hemo",
    tr: "Koparan Vurus Zehirlenmis veya Kanamali hedeflere %10 fazla hasar verir.",
  },
  DaggerFlurry: {
    kind: "damage",
    pct: 0.15,
    description: "+15% Flurry of Daggers damage",
    tr: "Hancer Yagmuru hasari %15 artar.",
  },
  VitalStrike: {
    kind: "conditional",
    marker: 2,
    description: "+15% Shadow Rend damage vs Poison/Hemo",
    tr: "Golge Parcalayis Zehirlenmis veya Kanamali hedeflere %15 fazla hasar verir.",
  },
  AssassinateClose: {
    kind: "conditional",
    marker: 1,
    description: "+10% Vicious Assault damage vs Poison/Hemo",
    tr: "Vahsi Saldiri Zehirlenmis veya Kanamali hedeflere %10 fazla hasar verir.",
  },
  DeathBlowOld: {
    kind: "power",
    property: "AddTargetBuff",
    value: "Append:Bleeding,Append:Bleeding",
    description: "Assassinate adds 2 stacks of Bleed",
    tr: "Suikast 2 Kanama yigi ekler.",
  },
  CrippleStrike: {
    kind: "conditional",
    marker: 4,
    description: "+15% Scorpion Sting damage vs Bind",
    tr: "Akrep Sokmasi Baglanmis hedeflere %15 fazla hasar verir.",
  },
  HeartSeeker: {
    kind: "conditional",
    marker: 6,
    description: "+10% Heart Seeker damage while Stealthed",
    tr: "Gizliyken Kalp Avcisi hasari %10 artar.",
  },
  WhitheringMist: {
    kind: "conditional",
    marker: 5,
    description: "+10% Withering Mist damage vs Bind",
    tr: "Soldurucu Sis Baglanmis hedeflere %10 fazla hasar verir.",
  },
  ShadowTendrilDash: {
    kind: "buff",
    buffNames: TENDRIL_BUFFS,
    properties: [{ name: "Duration", value: 3000 }],
    description: "+3 second Black Miasma tendril duration",
    tr: "Kara Miyazma dokunac suresi 3 saniye artar.",
  },
  BlackStorm: {
    kind: "conditional",
    marker: 7,
    description: "+15% Black Storm damage while Stealthed",
    tr: "Gizliyken Kara Firtina hasari %15 artar.",
  },
  DarkChi: {
    kind: "conditional",
    marker: 5,
    description: "+10% Dark Chi damage vs Bind",
    tr: "Kara Chi Baglanmis hedeflere %10 fazla hasar verir.",
  },
  FatiguingStrike: {
    kind: "power",
    property: "AddTargetBuff",
    value: "Append:ArmorBane",
    description: "Hex Blade adds Armor Bane",
    tr: "Buyulu Kilic Zirh Felaketi ekler.",
  },
  Devour: {
    kind: "conditional",
    marker: 4,
    description: "+15% Devour damage vs Bind",
    tr: "Yutma Baglanmis hedeflere %15 fazla hasar verir.",
  },
  ChaosArmor: {
    kind: "damage",
    pct: 0.1,
    description: "+10% Chaos Wave damage",
    tr: "Kaos Dalgasi hasari %10 artar.",
  },
  PainBender: {
    kind: "power",
    property: "AddTargetBuff",
    value: "Append:Bound",
    description: "Butcher's Boon adds 1 stack of Bind",
    tr: "Kasabin Lutfu 1 Baglama yigi ekler.",
  },
  PoisonLance: {
    kind: "buff",
    buffNames: [
      "DashArmor10",
      "DashArmor25",
      "DashArmor45",
      "DashArmor50",
      "DashArmor55",
      "DashArmor60",
      "DashArmor65",
      "DashArmor75",
    ],
    properties: [
      { name: "MagicDefense", value: 0.15 },
      { name: "MeleeDefense", value: 0.15 },
    ],
    description: "Necrotic Surge +15% defense while dashing",
    tr: "Nekrotik Dalga atilirken savunmayi %15 artirir.",
  },
  Reaper: {
    kind: "conditional",
    marker: 5,
    description: "+10% Shadow Scythe damage vs Bind",
    tr: "Golge Tirpani Baglanmis hedeflere %10 fazla hasar verir.",
  },
};

export function rogueGearRuneEffect(powerName: string): RogueGearRuneEffect | undefined {
  return ROGUE_GEAR_RUNE_EFFECTS[powerName];
}
