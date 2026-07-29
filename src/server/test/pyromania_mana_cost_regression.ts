import { strict as assert } from "assert";
import * as fs from "fs";
import * as path from "path";
import { patchPowerManaCosts } from "../scripts/patch_gameswz_power_mana_costs";

const expectedCostByRank = ["40", "20", "20", "15", "15", "15", "15", "10", "10", "10", "10"];
const pyromaniaPowerNames = expectedCostByRank.map((_cost, rank) => (rank === 0 ? "Pyromania" : `Pyromania${rank}`));

const sourceXml = [
  "<PlayerPowerTypes>",
  ...pyromaniaPowerNames.map((powerName) => [
    `  <Power PowerName="${powerName}">`,
    "    <ManaCost>10,50</ManaCost>",
    "  </Power>",
  ].join("\n")),
  "</PlayerPowerTypes>",
].join("\n");

const firstPass = patchPowerManaCosts(sourceXml);
assert.equal(firstPass.changes, pyromaniaPowerNames.length, "every Pyromania rank must be corrected");

function manaCostOf(xml: string, powerName: string): string {
  const block = xml.match(new RegExp(`<Power PowerName="${powerName}">[\\s\\S]*?<\\/Power>`))?.[0];
  assert(block, `${powerName} block must exist`);
  const manaCost = block.match(/<ManaCost>([\s\S]*?)<\/ManaCost>/)?.[1];
  assert(manaCost !== undefined, `${powerName} must declare a ManaCost`);
  return manaCost;
}

for (const [rank, powerName] of pyromaniaPowerNames.entries()) {
  const manaCost = manaCostOf(firstPass.xml, powerName);
  assert.equal(manaCost, expectedCostByRank[rank], `${powerName} must spend its authored mastery mana`);
  // The second ManaCost field is mana restored per hit, so a comma here turns the channelled
  // flamethrower into a mana battery. The cast gate belongs in <ManaRequirement> instead.
  assert.doesNotMatch(manaCost, /,/, `${powerName} must not restore mana on hit`);
}

const secondPass = patchPowerManaCosts(firstPass.xml);
assert.equal(secondPass.changes, 0, "the Pyromania mana-cost patch must be idempotent");
assert.equal(secondPass.xml, firstPass.xml, "a second patch pass must not rewrite valid data");

// The shipped data has to match, otherwise the packaged Game.swz still ships the flattened costs.
const shippedXml = fs.readFileSync(
  path.resolve(__dirname, "..", "..", "client", "content", "xml", "PlayerPowerTypes.xml"),
  "utf8",
);
for (const [rank, powerName] of pyromaniaPowerNames.entries()) {
  assert.equal(
    manaCostOf(shippedXml, powerName),
    expectedCostByRank[rank],
    `shipped ${powerName} mana cost is stale -- run npm run patch:power-mana-costs`,
  );
}

// Every mastery ultimate gates on <ManaRequirement>, which the client only honours with
// patch-dungeonblitz-mana-requirement.ts applied. A requirement equal to the cost means the
// data lost its gate (Charon's Blades 10 asking for 10 discipline mana instead of 40).
const masteryBlocks = shippedXml.match(/<Power PowerName="[^"]+">[\s\S]*?<\/Power>/g) ?? [];
let gatedPowers = 0;
for (const block of masteryBlocks) {
  const requirement = block.match(/<ManaRequirement>([\s\S]*?)<\/ManaRequirement>/)?.[1];
  const powerName = block.match(/<Power PowerName="([^"]+)">/)?.[1] ?? "?";
  // "Template" is the documentation stub every field is copied from, not a real power.
  if (requirement === undefined || powerName === "Template") {
    continue;
  }
  const manaCost = Number((block.match(/<ManaCost>([\s\S]*?)<\/ManaCost>/)?.[1] ?? "0").split(",")[0]);
  assert.match(block, /<FromMasterMana>TRUE<\/FromMasterMana>/, `${powerName} requirement only applies to mastery powers`);
  assert.ok(Number(requirement) > manaCost, `${powerName} must require more discipline mana than it spends`);
  gatedPowers += 1;
}
assert.equal(gatedPowers, 32, "expected the three mastery ultimates (Hailstone, Pyromania, Charon's Blades) to stay gated");

console.log("pyromania_mana_cost_regression passed");
