import { strict as assert } from "assert";
import * as fs from "fs";
import * as path from "path";
import { parseSwz } from "../scripts/swzPatchUtils";

const ROOT = path.resolve(__dirname, "..", "..");
const XML_DIR = path.join(ROOT, "client", "content", "xml");
const CBQ_DIR = path.join(ROOT, "client", "content", "localhost", "p", "cbq");

const POWER_EXPECTATIONS = new Map<string, { buff: string; duration: string }>([
  ["SummonDragonSoul", { buff: "DragonSoulEffect", duration: "15000" }],
  ["SummonDragonSoul1", { buff: "DragonSoulRank1", duration: "11000" }],
  ["SummonDragonSoul2", { buff: "DragonSoulRank1", duration: "12000" }],
  ["SummonDragonSoul3", { buff: "DragonSoulRank3", duration: "13000" }],
  ["SummonDragonSoul4", { buff: "DragonSoulRank3", duration: "13000" }],
  ["SummonDragonSoul5", { buff: "DragonSoulRank3", duration: "13000" }],
  ["SummonDragonSoul6", { buff: "DragonSoulRank3", duration: "13500" }],
  ["SummonDragonSoul7", { buff: "DragonSoulRank3", duration: "13500" }],
  ["SummonDragonSoul8", { buff: "DragonSoulRank8", duration: "14500" }],
  ["SummonDragonSoul9", { buff: "DragonSoulRank8", duration: "15000" }],
  ["SummonDragonSoul10", { buff: "DragonSoulRank8", duration: "15000" }],
]);

const BUFF_DURATIONS = new Map<string, string>([
  ["DragonSoulEffect", "15000"],
  ["DragonSoulRank1", "12000"],
  ["DragonSoulRank3", "13500"],
  ["DragonSoulRank8", "15000"],
]);

const FIREBRAND_BUFFS = ["FireBrand", "FireBrandRank1", "FireBrandRank3", "FireBrandRank6", "FireBrandRank8"];
const FIREBRAND_POWERS = ["FireBrand", "FireBrand1", "FireBrand2", "FireBrand3", "FireBrand4", "FireBrand5", "FireBrand6", "FireBrand7", "FireBrand8", "FireBrand9", "FireBrand10"];
const FIREBRAND_SHOTS = ["FireBrandShot1", "FireBrandShot3", "FireBrandShot6", "FlameAxeFireBrandShot8"];
const FIREBRAND_BASE_DURATION = "7813";

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

function entBlock(xml: string, entName: string): string {
  return blockByPattern(xml, new RegExp(`<EntType EntName="${entName}"[^>]*>[\\s\\S]*?<\\/EntType>`), entName);
}

function tagValue(block: string, tag: string): string | null {
  return block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`))?.[1] ?? null;
}

function assertDragonSoulData(powerXml: string, buffXml: string, entXml: string | null, label: string): void {
  for (const [powerName, expected] of POWER_EXPECTATIONS) {
    const block = powerBlock(powerXml, powerName);
    const selfBuffs = tagValue(block, "AddSelfBuff")?.split(",") ?? [];
    assert(
      selfBuffs.includes(expected.buff),
      `${label}: ${powerName} must add ${expected.buff}`,
    );
    assert(
      !selfBuffs.some((buff) => buff === "FireBrand" || /^FireBrandRank\d+$/.test(buff)),
      `${label}: ${powerName} must not activate Fire Brand when Dragon Soul is summoned`,
    );
    assert.equal(tagValue(block, "SpawnDuration"), expected.duration, `${label}: ${powerName} SpawnDuration`);
    assert(!block.includes("reduced Defense"), `${label}: ${powerName} text must not mention reduced Defense`);
  }

  for (const powerName of FIREBRAND_POWERS) {
    assert.equal(tagValue(powerBlock(powerXml, powerName), "CoolDownTime"), "20000", `${label}: ${powerName} CoolDownTime`);
  }

  for (const powerName of FIREBRAND_SHOTS) {
    const block = powerBlock(powerXml, powerName);
    assert.equal(tagValue(block, "ManaCost"), "0,1", `${label}: ${powerName} must restore 1 mana per hit`);
    assert.equal(tagValue(block, "BasePowerName"), null, `${label}: ${powerName} must not add loader-risky BasePowerName`);
  }

  for (const buffName of FIREBRAND_BUFFS) {
    assert.equal(tagValue(buffBlock(buffXml, buffName), "Duration"), FIREBRAND_BASE_DURATION, `${label}: ${buffName} Duration`);
  }

  for (const [buffName, duration] of BUFF_DURATIONS) {
    const block = buffBlock(buffXml, buffName);
    assert.equal(tagValue(block, "Duration"), duration, `${label}: ${buffName} Duration`);
    assert(!block.includes("<MagicDefense>"), `${label}: ${buffName} must not reduce MagicDefense`);
    assert(!block.includes("<MeleeDefense>"), `${label}: ${buffName} must not reduce MeleeDefense`);
  }

  if (entXml) {
    assert.equal(tagValue(entBlock(entXml, "DragonSoul"), "Duration"), "15000", `${label}: DragonSoul entity Duration`);
  }
}

function swzChunk(swzPath: string, marker: string): string {
  const chunk = parseSwz(swzPath).chunks.find((entry) => entry.xml.includes(marker));
  assert(chunk, `${path.basename(swzPath)} must contain ${marker}`);
  return chunk.xml;
}

assertDragonSoulData(
  fs.readFileSync(path.join(XML_DIR, "PlayerPowerTypes.xml"), "utf8"),
  fs.readFileSync(path.join(XML_DIR, "PlayerBuffTypes.xml"), "utf8"),
  fs.readFileSync(path.join(XML_DIR, "EntTypes.xml"), "utf8"),
  "loose XML",
);

for (const fileName of ["Game.swz", "Game.en.swz", "Game.tr.swz"]) {
  const swzPath = path.join(CBQ_DIR, fileName);
  assertDragonSoulData(
    swzChunk(swzPath, "<PlayerPowerTypes"),
    swzChunk(swzPath, "<PlayerBuffTypes"),
    null,
    fileName,
  );
}

console.log("dragon_soul_firebrand_regression passed");
