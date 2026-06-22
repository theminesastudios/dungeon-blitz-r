import { strict as assert } from "assert";
import * as fs from "fs";
import * as path from "path";
import { parseSwz } from "../scripts/swzPatchUtils";

const TARGET_POWER = "FirePitMelee";
const TARGET_DAMAGE_MULT = "1";
const XML_DIR = path.resolve(__dirname, "..", "..", "client", "content", "xml");
const CBQ_DIR = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p", "cbq");

function powerBlock(xml: string, powerName: string): string {
  const match = xml.match(new RegExp(`<Power PowerName="${powerName}">[\\s\\S]*?<\\/Power>`));
  assert.ok(match, `${powerName} power must exist`);
  return match![0];
}

function tagValue(xml: string, tagName: string): string {
  const match = xml.match(new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`));
  assert.ok(match, `${tagName} tag must exist`);
  return match![1].trim();
}

function assertFirePitDamage(xml: string, label: string): void {
  const block = powerBlock(xml, TARGET_POWER);
  assert.equal(
    tagValue(block, "BaseDamageMult"),
    TARGET_DAMAGE_MULT,
    `${label}: ${TARGET_POWER} should tick damage without the old instant-kill multiplier`
  );
  assert.equal(tagValue(block, "CoolDownTime"), "300", `${label}: ${TARGET_POWER} tick cadence should be unchanged`);
  assert.equal(tagValue(block, "TargetMethod"), "PBAoE", `${label}: ${TARGET_POWER} should remain a lava AoE hazard`);
}

assertFirePitDamage(
  fs.readFileSync(path.join(XML_DIR, "MonsterPowerTypes.xml"), "utf8"),
  "MonsterPowerTypes.xml"
);

for (const fileName of ["Game.swz", "Game.en.swz", "Game.tr.swz"]) {
  const swzPath = path.join(CBQ_DIR, fileName);
  const chunk = parseSwz(swzPath).chunks.find((entry) => entry.xml.includes("<MonsterPowerTypes"));
  assert.ok(chunk, `${fileName} must contain MonsterPowerTypes`);
  assertFirePitDamage(chunk!.xml, fileName);
}

console.log("imperial_barracks_lava_damage_regression: ok");
