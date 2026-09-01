/**
 * Lays the Hallow's Eve coffers panel into the client's lockbox screen.
 *
 * ## Why the art moves and not the class
 *
 * Clicking a coffer opens `screenLockBox` - `class_73`, bound to
 * `a_ScreenLockBoxAD` in `UI_4.swf`. The obvious move was to repoint that class at
 * `a_ScreenHalloweenCoffers`, the way `class_69` was repointed at the dungeon
 * prompt. **It does not work.** `class_73`'s constructor is
 *
 *     super(param1,"a_ScreenLockBoxAD",null)
 *
 * and a null third argument means `var_2` is the *screen root*, not a panel inside
 * it. `OnCreateScreen` then reads eighteen children off that root - `am_Open`,
 * `am_Ok`, `am_OpenAnother`, `am_GetKeys`, `am_GetTroves`, `am_OpenSigilStore`,
 * `am_KeyCounter`, `am_LockboxCounter`, `am_EarnedSigils`, `am_Lockbox`,
 * `am_OpenButtonBase`, `am_RewardFloater0/1`, `am_RewardsTooltip`,
 * `am_SigilFloatAnim`, `am_SparkleContainer`, `am_SparkleFoutainContainer`,
 * `am_AmbientGlowContainer` - and the seasonal screen's root carries exactly one
 * child, `am_Panel`. Repointing would have produced a beautiful skull grid with no
 * Open button, no key counter and no reward reveal, and three of those names are
 * `DefineEditText`, which the SWF utilities here cannot carry across files at all.
 *
 * So the traffic runs the other way. `a_ScreenHalloweenCoffers`'s `am_Panel` is
 * imported into `UI_4.swf` and laid into `a_ScreenLockBoxAD` on a depth of its own.
 * The class is untouched, its bytecode is untouched, and every button still does
 * what it did.
 *
 * ## One screen, two lockboxes
 *
 * `a_ScreenLockBoxAD` is also the Treasure Trove screen, so an unconditional skin
 * dresses troves as coffers too. That is why **nothing here is destructive any
 * more**: an earlier pass dropped the lockbox's own backdrop and emptied
 * `am_RewardsTooltip`, which left the trove with no window to open in. This script
 * only *adds* a placement. Which of the two screens the player is looking at is
 * decided at runtime, by `patch-dungeonblitz-hallows-eve-coffer-screen.ts`, off
 * `mLockboxData.mLockboxID`: the panel is shown for the coffer and hidden for
 * everything else, and the lockbox room behind it never goes anywhere.
 *
 * ## The fit
 *
 * The two screens were authored on the same stage - `a_ScreenLockBoxAD`'s backdrop
 * and the seasonal panel are both 1155x669px, to the pixel - so at scale 1 the
 * panel covers the client edge to edge and its outer decor (the forest, the
 * pumpkin tree) runs under the game's own border. It goes in at `SKIN_SCALE`
 * instead, centred on the backdrop, which pulls that decor in off the edges and
 * leaves the lockbox room showing as a surround. The chest, the Open button and
 * the key counters all still land inside the shrunk panel's skull grid, so nothing
 * the class draws ends up standing on bare stone.
 *
 * The panel keeps its own `am_Close`. DONE - `am_Ok` - is trove furniture and is
 * switched off with the rest of it, so the X at the panel's top right is what the
 * coffer screen closes on; the runtime patch binds it to the same handler DONE had.
 *
 * Usage: npm exec ts-node scripts/patch-ui4-hallows-eve-coffer-skin.ts [--verify]
 *
 * Re-runnable: the skin is placed under an instance name. A file that already
 * carries it has only its placement rewritten, so the scale can be retuned without
 * importing the artwork a second time.
 */
import * as path from "path";
import {
  Bounds,
  SwfFile,
  SwfLevelError,
  SwfTag,
  appendCharacterTag,
  buildPlaceObject2,
  buildSprite,
  characterBounds,
  ensureBackup,
  importCharacters,
  maxCharacterId,
  parsePlace,
  readSwfFile,
  readSymbolClasses,
  rebuildSprite,
  spriteInnerTags,
  writeSwfFile,
  TAG_DEFINE_SPRITE,
  TAG_END,
  TAG_PLACE_OBJECT2,
  TAG_PLACE_OBJECT3,
  TAG_SHOW_FRAME,
} from "./swfLevelUtils";

