import { strict as assert } from "assert";
import * as fs from "fs";
import * as path from "path";
import { patchPlayerPowers } from "../scripts/patch_gameswz_mage_skill_balance";

// Fire Brand replaces the ranged basic attack. Without an impact effect the projectile just
// vanishes on the target and a landed hit reads as a miss, so every rank needs the same
// a_CrimsonShotImpact that plain Fireball uses. Pyromania mana is owned by
// patch_gameswz_power_mana_costs; this patcher must leave it alone.
const shotNames = ["FireBrandShot1", "FireBrandShot3", "FireBrandShot6", "FlameAxeFireBrandShot8"];

function blockOf(xml: string, powerName: string): string {
  const block = xml.match(new RegExp(`<Power PowerName="${powerName}">[\\s\\S]*?<\\/Power>`))?.[0];
  assert(block, `${powerName} block must exist`);
  return block;
}

const shippedXml = fs.readFileSync(
  path.resolve(__dirname, "..", "..", "client", "content", "xml", "PlayerPowerTypes.xml"),
  "utf8",
);

for (const source of [shippedXml, patchPlayerPowers(shippedXml).xml]) {
  for (const powerName of shotNames) {
    const block = blockOf(source, powerName);
    const fireGfx = block.match(/<FireGfx>([\s\S]*?)<\/FireGfx>/)?.[1];
    assert(fireGfx, `${powerName} must declare an impact effect, not an empty <FireGfx/>`);
    assert.match(fireGfx, /<AnimClass>a_CrimsonShotImpact<\/AnimClass>/, `${powerName} must play the fire impact anim`);
  }

  const pyromania = blockOf(source, "Pyromania");
  assert.match(pyromania, /<ManaCost>40<\/ManaCost>/, "the balance patcher must not zero Pyromania mana");
}

const secondPass = patchPlayerPowers(patchPlayerPowers(shippedXml).xml);
assert.equal(secondPass.stats.changes, 0, "the mage balance patch must be idempotent");

console.log("firebrand shot impact gfx regression passed");
