/**
 * Builds the nine Legends' Inn stage SWFs.
 *
 * Legends' Inn is a tour of Ellyria: one authored dungeon from each region, kept
 * whole. Each stage SWF is the region SWF trimmed down to the single level the
 * stage uses, with two changes - an exit door in the boss room that leads to the
 * next stage, and a repopulated bestiary.
 *
 * The bestiary is the point of the dungeon: every hostile becomes a Dread Rogue,
 * Paladin or Mage. A level SWF names a hostile by binding an empty marker sprite
 * to a class called `ac_<EntName>`, and the client reads the EntType off that
 * name, so the swap is a rename in the ABC constant pool and the SymbolClass
 * table - no new artwork, no new code, and every room script, wave group, patrol
 * and boss cutscene still drives exactly the cue it was authored against.
 * legendsInnEnemies.ts picks the names; this file applies them.
 *
 * The exit is deliberately *only* a door. The portal a player walks into is a
 * server-spawned entity that arrives when the stage's boss dies - see
 * core/LegendsInn.ts - so nothing is drawn in the boss room until it is earned.
 *
 * Trimming instead of re-authoring is what makes "the whole dungeon" possible.
 * Every room, backdrop, collision object, local door, cue and room script is the
 * shipped one, still bound to the class the region's own ABC defines, so nothing
 * has to be rebuilt out of donor classes the way a generated level does. The ABC
 * is carried over untouched; only characters the level does not reach are
 * dropped, along with the SymbolClass entries that named them.
 *
 * Sharing class names with the region SWF is safe: ResourceManager loads every
 * level file into `new ApplicationDomain(ApplicationDomain.currentDomain)`, so
 * two level SWFs never see each other's definitions.
 *
 * Stages 1-8 lose their a_LevelDirector placement. The dungeon is not over when
 * its boss dies - the portal opens the way on - and the level director is what
 * would otherwise end the run client-side.
 *
 * Usage: npm exec ts-node scripts/build-legends-inn-stages.ts [--survey] [--stage <n>]
 */
import * as fs from "fs";
import * as path from "path";
import {
  SwfFile,
  SwfLevelError,
  SwfTag,
  buildPlaceObject2,
  characterBounds,
  characterId,
  characterTagsById,
  collectDependencies,
  encodeTag,
  importCharacters,
  movePlacement,
  parsePlace,
  readAbcStrings,
  readSwfFile,
  readSymbolClasses,
  rebuildSprite,
  renameAbcStrings,
  spriteInnerTags,
  writeSwfFile,
  writeSymbolClasses,
  TAG_DEFINE_SPRITE,
  TAG_PLACE_OBJECT2,
  TAG_PLACE_OBJECT3,
} from "./swfLevelUtils";
import {
  ENTRY_DOOR_ID,
  ENTRY_LEVEL,
  LEGENDS_INN_LEVEL,
  LEGENDS_INN_PORTAL_ENT,
  LEGENDS_INN_STAGES,
  LEGENDS_INN_STAGE_DATA_FILE,
  LegendsInnStage,
  RETURN_DOOR_ID,
  STAGE_TIER,
} from "./legendsInnStages";
import {
  AssignmentContext,
  EnemyAssignment,
  PoolEntry,
  assignStageEnemies,
  createAssignmentContext,
  loadDreadClassMobPool,
  loadNamedPoolEntries,
  readEnemyCues,
  resolveRosterElements,
} from "./legendsInnEnemies";
import { bossEntName, bossesForStage } from "./legendsInnBosses";
import { disassemble, parseAbc, parseSwf } from "./swfPatchUtils";

const OP_PUSHSTRING = 0x2c;
const OP_SETPROPERTY = 0x61;
const OP_INITPROPERTY = 0x68;

const CLIENT_CONTENT = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p");
const OUT_DIR = path.join(CLIENT_CONTENT, "cbp");

/**
 * Door ids the exit portal may take, best first. Which one a stage ends up with
 * depends on the classes its region SWF exports, so the stage reports it and the
 * server config follows.
 */
const EXIT_DOOR_IDS = [2, 3, 4, 5, 6, 7, 8, 9, 10];

/** How far to the side of the boss the portal stands, in room-local pixels. */
const EXIT_STANDOFF = 250;

/** How far behind the boss - the side the portal is not on - the chest stands. */
const CHEST_STANDOFF = 200;

interface RoomInfo {
  charId: number;
  className: string;
  /** Level-space offset of the room placement, in pixels. */
  x: number;
  y: number;
}

interface Marker {
  className: string;
  instance: string | null;
  /** Room-local position, in pixels. */
  x: number;
  y: number;
}

function parseArgs(argv: string[]): { survey: boolean; stages: LegendsInnStage[] } {
  let survey = false;
  let only: number | null = null;
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--survey") survey = true;
    else if (arg === "--stage") only = Number(argv[++index]);
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: npm exec ts-node scripts/build-legends-inn-stages.ts [--survey] [--stage <n>]");
      process.exit(0);
    } else throw new SwfLevelError(`Unknown argument: ${arg}`);
  }
  if (only !== null && (!Number.isInteger(only) || only < 1 || only > LEGENDS_INN_STAGES.length)) {
    throw new SwfLevelError(`--stage must be between 1 and ${LEGENDS_INN_STAGES.length}`);
  }
  return { survey, stages: only === null ? LEGENDS_INN_STAGES : [LEGENDS_INN_STAGES[only - 1]] };
}

function spriteChildren(swf: SwfFile, id: number): Array<{ charId: number; instance: string | null; x: number; y: number }> {
  const tag = characterTagsById(swf).get(id);
  if (!tag || tag.code !== TAG_DEFINE_SPRITE) return [];
  const children: Array<{ charId: number; instance: string | null; x: number; y: number }> = [];
  for (const inner of spriteInnerTags(tag)) {
    if (inner.code !== TAG_PLACE_OBJECT2 && inner.code !== TAG_PLACE_OBJECT3) continue;
    const place = parsePlace(inner);
    if (place.charId === null) continue;
    children.push({
      charId: place.charId,
      instance: place.name,
      x: place.matrix ? place.matrix.translateX / 20 : 0,
      y: place.matrix ? place.matrix.translateY / 20 : 0,
    });
  }
  return children;
}

function readRooms(swf: SwfFile, levelId: number, nameById: Map<number, string>): RoomInfo[] {
  const rooms: RoomInfo[] = [];
  for (const child of spriteChildren(swf, levelId)) {
    const className = nameById.get(child.charId) ?? "";
    if (!/^a_Room_/.test(className)) continue;
    rooms.push({ charId: child.charId, className, x: child.x, y: child.y });
  }
  return rooms;
}

/**
 * The names the boss room announces its bosses under.
 *
 * A boss does not fight under its EntType's display name. The boss room's own
 * `InitRoom` overwrites it - `pushstring "Chief Tourzahl"; setproperty displayName`
 * - and that string is what the health bar at the bottom of the screen shows.
 * Swapping the bestiary therefore left a Dog Chieftain announcing itself as the
 * goblin chief it replaced.
 *
 * Found by disassembly rather than by a hand-written table: it is one authored
 * string per boss in nine different region SWFs, and a table would be nine
 * chances to mistype something no test could catch. Empty assignments are
 * skipped - most rooms clear the name on their ordinary hostiles.
 */
