/**
 * Registers the Legends' Inn stages with the client's game data.
 *
 * Two chunks of Game.swz are touched, and the loose copies of the same XML under
 * src/client/content/xml are kept in step:
 *   - LevelTypes gains one entry per stage, so the client has a display name and
 *     music for each,
 *   - DoorTypes gains the Craft Town portal, the way back out of every stage, and
 *     the boss-room portal that carries the player from one stage to the next.
 *
 * A stage is a copy of a shipped dungeon, so its LevelType is copied from that
 * dungeon's - same zone set, same music - with only the name changed. The chain
 * itself is read from door_map.json, which build-legends-inn-stages.ts writes
 * from what it actually placed; the exit door id is not the same in every stage,
 * because it depends on which a_Door_ classes the region SWF exports.
 *
 * Without these entries the client draws the portals but has nowhere to send the
 * player.
 *
 * Usage: npm exec ts-node scripts/patch_gameswz_legends_inn.ts [--verify] [--swz-path <file>]
 */
import * as fs from "fs";
import * as path from "path";
import { ensureBackup, parseSwz, SwzPatchError, writeSwz } from "./swzPatchUtils";
import {
  ENTRY_DOOR_ID,
  ENTRY_LEVEL,
  LEGENDS_INN_LEVEL,
  LEGENDS_INN_MUSIC_LOOP,
  LEGENDS_INN_STAGES,
  RETURN_DOOR_ID,
  legendsInnDisplayName,
} from "./legendsInnStages";

const DOOR_MAP_PATH = path.resolve(__dirname, "..", "data", "door_map.json");
const CLIENT_XML_DIR = path.resolve(__dirname, "..", "..", "client", "content", "xml");

export interface LegendsInnSwzStats {
  levelTypes: number;
  doorTypes: number;
}

interface DoorLink {
  mapName: string;
  doorId: number;
  targetMapName: string;
  targetDoorId: number;
}

function defaultGameSwzPath(): string {
  return path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p", "cbq", "Game.swz");
}

function resolveArgPath(args: string[], flag: string, fallback: string): string {
  const index = args.indexOf(flag);
  return index !== -1 && index + 1 < args.length ? path.resolve(args[index + 1]) : fallback;
}

/**
 * The stage chain, as the build recorded it. Reading it back rather than
 * recomputing it keeps the client's doors and the server's doors from drifting
 * apart - there is only one description of where a portal leads.
 */
export function readStageDoors(doorMapPath = DOOR_MAP_PATH): DoorLink[] {
  const doors: Array<[[string, number], string]> = JSON.parse(fs.readFileSync(doorMapPath, "utf8"));
  const links: DoorLink[] = [];
  for (const [[mapName, doorId], targetMapName] of doors) {
    const involves = LEGENDS_INN_LEVEL.test(mapName) || LEGENDS_INN_LEVEL.test(targetMapName);
    if (!involves) continue;
    // Arriving anywhere lands on that level's entrance door; Craft Town's is the
    // portal the dungeon is entered through.
    const targetDoorId = targetMapName === ENTRY_LEVEL ? ENTRY_DOOR_ID : RETURN_DOOR_ID;
    links.push({ mapName, doorId, targetMapName, targetDoorId });
  }
  if (links.length === 0) throw new SwzPatchError("door_map.json has no Legends' Inn doors - run build-legends-inn-stages.ts first");
  return links;
}

function buildDoorType(link: DoorLink, indent: string, newline: string): string {
  return [
    `${indent}<DoorType>`,
    `${indent}\t<MapName>${link.mapName}</MapName>`,
    `${indent}\t<DoorID>${link.doorId}</DoorID>`,
    `${indent}\t<TargetMapName>${link.targetMapName}</TargetMapName>`,
    `${indent}\t<TargetDoorID>${link.targetDoorId}</TargetDoorID>`,
    `${indent}</DoorType>`,
  ].join(newline);
}

/** Strips whole `<Tag>...</Tag>` blocks whose body the predicate accepts. */
function removeBlocks(xml: string, tag: string, matches: (block: string) => boolean): string {
  const pattern = new RegExp(`[ \\t]*<${tag}[ >][\\s\\S]*?</${tag}>\\r?\\n?`, "g");
  return xml.replace(pattern, (block) => (matches(block) ? "" : block));
}

/**
 * Whether a name belongs to this feature.
 *
 * Always asked through LEGENDS_INN_LEVEL rather than a literal pattern: the
 * stages were renamed once already (they gained the Dread `Hard` suffix), and a
 * hand-written `LegendsInn\d*` stopped matching them. XML tolerates two
 * `<LevelType>` blocks with the same name, so the only symptom was every run of
 * this script quietly leaving the previous run's entries behind - and the client
 * reading whichever it found first, which was the stale one.
 */
function ownsLevel(name: string | undefined): boolean {
  return Boolean(name && LEGENDS_INN_LEVEL.test(name));
}