const CLIENT_CONTENT = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p");
const SEASONAL_SWF = path.join(CLIENT_CONTENT, "cbo", "UI_Seasonal.swf");
const UI4_SWF = path.join(CLIENT_CONTENT, "cbp", "UI_4.swf");

/** The screen the coffer opens, and the seasonal screen it borrows its face from. */
const HOST_SCREEN = "a_ScreenLockBoxAD";
const DONOR_SCREEN = "a_ScreenHalloweenCoffers";

/** The donor's one root child - the whole panel. */
const DONOR_PANEL_CHILD = "am_Panel";

/** What the imported panel is placed under. The runtime patch toggles this name. */
const SKIN_NAME = "am_HallowsEveSkin";

/**
 * Where the skin goes, and what is pushed under it.
 *
 * The screen's own furniture is spread up the depth list: the room on 1, a hairline
 * on 3, the pedestal the chest stands on on 4, the Open plate on 6, `am_Ok` on 8,
 * and the chest itself right up on 93. Anything the panel is meant to hide has to
 * be *below* it, because a placement cannot be hidden by name unless it has one -
 * and the room, the hairline and the pedestal are all unnamed.
 *
 * So the panel goes on 5 and the pedestal is moved down to 2, which leaves the
 * three unnamed pieces stacked under it. Everything above 5 either has an instance
 * name (and is switched at runtime by
 * `patch-dungeonblitz-hallows-eve-coffer-screen.ts`) or belongs on top of the panel
 * anyway: the two reward floaters on 71 and 79 keep drawing the prize over the
 * skull grid, and `am_Ok` on 8 is left where it was authored so the trove screen is
 * untouched - on the coffer screen it is switched off and the panel's own X closes
 * the window instead.
 */
const SKIN_DEPTH = 5;

/** The room the skin is centred on, by depth. Nothing here is removed. */
const HOST_BACKDROP_DEPTH = 1;

/** The pedestal, and the free depth it is moved to so the panel covers it. */
const PLINTH_DEPTH = 4;
const PLINTH_NEW_DEPTH = 2;

/**
 * The screen's unnamed placements, gathered under names the runtime patch can hide.
 *
 * A placement with no instance name cannot be addressed by anything: `getChildByName`
 * has nothing to look up and `visible` has nothing to set. Two runs of them are in
 * the way of the coffer board:
 *
 *   - **The room** on depths 1, 2 and 3 - the lockbox chamber's own backdrop, the
 *     pedestal (moved down to 2 by `PLINTH_NEW_DEPTH`) and a hairline drawn on it.
 *     The panel goes in at `SKIN_SCALE`, so the room shows around it: bare wooden
 *     boards under the board's own stonework.
 *   - **The sigil row** on 64, 66 and 68 - a plate, a coin and the amount, with
 *     `am_EarnedSigils` and `am_OpenSigilStore` sitting on them. It is the trove's
 *     shop and the coffers has no shop, but hiding only the two named pieces leaves
 *     the plate they stood on.
 *
 * Each run is lifted into a sprite of its own, placed back at the lowest of its
 * depths under one instance name. The placement tags are carried across untouched -
 * a colour transform or blend mode survives - and a sprite placed at the identity
 * draws its children exactly where they were, so the trove screen is unchanged.
 */
const WRAPPED_GROUPS: Array<{ name: string; depths: number[] }> = [
  { name: "am_LockBoxRoom", depths: [1, PLINTH_NEW_DEPTH, 3] },
  { name: "am_SigilPlate", depths: [64, 66, 68] },
];