function readBossDisplayNames(swfPath: string, bossRoomClass: string): string[] {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);
  const names: string[] = [];

  for (const instance of abc.instances) {
    if ((abc.multinameNames[instance.classNameIdx] ?? "") !== bossRoomClass) continue;
    for (const trait of instance.traits) {
      if (trait.methodIdx === null) continue;
      const body = abc.methodBodies.get(trait.methodIdx);
      if (!body) continue;

      let instructions;
      try {
        instructions = disassemble(ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen), bossRoomClass);
      } catch {
        continue;
      }
      for (let index = 0; index + 1 < instructions.length; index += 1) {
        const push = instructions[index];
        const store = instructions[index + 1];
        if (push.opcode !== OP_PUSHSTRING) continue;
        if (store.opcode !== OP_SETPROPERTY && store.opcode !== OP_INITPROPERTY) continue;
        if ((abc.multinameNames[store.operands?.[0]?.[1] ?? -1] ?? "") !== "displayName") continue;
        const value = abc.stringValues[push.operands?.[0]?.[1] ?? -1] ?? "";
        if (value && !names.includes(value)) names.push(value);
      }
    }
  }

  return names;
}

/**
 * How many rooms each class appears in.
 *
 * This is what the dungeon entry screen's catalog counts - not how many bodies
 * are placed. generate-dungeon-enemy-elements.js reads a room script's cue
 * *declarations*, one per type per room, so a type placed six times in one room
 * counts once there; matching that keeps the Legends' Inn rows comparable with
 * every other dungeon's. Wave groups nest their cues inside anonymous sprites,
 * hence the walk rather than a look at the room's direct children.
 */
function countRoomsByClass(swf: SwfFile, rooms: RoomInfo[], nameById: Map<number, string>): Map<string, number> {
  const counts = new Map<string, number>();

  const collect = (charId: number, into: Set<string>, seen: Set<number>): void => {
    if (seen.has(charId)) return;
    seen.add(charId);
    for (const child of spriteChildren(swf, charId)) {
      const className = nameById.get(child.charId);
      if (className) into.add(className);
      else collect(child.charId, into, seen);
    }
  };

  for (const room of rooms) {
    const present = new Set<string>();
    collect(room.charId, present, new Set<number>());
    for (const className of present) counts.set(className, (counts.get(className) ?? 0) + 1);
  }
  return counts;
}

/**
 * Brings airborne cue placements down onto the floor.
 *
 * Several cues in these dungeons were authored for something that flies - wisps,
 * psychophage swarms, embers, imps, ghost servants - and their placements hang
 * over chasms, water and treetops on purpose. Nothing built on the Rogue, Paladin
 * or Mage skeleton flies, so once the bestiary is swapped those placements leave
 * a walking mob standing in the air, drifting up after the player.
 *
 * There is no floor plan to consult here, but the room already contains the
 * answer: every *ground* enemy in it was authored standing on walkable ground. So
 * an airborne placement takes the floor height of the nearest ground enemy across
 * from it, keeping its own x. The client then does the last of the work - it snaps
 * a spawn onto the floor within 160px, so the reference only has to be close.
 *
 * Placements are edited in place rather than rebuilt, because a cue's instance
 * name is what a room script binds it by.
 *
 * Returns how many placements moved and how many had nothing to measure against.
 */
function groundAirborneCues(
  swf: SwfFile,
  rooms: RoomInfo[],
  nameById: Map<number, string>,
  isAirborne: (className: string) => boolean,
  isGroundEnemy: (className: string) => boolean,
): { moved: number; unplaced: number } {
  let moved = 0;
  let unplaced = 0;
  // A group sprite can be placed in two rooms, and the walk would then reach the
  // same placement twice. `movePlacement` shifts by a delta, so a second visit
  // would move it again - past the floor and out of the room.
  const alreadyMoved = new Set<string>();

  for (const room of rooms) {
    // Two passes over the same subtree: one to learn where the floor is, one to
    // move what is off it. Sprite ids are tracked so a group placed twice is not
    // walked twice, and rewritten once.
    const floor: Array<{ x: number; y: number }> = [];
    const walk = (
      spriteId: number,
      offsetX: number,
      offsetY: number,
      seen: Set<number>,
      visit: (className: string, x: number, y: number, spriteId: number, index: number) => void,
    ): void => {
      if (seen.has(spriteId)) return;
      seen.add(spriteId);
      const tag = characterTagsById(swf).get(spriteId);
      if (!tag || tag.code !== TAG_DEFINE_SPRITE) return;
      spriteInnerTags(tag).forEach((inner, index) => {
        if (inner.code !== TAG_PLACE_OBJECT2 && inner.code !== TAG_PLACE_OBJECT3) return;
        const place = parsePlace(inner);
        if (place.charId === null) return;
        const x = offsetX + (place.matrix ? place.matrix.translateX / 20 : 0);
        const y = offsetY + (place.matrix ? place.matrix.translateY / 20 : 0);
        const className = nameById.get(place.charId) ?? "";
        if (className) visit(className, x, y, spriteId, index);
        else walk(place.charId, x, y, seen, visit);
      });
    };

    walk(room.charId, 0, 0, new Set<number>(), (className, x, y) => {
      if (isGroundEnemy(className)) floor.push({ x, y });
    });

    const edits = new Map<number, Map<number, number>>();
    walk(room.charId, 0, 0, new Set<number>(), (className, x, y, spriteId, index) => {
      if (!isAirborne(className)) return;
      if (alreadyMoved.has(`${spriteId}:${index}`)) return;
      if (floor.length === 0) {
        unplaced += 1;
        return;
      }
      const nearest = floor.reduce((best, point) => (Math.abs(point.x - x) < Math.abs(best.x - x) ? point : best), floor[0]);
      const dy = nearest.y - y;
      if (Math.round(dy) === 0) return;
      let bySprite = edits.get(spriteId);
      if (!bySprite) edits.set(spriteId, (bySprite = new Map<number, number>()));
      bySprite.set(index, dy);
      alreadyMoved.add(`${spriteId}:${index}`);
      moved += 1;
    });

    for (const [spriteId, byIndex] of edits) {
      const tagIndex = swf.tags.findIndex(
        (tag) => tag.code === TAG_DEFINE_SPRITE && tag.data.readUInt16LE(0) === spriteId,
      );
      if (tagIndex === -1) continue;
      const inner = spriteInnerTags(swf.tags[tagIndex]).map((tag, index) => {
        const dy = byIndex.get(index);
        return dy === undefined ? tag : movePlacement(tag, 0, dy);
      });
      swf.tags[tagIndex] = rebuildSprite(swf.tags[tagIndex], inner);
    }
  }

  return { moved, unplaced };
}