export function patchLevelTypes(xml: string): { xml: string; added: number } {
  const newline = xml.includes("\r\n") ? "\r\n" : "\n";
  const stripped = removeBlocks(xml, "LevelType", (block) =>
    ownsLevel(/LevelName="([^"]*)"/.exec(block)?.[1]),
  );

  const blocks = LEGENDS_INN_STAGES.map((stage) => {
    const source = new RegExp(`[ \\t]*<LevelType LevelName="${stage.sourceLevelName}">[\\s\\S]*?</LevelType>`).exec(stripped);
    if (!source) throw new SwzPatchError(`LevelTypes has no ${stage.sourceLevelName} to copy`);
    const block = source[0]
      .replace(/LevelName="[^"]*"/, `LevelName="${stage.levelName}"`)
      .replace(/<DisplayName>[^<]*<\/DisplayName>/, `<DisplayName>${legendsInnDisplayName()}</DisplayName>`)
      .replace(/<RankingsURL>[^<]*<\/RankingsURL>/, `<RankingsURL>legendsinn${LEGENDS_INN_STAGES.indexOf(stage) + 1}</RankingsURL>`);

    // One track for the whole dungeon, named identically in all nine stages -
    // see LEGENDS_INN_MUSIC_LOOP for why that is what keeps it playing across the
    // portals instead of restarting. Inserted rather than replaced when the
    // borrowed dungeon had no MusicLoop of its own.
    const music = `<MusicLoop>${LEGENDS_INN_MUSIC_LOOP}</MusicLoop>`;
    return /<MusicLoop>[^<]*<\/MusicLoop>/.test(block)
      ? block.replace(/<MusicLoop>[^<]*<\/MusicLoop>/, music)
      : block.replace(/(\s*)<\/LevelType>/, `$1\t${music}$1</LevelType>`);
  });

  const closing = stripped.lastIndexOf("</LevelTypes>");
  if (closing === -1) throw new SwzPatchError("LevelTypes chunk has no closing tag");
  return {
    xml: stripped.slice(0, closing) + blocks.join(newline) + newline + stripped.slice(closing),
    added: blocks.length,
  };
}

export function patchDoorTypes(xml: string, links: DoorLink[]): { xml: string; added: number } {
  const newline = xml.includes("\r\n") ? "\r\n" : "\n";
  const entryDoor = new RegExp(`<MapName>${ENTRY_LEVEL}</MapName>\\s*<DoorID>${ENTRY_DOOR_ID}</DoorID>`);
  const stripped = removeBlocks(
    xml,
    "DoorType",
    (block) =>
      [...block.matchAll(/<(?:Target)?MapName>([^<]*)</g)].some((match) => ownsLevel(match[1])) ||
      entryDoor.test(block),
  );

  // `<DoorType>` exactly - `<DoorTypes>` is the root element and sits at column 0.
  const indent = /^([ \t]*)<DoorType>/m.exec(stripped)?.[1] ?? "\t";
  const blocks = links.map((link) => buildDoorType(link, indent, newline));
  const closing = stripped.lastIndexOf("</DoorTypes>");
  if (closing === -1) throw new SwzPatchError("DoorTypes chunk has no closing tag");
  return {
    xml: stripped.slice(0, closing) + blocks.join(newline) + newline + stripped.slice(closing),
    added: blocks.length,
  };
}

/** The loose XML under content/xml mirrors the SWZ chunks; keep the two in step. */
function patchLooseXml(links: DoorLink[], verifyOnly: boolean): void {
  const files: Array<[string, (xml: string) => { xml: string; added: number }]> = [
    [path.join(CLIENT_XML_DIR, "LevelTypes.xml"), patchLevelTypes],
    [path.join(CLIENT_XML_DIR, "DoorTypes.xml"), (xml) => patchDoorTypes(xml, links)],
  ];
  for (const [filePath, patch] of files) {
    if (!fs.existsSync(filePath)) continue;
    const xml = fs.readFileSync(filePath, "utf8");
    const patched = patch(xml);
    if (!verifyOnly && patched.xml !== xml) fs.writeFileSync(filePath, patched.xml);
  }
}

function patchGameSwz(swzPath: string, verifyOnly: boolean): LegendsInnSwzStats {
  const links = readStageDoors();
  const ctx = parseSwz(swzPath);
  const levelTypes = ctx.chunks.find((chunk) => chunk.xml.includes("<LevelTypes"));
  const doorTypes = ctx.chunks.find((chunk) => chunk.xml.includes("<DoorTypes"));
  if (!levelTypes) throw new SwzPatchError("LevelTypes chunk not found in Game.swz");
  if (!doorTypes) throw new SwzPatchError("DoorTypes chunk not found in Game.swz");

  const level = patchLevelTypes(levelTypes.xml);
  const doors = patchDoorTypes(doorTypes.xml, links);

  if (!verifyOnly) {
    ensureBackup(swzPath);
    levelTypes.xml = level.xml;
    doorTypes.xml = doors.xml;
    writeSwz(ctx);
  }
  patchLooseXml(links, verifyOnly);

  return { levelTypes: level.added, doorTypes: doors.added };
}

function main(): void {
  const args = process.argv.slice(2);
  const swzPath = resolveArgPath(args, "--swz-path", defaultGameSwzPath());
  const verifyOnly = args.includes("--verify");
  const stats = patchGameSwz(swzPath, verifyOnly);

  console.log(`SWZ: ${swzPath}`);
  console.log(`LevelTypes written: ${stats.levelTypes}`);
  console.log(`DoorTypes written: ${stats.doorTypes}`);
  if (verifyOnly) console.log("verify only - nothing written");
}

if (require.main === module) {
  main();
}
