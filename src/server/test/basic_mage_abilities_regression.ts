import { strict as assert } from "assert";
import * as fs from "fs";
import * as path from "path";
import { parseSwz } from "../scripts/swzPatchUtils";

const ROOT = path.resolve(__dirname, "..", "..");
const XML_DIR = path.join(ROOT, "client", "content", "xml");
const CBQ_DIR = path.join(ROOT, "client", "content", "localhost", "p", "cbq");

function blockByPattern(xml: string, pattern: RegExp, label: string): string {
  const match = xml.match(pattern);
  assert(match, `${label} block must exist`);
  return match[0];
}

function powerBlock(xml: string, powerName: string): string {
  return blockByPattern(xml, new RegExp(`<Power PowerName="${powerName}">[\\s\\S]*?<\\/Power>`), powerName);
}

function entBlock(xml: string, entName: string): string {
  return blockByPattern(xml, new RegExp(`<EntType EntName="${entName}"[^>]*>[\\s\\S]*?<\\/EntType>`), entName);
}

function tagValue(block: string, tag: string): string | null {
  return block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`))?.[1] ?? null;
}

function commaValues(block: string, tag: string): string[] {
  return (tagValue(block, tag) ?? "").split(",").map((part) => part.trim()).filter(Boolean);
}

function assertBasicMageAbilities(powerXml: string, entXml: string | null, label: string): void {
  assert(!commaValues(powerBlock(powerXml, "VineLance2"), "AddTargetBuff").includes("PoisonCloud"), `${label}: Vine Strike rank 2 should not poison`);
  assert(commaValues(powerBlock(powerXml, "VineLance3"), "AddTargetBuff").includes("PoisonCloud"), `${label}: Vine Strike rank 3 should poison`);

  for (const powerName of ["IceSpike", "IceSpike1", "IceSpike10"]) {
    assert.equal(tagValue(powerBlock(powerXml, powerName), "ManaCost"), "30", `${label}: ${powerName} mana cost`);
  }

  for (const powerName of ["MeteorROR", "MeteorROR1", "MeteorROR4"]) {
    assert.equal(tagValue(powerBlock(powerXml, powerName), "RecoverTime"), "625", `${label}: ${powerName} 80% attack speed`);
  }
  for (const powerName of ["MeteorROR5", "MeteorROR10"]) {
    assert.equal(tagValue(powerBlock(powerXml, powerName), "RecoverTime"), "519", `${label}: ${powerName} 80% attack speed`);
  }

  for (const powerName of ["IceStorm", "IceStorm1", "IceStorm10"]) {
    const block = powerBlock(powerXml, powerName);
    assert.equal(tagValue(block, "CastTime"), "855,503,443", `${label}: ${powerName} faster cast`);
    assert(commaValues(block, "AddTargetBuff").includes("Chilblains"), `${label}: ${powerName} inflicts Chilblains`);
  }

  for (const powerName of ["MagePetMelee", "MagePetUber"]) {
    const block = powerBlock(powerXml, powerName);
    assert.equal(tagValue(block, "AoERadius"), "70", `${label}: ${powerName} AoE radius`);
    assert.equal(tagValue(block, "CenterOffset"), "40", `${label}: ${powerName} AoE center offset`);
  }

  if (entXml) {
    assert.equal(tagValue(entBlock(entXml, "NatureGuard"), "HitPoints"), "1", `${label}: base Call Guard HP scaling`);
    assert.equal(tagValue(entBlock(entXml, "NatureGuard"), "ArmorClass"), "1.3", `${label}: base Call Guard defense scaling`);
    assert.equal(tagValue(entBlock(entXml, "SummonGuard1"), "HitPoints"), "1", `${label}: rank 1 Call Guard HP scaling`);
    assert.equal(tagValue(entBlock(entXml, "SummonGuard1"), "ArmorClass"), "1.3", `${label}: rank 1 Call Guard defense scaling`);
    assert.equal(tagValue(entBlock(entXml, "SummonGuard10"), "HitPoints"), "1.6", `${label}: rank 10 Call Guard HP scaling`);
    assert.equal(tagValue(entBlock(entXml, "SummonGuard10"), "ArmorClass"), "2.2", `${label}: rank 10 Call Guard defense scaling`);
    assert(commaValues(entBlock(entXml, "NatureGuard"), "Powers").includes("MagePetUber"), `${label}: base Call Guard has AoE special`);
    assert(commaValues(entBlock(entXml, "SummonGuard1"), "Powers").includes("MagePetUber"), `${label}: rank 1 Call Guard has AoE special`);
  }
}

function swzChunk(swzPath: string, marker: string): string | null {
  return parseSwz(swzPath).chunks.find((entry) => entry.xml.includes(marker))?.xml ?? null;
}

assertBasicMageAbilities(
  fs.readFileSync(path.join(XML_DIR, "PlayerPowerTypes.xml"), "utf8"),
  fs.readFileSync(path.join(XML_DIR, "EntTypes.xml"), "utf8"),
  "loose XML",
);

for (const fileName of ["Game.swz", "Game.en.swz", "Game.tr.swz"]) {
  const swzPath = path.join(CBQ_DIR, fileName);
  const powerXml = swzChunk(swzPath, "<PlayerPowerTypes");
  assert(powerXml, `${fileName} must contain PlayerPowerTypes`);
  assertBasicMageAbilities(powerXml, swzChunk(swzPath, "<EntTypes"), fileName);
}

console.log("basic_mage_abilities_regression passed");