/** Functional children of a room - the ones the client resolves by class name. */
function readMarkers(swf: SwfFile, roomId: number, nameById: Map<number, string>): Marker[] {
  const markers: Marker[] = [];
  for (const child of spriteChildren(swf, roomId)) {
    const className = nameById.get(child.charId) ?? "";
    if (!className && child.instance === null) continue;
    markers.push({ className, instance: child.instance, x: child.x, y: child.y });
  }
  return markers;
}

function nextFreeDepth(spriteTag: SwfTag): number {
  let max = 0;
  for (const inner of spriteInnerTags(spriteTag)) {
    if (inner.code !== TAG_PLACE_OBJECT2 && inner.code !== TAG_PLACE_OBJECT3) continue;
    const place = parsePlace(inner);
    if (place.depth > max) max = place.depth;
  }
  return max + 1;
}

/**
 * The room the dungeon's fight ends in.
 *
 * A room named for its boss is the authored answer and wins outright. Otherwise
 * `am_Boss` marks a boss - but several rooms can carry one, since a mid-dungeon
 * mini-boss is marked the same way, so the last one placed is taken: rooms are
 * placed in the order they were authored and the finale is authored last.
 */
function findBossRoom(swf: SwfFile, rooms: RoomInfo[], nameById: Map<number, string>, override?: string): {
  room: RoomInfo;
  anchor: Marker | null;
} {
  const bossAnchor = (room: RoomInfo) =>
    readMarkers(swf, room.charId, nameById).find((marker) => marker.instance === "am_Boss") ?? null;

  if (override) {
    const room = rooms.find((entry) => entry.className === override);
    if (!room) throw new SwfLevelError(`no room named ${override} in this level`);
    return { room, anchor: bossAnchor(room) };
  }
  const named = rooms.filter((room) => /boss/i.test(room.className));
  if (named.length > 0) {
    const room = named[named.length - 1];
    return { room, anchor: bossAnchor(room) };
  }
  const marked = rooms.filter((room) => bossAnchor(room) !== null);
  if (marked.length > 0) {
    const room = marked[marked.length - 1];
    return { room, anchor: bossAnchor(room) };
  }
  return { room: rooms[rooms.length - 1], anchor: null };
}

/**
 * Where the exit portal stands, in room-local pixels.
 *
 * The boss anchor is the safest floor evidence a boss room offers - a boss is
 * authored standing on walkable ground - and any other functional marker is the
 * same kind of evidence. The portal is then stood off to one side so it does not
 * cover the fight, towards the middle of the room so the standoff cannot walk it
 * out through a wall.
 */
function exitAnchor(
  swf: SwfFile,
  room: RoomInfo,
  anchor: Marker | null,
  nameById: Map<number, string>,
): { x: number; y: number; chest: { x: number; y: number } } {
  let base = anchor ? { x: anchor.x, y: anchor.y } : null;
  if (!base) {
    const markers = readMarkers(swf, room.charId, nameById).filter((marker) =>
      /^(ac_|a_Target_|a_DoorLocal_|a_PlayerSpawn)/.test(marker.className),
    );
    if (markers.length === 0) throw new SwfLevelError(`${room.className} has no anchor to place the exit portal on`);
    // Furthest into the room, so the portal reads as the way onward.
    base = markers.reduce((best, marker) => (marker.x > best.x ? marker : best), markers[0]);
  }
  const bounds = characterBounds(swf, room.charId);
  if (!bounds) return { ...base, chest: { x: base.x + CHEST_STANDOFF, y: base.y } };
  const middle = (bounds.xMin + bounds.xMax) / 40;
  const towardsMiddle = base.x > middle ? -1 : 1;
  return {
    x: base.x + towardsMiddle * EXIT_STANDOFF,
    y: base.y,
    // The chest stands on the far side of the boss from the portal - "behind" it,
    // from where the party comes in - so the fight has to be finished before it can
    // be reached, and so the two things that appear in this room do not overlap.
    chest: { x: base.x - towardsMiddle * CHEST_STANDOFF, y: base.y },
  };
}

/**
 * The chest cue a stage places behind its boss.
 *
 * The chest is drawn from the level's own `ac_TreasureChest*` classes rather than
 * imported, for the same reason the hostiles are: a cue is a name, the artwork
 * comes from the EntType, and a SymbolClass entry naming a class the SWF's own ABC
 * does not define is a ReferenceError the moment the room is built.
 *
 * `TreasureChestLarge` is the one we want - the big gold chest - so a stage whose
 * ABC does not define it has one of its other chest classes renamed into it.
 * That renames the level's own chests along with ours, which is cosmetic: they
 * keep their loot, and the stage chest is told apart by *where it stands* (see
 * `StageBuild.chest`), never by its EntType.
 */
function chestCue(
  swf: SwfFile,
  symbols: Array<{ id: number; name: string }>,
  poolStrings: Set<string>,
): { charId: number; rename: [string, string] | null } {
  const wanted = "ac_TreasureChestLarge";
  const exact = symbols.find((entry) => entry.name === wanted);
  if (exact) return { charId: exact.id, rename: null };

  // Best art first. Medium is a chest of the same family; Empty is the plain one
  // the tutorial's reward chests use, and is the last resort.
  for (const className of ["ac_TreasureChestMedium", "ac_TreasureChestEmpty", "ac_QuestTreasureChest"]) {
    const binding = symbols.find((entry) => entry.name === className);
    if (!binding) continue;
    if (poolStrings.has(wanted)) return { charId: binding.id, rename: null };
    return { charId: binding.id, rename: [className, wanted] };
  }
  throw new SwfLevelError("no ac_TreasureChest class in this SWF for the boss chest");
}

/**
 * A door class the region SWF exports and the level does not already place, so
 * both the class and the door id behind it are free for the exit.
 */
function freeDoorClass(
  swf: SwfFile,
  symbols: Array<{ id: number; name: string }>,
  rooms: RoomInfo[],
  nameById: Map<number, string>,
): { className: string; doorId: number; charId: number } {
  const used = new Set<string>();
  for (const room of rooms) {
    for (const marker of readMarkers(swf, room.charId, nameById)) used.add(marker.className);
  }
  for (const doorId of EXIT_DOOR_IDS) {
    const className = `a_Door_${doorId}`;
    if (used.has(className)) continue;
    const binding = symbols.find((entry) => entry.name === className);
    if (binding) return { className, doorId, charId: binding.id };
  }
  throw new SwfLevelError(`no free a_Door_ class in this SWF for the exit portal`);
}

/**
 * Moves a set of characters, and everything they depend on, in front of a sprite
 * so that sprite may place them.
 *
 * Flash constructs a sprite from the definitions it has already seen. A
 * placement naming a character defined further down the file throws
 * `Error #2136: ... contains invalid data` out of `constructChildren`, blamed on
 * the sprite's class rather than on the placement. Imported characters land just
 * ahead of SymbolClass - after every room - so they always need this.
 */
