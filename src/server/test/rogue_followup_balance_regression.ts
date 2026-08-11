import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..", "..");
const XML_DIR = path.join(ROOT, "client", "content", "xml");

function block(xml: string, element: string, attribute: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = xml.match(new RegExp(`<${element} ${attribute}="${escaped}">[\\s\\S]*?<\\/${element}>`));
  assert.ok(match, `${element} ${name} must exist`);
  return match[0];
}

function tag(xml: string, name: string): string {
  return xml.match(new RegExp(`<${name}>([^<]*)<\\/${name}>`))?.[1] ?? "";
}

function powerMod(xml: string, name: string): string {
  const match = (xml.match(/<PowerModType>[\s\S]*?<\/PowerModType>/g) ?? [])
    .find((candidate) => tag(candidate, "ModName") === name);
  assert.ok(match, `PowerModType ${name} must exist`);
  return match;
}

const powers = fs.readFileSync(path.join(XML_DIR, "PlayerPowerTypes.xml"), "utf8");
const buffs = fs.readFileSync(path.join(XML_DIR, "PlayerBuffTypes.xml"), "utf8");
const mods = fs.readFileSync(path.join(XML_DIR, "PowerModTypes.xml"), "utf8");
const runtimePatch = fs.readFileSync(path.join(ROOT, "server", "scripts", "patch-dungeonblitz-shadowstalker-expertise.js"), "utf8");

assert.deepEqual(
  [1, 2, 3, 4, 5].map((rank) => tag(powerMod(mods, `Pounce${rank}`), "SelfValue")),
  [".01", ".02", ".03", ".05", ".07"]
);
assert.match(powerMod(mods, "Pounce1"), /1%, 2%, 3%, 5%, 7%/);

for (const [name, expected] of [
  ["ShadowTendrilDamage", "-0.06"],
  ["ShadowTendrilRank1", "-0.06"],
  ["ShadowTendrilRank4", "-0.06"],
  ["ShadowTendrilRank6", "-0.08"],
  ["ShadowTendrilRank8", "-0.08"],
  ["ShadowTendrilRank10", "-0.1"],
] as const) {
  const buff = block(buffs, "BuffType", "BuffName", name);
  assert.equal(tag(buff, "MeleeDefense"), expected, `${name} melee defense`);
  assert.equal(tag(buff, "MagicDefense"), expected, `${name} magic defense`);
}

for (const [rank, expected] of [[1, "6"], [6, "8"], [10, "10"]] as const) {
  assert.equal(
    tag(block(powers, "Power", "PowerName", `ShadowTendrilDash${rank}`), "UpgradeDescription"),
    `Tendril Defense reduction is ${expected}%.`
  );
}

assert.match(tag(block(powers, "Power", "PowerName", "HeartSeeker10"), "Description"), /80% bonus damage.*Black Miasma/);
assert.match(tag(block(powers, "Power", "PowerName", "BlackStorm10"), "Description"), /160% bonus damage.*Black Miasma/);
assert.match(tag(block(powers, "Power", "PowerName", "Assassinate3"), "Description"), /1% more damage per Bleed stack/);
assert.match(tag(block(powers, "Power", "PowerName", "Assassinate7"), "Description"), /1\.5% more damage per Bleed stack/);

const reaper4 = block(powers, "Power", "PowerName", "Reaper4");
assert.equal(tag(reaper4, "AddTargetBuff"), "ArmorBane");
assert.match(tag(reaper4, "UpgradeDescription"), /Inflicts Armor Bane/);
assert.match(tag(block(powers, "Power", "PowerName", "Reaper10"), "Description"), /120% of Expertise/);
assert.match(tag(block(powers, "Power", "PowerName", "PainBender10"), "Description"), /225% of Expertise/);

assert.match(runtimePatch, /BlackStorm" \? 1\.6 : 0\.8/);
assert.match(runtimePatch, /0\.015 : 0\.01/);
assert.match(runtimePatch, /_loc27_ = 1\.2/);
assert.match(runtimePatch, /_loc28_ = 2\.25/);

console.log("Rogue follow-up balance regression tests passed.");
