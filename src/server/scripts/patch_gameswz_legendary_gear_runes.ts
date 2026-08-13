import * as fs from "fs";
import * as path from "path";
import { ensureBackup, parseSwz, writeSwz } from "./swzPatchUtils";

type PatchResult = {
  xml: string;
  changes: number;
  matchedGearIds: Set<string>;
};

const XML_DIR = path.resolve(__dirname, "..", "..", "client", "content", "xml");
const CBQ_DIR = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p", "cbq");
const TARGET_GEAR_IDS = new Set(["1162", "1163", "1164"]);
const GEAR_RUNE_REWORK_IDS = new Set(["241", "247", "256", "518", "866"]);

function readTag(block: string, tag: string): string | null {
  return block.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1] ?? null;
}

function replaceTag(block: string, tag: string, expectedValue: string): { block: string; changed: boolean } {
  const tagPattern = new RegExp(`<${tag}>[^<]*</${tag}>`);
  const expectedTag = `<${tag}>${expectedValue}</${tag}>`;
  const currentTag = block.match(tagPattern)?.[0];

  if (!currentTag) {
    throw new Error(`Legendary target gear is missing <${tag}>.`);
  }
  if (currentTag === expectedTag) {
    return { block, changed: false };
  }

  return { block: block.replace(tagPattern, expectedTag), changed: true };
}

export function patchLegendaryGearRunes(xml: string): PatchResult {
  let changes = 0;
  const matchedGearIds = new Set<string>();
  const matchedReworkRarities = new Map<string, Set<string>>();
  const patchedXml = xml.replace(
    /<Gear\b[^>]*GearID="([^"]+)"[^>]*>[\s\S]*?<\/Gear>/g,
    (block: string, gearId: string) => {
      if (GEAR_RUNE_REWORK_IDS.has(gearId)) {
        matchedGearIds.add(gearId);
        const rarity = readTag(block, "Rarity");
        if (rarity) {
          const rarities = matchedReworkRarities.get(gearId) ?? new Set<string>();
          rarities.add(rarity);
          matchedReworkRarities.set(gearId, rarities);
        }
        if (gearId === "241") {
          const gearFindRune = replaceTag(block, "MagicRune", rarity === "M" ? "ItemDrop" : "Speed+ItemDrop");
          changes += Number(gearFindRune.changed);
          return gearFindRune.block;
        }

        if (gearId === "247") {
          const movementRune = replaceTag(block, "MagicRune", rarity === "M" ? "Speed" : "Speed+ItemDrop");
          const healthRune = replaceTag(movementRune.block, "ProcRune", "HealthPercent");
          changes += Number(movementRune.changed) + Number(healthRune.changed);
          if (readTag(block, "Rarity") !== "L") {
            return healthRune.block;
          }

          const criticalPowerRune = replaceTag(healthRune.block, "ProcRune2", "CritDamage");
          changes += Number(criticalPowerRune.changed);
          return criticalPowerRune.block;
        }

        if (gearId === "518") {
          if (rarity !== "L") {
            return block;
          }

          const criticalChanceRune = replaceTag(block, "ProcRune2", "CritChance");
          changes += Number(criticalChanceRune.changed);
          return criticalChanceRune.block;
        }

        if (gearId === "866") {
          const gearFindRune = replaceTag(block, "MagicRune", rarity === "M" ? "ItemDrop" : "Speed+ItemDrop");
          const renewRune = replaceTag(gearFindRune.block, "ProcRune", "ProcHealTime");
          const balancedStat = replaceTag(renewRune.block, "StatRune", "MageBalanced");
          changes += Number(gearFindRune.changed) + Number(renewRune.changed) + Number(balancedStat.changed);
          const appearance = rarity === "M" ? {
            ColorSwap2: "0x80C0F0=0xFFF4CC",
            ColorSwap3: "0x0070E0=0xC3B78B",
            ColorSwap4: "0xFF9999=0x48EBEC",
            ColorSwap5: "0xB00000=0x00B1B2",
            ColorSwap6: "0x600000=0x00768F",
            ColorSwap7: "0xF0F0F0=0xAAC0C4",
            ColorSwap8: "0xCCCCCC=0x3E484A",
            ColorSwap9: "0xA5A5A5=0x1A1F20",
          } : rarity === "L" ? {
            ColorSwap2: "0x80C0F0=0xDFFEFF",
            ColorSwap3: "0x0070E0=0x88D2D4",
            ColorSwap4: "0xFF9999=0xDFFEFF",
            ColorSwap5: "0xB00000=0x26DADF",
            ColorSwap6: "0x600000=0x00969B",
            ColorSwap7: "0xF0F0F0=0xFFFFFF",
            ColorSwap8: "0xCCCCCC=0xFFE547",
            ColorSwap9: "0xA5A5A5=0xF29C00",
          } : null;
          let appearanceBlock = balancedStat.block;
          for (const [tag, value] of Object.entries(appearance ?? {})) {
            const colorSwap = replaceTag(appearanceBlock, tag, value);
            appearanceBlock = colorSwap.block;
            changes += Number(colorSwap.changed);
          }
          return appearanceBlock;
        }

        const movementRune = replaceTag(block, "MagicRune", rarity === "M" ? "ItemDrop" : "Speed+ItemDrop");
        const balancedStat = replaceTag(movementRune.block, "StatRune", "MageBalanced");
        changes += Number(movementRune.changed) + Number(balancedStat.changed);
        if (readTag(block, "Rarity") !== "L") {
          return balancedStat.block;
        }

        const attackSpeedRune = replaceTag(balancedStat.block, "ProcRune2", "Haste");
        changes += Number(attackSpeedRune.changed);
        return attackSpeedRune.block;
      }

      if (!TARGET_GEAR_IDS.has(gearId) || readTag(block, "Rarity") !== "L") {
        return block;
      }

      matchedGearIds.add(gearId);
      const healthRune = replaceTag(block, "ProcRune", "HealthPercent");
      const hasteRune = replaceTag(healthRune.block, "ProcRune2", "Haste");
      changes += Number(healthRune.changed) + Number(hasteRune.changed);
      return hasteRune.block;
    },
  );

  for (const gearId of TARGET_GEAR_IDS) {
    if (!matchedGearIds.has(gearId)) {
      throw new Error(`Legendary gear ${gearId} was not found in GearTypes data.`);
    }
  }
  for (const gearId of GEAR_RUNE_REWORK_IDS) {
    const rarities = matchedReworkRarities.get(gearId);
    for (const rarity of ["M", "R", "L"]) {
      if (!rarities?.has(rarity)) {
        throw new Error(`Gear rune rework ${gearId} rarity ${rarity} was not found in GearTypes data.`);
      }
    }
  }

  return { xml: patchedXml, changes, matchedGearIds };
}

