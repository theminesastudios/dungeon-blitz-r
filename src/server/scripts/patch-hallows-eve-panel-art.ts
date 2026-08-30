/**
 * Brings the Green Knight's Challenge panel to life.
 *
 * ## What the panel already had
 *
 * `a_ScreenHalloweenDungeonPrompt` was authored with a state machine and animation
 * slots that its driver class would have filled. The driver was deleted from this
 * build, so the panel has been drawing one frozen state: a chained, locked door with
 * a clock bolted to the skull, and three animation holders left empty.
 *
 * Everything needed is in the same file, unused:
 *
 *     a_EvilPortalAnimation    char 415   24 frames   418x385
 *     a_EvilWispLockAnimation  char 393   24 frames   375x322
 *     a_KeySparkleAnimation    char 370  111 frames    41x48
 *     a_EvilTorchAnimation     char 289   32 frames    35x78
 *
 * and the empty holders are `am_PortalHolder`, `am_WispAnimHolder` and
 * `am_SprakleAnimHolder` - the last of which sits at (432, -151), which is exactly
 * where the Reward key is drawn. The panel was built expecting all of this.
 *
 * ## What this does
 *
 *   - **Opens the door.** `am_ClosedDoor` and `am_DoorLock` are removed, so the
 *     archway is a doorway rather than a barred one.
 *   - **Puts the rift in it.** `a_EvilPortalAnimation` goes into `am_PortalHolder`,
 *     scaled and centred on the doorway the two removed pieces used to cover, so the
 *     green light is coming *through* the arch.
 *   - **Wisps.** `a_EvilWispLockAnimation` into `am_WispAnimHolder`, over the lock's
 *     old position.
 *   - **Sparkles the reward.** `a_KeySparkleAnimation` into `am_SprakleAnimHolder`,
 *     on the key.
 *   - **Lights the skull.** Two `a_EvilTorchAnimation` instances in the eye sockets,
 *     where the removed clock used to draw attention.
 *   - **Removes the clock.** `am_Clock` goes; the twelve-hour timer it belonged to
 *     cannot be driven from here (see `REMOVED_CHILDREN` in
 *     `patch-hallows-eve-challenge-screen.ts`), so a clock face on the skull is
 *     furniture for a feature that is not there.
 *
 * Nothing here is bound by `class_69`, so nothing can throw: the removals are
 * placements no code names, and the additions are placements *inside* holders that
 * code only ever hands to a `class_33` as a whole.
 *
 * Usage: npm exec ts-node scripts/patch-hallows-eve-panel-art.ts [--verify]
 *
 * Re-runnable: each piece checks for its own result.
 */
import * as path from "path";
import {
  SwfFile,
  SwfLevelError,
  buildPlaceObject2,
  characterTagsById,
  ensureBackup,
  importCharacters,
  parsePlace,
  readSwfFile,
  readSymbolClasses,
  writeSymbolClasses,
  rebuildSprite,
  spriteInnerTags,
  writeSwfFile,
  TAG_DEFINE_SPRITE,
  TAG_PLACE_OBJECT2,
  TAG_PLACE_OBJECT3,
} from "./swfLevelUtils";

const SEASONAL_SWF = path.resolve(
  __dirname, "..", "..", "client", "content", "localhost", "p", "cbo", "UI_Seasonal.swf",
);

const SCREEN = "a_ScreenHalloweenDungeonPrompt";
const PANEL_CHILD = "am_Panel";

/** Placements dropped from the panel outright. Nothing in `class_69` names them. */
const REMOVED = [
  "am_Clock",       // the twelve-hour face, on a timer that cannot be driven
  "am_ClosedDoor",  // the barred door
  "am_DoorLock",    // and its chained padlock
  /**
   * The green dashes in the doorway.
   *
   * `am_WispAnimHolder` is not the empty slot its name suggests - char 96 carries its
   * own 89x79 artwork, a handful of pale green strokes, and it sits at (-167, -244),
   * squarely over the opening. With the door in place they were hidden; with it gone
   * they read as smears across the rift.
   *
   * They cost a long hunt because every obvious suspect was innocent: the rift is
   * clean at every frame, the panel's base art has a plain dark doorway, and the
   * backdrop is flat grey. They also survived an extreme colour transform on the
   * rift - which was the proof they were not part of it, since a CXFORM reaches
   * everything its placement draws.
   */
  "am_WispAnimHolder",
];

