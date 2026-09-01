import type { RogueGearRuneEffect } from "./rogueGearRuneEffects";

// These powers do not spawn entities, so SpawnLimit is used only as a numeric runtime marker.
export const MAGE_GEAR_EFFECT_PROPERTY = "SpawnLimit";

export type MageGearRuneEffect = RogueGearRuneEffect;

export const MAGE_GEAR_RUNE_EFFECTS: Readonly<Record<string, MageGearRuneEffect>> = {
  FrozenWard: {
    kind: "power",
    property: "AddTargetBuff",
    value: "Append:Chilblains",
    description: "Frozen Ward adds 1 stack of Chilblains",
    tr: "Donmus Muhafiz 1 Soguk Yarasi yigi ekler.",
  },
  FrostBlast: {
    kind: "conditional",
    marker: 11,
    description: "+15% Arctic Blast damage vs Frozen/Rooted",
    tr: "Arktik Patlama Donmus veya Koklenmis hedeflere %15 fazla hasar verir.",
  },
  FrigidComet: {
    kind: "conditional",
    marker: 12,
    description: "+1% Frigid Comet damage per Chilblains stack",
    tr: "Soguk Kuyruklu Yildiz her Soguk Yarasi yigi basina %1 fazla hasar verir.",
  },
  BitterBlade: {
    kind: "conditional",
    marker: 13,
    description: "+1% Bitter Blade damage per Chilblains stack",
    tr: "Aci Kilic her Soguk Yarasi yigi basina %1 fazla hasar verir.",
  },
  Avalanche: {
    kind: "conditional",
    marker: 14,
    description: "Frost Spire casts in both directions",
    tr: "Buz Kulesi iki yone birden uygulanir.",
  },
  GlacialSpear: {
    kind: "conditional",
    marker: 15,
    description: "+10% Glacial Spear damage vs Frozen/Rooted",
    tr: "Buzul Mizrak Donmus veya Koklenmis hedeflere %10 fazla hasar verir.",
  },
  FlameSpout: {
    kind: "conditional",
    marker: 16,
    description: "+1% Inferno damage per Burn stack",
    tr: "Cehennem Atesi her Yanma yigi basina %1 fazla hasar verir.",
  },
  IridescentBurst: {
    kind: "damage",
    pct: 0.1,
    description: "+10% Iridescent Burst damage",
    tr: "Yanardoner Patlama hasari %10 artar.",
  },
  FlameStrike: {
    kind: "damage",
    pct: 0.2,
    targetBase: "FireFieldTrail",
    description: "+20% Conflagration trail DoT damage",
    tr: "Tutuşma izi zamanla hasari %20 artar.",
  },
  FireStorm: {
    kind: "conditional",
    marker: 17,
    description: "+1% Molten Rain damage per Burn stack",
    tr: "Erimis Yagmur her Yanma yigi basina %1 fazla hasar verir.",
  },
  MoltenFistExplode: {
    kind: "damage",
    pct: 0.15,
    description: "+15% Molten Fist damage",
    tr: "Erimis Yumruk hasari %15 artar.",
  },
  FireBrandShot: {
    kind: "buff",
    buffNames: ["FireBrand", "FireBrandRank1", "FireBrandRank3", "FireBrandRank6", "FireBrandRank8"],
    properties: [{ name: "Duration", value: 3000 }],
    description: "+3 second Firebrand duration",
    tr: "Ates Damgasi suresi 3 saniye artar.",
  },
  Desecrate: {
    kind: "conditional",
    marker: 18,
    description: "+10% Desecrate damage vs Poison/Plague",
    tr: "Kutsala Saygisizlik Zehir/Veba hedeflerine %10 fazla hasar verir.",
  },
  Lifethirst: {
    kind: "power",
    property: "AddTargetBuff",
    value: "Append:PoisonCloud",
    description: "Lifethirst adds 1 stack of Poison",
    tr: "Yasam Susuzlugu 1 Zehir yigi ekler.",
  },
  SpectralGrasp: {
    kind: "damage",
    pct: 0.15,
    description: "+15% Spectral Grasp damage",
    tr: "Hayalet Pençesi hasari %15 artar.",
  },
  Infestation: {
    kind: "buff",
    buffNames: ["Infested1", "Infested2", "Infested3"],
    properties: [{ name: "Duration", value: 2000 }],
    description: "+2 second Infestation duration",
    tr: "Istila suresi 2 saniye artar.",
  },
  BansheeWail: {
    kind: "conditional",
    marker: 19,
    description: "+10% Wail damage vs Poison/Plague",
    tr: "Banshee Cigligi Zehir/Veba hedeflerine %10 fazla hasar verir.",
  },
  DeathMark: {
    kind: "power",
    property: "SpawnDuration",
    value: "3000",
    description: "+3 second Death Mark duration",
    tr: "Olum Isareti suresi 3 saniye artar.",
  },
};

export function mageGearRuneEffect(powerName: string): MageGearRuneEffect | undefined {
  return MAGE_GEAR_RUNE_EFFECTS[powerName];
}
