import { strict as assert } from "assert";
import * as fs from "fs";
import * as path from "path";
import { parseSwz } from "../scripts/swzPatchUtils";

const ROOT = path.resolve(__dirname, "..", "..");
const XML_DIR = path.join(ROOT, "client", "content", "xml");
const CBQ_DIR = path.join(ROOT, "client", "content", "localhost", "p", "cbq");
const FLAMETHROWER_VISUAL_BUFFS = ["Flamethrower", "FlamethrowerRank1", "FlamethrowerRank5", "FlamethrowerRank9"];

function blockByPattern(xml: string, pattern: RegExp, label: string): string {
  const match = xml.match(pattern);
  assert(match, `${label} block must exist`);
  return match[0];
}

function powerBlock(xml: string, powerName: string): string {
  return blockByPattern(xml, new RegExp(`<Power PowerName="${powerName}">[\\s\\S]*?<\\/Power>`), powerName);
}

function buffBlock(xml: string, buffName: string): string {
  return blockByPattern(xml, new RegExp(`<BuffType BuffName="${buffName}">[\\s\\S]*?<\\/BuffType>`), buffName);
}

function tagValue(block: string, tag: string): string | null {
  return block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`))?.[1] ?? null;
}

function assertPyromaniaData(powerXml: string, buffXml: string, label: string): void {
  for (const buffName of FLAMETHROWER_VISUAL_BUFFS) {
    assert.equal(tagValue(buffBlock(buffXml, buffName), "Duration"), "1000", `${label}: ${buffName} must expire quickly when Pyromania stops casting`);
  }

  assert.equal(tagValue(powerBlock(powerXml, "FlamethrowerROR"), "AddSelfBuff"), "Flamethrower", `${label}: base Flamethrower ROR visual buff`);
  assert.equal(tagValue(powerBlock(powerXml, "FlamethrowerROR1"), "AddSelfBuff"), "FlamethrowerRank1", `${label}: rank 1 Flamethrower ROR visual buff`);
  assert.equal(tagValue(powerBlock(powerXml, "FlamethrowerROR5"), "AddSelfBuff"), "FlamethrowerRank5", `${label}: rank 5 Flamethrower ROR visual buff`);
  assert.equal(tagValue(powerBlock(powerXml, "FlamethrowerROR10"), "AddSelfBuff"), "FlamethrowerRank9", `${label}: rank 10 Flamethrower ROR visual buff`);
}

function swzChunk(swzPath: string, marker: string): string {
  const chunk = parseSwz(swzPath).chunks.find((entry) => entry.xml.includes(marker));
  assert(chunk, `${path.basename(swzPath)} must contain ${marker}`);
  return chunk.xml;
}

assertPyromaniaData(
  fs.readFileSync(path.join(XML_DIR, "PlayerPowerTypes.xml"), "utf8"),
  fs.readFileSync(path.join(XML_DIR, "PlayerBuffTypes.xml"), "utf8"),
  "xml",
);

for (const fileName of ["Game.swz", "Game.en.swz", "Game.tr.swz"]) {
  const swzPath = path.join(CBQ_DIR, fileName);
  assertPyromaniaData(
    swzChunk(swzPath, "<PlayerPowerTypes"),
    swzChunk(swzPath, "<PlayerBuffTypes"),
    fileName,
  );
}

console.log("pyromania_visual_regression passed");