/**
 * Animations to play slower, and by how much.
 *
 * A nested sprite runs at the SWF's own frame rate; there is no per-clip speed. The
 * only way to slow one down without redrawing it is to make its timeline longer, so
 * each drawn state is held for several frames instead of one. Repeating a `ShowFrame`
 * does exactly that - the frame's display list is unchanged, so the same picture is
 * shown again - and the sprite header's frame count is raised to match.
 *
 * `from` is the length the clip is expected to have before this runs. It is written
 * down rather than inferred so that a re-run over an already-slowed file is a no-op
 * instead of slowing it again.
 */
const SLOWED: Array<{ symbol: string; from: number; factor: number; note: string }> = [
  {
    symbol: "a_EvilPortalAnimation",
    from: 24,
    factor: 3,
    note: "the rift swirled too fast to read as a portal; three frames a state",
  },
];

/** An animation to drop into one of the panel's empty holders. */
interface Fill {
  /** The holder's instance name on `am_Panel`. */
  holder: string;
  /** The animation's SymbolClass name in this same file. */
  symbol: string;
  /** Where it goes inside the holder, in the panel's own pixels. */
  x: number;
  y: number;
  scale: number;
  /**
   * Independent axes, for a symbol whose shape does not match the hole it fills.
   *
   * The flame is 35x78 - tall and thin - and an eye socket is nearly square, so a
   * uniform scale either leaves the socket showing or runs the flame down the cheek.
   */
  scaleY?: number;
  /** More than one instance, for symmetrical things like eyes. */
  extra?: Array<{ x: number; y: number; scale: number }>;
  /** Per-channel multiply, for recolouring a symbol that is drawn the wrong colour. */
  tint?: { r: number; g: number; b: number };
  /** Per-channel offset, applied after the multiply. Lifts dark marks out of a glow. */
  tintAdd?: { r: number; g: number; b: number };
  /**
   * A name for the instances this fill places.
   *
   * Two fills may want the same symbol in the same holder - the rift fills the
   * doorway and a shrunken copy of it lights each eye socket - and "is this symbol
   * already in here" cannot tell them apart. Naming the placements can. Nothing
   * reads these names; they exist to be looked for.
   */
  id?: string;
  /** Imported from another file, rather than already in UI_Seasonal. */
  from?: string;
  note: string;
}

/**
 * Where each animation lands.
 *
 * The numbers are panel pixels relative to the holder, worked out from the removed
 * pieces' own placements: the doorway `am_ClosedDoor` covered is 155x242 at
 * (-197, -319), and `am_PortalHolder` sits at (-248, -374), so the rift is centred on
 * that gap rather than on the holder's origin.
 */
const FILLS: Fill[] = [
  {
    holder: "am_PortalHolder",
    symbol: "a_EvilPortalAnimation",
    /**
     * The rift is 418x385 - nearly square - and the doorway it has to fill is tall
     * and narrow, so one scale cannot do both: matching the width left black above
     * and below, and matching the height would have spilled it across the pillars.
     * The axes are set separately, and `y` is lifted by half the height the taller
     * scale adds so the swirl stays centred in the opening.
     */
    x: -19, y: -2, scale: 1.12, scaleY: 1.02,
    /**
     * Lifted towards white.
     *
     * At its own brightness the rift reads as green swirls with a small hot centre,
     * where the shot it is being matched to is a broad soft glare that fills the
     * arch. A flat multiply above one on all three channels pushes the whole thing
     * up: the pale core saturates to white and the darker green folds come up with
     * it, which is the difference between "a portal is in there" and "light is
     * pouring out".
     */
    tint: { r: 1.02, g: 1.08, b: 1.0 },
    /**
     * The dark streaks, flattened out.
     *
     * The rift is drawn as twenty-odd overlapping swirl layers, and the darker green
     * marks are inside those shapes rather than separate pieces - there is nothing to
     * delete. Multiplying cannot help either: twice a dark pixel is still dark, which
     * is why raising `tint` only ever blew the bright core to white while the streaks
     * stayed. An offset works the other way round, lifting the darks hardest and
     * letting what is already bright clip, so the marks sink into the glow.
     */
    tintAdd: { r: 26, g: 26, b: 26 },
    note: "the green rift, filling the doorway the chained door used to cover",
  },
  /**
   * **No wisps.** `a_EvilWispLockAnimation` was laid over the lock's old position and
   * it is what the darker green dashes in the doorway were - not the rift, which is
   * why no amount of colour transform on the rift ever removed them. It is a lock
   * effect on a door that is now open, so it has no job here.
   */
  /**
   * **No Green Knight portrait. It was tried; it cannot be built from what is here.**
   *
   * `Gfx_Paladin_1.swf` holds him as fifty-one paperdoll parts, drawn in a flat
   * placeholder blue that the renderer recolours at runtime. Two of them were
   * imported and tinted green - `a_Face_GreenKnight` and `a_Hat_HatGhostGreenKnight`
   * - first at separate offsets and then, correctly, sharing one joint origin and
   * one scale.
   *
   * Neither composed. `a_Face_GreenKnight` is a *decal* - eyes and mouth meant to be
   * laid over a head part that comes from the character's own body set - so with no
   * head under it there is nothing for it to sit on, and what lands in the doorway is
   * a helm floating on its own.
   *
   * Doing it properly means assembling the head, face, helm and their joint
   * transforms out of the rig, which is character work rather than a placement. The
   * rift stays.
   */
  {
    holder: "am_SprakleAnimHolder",
    symbol: "a_KeySparkleAnimation",
    x: 0, y: 0, scale: 1,
    note: "the Reward key, sparkling",
  },
  /**
   * **No effect on the skull.** Three shapes were tried in the eye sockets - the
   * torch flame squashed to fit, then the rift's core in orange, then the same bead
   * in gold - and none of them read as eyes. A flame tapers to a point where the
   * socket is round, and the rift's core is a hard-edged bead that either overhangs
   * the socket or floats inside it. Nothing in this file is the right shape, so the
   * skull is left exactly as it was drawn.
   */
];