/**
 * How much of the screen the panel is allowed to cover.
 *
 * It ran at 0.85 for a while, on the reasoning that a panel filling the client
 * corner to corner put its forest decor under the game's own border. That was true
 * while the lockbox room was still drawn behind it - the inset read as a window
 * standing in a room. It is not true any more: `am_LockBoxRoom` takes the room off
 * the coffer screen entirely, so the inset stopped framing anything and started
 * exposing whatever the screen had left lying at its edges.
 *
 * So it goes back to 1, which is not a guess - the panel and the screen it replaces
 * were authored on the same stage, both 1155x669px to the pixel. Corner to corner
 * *is* the fit. Everything the class draws on top of it - the two reward floaters,
 * the chest during a reveal, the sparkles - sits on depths above the panel and is
 * unaffected.
 */
const SKIN_SCALE = 1;

function isPlacement(code: number): boolean {
  return code === TAG_PLACE_OBJECT2 || code === TAG_PLACE_OBJECT3;
}

/**
 * Rewrites a placement's depth in place.
 *
 * The two bytes are edited rather than the tag rebuilt: a `PlaceObject2` may carry a
 * colour transform, a blend mode, filters or a clip depth after its matrix, and
 * re-emitting one from a parsed matrix would quietly drop whichever of those the
 * original had. Depth sits at a fixed offset in both tags - after one flag byte in
 * `PlaceObject2`, after two in `PlaceObject3` - so nothing else has to be understood.
 */
function setPlacementDepth(tag: SwfTag, depth: number): SwfTag {
  const data = Buffer.from(tag.data);
  data.writeUInt16LE(depth, tag.code === TAG_PLACE_OBJECT3 ? 2 : 1);
  return { code: tag.code, data };
}

function spriteIndexOf(swf: SwfFile, charId: number): number {
  const index = swf.tags.findIndex(
    (tag) => tag.code === TAG_DEFINE_SPRITE && tag.data.readUInt16LE(0) === charId,
  );
  if (index === -1) throw new SwfLevelError(`character ${charId} is not a sprite in this SWF`);
  return index;
}

function screenSprite(swf: SwfFile, name: string): { id: number; index: number } {
  const symbol = readSymbolClasses(swf).find((entry) => entry.name === name);
  if (!symbol) throw new SwfLevelError(`no ${name} in this SWF`);
  return { id: symbol.id, index: spriteIndexOf(swf, symbol.id) };
}

/** The donor's `am_Panel` character id. */
function donorPanelId(seasonal: SwfFile): number {
  const screen = screenSprite(seasonal, DONOR_SCREEN);
  for (const inner of spriteInnerTags(seasonal.tags[screen.index])) {
    if (!isPlacement(inner.code)) continue;
    const place = parsePlace(inner);
    if (place.name === DONOR_PANEL_CHILD && place.charId !== null) return place.charId;
  }
  throw new SwfLevelError(`${DONOR_SCREEN} has no ${DONOR_PANEL_CHILD}`);
}

/** The character already standing under `SKIN_NAME`, if this ran before. */
function existingSkinId(ui4: SwfFile): number | null {
  const host = screenSprite(ui4, HOST_SCREEN);
  for (const inner of spriteInnerTags(ui4.tags[host.index])) {
    if (!isPlacement(inner.code)) continue;
    const place = parsePlace(inner);
    if (place.name === SKIN_NAME && place.charId !== null) return place.charId;
  }
  return null;
}

/**
 * Lifts one run of unnamed placements into a named sprite.
 *
 * Returns the screen's children with the run swapped for the wrapper, or exactly
 * what it was handed when there is nothing to do - which is what a second run sees,
 * because by then the only placement on those depths is the wrapper, and it has a
 * name.
 */