function hoistBefore(swf: SwfFile, ids: Set<number>, spriteId: number): void {
  const spriteIndex = swf.tags.findIndex(
    (tag) => tag.code === TAG_DEFINE_SPRITE && tag.data.readUInt16LE(0) === spriteId,
  );
  if (spriteIndex === -1) throw new SwfLevelError(`sprite ${spriteId} not found`);

  const needed = new Set<number>();
  for (const id of ids) for (const dependency of collectDependencies(swf, [id])) needed.add(dependency);
  needed.delete(spriteId);

  const moving: SwfTag[] = [];
  const kept: SwfTag[] = [];
  swf.tags.forEach((tag, index) => {
    const id = characterId(tag);
    if (id !== null && index > spriteIndex && needed.has(id)) moving.push(tag);
    else kept.push(tag);
  });
  if (moving.length === 0) return;

  const movedIndex = kept.findIndex(
    (tag) => tag.code === TAG_DEFINE_SPRITE && tag.data.readUInt16LE(0) === spriteId,
  );
  kept.splice(movedIndex, 0, ...moving);
  swf.tags = kept;
}

/**
 * Every placement must name a character the file has already defined. Shipped
 * levels do place characters that were deleted outright, which Flash ignores, so
 * only a definition that arrives too late is an error.
 */
function assertDefinitionOrder(swf: SwfFile, label: string): void {
  const definedAt = new Map<number, number>();
  swf.tags.forEach((tag, index) => {
    const id = characterId(tag);
    if (id !== null && !definedAt.has(id)) definedAt.set(id, index);
  });
  swf.tags.forEach((tag, index) => {
    if (tag.code !== TAG_DEFINE_SPRITE) return;
    for (const inner of spriteInnerTags(tag)) {
      if (inner.code !== TAG_PLACE_OBJECT2 && inner.code !== TAG_PLACE_OBJECT3) continue;
      const place = parsePlace(inner);
      if (place.charId === null) continue;
      const definition = definedAt.get(place.charId);
      if (definition !== undefined && definition > index) {
        throw new SwfLevelError(
          `${label}: sprite ${tag.data.readUInt16LE(0)} places character ${place.charId}, which is defined later`,
        );
      }
    }
  });
}

/** Shape characters. Nothing that extends MovieClip can be bound to one. */
const SHAPE_TAGS = new Set([2, 22, 32, 83]);

/**
 * Every class the level binds must still name the same kind of character it was
 * authored against. A trim frees ids and an import reuses them, so a stale
 * binding can silently land on unrelated artwork; a class that extends MovieClip
 * bound to a shape is `Error #2136` at the moment that shape is constructed.
 */
function assertBindingsMatchTags(swf: SwfFile, label: string): void {
  const byId = characterTagsById(swf);
  for (const binding of readSymbolClasses(swf)) {
    const tag = byId.get(binding.id);
    if (!tag) throw new SwfLevelError(`${label}: ${binding.name} is bound to missing character ${binding.id}`);
    // Fonts and text fields are bound too and are fine; a shape is not, because
    // every a_/ac_ class in a level SWF extends MovieClip.
    if (SHAPE_TAGS.has(tag.code)) {
      throw new SwfLevelError(
        `${label}: ${binding.name} is bound to character ${binding.id}, which is a shape (tag ${tag.code})`,
      );
    }
  }
}

/**
 * Font characters, which survive a trim whatever the dependency walk says.
 *
 * `DefineEditText` is not one of the character tags swfLevelUtils models, so it
 * is carried over untouched - but nothing ever walks it, and the font it names
 * is a real character that the walk therefore never reaches. An EditText left
 * pointing at a dropped font makes the sprite holding it invalid, which Flash
 * reports as `Error #2136` against that sprite's class. These levels carry one or
 * two fonts each, so keeping all of them costs nothing.
 */
const FONT_TAGS = new Set([10, 48, 75]);

/** Drops every character the kept roots do not reach, and the bindings that named them. */
function trim(swf: SwfFile, keep: Set<number>): void {
  swf.tags = swf.tags.filter((tag) => {
    const id = characterId(tag);
    if (id !== null) return keep.has(id) || FONT_TAGS.has(tag.code);
    if (tag.code === TAG_PLACE_OBJECT2 || tag.code === TAG_PLACE_OBJECT3) {
      // Root-frame placements of characters that are gone would otherwise draw
      // whatever ends up at that id.
      const place = parsePlace(tag);
      return place.charId === null || keep.has(place.charId);
    }
    return true;
  });
}

interface StageBuild {
  spec: LegendsInnStage;
  /** Door the exit portal ended up on; the chain in door_map follows it. */
  exitDoorId: number;
  /** Level-space a_PlayerSpawn, which is where an arrival lands. */
  spawn: { x: number; y: number } | null;
  /** Level-space point the exit door stands on, i.e. where the portal is spawned. */
  exit: { x: number; y: number };
  /**
   * Level-space point the boss chest stands on.
   *
   * The server needs it because the *class* cannot tell the stage chest from the
   * dungeon's own decorative chests - several stages have one, and one of them
   * shares the class after the rename. Where it stands is the only thing that is
   * unambiguously ours.
   */
  chest: { x: number; y: number };
  /** What this stage's boss ended up being. The portal opens when it dies. */
  bosses: string[];
  /** Every hostile the stage now places, for the entry screen and the build log. */
  roster: EnemyAssignment["roster"];
  /** New EntType -> how many rooms it stands in, for the entry screen's catalog. */
  roomCounts: Map<string, number>;
  /** Room class names, in the order the level places them. */
  rooms: string[];
  /** Airborne placements brought down onto the floor, and any that had no floor. */
  grounded: { moved: number; unplaced: number };
}