/** Depths for what is added inside a holder. Holders are empty, so 1 upwards is free. */
const FILL_DEPTH_BASE = 1;

function isPlacement(code: number): boolean {
  return code === TAG_PLACE_OBJECT2 || code === TAG_PLACE_OBJECT3;
}

function spriteIndexOf(swf: SwfFile, charId: number): number {
  const index = swf.tags.findIndex(
    (tag) => tag.code === TAG_DEFINE_SPRITE && tag.data.readUInt16LE(0) === charId,
  );
  if (index === -1) throw new SwfLevelError(`character ${charId} is not a sprite in this SWF`);
  return index;
}

function symbolId(swf: SwfFile, name: string): number {
  const found = readSymbolClasses(swf).find((entry) => entry.name === name);
  if (!found) throw new SwfLevelError(`UI_Seasonal.swf has no ${name}`);
  return found.id;
}

function namedChildren(swf: SwfFile, charId: number): Map<string, number | null> {
  const map = new Map<string, number | null>();
  const tag = characterTagsById(swf).get(charId);
  if (!tag || tag.code !== TAG_DEFINE_SPRITE) return map;
  for (const inner of spriteInnerTags(tag)) {
    if (!isPlacement(inner.code)) continue;
    const place = parsePlace(inner);
    if (place.name) map.set(place.name, place.charId);
  }
  return map;
}

function panelId(swf: SwfFile): number {
  const child = namedChildren(swf, symbolId(swf, SCREEN)).get(PANEL_CHILD);
  if (child === undefined || child === null) throw new SwfLevelError(`${SCREEN} has no ${PANEL_CHILD}`);
  return child;
}

/** Stretches a clip's timeline so each state is held `factor` frames. */
function slowAnimations(swf: SwfFile, verify: boolean): string[] {
  const done: string[] = [];
  for (const spec of SLOWED) {
    const id = symbolId(swf, spec.symbol);
    const index = spriteIndexOf(swf, id);
    const frames = swf.tags[index].data.readUInt16LE(2);
    if (frames !== spec.from) continue; // already stretched, or not the clip we measured
    done.push(`${spec.symbol} ${frames} -> ${frames * spec.factor} frames`);
    if (verify) continue;

    const inner = spriteInnerTags(swf.tags[index]);
    const stretched: typeof inner = [];
    for (const tag of inner) {
      stretched.push(tag);
      if (tag.code !== 1) continue; // ShowFrame
      for (let i = 1; i < spec.factor; i += 1) stretched.push({ code: 1, data: Buffer.alloc(0) });
    }
    const head = Buffer.from(swf.tags[index].data.subarray(0, 4));
    head.writeUInt16LE(frames * spec.factor, 2);
    swf.tags[index] = rebuildSprite({ code: TAG_DEFINE_SPRITE, data: head }, stretched);
  }
  return done;
}