function wrapUnnamed(ui4: SwfFile, children: SwfTag[], group: { name: string; depths: number[] }): SwfTag[] {
  const wrapped = children.filter(
    (tag) => isPlacement(tag.code) && group.depths.includes(parsePlace(tag).depth) && !parsePlace(tag).name,
  );
  if (wrapped.length === 0) {
    console.log(`  ${group.name}: nothing unnamed left on depths ${group.depths.join(", ")}`);
    return children;
  }

  const spriteId = maxCharacterId(ui4) + 1;
  const empty = buildSprite({ id: spriteId, placements: [] });
  // The originals go in as they are: rebuilding a placement from a parsed matrix
  // would drop any colour transform or blend mode it carries.
  appendCharacterTag(
    ui4,
    rebuildSprite(empty, [
      ...wrapped,
      { code: TAG_SHOW_FRAME, data: Buffer.alloc(0) },
      { code: TAG_END, data: Buffer.alloc(0) },
    ]),
  );

  const kept = children.filter((tag) => !wrapped.includes(tag));
  // At the front, not the back: the last two tags in a sprite are ShowFrame and
  // End, and both `splitTags` and the player stop reading at End - a placement
  // appended past it is simply never seen. Order among placements does not matter,
  // because what draws over what is the depth.
  kept.unshift(
    buildPlaceObject2({
      depth: Math.min(...group.depths),
      charId: spriteId,
      name: group.name,
    }),
  );
  console.log(`  ${group.name}: wrapped ${wrapped.length} placement(s) into character ${spriteId}`);
  return kept;
}

/**
 * Reports the panel's own close button, which the coffer screen closes on.
 *
 * An earlier pass dropped it, on the grounds that the lockbox screen has no close
 * button at its root and an X that did nothing would be worse than none. It does
 * something now: `am_Ok` - the DONE button - is trove furniture and goes off with
 * the rest of it, so `patch-dungeonblitz-hallows-eve-coffer-screen.ts` binds this X
 * to `method_1132`, which is the very handler DONE was bound to. It is a three-frame
 * button 40x38 at the panel's top right, which is where the event's own screenshots
 * show it.
 */
function reportNestedClose(ui4: SwfFile, panelId: number): void {
  const index = spriteIndexOf(ui4, panelId);
  const found = spriteInnerTags(ui4.tags[index]).some(
    (tag) => isPlacement(tag.code) && parsePlace(tag).name === "am_Close",
  );
  console.log(
    found
      ? "  the imported panel carries am_Close; the runtime patch binds it to the DONE handler"
      : "  WARNING: the imported panel has no am_Close - the coffer screen will have no way out",
  );
}

/**
 * Where the panel goes so that its drawn area is centred on the room's and scaled
 * by `SKIN_SCALE`.
 *
 * Both are measured rather than guessed: a sprite's bounds are relative to its own
 * origin, and this panel's origin sits down at its bottom right, so the offset
 * between the two is nothing like zero.
 */
function skinPlacement(panel: Bounds, backdrop: Bounds): { x: number; y: number } {
  const panelMidX = (panel.xMin + panel.xMax) / 2;
  const panelMidY = (panel.yMin + panel.yMax) / 2;
  const roomMidX = (backdrop.xMin + backdrop.xMax) / 2;
  const roomMidY = (backdrop.yMin + backdrop.yMax) / 2;
  return {
    x: (roomMidX - SKIN_SCALE * panelMidX) / 20,
    y: (roomMidY - SKIN_SCALE * panelMidY) / 20,
  };
}

