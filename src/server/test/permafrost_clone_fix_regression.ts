import { strict as assert } from "assert";
import * as fs from "fs";
import * as path from "path";
import { parseSwz } from "../scripts/swzPatchUtils";

const ROOT = path.resolve(__dirname, "..", "..");
const XML_DIR = path.join(ROOT, "client", "content", "xml");
const CBQ_DIR = path.join(ROOT, "client", "content", "localhost", "p", "cbq");

function powerBlock(xml: string, powerName: string): string {
  const match = xml.match(new RegExp(`<Power PowerName="${powerName}">[\\s\\S]*?<\\/Power>`));
  assert(match, `${powerName} block must exist`);
  return match[0];
}

function tagValue(block: string, tag: string): string {
  const match = block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  assert(match, `${tag} must exist`);
  return match[1];
}

function assertPermafrostCloneFix(powerXml: string, label: string): void {
  for (let rank = 1; rank <= 10; rank += 1) {
    const buffs = tagValue(powerBlock(powerXml, `PermafrostCloneExplode${rank}`), "AddTargetBuff")
      .split(",")
      .map((buff) => buff.trim())
      .filter(Boolean);
    assert.deepEqual(buffs, ["Chilled42", "ChilblainsPermafrost"], `${label}: rank ${rank} should not add normal Chilblains`);
  }
}

function swzPowerXml(swzPath: string): string {
  const chunk = parseSwz(swzPath).chunks.find((entry) => entry.xml.includes("<PlayerPowerTypes"));
  assert(chunk, `${path.basename(swzPath)} must contain PlayerPowerTypes`);
  return chunk.xml;
}

assertPermafrostCloneFix(fs.readFileSync(path.join(XML_DIR, "PlayerPowerTypes.xml"), "utf8"), "loose XML");

for (const fileName of ["Game.swz", "Game.en.swz", "Game.tr.swz"]) {
  assertPermafrostCloneFix(swzPowerXml(path.join(CBQ_DIR, fileName)), fileName);
}

console.log("permafrost_clone_fix_regression passed");