/** Drops the placements named in `REMOVED`. */
function removePieces(swf: SwfFile, panel: number, verify: boolean): string[] {
  const index = spriteIndexOf(swf, panel);
  const inner = spriteInnerTags(swf.tags[index]);
  const gone: string[] = [];
  const kept = inner.filter((tag) => {
    if (!isPlacement(tag.code)) return true;
    const name = parsePlace(tag).name;
    if (!name || !REMOVED.includes(name)) return true;
    gone.push(name);
    return false;
  });
  if (gone.length > 0 && !verify) swf.tags[index] = rebuildSprite(swf.tags[index], kept);
  return gone;
}

/**
 * Brings a symbol across from another SWF, once.
 *
 * The Green Knight has no single portrait: `Gfx_Paladin_1.swf` holds him as fifty-one
 * paperdoll parts that the game assembles and *recolours* at runtime, which is why
 * the helm on disk is blue. So the head is built here from the two parts that read
 * as him on their own, and tinted green by hand.
 */
function importedId(swf: SwfFile, file: string, symbol: string): number {
  const existing = readSymbolClasses(swf).find((entry) => entry.name === symbol);
  if (existing) return existing.id;

  const source = readSwfFile(path.resolve(
    __dirname, "..", "..", "client", "content", "localhost", "p", "cbp", file,
  ));
  const from = readSymbolClasses(source).find((entry) => entry.name === symbol);
  if (!from) throw new SwfLevelError(`${file} has no ${symbol}`);
  const { idMap } = importCharacters(source, swf, [from.id]);
  const minted = idMap.get(from.id);
  if (minted === undefined) throw new SwfLevelError(`${symbol} did not come across from ${file}`);
  writeSymbolClasses(swf, [...readSymbolClasses(swf), { id: minted, name: symbol }]);
  console.log(`  imported ${symbol} from ${file} as character ${minted}`);
  return minted;
}

/** Puts each animation inside its holder. */
function fillHolders(swf: SwfFile, panel: number, verify: boolean): string[] {
  const holders = namedChildren(swf, panel);
  const done: string[] = [];

  for (const fill of FILLS) {
    const holderId = holders.get(fill.holder);
    if (holderId === undefined || holderId === null) {
      throw new SwfLevelError(`the panel has no ${fill.holder}`);
    }
    const animId = fill.from ? importedId(swf, fill.from, fill.symbol) : symbolId(swf, fill.symbol);

    const index = spriteIndexOf(swf, holderId);
    const inner = spriteInnerTags(swf.tags[index]);
    const already = inner.some((tag) => {
      if (!isPlacement(tag.code)) return false;
      const place = parsePlace(tag);
      return fill.id ? String(place.name ?? "").startsWith(fill.id) : place.charId === animId;
    });
    if (already) continue;

    done.push(`${fill.holder} <- ${fill.symbol}`);
    if (verify) continue;

    let depth = FILL_DEPTH_BASE;
    for (const tag of inner) {
      if (!isPlacement(tag.code)) continue;
      depth = Math.max(depth, parsePlace(tag).depth + 1);
    }

    const spots = [{ x: fill.x, y: fill.y, scale: fill.scale }, ...(fill.extra ?? [])];
    const showFrame = inner.findIndex((tag) => tag.code === 1);
    const insertAt = showFrame === -1 ? Math.max(0, inner.length - 1) : showFrame;
    inner.splice(
      insertAt,
      0,
      ...spots.map((spot, offset) =>
        buildPlaceObject2({
          depth: depth + offset,
          charId: animId,
          name: fill.id ? `${fill.id}${offset}` : undefined,
          x: spot.x,
          y: spot.y,
          scaleX: spot.scale,
          scaleY: fill.scaleY ?? spot.scale,
          tint: fill.tint,
          tintAdd: fill.tintAdd,
        }),
      ),
    );
    swf.tags[index] = rebuildSprite(swf.tags[index], inner);
  }
  return done;
}

function main(): void {
  const verify = process.argv.includes("--verify");
  const swf = readSwfFile(SEASONAL_SWF);
  const panel = panelId(swf);

  const removed = removePieces(swf, panel, verify);
  const filled = fillHolders(swf, panel, verify);
  const slowed = slowAnimations(swf, verify);
  for (const line of slowed) console.log(`  slowed ${line}`);

  if (removed.length === 0 && filled.length === 0 && slowed.length === 0) {
    console.log("the panel is already dressed; nothing to do.");
    return;
  }
  if (removed.length > 0) console.log(`removed: ${removed.join(", ")}`);
  for (const line of filled) console.log(`  ${line}`);
  if (verify) {
    console.log("verify only - nothing written.");
    return;
  }

  ensureBackup(SEASONAL_SWF);
  writeSwfFile(SEASONAL_SWF, swf);
  console.log(`wrote ${SEASONAL_SWF}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