function buildStage(
  spec: LegendsInnStage,
  stageIndex: number,
  survey: boolean,
  pool: PoolEntry[],
  context: AssignmentContext,
): StageBuild | null {
  const source = readSwfFile(path.join(CLIENT_CONTENT, spec.swf));
  const symbols = readSymbolClasses(source);
  const nameById = new Map(symbols.map((entry) => [entry.id, entry.name]));

  const levelBinding = symbols.find((entry) => entry.name === spec.levelClass);
  if (!levelBinding) throw new SwfLevelError(`${spec.swf} has no ${spec.levelClass}`);

  const rooms = readRooms(source, levelBinding.id, nameById);
  if (rooms.length === 0) throw new SwfLevelError(`${spec.levelClass} has no a_Room_ children`);

  const boss = findBossRoom(source, rooms, nameById, spec.bossRoom);
  const anchor = exitAnchor(source, boss.room, boss.anchor, nameById);
  const door = freeDoorClass(source, symbols, rooms, nameById);
  // Decided before the trim, because the trim has to be told to keep it.
  const chest = chestCue(source, symbols, new Set(readAbcStrings(source)));

  // Where the player lands coming in. Dungeons spawn arrivals on a_PlayerSpawn.
  let spawn: { x: number; y: number } | null = null;
  let entranceDoor: { x: number; y: number } | null = null;
  for (const room of rooms) {
    for (const marker of readMarkers(source, room.charId, nameById)) {
      if (marker.className === "a_PlayerSpawn" && !spawn) spawn = { x: room.x + marker.x, y: room.y + marker.y };
      if (marker.className === "a_Door_1" && !entranceDoor) entranceDoor = { x: room.x + marker.x, y: room.y + marker.y };
    }
  }

  const levelDirectors = spriteChildren(source, levelBinding.id).filter((child) =>
    /^a_LevelDirector/.test(nameById.get(child.charId) ?? ""),
  );

  // The bestiary swap, decided before anything is written so --survey can show it.
  //
  // Only classes the level itself reaches: a region SWF exports every enemy the
  // whole region uses, and this stage is one dungeon out of it. Rolling a Dread
  // mob for a cue that the trim is about to delete would spend the roster on
  // enemies nobody meets and, worse, count a neighbouring dungeon's boss as this
  // stage's - which is what opens the exit portal.
  const reachable = collectDependencies(source, [levelBinding.id]);
  const cues = readEnemyCues(
    DATA_DIR,
    symbols.filter((entry) => reachable.has(entry.id)).map((entry) => entry.name),
  );
  // The stage's guardians, by name rather than by roll - see legendsInnBosses.ts.
  // Resolved from EntTypes.json so the roster row a boss produces carries the same
  // level, rank and display name an ordinary pick would.
  const guardians = bossesForStage(stageIndex + 1);
  const enemies = assignStageEnemies(
    cues,
    {
      classWeights: spec.classWeights,
      levelBand: spec.enemyLevelBand,
      bossClass: spec.bossClass,
      bossRank: spec.bossRank,
      rankPlan: spec.rankPlan,
      bossOverrides: loadNamedPoolEntries(
        DATA_DIR,
        guardians.map((boss) => `${bossEntName(boss)}Hard`),
      ),
    },
    pool,
    context,
    new Set(symbols.filter((entry) => entry.name.startsWith("ac_")).map((entry) => entry.name.slice(3))),
  );

  // Counted against the *old* class names, because that is what the rooms still
  // place at this point; the catalog reports them under the Dread names the
  // client will actually ask for.
  const roomsByOldClass = countRoomsByClass(source, rooms, nameById);
  const roomCounts = new Map<string, number>();
  for (const row of enemies.roster) {
    const count = roomsByOldClass.get(`ac_${row.from}`) ?? 0;
    if (count > 0) roomCounts.set(row.to, count);
  }

  if (survey) {
    console.log(`\n=== ${spec.levelName}  ${spec.region}  ${spec.swf}/${spec.levelClass}`);
    console.log(`    rooms ${rooms.length}: ${rooms.map((room) => room.className).join(", ")}`);
    console.log(`    boss room ${boss.room.className}${boss.anchor ? ` (am_Boss @ ${boss.anchor.x.toFixed(0)}, ${boss.anchor.y.toFixed(0)})` : " (no am_Boss, using last room)"}`);
    console.log(`    exit door ${door.className} at room-local (${anchor.x.toFixed(0)}, ${anchor.y.toFixed(0)}), level-space (${(boss.room.x + anchor.x).toFixed(0)}, ${(boss.room.y + anchor.y).toFixed(0)})`);
    console.log(`    a_PlayerSpawn ${spawn ? `(${spawn.x.toFixed(0)}, ${spawn.y.toFixed(0)})` : "MISSING"}, a_Door_1 ${entranceDoor ? `(${entranceDoor.x.toFixed(0)}, ${entranceDoor.y.toFixed(0)})` : "MISSING"}`);
    console.log(`    level directors: ${levelDirectors.map((child) => nameById.get(child.charId)).join(", ") || "(none)"}`);
    console.log(`    keeps ${reachable.size} of ${characterTagsById(source).size} characters`);
    console.log(`    spare a_Animation: ${symbols.filter((entry) => /^a_Animation/.test(entry.name) && !reachable.has(entry.id)).map((entry) => entry.name).join(", ") || "(none)"}`);
    console.log(`    bestiary (${enemies.roster.length}): ${enemies.roster.map((row) => `${row.from} -> ${row.to}`).join(", ")}`);
    console.log(`    boss: ${enemies.bosses.join(", ") || "(none)"}`);
    return null;
  }

  // 1. Trim to the one level, plus the door marker character the exit needs.
  const fontsBefore = source.tags.filter((tag) => FONT_TAGS.has(tag.code)).length;
  const keep = new Set(reachable);
  for (const id of collectDependencies(source, [door.charId])) keep.add(id);
  for (const id of collectDependencies(source, [chest.charId])) keep.add(id);
  trim(source, keep);
  const fontsAfter = source.tags.filter((tag) => FONT_TAGS.has(tag.code)).length;
  if (fontsAfter !== fontsBefore) {
    throw new SwfLevelError(`${spec.levelName}: trim dropped ${fontsBefore - fontsAfter} of ${fontsBefore} fonts`);
  }
  // Which characters may still carry a class, decided before anything is
  // imported. An import reuses the ids the trim just freed, so a binding kept on
  // the strength of "some character has that id now" would hand a dead class -
  // a room, a level - to a shape that only happens to have inherited its id, and
  // Flash cannot build a MovieClip subclass out of a shape (Error #2136).
  const boundable = new Set(source.tags.map(characterId).filter((id): id is number => id !== null));

  // 2. Place the exit door and the boss chest.
  //
  //    The door is *only* a door - a door marker is drawn hidden, so the boss room
  //    gains nothing visible from it. What the player eventually walks into is
  //    spawned by the server once the boss is down, on this same point.
  //
  //    The chest is a real cue and is there from the moment the room loads, behind
  //    the boss: it cannot be reached until the fight is over, and it is what the
  //    stage actually pays out (core/LegendsInnChest.ts).
  hoistBefore(source, new Set([door.charId, chest.charId]), boss.room.charId);

  const roomIndex = source.tags.findIndex(
    (tag) => tag.code === TAG_DEFINE_SPRITE && tag.data.readUInt16LE(0) === boss.room.charId,
  );
  if (roomIndex === -1) throw new SwfLevelError(`boss room ${boss.room.className} was trimmed away`);
  const roomTag = source.tags[roomIndex];
  const depth = nextFreeDepth(roomTag);
  const portalAt = {
    x: anchor.x + (spec.exitOffset?.x ?? 0),
    y: anchor.y + (spec.exitOffset?.y ?? 0),
  };
  const inner = spriteInnerTags(roomTag);
  const showFrame = inner.findIndex((tag) => tag.code === 1);
  inner.splice(
    showFrame === -1 ? inner.length - 1 : showFrame,
    0,
    buildPlaceObject2({ depth, charId: door.charId, x: portalAt.x, y: portalAt.y }),
    buildPlaceObject2({ depth: depth + 1, charId: chest.charId, x: anchor.chest.x, y: anchor.chest.y }),
  );
  source.tags[roomIndex] = rebuildSprite(roomTag, inner);

  // 3. Stages before the last must not end when their boss dies.
  const isLastStage = stageIndex === LEGENDS_INN_STAGES.length - 1;
  if (!isLastStage && levelDirectors.length > 0) {
    const levelIndex = source.tags.findIndex(
      (tag) => tag.code === TAG_DEFINE_SPRITE && tag.data.readUInt16LE(0) === levelBinding.id,
    );
    if (levelIndex === -1) throw new SwfLevelError(`level sprite ${spec.levelClass} was trimmed away`);
    const levelTag = source.tags[levelIndex];
    const directorIds = new Set(levelDirectors.map((child) => child.charId));
    const kept = spriteInnerTags(levelTag).filter((tag) => {
      if (tag.code !== TAG_PLACE_OBJECT2 && tag.code !== TAG_PLACE_OBJECT3) return true;
      const place = parsePlace(tag);
      return place.charId === null || !directorIds.has(place.charId);
    });
    source.tags[levelIndex] = rebuildSprite(levelTag, kept);
  }

  // 4. Bring the airborne placements down. This runs against the level's original
  //    class names, before the rename, because "was this cue authored for
  //    something that flies" is a fact about what the level used to hold.
  const airborne = new Set(cues.filter((cue) => cue.flying).map((cue) => cue.className));
  const grounded = groundAirborneCues(
    source,
    rooms,
    nameById,
    (className) => airborne.has(className),
    (className) => cues.some((cue) => cue.className === className && !cue.flying),
  );

  // 5. Repopulate the bestiary. A hostile's identity is the class name bound to
  //    its marker sprite and nothing else, so renaming the string in the ABC
  //    constant pool and in the SymbolClass table is the whole swap. Both have to
  //    move together: the pool is what makes the class exist, the table is what
  //    binds it to the marker, and a table entry naming a class the pool no
  //    longer defines is a ReferenceError the moment the room is constructed.
  //    The boss's plate rides along. Its name is a string the boss room writes
  //    over the EntType's, so it has to be renamed the same way the classes are -
  //    otherwise the stage's new boss fights under the name of the one it replaced.
  const bossNames = readBossDisplayNames(path.join(CLIENT_CONTENT, spec.swf), boss.room.className);
  const poolStrings = new Set(readAbcStrings(source));
  // The chest class rides the same mechanism, and has to reach both the pool and
  // the SymbolClass table for exactly the reason the paragraph above gives.
  const classRenames = new Map(enemies.renames);
  if (chest.rename) classRenames.set(chest.rename[0], chest.rename[1]);
  for (const [from, to] of Object.entries(spec.cueRenames ?? {})) {
    if (!symbols.some((entry) => entry.name === from)) {
      throw new SwfLevelError(`${spec.levelName}: no ${from} to rename to ${to}`);
    }
    classRenames.set(from, to);
  }
  const renames = new Map(classRenames);
  bossNames.forEach((authored, index) => {
    // Keyed off the boss *cue*, not the rank: `rank === "Boss"` does not identify
    // the thing whose name belongs on the health bar, and stage 9 was the visible
    // symptom - its plate kept announcing the shipped dungeon's boss because no
    // roster row matched.
    //
    // No `Dread ` prefix any more. That prefix existed to stop a borrowed name
    // ("Hive Guardian") reading as the dungeon it was borrowed from; the guardians
    // have names of their own now, and "Dread Vehr the Courier" reads as a typo.
    const replacement = enemies.roster.filter((row) => row.bossSlot)[index]?.displayName ?? "";
    if (!replacement || replacement === authored) return;
    // renameAbcStrings refuses to create a name the pool already holds, and a
    // clash here would abort a build over a health-bar caption.
    if (poolStrings.has(replacement)) {
      console.log(`             boss plate "${authored}" left alone: "${replacement}" is already in the pool`);
      return;
    }
    renames.set(authored, replacement);
    poolStrings.add(replacement);
  });

  const renamed = renameAbcStrings(source, renames);
  if (renamed < renames.size) {
    throw new SwfLevelError(
      `${spec.levelName}: renamed ${renamed} of ${renames.size} strings in the ABC pool`,
    );
  }

  // 6. Rewrite the bindings: a SymbolClass entry naming a character that the
  //    trim removed is fatal at load, so only what survived the trim may stay.
  writeSymbolClasses(
    source,
    symbols
      .filter((entry) => boundable.has(entry.id))
      .map((entry) => ({ id: entry.id, name: classRenames.get(entry.name) ?? entry.name })),
  );
  assertDefinitionOrder(source, spec.levelName);
  assertBindingsMatchTags(source, spec.levelName);

  const out = path.join(OUT_DIR, spec.outFile);
  writeSwfFile(out, source);
  const size = fs.statSync(out).size;
  const exit = { x: boss.room.x + portalAt.x, y: boss.room.y + portalAt.y };
  console.log(
    `${spec.levelName.padEnd(16)} ${spec.region.padEnd(16)} ${rooms.length} rooms  boss ${boss.room.className}  ` +
      `exit ${door.className} @ (${exit.x.toFixed(0)}, ${exit.y.toFixed(0)})  ` +
      `${isLastStage ? "keeps" : "drops"} level director  -> ${spec.outFile} ${(size / 1024 / 1024).toFixed(2)} MB`,
  );
  if (spawn) console.log(`                 a_PlayerSpawn (${spawn.x.toFixed(0)}, ${spawn.y.toFixed(0)})`);
  console.log(`                 ${enemies.roster.length} hostiles -> ${describeRoster(enemies.roster)}`);
  console.log(`                 boss ${enemies.bosses.join(" + ") || "(none)"}`);
  if (grounded.moved > 0 || grounded.unplaced > 0) {
    console.log(`                 grounded ${grounded.moved} airborne placements${grounded.unplaced ? `, ${grounded.unplaced} with no floor to measure` : ""}`);
  }
  return {
    spec,
    exitDoorId: door.doorId,
    spawn,
    exit,
    chest: { x: boss.room.x + anchor.chest.x, y: boss.room.y + anchor.chest.y },
    bosses: enemies.bosses,
    roster: enemies.roster,
    roomCounts,
    rooms: rooms.map((room) => room.className),
    grounded,
  };
}

