import { strict as assert } from "assert";
import * as fs from "fs";
import * as path from "path";
import { parseSwz } from "../scripts/swzPatchUtils";
import { patchDreadfoldPortalRequirements } from "../scripts/patch_gameswz_dreadfold_portals";

const ENTRY_MAPS = [
  ["BridgeTown", "BridgeTownHard"],
  ["EmeraldGlades", "EmeraldGladesHard"],
  ["ShazariDesert", "ShazariDesertHard"],
  ["JadeCity", "JadeCityHard"],
] as const;

const RETURN_MAPS = ENTRY_MAPS.map(([normal, hard]) => [hard, normal] as const);

function sourceDoorTypesPath(): string {
  return path.resolve(__dirname, "..", "..", "client", "content", "xml", "DoorTypes.xml");
}

function gameSwzPath(): string {
  return path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p", "cbq", "Game.swz");
}

function getDoorBlock(xml: string, mapName: string): string {
  const match = xml.match(
    new RegExp(`<DoorType>\\s*<MapName>${mapName}<\\/MapName>\\s*<DoorID>300<\\/DoorID>[\\s\\S]*?<\\/DoorType>`),
  );
  assert.ok(match, `${mapName} Dreadfold portal should exist`);
  return match[0];
}

function getEntryLockedMessage(xml: string): string {
  const match = getDoorBlock(xml, "BridgeTown").match(/<LockedMessage>([\s\S]*?)<\/LockedMessage>/);
  assert.ok(match, "BridgeTown Dreadfold portal should define the shared locked message");
  return match[1];
}

function assertCorrectPortalRequirements(xml: string, label: string): void {
  const lockedMessage = getEntryLockedMessage(xml);

  for (const [mapName, targetMapName] of ENTRY_MAPS) {
    const block = getDoorBlock(xml, mapName);
    assert.match(block, new RegExp(`<TargetMapName>${targetMapName}<\\/TargetMapName>`), `${label} ${mapName} target should match`);
    assert.match(block, /<CompletedMissions>Capstone<\/CompletedMissions>/, `${label} ${mapName} should require Capstone`);
    assert.doesNotMatch(block, /<RequiredMissions>/, `${label} ${mapName} should not keep old regional requirements`);
    assert.ok(block.includes(lockedMessage), `${label} ${mapName} should use the shared locked message`);
  }

  for (const [mapName, targetMapName] of RETURN_MAPS) {
    const block = getDoorBlock(xml, mapName);
    assert.match(block, new RegExp(`<TargetMapName>${targetMapName}<\\/TargetMapName>`), `${label} ${mapName} target should match`);
    assert.doesNotMatch(block, /<CompletedMissions>|<RequiredMissions>|<LockedMessage>/, `${label} ${mapName} should stay freely returnable`);
  }

  assert.equal(
    patchDreadfoldPortalRequirements(xml).stats.replacements,
    0,
    `${label} Dreadfold portal patch should be idempotent`,
  );
}

function getGameSwzDoorTypes(): string {
  const ctx = parseSwz(gameSwzPath());
  const chunk = ctx.chunks.find((entry) => entry.xml.includes("<DoorTypes"));
  assert.ok(chunk, "Game.swz should contain DoorTypes");
  return chunk.xml;
}

function main(): void {
  assertCorrectPortalRequirements(fs.readFileSync(sourceDoorTypesPath(), "utf8"), "source XML");
  assertCorrectPortalRequirements(getGameSwzDoorTypes(), "Game.swz");
  console.log("dreadfold_portal_regression: ok");
}

main();
