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

function buffBlock(xml: string, buffName: string): string {
  return blockByPattern(xml, new RegExp(`<BuffType BuffName="${buffName}">[\\s\\S]*?<\\/BuffType>`), buffName);
}

function modBlock(xml: string, modName: string): string {
  return blockByPattern(xml, new RegExp(`<PowerModType>\\s*<ModName>${modName}<\\/ModName>[\\s\\S]*?<\\/PowerModType>`), modName);
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

function assertNecromancerHordeBalance(powerXml: string, buffXml: string, modXml: string, entXml: string | null, label: string): void {
  assert.equal(tagValue(powerBlock(powerXml, "ProcLifethirstPets4"), "AddTargetBuff"), "MinionHoT1,MinionMaster3", `${label}: Lifethirst rank 4 pet proc`);
  assert.equal(tagValue(powerBlock(powerXml, "ProcLifethirstPets7"), "AddTargetBuff"), "MinionHoT2,MinionMaster4", `${label}: Lifethirst rank 7 pet proc`);
  assert.equal(tagValue(powerBlock(powerXml, "ProcLifethirstPets10"), "AddTargetBuff"), "MinionHoT3,MinionMaster5", `${label}: Lifethirst rank 10 pet proc`);

  assert.equal(tagValue(powerBlock(powerXml, "GhoulMelee"), "BaseDamageMult"), "1.1", `${label}: Call the Horde melee damage`);
  assert.equal(tagValue(powerBlock(powerXml, "Ghoul2Fireball"), "BaseDamageMult"), "1.1", `${label}: Bolster ranged damage`);
  assert((tagValue(powerBlock(powerXml, "Ghoul2Fireball"), "AddTargetBuff") ?? "").split(",").includes("PoisonCloud"), `${label}: Bolster ranged shot poison`);

  for (const powerName of ["PlagueBattalion8", "PlagueBattalion9", "PlagueBattalion10"]) {
    const block = powerBlock(powerXml, powerName);
    assert.equal((tagValue(block, "AddTargetBuff") ?? "").split(",").filter((buff) => buff === "PlagueBattalion").length, 3, `${label}: ${powerName} target plague count`);
    assert.equal((tagValue(block, "AddSelfBuff") ?? "").split(",").filter((buff) => buff === "PlagueBattalion").length, 3, `${label}: ${powerName} self plague count`);
  }

  assert.equal(tagValue(powerBlock(powerXml, "BansheeWail10"), "BaseDamageMult"), "3.818", `${label}: Wail of the Banshee rank 10 damage`);
  if (label !== "Game.tr.swz") {
    assert((tagValue(powerBlock(powerXml, "BansheeWail10"), "UpgradeDescription") ?? "").includes("500% bonus cap"), `${label}: Wail of the Banshee rank 10 scaling text`);
  }
  assert.equal(tagValue(buffBlock(buffXml, "MinionMaster5"), "Duration"), "5000", `${label}: MinionMaster duration`);
  assert.equal(tagValue(buffBlock(buffXml, "MinionMaster5"), "MeleeDamage"), "0.05", `${label}: MinionMaster melee damage`);
  assert.equal(tagValue(buffBlock(buffXml, "MinionMaster5"), "MagicDamage"), "0.05", `${label}: MinionMaster expertise stat`);
  const minionMasterMod = modBlock(modXml, "MinionMaster5");
  assert.equal(tagValue(minionMasterMod, "ModType"), "Power", `${label}: MinionMaster modifier type`);
  assert.equal(tagValue(minionMasterMod, "PowerProperty"), "AddSelfBuff", `${label}: MinionMaster modifier property`);
  assert.equal(tagValue(minionMasterMod, "PowerValue"), "Append:MinionMaster5", `${label}: MinionMaster modifier value`);
  for (const powerName of ["SummonGhoul1", "SummonGhoul10", "SummonRangedGhoul1", "SummonRangedGhoul10", "InfestationSpawn1", "InfestationSpawn10", "InfestationSpawnKing"]) {
    assert(commaValues(minionMasterMod, "PowerName").includes(powerName), `${label}: MinionMaster applies to ${powerName}`);
  }
  assert.equal(tagValue(modBlock(modXml, "CurseCrit5"), "SelfValue"), ".1", `${label}: Crippling Curse max crit`);
  assert.equal(tagValue(modBlock(modXml, "PoisonDmg5"), "BuffValue"), ".35", `${label}: Concentrated Venom max scaling`);

  if (entXml) {
    for (const entName of ["GhoulGuard1", "GhoulGuard10", "Ghoul2Guard1", "Ghoul2Guard10", "InfestationSpawn1", "InfestationSpawnKing"]) {
      const block = entBlock(entXml, entName);
      assert.equal(tagValue(block, "HitPoints"), "0.1", `${label}: ${entName} HP owner scaling`);
      assert.equal(tagValue(block, "MeleeDamage"), "0.1", `${label}: ${entName} melee owner scaling`);
      assert.equal(tagValue(block, "MagicDamage"), "0.1", `${label}: ${entName} magic/expertise owner scaling`);
      assert.equal(tagValue(block, "ArmorClass"), "0.1", `${label}: ${entName} defense owner scaling`);
    }
  }
}

function swzChunk(swzPath: string, marker: string): string {
  const chunk = parseSwz(swzPath).chunks.find((entry) => entry.xml.includes(marker));
  assert(chunk, `${path.basename(swzPath)} must contain ${marker}`);
  return chunk.xml;
}

assertNecromancerHordeBalance(
  fs.readFileSync(path.join(XML_DIR, "PlayerPowerTypes.xml"), "utf8"),
  fs.readFileSync(path.join(XML_DIR, "PlayerBuffTypes.xml"), "utf8"),
  fs.readFileSync(path.join(XML_DIR, "PowerModTypes.xml"), "utf8"),
  fs.readFileSync(path.join(XML_DIR, "EntTypes.xml"), "utf8"),
  "loose XML",
);

for (const fileName of ["Game.swz", "Game.en.swz", "Game.tr.swz"]) {
  const swzPath = path.join(CBQ_DIR, fileName);
  assertNecromancerHordeBalance(
    swzChunk(swzPath, "<PlayerPowerTypes"),
    swzChunk(swzPath, "<PlayerBuffTypes"),
    swzChunk(swzPath, "<PowerModTypes"),
    null,
    fileName,
  );
}

console.log("necromancer_horde_balance_regression passed");
