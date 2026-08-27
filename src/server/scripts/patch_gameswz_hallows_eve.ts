/**
 * Opens SwampRoadNorth's door 108 into the shipped Green Knight arena.
 *
 * The arena's own LevelType has always been in Game.swz - `LDArena1`, display name
 * **The Green Knight**, catacomb music, and a `ZoneSet` of SwampRoadNorth, which is
 * the game itself saying the event belonged to this square. Nothing about it needs
 * writing. The one thing it never had was a DoorType, which is exactly why it was
 * unreachable, and that is what this adds.
 *
 * LevelTypes is still touched, but only to *remove*: this project briefly minted a
 * `HallowsEve` entry for a stand-in dungeon before LDArena1 turned up, and that
 * entry has to be swept back out of every copy rather than merely stopped.
 *
 * The door carries no `RequiredMissions`: the way in is gated by the Hollow Watcher
 * standing next to it, the same way Titus gates Legends' Inn, because a
 * `RequiredMissions` lock puts a machine-written `LockedMessage` on the door and
 * says nothing about what is behind it.
 *
 * Usage: npm exec ts-node scripts/patch_gameswz_hallows_eve.ts [--verify]
 *
 * Re-runnable: every entry it owns is replaced rather than appended.
 */
import * as fs from "fs";
import * as path from "path";
import { ensureBackup, parseSwz, SwzPatchError, writeSwz } from "./swzPatchUtils";
import { HALLOWS_EVE_DOOR_ID } from "./patch-levelssrn-hallows-eve";
import { HALLOWS_EVE_ENTRY_LEVELS, HALLOWS_EVE_LEVEL } from "./wire-hallows-eve";

const CLIENT_CONTENT = path.resolve(__dirname, "..", "..", "client", "content");
const CLIENT_XML_DIR = path.join(CLIENT_CONTENT, "xml");
const GAME_SWZ = path.join(CLIENT_CONTENT, "localhost", "p", "cbq", "Game.swz");

/** The stand-in this project minted before finding LDArena1, and now sweeps out. */
const RETIRED_LEVEL = "HallowsEve";

/** Where an arrival lands inside the arena: its own entrance door. */
const TARGET_DOOR_ID = 1;

function buildDoorType(mapName: string, newline: string): string {
  return [
    "\t<DoorType>",
    `\t\t<MapName>${mapName}</MapName>`,
    `\t\t<DoorID>${HALLOWS_EVE_DOOR_ID}</DoorID>`,
    `\t\t<TargetMapName>${HALLOWS_EVE_LEVEL}</TargetMapName>`,
    `\t\t<TargetDoorID>${TARGET_DOOR_ID}</TargetDoorID>`,
    "\t</DoorType>",
  ].join(newline);
}

/**
 * Removes the retired stand-in's LevelType.
 *
 * `LDArena1`'s own entry is left exactly as it shipped - it already reads "The
 * Green Knight" on catacomb music - and its presence is asserted rather than
 * written, because if it were missing the door would lead somewhere the client
 * cannot name.
 */
export function patchLevelTypesXml(xml: string): { xml: string; changed: boolean } {
  const patched = xml.replace(
    new RegExp(`[ \\t]*<LevelType LevelName="${RETIRED_LEVEL}"[ >][\\s\\S]*?</LevelType>\\r?\\n?`, "g"),
    "",
  );
  if (!new RegExp(`<LevelType LevelName="${HALLOWS_EVE_LEVEL}">`).test(patched)) {
    throw new SwzPatchError(`LevelTypes has no ${HALLOWS_EVE_LEVEL} - the shipped arena should already be listed`);
  }
  return { xml: patched, changed: patched !== xml };
}

export function patchDoorTypesXml(xml: string): { xml: string; changed: boolean } {
  const newline = xml.includes("\r\n") ? "\r\n" : "\n";
  const stripped = xml.replace(/[ \t]*<DoorType>[\s\S]*?<\/DoorType>\r?\n?/g, (block) =>
    block.includes(`<TargetMapName>${HALLOWS_EVE_LEVEL}</TargetMapName>`) ||
    block.includes(`<TargetMapName>${RETIRED_LEVEL}</TargetMapName>`)
      ? ""
      : block,
  );

  const closing = stripped.lastIndexOf("</DoorTypes>");
  if (closing === -1) throw new SwzPatchError("DoorTypes chunk has no closing tag");

  const block = HALLOWS_EVE_ENTRY_LEVELS.map((level) => buildDoorType(level, newline)).join(newline) + newline;
  const patched = stripped.slice(0, closing) + block + stripped.slice(closing);
  return { xml: patched, changed: patched !== xml };
}

const CHUNKS: Array<{ root: string; file: string; patch: (xml: string) => { xml: string; changed: boolean } }> = [
  { root: "<LevelTypes", file: "LevelTypes.xml", patch: patchLevelTypesXml },
  { root: "<DoorTypes", file: "DoorTypes.xml", patch: patchDoorTypesXml },
];

function patchSwz(verifyOnly: boolean): string[] {
  if (!fs.existsSync(GAME_SWZ)) throw new SwzPatchError(`${GAME_SWZ} not found`);

  const ctx = parseSwz(GAME_SWZ);
  const written: string[] = [];
  for (const spec of CHUNKS) {
    const chunk = ctx.chunks.find((entry) => entry.xml.includes(spec.root));
    if (!chunk) throw new SwzPatchError(`Game.swz has no ${spec.root} chunk`);
    const patched = spec.patch(chunk.xml);
    if (patched.changed) {
      chunk.xml = patched.xml;
      written.push(spec.root.slice(1));
    }
  }
  if (written.length > 0 && !verifyOnly) {
    ensureBackup(GAME_SWZ);
    writeSwz(ctx);
  }
  return written;
}

function patchLooseXml(verifyOnly: boolean): string[] {
  const written: string[] = [];
  for (const spec of CHUNKS) {
    const filePath = path.join(CLIENT_XML_DIR, spec.file);
    if (!fs.existsSync(filePath)) continue;
    const xml = fs.readFileSync(filePath, "utf8");
    const patched = spec.patch(xml);
    if (patched.changed) {
      if (!verifyOnly) fs.writeFileSync(filePath, patched.xml);
      written.push(spec.file);
    }
  }
  return written;
}

function main(): void {
  const verifyOnly = process.argv.includes("--verify");
  const swz = patchSwz(verifyOnly);
  console.log(`cbq/Game.swz: ${swz.length > 0 ? swz.join(", ") : "already current"}`);
  const loose = patchLooseXml(verifyOnly);
  console.log(`content/xml:  ${loose.length > 0 ? loose.join(", ") : "already current"}`);
  console.log(
    `${HALLOWS_EVE_LEVEL} (The Green Knight) reached from ` +
      `${HALLOWS_EVE_ENTRY_LEVELS.map((level) => `${level}/${HALLOWS_EVE_DOOR_ID}`).join(", ")}`,
  );
  if (verifyOnly) console.log("verify only - nothing written");
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
