import { strict as assert } from "assert";
import * as fs from "fs";
import * as path from "path";
import { parseSwz } from "../scripts/swzPatchUtils";

const ROOT = path.resolve(__dirname, "..", "..");
const XML_DIR = path.join(ROOT, "client", "content", "xml");
const CBQ_DIR = path.join(ROOT, "client", "content", "localhost", "p", "cbq");

const EXPECTED_VALUES = new Map<string, string>([
  ["BurnDmg1", ".1"],
  ["BurnDmg2", ".2"],
  ["BurnDmg3", ".3"],
  ["BurnDmg4", ".4"],
  ["BurnDmg5", ".5"],
]);

const EXPECTED_DESCRIPTION = "Increases Burn Damage@Burn Damage:, +10%, +20%, +30%, +40%, +50%";

function blockByPattern(xml: string, pattern: RegExp, label: string): string {
  const match = xml.match(pattern);
  assert(match, `${label} block must exist`);
  return match[0];
}

function modBlock(xml: string, modName: string): string {
  return blockByPattern(
    xml,
    new RegExp(`<PowerModType>\\s*<ModName>${modName}<\\/ModName>[\\s\\S]*?<\\/PowerModType>`),
    modName,
  );
}

function tagValue(block: string, tag: string): string | null {
  return block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`))?.[1] ?? null;
}

function assertAccelerantScaling(xml: string, label: string, expectedDisplayName: string | null = "Accelerant"): void {
  for (const [modName, expectedValue] of EXPECTED_VALUES) {
    const block = modBlock(xml, modName);
    if (expectedDisplayName !== null) {
      assert.equal(tagValue(block, "DisplayName"), expectedDisplayName, `${label}: ${modName} DisplayName`);
    }
    assert.equal(tagValue(block, "BuffName"), "Burned", `${label}: ${modName} BuffName`);
    assert.equal(tagValue(block, "BuffProperty"), "DoTDamage", `${label}: ${modName} BuffProperty`);
    assert.equal(tagValue(block, "BuffValue"), expectedValue, `${label}: ${modName} BuffValue`);
  }
  if (expectedDisplayName !== null) {
    assert.equal(tagValue(modBlock(xml, "BurnDmg1"), "Description"), EXPECTED_DESCRIPTION, `${label}: BurnDmg1 Description`);
  }
}

function swzChunk(swzPath: string): string {
  const chunk = parseSwz(swzPath).chunks.find((entry) => entry.xml.includes("<PowerModTypes"));
  assert(chunk, `${path.basename(swzPath)} must contain PowerModTypes`);
  return chunk.xml;
}

assertAccelerantScaling(fs.readFileSync(path.join(XML_DIR, "PowerModTypes.xml"), "utf8"), "loose XML");

for (const fileName of ["Game.swz", "Game.en.swz"]) {
  assertAccelerantScaling(swzChunk(path.join(CBQ_DIR, fileName)), fileName);
}
assertAccelerantScaling(swzChunk(path.join(CBQ_DIR, "Game.tr.swz")), "Game.tr.swz", null);

console.log("accelerant_scaling_regression passed");