/** "7 Rogue / 4 Paladin / 3 Mage", the one line that says whether a stage read right. */
function describeRoster(roster: EnemyAssignment["roster"]): string {
  const counts = new Map<string, number>();
  for (const row of roster) counts.set(row.mobClass, (counts.get(row.mobClass) ?? 0) + 1);
  return ["Rogue", "Paladin", "Mage"]
    .filter((mobClass) => counts.has(mobClass))
    .map((mobClass) => `${counts.get(mobClass)} ${mobClass}`)
    .join(" / ");
}

// ---------------------------------------------------------------------------
// Configuration the stages imply
//
// Which door the portal landed on and where a stage's spawn is are decided by
// the build, so the build writes the config that depends on them rather than
// leaving hand-copied values to drift the next time the stage list changes.
// ---------------------------------------------------------------------------

const DATA_DIR = path.resolve(__dirname, "..", "data");
const CLIENT_XML_DIR = path.resolve(__dirname, "..", "..", "client", "content", "xml");
const SWZ_LIST_DIR = path.join(CLIENT_CONTENT, "cbq");
const MASTER_FILE_LISTS = [
  path.join(CLIENT_XML_DIR, "MasterFileList.xml"),
  path.join(SWZ_LIST_DIR, "masterFileList.xml"),
  path.join(SWZ_LIST_DIR, "masterFileList_1.xml"),
  path.join(SWZ_LIST_DIR, "masterFileList_2.xml"),
];

