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
};

export function mageGearRuneEffect(powerName: string): MageGearRuneEffect | undefined {
  return MAGE_GEAR_RUNE_EFFECTS[powerName];
}