function patchXmlFile(filePath: string, verifyOnly: boolean): number {
  const original = fs.readFileSync(filePath, "utf8");
  const patched = patchLegendaryGearRunes(original);
  if (!verifyOnly && patched.xml !== original) {
    fs.writeFileSync(filePath, patched.xml, "utf8");
  }
  return patched.changes;
}

function patchSwzFile(swzPath: string, verifyOnly: boolean): number {
  const ctx = parseSwz(swzPath);
  const gearTypesChunk = ctx.chunks.find((entry) => entry.xml.includes("<GearTypes"));
  if (!gearTypesChunk) {
    throw new Error(`${swzPath} does not contain GearTypes data.`);
  }

  const patched = patchLegendaryGearRunes(gearTypesChunk.xml);
  if (!verifyOnly && patched.xml !== gearTypesChunk.xml) {
    gearTypesChunk.xml = patched.xml;
    ensureBackup(swzPath);
    writeSwz(ctx);
  }
  return patched.changes;
}

export function patchConfiguredLegendaryGearRunes(verifyOnly: boolean): number {
  const swzPaths = ["Login.swz", "Login.en.swz", "Login.tr.swz"]
    .map((fileName) => path.join(CBQ_DIR, fileName))
    .filter(fs.existsSync);

  return patchXmlFile(path.join(XML_DIR, "GearTypes.xml"), verifyOnly) +
    swzPaths.reduce((total, swzPath) => total + patchSwzFile(swzPath, verifyOnly), 0);
}

function main(): number {
  const verifyOnly = process.argv.includes("--verify") || process.argv.includes("--dry-run");
  const changes = patchConfiguredLegendaryGearRunes(verifyOnly);
  console.log(JSON.stringify({ verifyOnly, changes }, null, 2));
  console.log(changes === 0 ? "No changes needed." : verifyOnly ? "Patch required." : "Patch apply complete.");
  return verifyOnly && changes > 0 ? 1 : 0;
}

if (require.main === module) {
  process.exit(main());
}
