import { strict as assert } from "assert";
import { patchPowerManaCosts } from "../scripts/patch_gameswz_power_mana_costs";

const pyromaniaPowerNames = [
  "Pyromania",
  ...Array.from({ length: 10 }, (_, index) => `Pyromania${index + 1}`),
];

const sourceXml = [
  "<PlayerPowerTypes>",
  ...pyromaniaPowerNames.map((powerName) => [
    `  <Power PowerName="${powerName}">`,
    "    <ManaCost>0</ManaCost>",
    "  </Power>",
  ].join("\n")),
  "</PlayerPowerTypes>",
].join("\n");

const firstPass = patchPowerManaCosts(sourceXml);
assert.equal(firstPass.changes, pyromaniaPowerNames.length, "every Pyromania rank must be corrected");

for (const powerName of pyromaniaPowerNames) {
  const block = firstPass.xml.match(new RegExp(`<Power PowerName="${powerName}">[\\s\\S]*?<\\/Power>`))?.[0];
  assert(block, `${powerName} block must exist`);
  assert.match(block, /<ManaCost>10,50<\/ManaCost>/, `${powerName} must cost 10 mastery mana and require 50 mastery mana`);
}

const secondPass = patchPowerManaCosts(firstPass.xml);
assert.equal(secondPass.changes, 0, "the Pyromania mana-cost patch must be idempotent");
assert.equal(secondPass.xml, firstPass.xml, "a second patch pass must not rewrite valid data");

console.log("pyromania_mana_cost_regression passed");