/** JSON in this tree is CRLF and some of it carries a BOM, which JSON.parse rejects. */
function readJson(filePath: string): any {
  return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^﻿/, ""));
}

function writeText(filePath: string, text: string, crlf: boolean): void {
  fs.writeFileSync(filePath, crlf ? text.replace(/\r?\n/g, "\r\n") : text);
}

/**
 * Registers each stage as its own dungeon level, in the block reserved for them.
 *
 * The trailing `Hard` is what makes Legends' Inn a Dread dungeon rather than a
 * dungeon full of Dread-named mobs: `LevelConfig` reads it into `LevelSpec.isHard`,
 * which is what puts the run on the Dread reward tables and the Dread stat caps
 * and what labels it "Dread Legends' Inn" in presence.
 *
 * `mapId - baseId` is the stage's monster bonus, and it is per stage because the
 * roster is: the gap is whatever lifts the *weakest* mob the stage rolled onto
 * row 50. The server reads it back through `getHostileHpTier`, and core/LegendsInn.ts
 * sends the same number to the client as `mBonusLevels`, which is the half that
 * actually decides how much health a hostile has.
 */
/**
 * How many levels this stage's monsters are lifted by.
 *
 * Enough for the weakest EntType in the roster to reach STAGE_TIER; everything
 * stronger clamps there, because the health table ends at row 50. Derived from
 * the roster rather than declared, so it cannot drift when the roster is rerolled.
 */
function monsterBonusLevels(build: StageBuild): number {
  const lowest = build.roster.reduce((least, row) => Math.min(least, row.level), Number.POSITIVE_INFINITY);
  return Number.isFinite(lowest) ? Math.max(0, STAGE_TIER - lowest) : 0;
}

function writeLevelConfig(builds: StageBuild[]): void {
  const filePath = path.join(DATA_DIR, "level_config.json");
  const raw = fs.readFileSync(filePath, "utf8");
  const config: Record<string, string> = JSON.parse(raw);

  const entries: Array<[string, string]> = [];
  let placed = false;
  const stageEntries = (): Array<[string, string]> =>
    builds.map((build) => [
      build.spec.levelName,
      `${build.spec.outFile}/${build.spec.levelClass} ${STAGE_TIER + monsterBonusLevels(build)} ${STAGE_TIER} true Hard`,
    ]);

  for (const [key, value] of Object.entries(config)) {
    if (LEGENDS_INN_LEVEL.test(key)) continue;
    entries.push([key, value]);
    if (key.includes("LEGENDS INN")) {
      entries.push(...stageEntries());
      placed = true;
    }
  }
  if (!placed) entries.push(...stageEntries());

  writeText(filePath, `${JSON.stringify(Object.fromEntries(entries), null, 4)}\n`, raw.includes("\r\n"));
  console.log(`level_config.json  ${builds.length} stages`);
}

/** Chains the stages: entry -> 1 -> 2 -> ... -> 9 -> back out. */
function writeDoorMap(builds: StageBuild[]): void {
  const filePath = path.join(DATA_DIR, "door_map.json");
  const raw = fs.readFileSync(filePath, "utf8");
  const doors: Array<[[string, number], string]> = JSON.parse(raw);

  const kept = doors.filter(
    ([[level, doorId], target]) =>
      !LEGENDS_INN_LEVEL.test(level) && !LEGENDS_INN_LEVEL.test(target) && !(level === ENTRY_LEVEL && doorId === ENTRY_DOOR_ID),
  );
  const added: Array<[[string, number], string]> = [[[ENTRY_LEVEL, ENTRY_DOOR_ID], builds[0].spec.levelName]];
  for (let index = 0; index < builds.length; index += 1) {
    const build = builds[index];
    const next = builds[index + 1];
    added.push([[build.spec.levelName, RETURN_DOOR_ID], ENTRY_LEVEL]);
    added.push([[build.spec.levelName, build.exitDoorId], next ? next.spec.levelName : ENTRY_LEVEL]);
  }

  const trailing = raw.endsWith("\n") ? "\n" : "";
  fs.writeFileSync(filePath, JSON.stringify([...kept, ...added]) + trailing);
  console.log(`door_map.json      ${added.length} doors`);
}

/**
 * Arrival points. A dungeon lands its arrivals on a_PlayerSpawn, and both doors
 * a stage owns are entered from outside it, so both point at the same place.
 */
function writeDoorSpawns(builds: StageBuild[]): void {
  const filePath = path.join(DATA_DIR, "door_spawn_map.json");
  const raw = fs.readFileSync(filePath, "utf8");
  const spawns: Record<string, Record<string, { x: number; y: number }>> = JSON.parse(raw);

  for (const key of Object.keys(spawns)) if (LEGENDS_INN_LEVEL.test(key)) delete spawns[key];
  for (const build of builds) {
    if (!build.spawn) continue;
    spawns[build.spec.levelName] = { [String(RETURN_DOOR_ID)]: { x: Math.round(build.spawn.x), y: Math.round(build.spawn.y) } };
  }

  // Re-emitted in the file's own hand-written shape so the diff stays local.
  const levels = Object.entries(spawns).map(([level, doors]) => {
    const rows = Object.entries(doors).map(([doorId, point]) => `    "${doorId}": { "x": ${point.x}, "y": ${point.y} }`);
    return `  "${level}": {\n${rows.join(",\n")}\n  }`;
  });
  writeText(filePath, `{\n${levels.join(",\n")}\n}\n`, raw.includes("\r\n"));
  console.log(`door_spawn_map.json ${builds.filter((build) => build.spawn).length} arrivals`);
}

/**
 * Completion. Only the last stage ends the run: the stages before it are a road,
 * and a road that reports itself finished would hand out the reward eight times
 * over and close the dungeon under the party's feet.
 */
function writeCompletionConditions(builds: StageBuild[]): void {
  const filePath = path.join(DATA_DIR, "dungeon_completion_conditions.json");
  const raw = fs.readFileSync(filePath, "utf8");
  const crlf = raw.includes("\r\n");
  const conditions = readJson(filePath).levels as Record<string, unknown>;

  // Keyed off LEGENDS_INN_LEVEL rather than a literal, so renaming the stages
  // cannot leave the old rows behind - JSON tolerates a duplicate key, so the
  // only symptom would have been the file growing nine entries per rebuild.
  const ownedEntry = (line: string) => {
    const name = /^\s*"([^"]+)"\s*:/.exec(line)?.[1];
    return Boolean(name && LEGENDS_INN_LEVEL.test(name));
  };
  const lines = raw.replace(/\r\n/g, "\n").split("\n").filter((line) => !ownedEntry(line));
  const isEntry = (line: string) => /^\s{4}"[^"]+"\s*:/.test(line);
  let lastEntry = -1;
  for (let index = 0; index < lines.length; index += 1) if (isEntry(lines[index])) lastEntry = index;
  if (lastEntry === -1) throw new SwfLevelError("dungeon_completion_conditions.json has no level entries");
  if (!lines[lastEntry].trimEnd().endsWith(",")) lines[lastEntry] = `${lines[lastEntry].trimEnd()},`;

  const added = builds.map((build, index) => {
    const last = index === builds.length - 1;
    const inherited = conditions[build.spec.sourceLevelName];
    if (last && !inherited) throw new SwfLevelError(`no completion condition to inherit from ${build.spec.sourceLevelName}`);
    const condition = last ? inherited : { mode: "disabled" };
    return `    "${build.spec.levelName}": ${JSON.stringify(condition)}${index === builds.length - 1 ? "" : ","}`;
  });
  lines.splice(lastEntry + 1, 0, ...added);

  writeText(filePath, lines.join("\n"), crlf);
  console.log(`dungeon_completion_conditions.json  ${builds.length - 1} disabled, 1 inherited`);
}