function main(): void {
  const verify = process.argv.includes("--verify");

  const ui4 = readSwfFile(UI4_SWF);
  const host = screenSprite(ui4, HOST_SCREEN);

  // The room the skin is centred on. It stays exactly where it is - the trove
  // screen is this artwork with the skin hidden.
  let backdropId: number | null = null;
  for (const inner of spriteInnerTags(ui4.tags[host.index])) {
    if (!isPlacement(inner.code)) continue;
    const place = parsePlace(inner);
    if (place.depth === HOST_BACKDROP_DEPTH && place.charId !== null) backdropId = place.charId;
  }
  if (backdropId === null) {
    throw new SwfLevelError(
      `${HOST_SCREEN} has no backdrop on depth ${HOST_BACKDROP_DEPTH}; this file has been ` +
        "patched destructively - restore it from git before running this",
    );
  }
  const backdrop = characterBounds(ui4, backdropId);
  if (!backdrop) throw new SwfLevelError(`the ${HOST_SCREEN} backdrop has no measurable bounds`);

  // A file that already carries the skin keeps the artwork it imported; only the
  // placement is rewritten, so re-running cannot stack 92 characters on itself.
  const carried = existingSkinId(ui4);
  let panelId: number;
  let seasonal: SwfFile | null = null;
  if (carried !== null) {
    panelId = carried;
    console.log(`${HOST_SCREEN} already carries ${SKIN_NAME} (character ${panelId}); re-placing it`);
  } else {
    seasonal = readSwfFile(SEASONAL_SWF);
    panelId = donorPanelId(seasonal);
    console.log(
      `${DONOR_SCREEN}/${DONOR_PANEL_CHILD} = character ${panelId} in ${path.basename(SEASONAL_SWF)}`,
    );
  }

  const panel = characterBounds(seasonal ?? ui4, panelId);
  if (!panel) throw new SwfLevelError(`character ${panelId} has no measurable bounds`);

  const panelWidth = panel.xMax - panel.xMin;
  const panelHeight = panel.yMax - panel.yMin;
  const roomWidth = backdrop.xMax - backdrop.xMin;
  const roomHeight = backdrop.yMax - backdrop.yMin;
  if (Math.abs(panelHeight - roomHeight) > 40 || Math.abs(panelWidth - roomWidth) > 40) {
    throw new SwfLevelError(
      `the two screens are not the same size (${panelWidth}x${panelHeight} vs ` +
        `${roomWidth}x${roomHeight} twips); this patch assumes they were authored on one stage`,
    );
  }

  const at = skinPlacement(panel, backdrop);
  const inset = (roomWidth * (1 - SKIN_SCALE)) / 2 / 20;
  console.log(
    `  panel ${Math.round(panelWidth / 20)}x${Math.round(panelHeight / 20)}px, room ` +
      `${Math.round(roomWidth / 20)}x${Math.round(roomHeight / 20)}px`,
  );
  console.log(
    `  -> ${HOST_SCREEN} depth ${SKIN_DEPTH} at (${at.x.toFixed(1)}, ${at.y.toFixed(1)}) ` +
      `scale ${SKIN_SCALE} (${Math.round(inset)}px of room showing down each side)`,
  );
  if (verify) {
    console.log("verify only - nothing written.");
    return;
  }

  if (seasonal) {
    const { idMap } = importCharacters(seasonal, ui4, [panelId]);
    const imported = idMap.get(panelId);
    if (imported === undefined) throw new SwfLevelError("the panel did not come across");
    console.log(`imported ${idMap.size} characters; panel ${panelId} -> ${imported}`);
    panelId = imported;
    reportNestedClose(ui4, panelId);
  }

  // The host may have moved: importCharacters splices its tags in ahead of SymbolClass.
  const hostIndex = spriteIndexOf(ui4, host.id);
  const inner = spriteInnerTags(ui4.tags[hostIndex]);
  const kept = inner
    .filter((tag) => !(isPlacement(tag.code) && parsePlace(tag).name === SKIN_NAME))
    // The pedestal is unnamed, so the panel is the only thing that can take it off
    // the coffer screen. Under it is the one place it can be.
    .map((tag) =>
      isPlacement(tag.code) && parsePlace(tag).depth === PLINTH_DEPTH
        ? setPlacementDepth(tag, PLINTH_NEW_DEPTH)
        : tag,
    );
  kept.unshift(
    buildPlaceObject2({
      depth: SKIN_DEPTH,
      charId: panelId,
      x: at.x,
      y: at.y,
      scaleX: SKIN_SCALE,
      scaleY: SKIN_SCALE,
      name: SKIN_NAME,
    }),
  );
  // The wrapper is a new character, so it splices a tag in and the host may move
  // again; the index is taken back afterwards rather than reused.
  let children = kept;
  for (const group of WRAPPED_GROUPS) children = wrapUnnamed(ui4, children, group);
  const finalIndex = spriteIndexOf(ui4, host.id);
  ui4.tags[finalIndex] = rebuildSprite(ui4.tags[finalIndex], children);

  ensureBackup(UI4_SWF);
  writeSwfFile(UI4_SWF, ui4);
  console.log(`wrote ${UI4_SWF}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
