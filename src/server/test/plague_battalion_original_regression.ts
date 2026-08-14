import { strict as assert } from "assert";
import * as fs from "fs";
import * as path from "path";

const XML_DIR = path.resolve(__dirname, "../../client/content/xml");
const STACK_CAPS = [4, 4, 4, 4, 5, 5, 5, 5, 5, 6];
const DOT_MULTIPLIERS = [2.5, 2.75, 2.75, 2.85, 2.85, 3.05, 3.05, 3.15, 3.3, 3.3];

function block(xml: string, pattern: RegExp): string {
  const match = xml.match(pattern);
  assert.ok(match, `missing block for ${pattern}`);
  return match[0];
}

function tag(source: string, name: string): string {
  return source.match(new RegExp(`<${name}>([^<]*)</${name}>`))?.[1] ?? "";
}

function main(): void {
  const powers = fs.readFileSync(path.join(XML_DIR, "PlayerPowerTypes.xml"), "utf8");
  const buffs = fs.readFileSync(path.join(XML_DIR, "PlayerBuffTypes.xml"), "utf8");
  const mods = fs.readFileSync(path.join(XML_DIR, "PowerModTypes.xml"), "utf8");

  assert.ok(!powers.includes('PowerName="PlagueBattalionMelee'), "obsolete caster melee overrides must be absent");
  assert.ok(!powers.includes('PowerName="PlagueBattalionROR'), "custom ranged overrides must be absent");
  assert.ok(!powers.includes('PowerName="BattalionPoisonMelee'), "custom minion attacks must be absent");
  assert.ok(!buffs.includes('BuffName="PlagueBattalionMinion'), "obsolete timed minion buffs must be absent");
  assert.ok(!buffs.includes('BuffName="BattalionPoisonMinion'), "custom minion attack markers must be absent");
  assert.ok(!mods.includes("<ModName>PlagueExpertise</ModName>"), "custom Expertise window must be absent");

  const baseBuff = block(buffs, /<BuffType BuffName="PlagueBattalion">[\s\S]*?<\/BuffType>/);
  assert.equal(tag(baseBuff, "Duration"), "10000", "original one-use marker duration");
  assert.ok(!baseBuff.includes("Override"), "original marker must not replace attacks");

  const callMelee = block(powers, /<Power PowerName="GhoulMelee">[\s\S]*?<\/Power>/);
  const bolsterMelee = block(powers, /<Power PowerName="Ghoul2Melee">[\s\S]*?<\/Power>/);
  const bolsterRanged = block(powers, /<Power PowerName="Ghoul2Fireball">[\s\S]*?<\/Power>/);
  assert.equal(tag(callMelee, "TargetMethod"), "Melee", "Call the Horde must retain its authored melee attack");
  assert.equal(tag(callMelee, "BaseDamageMult"), "1.1", "Call the Horde melee damage must not be replaced");
  assert.equal(tag(bolsterMelee, "TargetMethod"), "Melee", "Bolster must retain its melee fallback");
  assert.equal(tag(bolsterMelee, "BaseDamageMult"), "0.825", "Bolster melee damage must not be replaced");
  assert.equal(tag(bolsterRanged, "TargetMethod"), "ProjectilePlayer", "Bolster must retain its ranged projectile");
  assert.equal(tag(bolsterRanged, "BaseDamageMult"), "1.1", "Bolster ranged damage must not be replaced");
  assert.ok(!callMelee.includes("Plagued"), "Plagued must be applied by the shared next-hit handler");
  assert.ok(!bolsterMelee.includes("Plagued"), "Bolster melee must use the shared next-hit handler");
  assert.ok(!bolsterRanged.includes("Plagued"), "Bolster ranged must use the shared next-hit handler");

  for (let rank = 1; rank <= 10; rank += 1) {
    const cast = block(powers, new RegExp(`<Power PowerName="PlagueBattalion${rank}">[\\s\\S]*?</Power>`));
    const expectedUses = rank >= 8 ? 3 : 1;
    assert.deepEqual(
      tag(cast, "AddTargetBuff").split(","),
      Array(expectedUses).fill("PlagueBattalion"),
      `rank ${rank} minions must receive the original next-hit marker`,
    );
    assert.ok(
      tag(cast, "AddSelfBuff").split(",").includes("PlagueBattalion"),
      `rank ${rank} caster must receive the original next-attack marker`,
    );
    const poison = block(buffs, new RegExp(`<BuffType BuffName="Plagued${rank}">[\\s\\S]*?</BuffType>`));
    assert.equal(tag(poison, "StackCount"), String(STACK_CAPS[rank - 1]), `rank ${rank} stack cap`);
    assert.equal(tag(poison, "Duration"), "9000", `rank ${rank} poison duration`);
    assert.equal(tag(poison, "DoTTickLength"), "1000", `rank ${rank} poison tick interval`);
    assert.equal(Number(tag(poison, "DoTDamage")), DOT_MULTIPLIERS[rank - 1], `rank ${rank} poison damage`);
  }

  for (const modName of ["PoisonDmg1", "PoisonDmg2", "PoisonDmg3", "PoisonDmg4", "PoisonDmg5", "RunePlagueBattalion"]) {
    const mod = block(mods, new RegExp(`<PowerModType>(?:(?!</PowerModType>)[\\s\\S])*?<ModName>${modName}</ModName>(?:(?!</PowerModType>)[\\s\\S])*?</PowerModType>`));
    for (let rank = 1; rank <= 10; rank += 1) {
      assert.ok(tag(mod, "BuffName").split(",").includes(`Plagued${rank}`), `${modName} must modify Plagued${rank}`);
    }
  }

  console.log("plague battalion original regression passed");
}

main();