/**
 * The dungeon entry screen's enemy catalog.
 *
 * It can no longer be inherited from the dungeon a stage was copied from: the
 * rooms are the same but nothing standing in them is, so the catalog is built
 * from what the stage actually places now. The shape has to be the one
 * generate-dungeon-enemy-elements.js writes for every other dungeon, because two
 * things read it - the entry screen takes `elements`, and GameData walks
 * `enemyTypes` to learn which EntTypes count as a level's bosses.
 */
function writeEnemyElements(builds: StageBuild[]): void {
  const filePath = path.join(DATA_DIR, "dungeon_enemy_elements.json");
  const raw = fs.readFileSync(filePath, "utf8");
  const manifest = readJson(filePath) as Record<string, unknown>;

  for (const key of Object.keys(manifest)) if (LEGENDS_INN_LEVEL.test(key)) delete manifest[key];
  for (const build of builds) {
    const enemyTypes = [...build.roomCounts.entries()]
      .sort((left, right) => (right[1] !== left[1] ? right[1] - left[1] : left[0].localeCompare(right[0])))
      .map(([enemyType, count]) => ({ enemyType, count }));

    manifest[build.spec.levelName] = {
      elements: resolveRosterElements(DATA_DIR, build.roomCounts.keys()),
      enemyTypes,
      source: "level-swf",
      rooms: [...build.rooms].sort(),
    };
  }
  writeText(filePath, `${JSON.stringify(manifest, null, 2)}\n`, raw.includes("\r\n"));
  console.log(`dungeon_enemy_elements.json ${builds.length} catalogs`);
}

/**
 * What the server needs to know about a stage that only the build can know.
 *
 * The exit door id depends on which `a_Door_` classes the region SWF happened to
 * export, the door's world position depends on where the boss was authored, and
 * the boss's name depends on the roster the build just rolled. Writing them here
 * is what keeps core/LegendsInn.ts from carrying a hand-copied second opinion.
 */
function writeStageData(builds: StageBuild[]): void {
  const filePath = path.join(DATA_DIR, LEGENDS_INN_STAGE_DATA_FILE);
  const stages = builds.map((build, index) => ({
    levelName: build.spec.levelName,
    region: build.spec.region,
    stage: index + 1,
    exitDoorId: build.exitDoorId,
    returnDoorId: RETURN_DOOR_ID,
    // The number the client is handed as mBonusLevels. Kept beside the roster it
    // was derived from so the two can never disagree.
    monsterBonusLevels: monsterBonusLevels(build),
    portal: { x: Math.round(build.exit.x), y: Math.round(build.exit.y) },
    chest: { x: Math.round(build.chest.x), y: Math.round(build.chest.y) },
    bosses: build.bosses,
    enemies: [...new Set(build.roster.map((row) => row.to))],
  }));

  fs.writeFileSync(filePath, `${JSON.stringify({ portalEnt: LEGENDS_INN_PORTAL_ENT, stages }, null, 2)}\n`);
  console.log(`${LEGENDS_INN_STAGE_DATA_FILE}  ${stages.length} stages`);
}

/** Lists the client downloads level SWFs from. */
function writeMasterFileLists(builds: StageBuild[]): void {
  const rows = builds.map((build) => {
    const size = Math.round(fs.statSync(path.join(OUT_DIR, build.spec.outFile)).size / 1024);
    return `  <Level Version="cbp"\t\t\t\t Size="${size}" Name="${build.spec.outFile}" />`;
  });
  // These files mix line endings, so they are edited in place rather than split
  // and rejoined - normalising them would rewrite every untouched row.
  const stageRow = /^[^\n]*Name="LevelsLI\d*\.swf"[^\n]*\r?\n/gm;
  for (const filePath of MASTER_FILE_LISTS) {
    if (!fs.existsSync(filePath)) throw new SwfLevelError(`${filePath} not found`);
    const raw = fs.readFileSync(filePath, "utf8");
    const eol = /Name="LevelsLD\.swf"[^\n]*(\r?\n)/.exec(raw)?.[1] ?? (raw.includes("\r\n") ? "\r\n" : "\n");
    const block = rows.join(eol) + eol;

    const existing = [...raw.matchAll(stageRow)];
    let out: string;
    if (existing.length > 0) {
      const first = existing[0].index as number;
      out = raw.replace(stageRow, (_match, offset) => (offset === first ? block : ""));
    } else {
      // Level rows are alphabetical, and LevelsLI0N sorts where LevelsLI did.
      const anchor = /^[^\n]*Name="LevelsN[^\n]*\r?\n/m.exec(raw);
      if (!anchor) throw new SwfLevelError(`${filePath} has no place to list the stages`);
      const at = anchor.index;
      out = raw.slice(0, at) + block + raw.slice(at);
    }
    fs.writeFileSync(filePath, out);
  }
  console.log(`master file lists  ${rows.length} entries in ${MASTER_FILE_LISTS.length} files`);
}

function writeConfig(builds: StageBuild[]): void {
  writeLevelConfig(builds);
  writeDoorMap(builds);
  writeDoorSpawns(builds);
  writeCompletionConditions(builds);
  writeEnemyElements(builds);
  writeStageData(builds);
  writeMasterFileLists(builds);
}

function main(): void {
  const { survey, stages } = parseArgs(process.argv);
  const pool = loadDreadClassMobPool(DATA_DIR);
  // One context for the whole run, so the tour keeps introducing faces it has not
  // used yet. `--stage N` therefore rolls the roster stage 1 would have taken;
  // that is why a partial build never rewrites the config.
  const context = createAssignmentContext();
  const builds: StageBuild[] = [];
  for (const spec of stages) {
    const build = buildStage(spec, LEGENDS_INN_STAGES.indexOf(spec), survey, pool, context);
    if (build) builds.push(build);
  }
  if (survey) return;

  const total = stages.reduce((sum, spec) => {
    const file = path.join(OUT_DIR, spec.outFile);
    return sum + (fs.existsSync(file) ? fs.statSync(file).size : 0);
  }, 0);
  console.log(`\ntotal ${(total / 1024 / 1024).toFixed(2)} MB across ${stages.length} stage SWFs`);

  if (builds.length !== LEGENDS_INN_STAGES.length) {
    console.log("partial build - config not rewritten, run without --stage to update it");
    return;
  }
  console.log("");
  writeConfig(builds);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
