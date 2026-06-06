import { strict as assert } from "assert";
import * as fs from "fs";
import * as path from "path";
import { parseSwz } from "../scripts/swzPatchUtils";

const ROOT = path.resolve(__dirname, "..", "..");
const XML_DIR = path.join(ROOT, "client", "content", "xml");
const CBQ_DIR = path.join(ROOT, "client", "content", "localhost", "p", "cbq");
const PERMAFROST_DOT_BUFF = "ChilblainsPermafrostDot";

function powerBlock(xml: string, powerName: string): string {
  const match = xml.match(new RegExp(`<Power PowerName="${powerName}">[\\s\\S]*?<\\/Power>`));
  assert(match, `${powerName} block must exist`);
  return match[0];
}

function buffBlock(xml: string, buffName: string): string {
  const match = xml.match(new RegExp(`<BuffType BuffName="${buffName}">[\\s\\S]*?<\\/BuffType>`));
  assert(match, `${buffName} block must exist`);
  return match[0];
}

function modBlock(xml: string, modName: string): string {
  const block = xml
    .match(/<PowerModType>[\s\S]*?<\/PowerModType>/g)
    ?.find((item) => tagValue(item, "ModName") === modName);
  assert(block, `${modName} block must exist`);
  return block;
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
    assert.equal(buffs[0], "Chilled42", `${label}: rank ${rank} should still chill`);
    assert.equal(buffs.filter((buff) => buff === PERMAFROST_DOT_BUFF).length, 4, `${label}: rank ${rank} should apply 4 Permafrost DoT stacks`);
    assert.equal(buffs.filter((buff) => buff === "ChilblainsPermafrost").length, 4, `${label}: rank ${rank} should apply 4 Permafrost stacks`);
  }
}

function assertPermafrostBuffIsLoaderSafe(buffXml: string, label: string): void {
  const stackBlock = buffBlock(buffXml, "ChilblainsPermafrost");
  assert(!stackBlock.includes("<DoTDamage>"), `${label}: ChilblainsPermafrost should not define DoTDamage`);
  assert(!stackBlock.includes("<DoTTickLength>"), `${label}: ChilblainsPermafrost should not define DoTTickLength`);

  const dotBlock = buffBlock(buffXml, PERMAFROST_DOT_BUFF);
  assert.equal(tagValue(dotBlock, "BuffID"), "739", `${label}: Permafrost DoT buff should use stable BuffID`);
  assert.equal(tagValue(dotBlock, "Duration"), "5000", `${label}: Permafrost DoT duration should divide by tick length`);
  assert.equal(tagValue(dotBlock, "DoTDamage"), "1", `${label}: 4 Permafrost DoT stacks should deal 4 DoT damage`);
  assert.equal(tagValue(dotBlock, "DoTTickLength"), "1000", `${label}: Permafrost DoT should tick like Chilblains`);
  assert.equal(tagValue(dotBlock, "Effect"), "Chilblains", `${label}: Permafrost DoT should start Chillblains`);
  assert.equal(Number(tagValue(dotBlock, "Duration")) % Number(tagValue(dotBlock, "DoTTickLength")), 0, `${label}: Permafrost DoT tick length should divide duration`);
}

function assertPermafrostDotUsesChilblainsMods(modXml: string, label: string): void {
  for (let rank = 1; rank <= 5; rank += 1) {
    const block = modBlock(modXml, `ChilblainsDmg${rank}`);
    const buffs = tagValue(block, "BuffName").split(",").map((buff) => buff.trim());
    assert(buffs.includes("Chilblains"), `${label}: ChilblainsDmg${rank} should still affect Chilblains`);
    assert(buffs.includes(PERMAFROST_DOT_BUFF), `${label}: ChilblainsDmg${rank} should affect Permafrost DoT`);
  }
}

function swzXml(swzPath: string, rootTag: string): string {
  const chunk = parseSwz(swzPath).chunks.find((entry) => entry.xml.includes(`<${rootTag}`));
  assert(chunk, `${path.basename(swzPath)} must contain ${rootTag}`);
  return chunk.xml;
}

assertPermafrostCloneFix(fs.readFileSync(path.join(XML_DIR, "PlayerPowerTypes.xml"), "utf8"), "loose XML");
assertPermafrostBuffIsLoaderSafe(fs.readFileSync(path.join(XML_DIR, "PlayerBuffTypes.xml"), "utf8"), "loose XML");
assertPermafrostDotUsesChilblainsMods(fs.readFileSync(path.join(XML_DIR, "PowerModTypes.xml"), "utf8"), "loose XML");

for (const fileName of ["Game.swz", "Game.en.swz", "Game.tr.swz"]) {
  const swzPath = path.join(CBQ_DIR, fileName);
  assertPermafrostCloneFix(swzXml(swzPath, "PlayerPowerTypes"), fileName);
  assertPermafrostBuffIsLoaderSafe(swzXml(swzPath, "PlayerBuffTypes"), fileName);
  assertPermafrostDotUsesChilblainsMods(swzXml(swzPath, "PowerModTypes"), fileName);
}

console.log("permafrost_clone_fix_regression passed");
