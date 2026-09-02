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
  TAG_FRAME_LABEL,
  TAG_PLACE_OBJECT2,
  TAG_PLACE_OBJECT3,
  TAG_SHOW_FRAME,
} from "./swfLevelUtils";

const CLIENT_CONTENT = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p");
const SEASONAL_SWF = path.join(CLIENT_CONTENT, "cbo", "UI_Seasonal.swf");
const UI4_SWF = path.join(CLIENT_CONTENT, "cbp", "UI_4.swf");
const UI1_SWF = path.join(CLIENT_CONTENT, "cbp", "UI_1.swf");

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
 * The skull that cracks open, in place of the gold chest.
 *
 * ## Why this is a character swap and not code
 *
 * The reward reveal is `class_73.method_1148` doing
 * `var_396.method_147("Open", "LockBox_Basic_Open")`, and `class_33.PlayAnimation`
 * resolves that name against **the wrapped clip's own frame labels** - it builds a
 * label table in its constructor and then walks the timeline with
 * `mMovieClip.gotoAndStop(frame)`. So the animation is not something the code
 * chooses; it is whatever timeline is sitting under `am_Lockbox`.
 *
 * `a_EvilCofferOpenAnimation` in `UI_Seasonal.swf` is drawn for exactly that
 * wrapper - 64 frames labelled `Ready`/`Loop1`, `Recover1`/`Free1`/`End1`, **`Open`
 * at 3**, `Loop2` at 63 - which is the same vocabulary the shipped chest uses
 * (`Idle`, `Open`, `Drop`, `Jitter`, `SpawnNewChest`). Repointing the placement is
 * therefore the whole change: `method_147("Open", ...)` plays frames 3..62, the
 * skull cracks open, and the prize floater, the sparkles and the timing are all the
 * client's own untouched code.
 *
 * ## `Drop` is not optional
 *
 * `class_73` plays exactly two animations on this clip: `Open` for the reveal, and
 * **`Drop` on every screen opening**. The seasonal clip has no `Drop`, and a missing
 * label is not survivable: `PlayAnimation` returns false without setting
 * `mActiveTimeline`, and `method_147` then dereferences it anyway
 * (`this.mActiveTimeline.var_2191`). That threw TypeError #1009 inside
 * `OnInitDisplay`, which aborted `Display()` - the screen simply never appeared,
 * with no sign of why.
 *
 * So a `Drop` label is added to frame 1, where the clip is closed and idle. The
 * coffer has nothing to drop in - it is already on the wall - so the animation it
 * names is a single still frame, which is exactly what is wanted; what matters is
 * that the label exists at all.
 *
 * ## What it costs
 *
 * `am_Lockbox` is one placement with one name, and `class_73` binds it once in
 * `OnCreateScreen`, so the Treasure Trove reveal gets the same skull. There is no
 * second name to give the trove: renaming a timeline child at runtime does not move
 * the property the class reads. Set `SWAP_CHEST_FOR_COFFER` to false to put the
 * gold chest back for both.
 */
const SWAP_CHEST_FOR_COFFER = true;
const COFFER_ANIM_SYMBOL = "a_EvilCofferOpenAnimation";
const COFFER_GROUP_NAME = "am_CofferGroup";
const CHEST_NAME = "am_Lockbox";

/**
 * Where the opening skull lives, on a depth of its own.
 *
 * **Not** under `am_Lockbox`. Repointing that placement is what killed the screen
 * twice: `class_73` hands the clip to `class_33`, whose animation system wants a
 * label table this one does not satisfy, and the failure lands inside `Display()`
 * where nothing survives it. Proved by keeping the import and dropping the repoint -
 * the screen came straight back.
 *
 * So the chest keeps its own clip (and the trove keeps its chest), and the skull is
 * a separate child that the runtime patch shows and
 * walks frame by frame from `OnTickScreen` - the one block that has been running
 * cleanly all along. Depth 94 puts it directly over the chest and under the reward
 * floaters, so the prize still flies out on top of it.
 */
const COFFER_ANIM_NAME = "am_HallowsEveOpen";
const COFFER_ANIM_DEPTH = 400;

/**
 * How big the opening skull is drawn, and how many frames say it is already in.
 *
 * The chest occupies 295x435px on screen; the animation is 448x564px. 0.75 puts it
 * at 336x423 - the same height, centred where the chest was, and comfortably inside
 * the skull grid it is opening out of. 64 is how the swap recognises its own work
 * on a re-run: the shipped chest is 131 frames.
 */
/** The one animation `class_73` plays that the seasonal clip does not have. */
const MISSING_ANIM_LABEL = "Drop";

const COFFER_ANIM_SCALE = 0.75;
const COFFER_ANIM_FRAMES = 64;

/**
 * The prize banner: the map header's scroll, borrowed for the coffers.
 *
 * The event's own reward banner is not in these files - every SWF the client loads
 * was searched for one and the seasonal SWF's twenty-five symbols do not include it.
 * What is here is `a_MapScrollHeader` in `UI_1.swf`, the parchment that unrolls
 * across the top of the world map with a zone's name on it: 353x80px, twenty frames
 * of unrolling, and a text child of its own called `am_Zone`. It is the same
 * parchment ribbon the event's banner was drawn on.
 *
 * So it is imported and hung over the board, and the runtime patch unrolls it when a
 * coffer pays out and writes the prize into `am_Zone`.
 *
 * Placed against the panel's own geometry rather than the screen's: the header stone
 * runs to y=-481 in panel space and the grid starts at -506, so the banner sits
 * across that seam exactly as it does in the event's own screenshots.
 */
/**
 * The reward display, borrowed whole from the charm screen.
 *
 * `a_ScreenCharmComplete` shows a finished charm as an ornate ring with the item
 * icon inside it and a two-winged ribbon behind, the name written across the
 * ribbon in `am_Name`. That is the display this event wanted all along, and it
 * already lives in `UI_4.swf` - so the coffer panel places the same character
 * rather than importing anything.
 *
 * It replaces the world map parchment that stood here before, which carried the
 * map's own zone name and had to be overwritten every tick.
 */
const BANNER_CHAR = 217;
const BANNER_SYMBOL = "a_MapScrollHeader";
const BANNER_NAME = "am_HallowsEveBanner";
const BANNER_DEPTH = 470;
const BANNER_SCALE = 0.62;
const BANNER_CENTRE = { x: 40.5, y: -500 };

/**
 * The forge reward sparkle, reused behind the banner.
 *
 * `a_ScreenMagicForge` plays this as `am_ParticleBurst` when a craft completes - a
 * radial burst of sparkles thrown outward over eighteen frames. It already lives in
 * `UI_4.swf`, so it needs no import: the coffer panel places the same character. It
 * sits one depth *below* the parchment, so the sparkles read as coming from behind
 * the scroll rather than covering the prize name written on it.
 */
const BURST_CHAR = 2707;
const BURST_NAME = "am_HallowsEveBurst";
const BURST_DEPTH = BANNER_DEPTH - 1;
const BURST_SCALE = 1.15;

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
 * Adds a frame label to frame 1 of a sprite, if it does not already carry it.
 *
 * A `DefineFrameLabel` is a null-terminated name and nothing else; putting it at the
 * head of the sprite's tags puts it on frame 1. Several labels on one frame is
 * normal - the shipped chest has `Open` and `PlaySound2` both on 23.
 */
function addFrameLabel(swf: SwfFile, charId: number, label: string): void {
  const index = spriteIndexOf(swf, charId);
  const inner = spriteInnerTags(swf.tags[index]);
  const already = inner.some(
    (tag) => tag.code === TAG_FRAME_LABEL && tag.data.toString("utf8").replace(/\0.*$/, "") === label,
  );
  if (already) {
    console.log(`    character ${charId} already has a "${label}" label`);
    return;
  }
  inner.unshift({ code: TAG_FRAME_LABEL, data: Buffer.concat([Buffer.from(label, "utf8"), Buffer.alloc(1)]) });
  swf.tags[index] = rebuildSprite(swf.tags[index], inner);
  console.log(`    character ${charId}: added a "${label}" label on frame 1`);
}

/**
 * Puts the opening skull under `am_Lockbox`, where the reveal will find it.
 *
 * Centred on the box the chest drew into rather than on the placement's origin: the
 * two clips have their origins in quite different places, so matching the matrix
 * would have dropped the animation somewhere off the board.
 */
function swapChestForCoffer(seasonal: SwfFile, ui4: SwfFile, children: SwfTag[]): SwfTag[] {
  if (!SWAP_CHEST_FOR_COFFER) {
    console.log(`  ${CHEST_NAME}: left as the gold chest (SWAP_CHEST_FOR_COFFER)`);
    return children;
  }
  const index = children.findIndex(
    (tag) => isPlacement(tag.code) && parsePlace(tag).name === CHEST_NAME,
  );
  if (index === -1) {
    console.log(`  ${CHEST_NAME}: no placement to swap`);
    return children;
  }

  const place = parsePlace(children[index]);
  if (place.charId === null) return children;


  const donor = readSymbolClasses(seasonal).find((entry) => entry.name === COFFER_ANIM_SYMBOL);
  if (!donor) throw new SwfLevelError(`no ${COFFER_ANIM_SYMBOL} in ${path.basename(SEASONAL_SWF)}`);

  const { idMap } = importCharacters(seasonal, ui4, [donor.id]);
  const imported = idMap.get(donor.id);
  if (imported === undefined) throw new SwfLevelError(`${COFFER_ANIM_SYMBOL} did not come across`);
  addFrameLabel(ui4, imported, MISSING_ANIM_LABEL);

  // **Inside the grid, not on the screen root.**
  //
  // The skull has to open over the cell that was just clicked, and a child of
  // `am_CofferGroup` is already in the same coordinate space as the cells - so
  // placing it there turns the runtime sum `skin.x + group.x + cell.x` into a plain
  // read of `cell.x`. Depth 400 is above all forty cells and below nothing that
  // matters; the reward floaters live on the screen root and still draw over it.
  const groupIndex = spriteIndexOf(ui4, cofferGroupId(ui4));
  const inner = spriteInnerTags(ui4.tags[groupIndex]).filter(
    (tag) => !(isPlacement(tag.code) && parsePlace(tag).name === COFFER_ANIM_NAME),
  );
  inner.unshift(
    buildPlaceObject2({
      depth: COFFER_ANIM_DEPTH,
      charId: imported,
      name: COFFER_ANIM_NAME,
      scaleX: COFFER_ANIM_SCALE,
      scaleY: COFFER_ANIM_SCALE,
    }),
  );
  ui4.tags[groupIndex] = rebuildSprite(ui4.tags[groupIndex], inner);
  console.log(
    `  ${COFFER_ANIM_NAME}: ${COFFER_ANIM_SYMBOL} imported as ${imported} (${idMap.size} characters), ` +
      `placed inside am_CofferGroup on depth ${COFFER_ANIM_DEPTH} at scale ${COFFER_ANIM_SCALE}`,
  );
  return children;
}

/**
 * Hangs the prize banner in the panel, above the grid.
 *
 * A child of the panel rather than of the screen, so it travels with the artwork and
 * its coordinates are the panel's own - which is what the placement below is
 * measured in.
 */
function addPrizeBanner(ui4: SwfFile, panelId: number): void {
  const index = spriteIndexOf(ui4, panelId);
  const inner = spriteInnerTags(ui4.tags[index]);
  if (inner.some((tag) => isPlacement(tag.code) && parsePlace(tag).name === BANNER_NAME)) {
    console.log(`  ${BANNER_NAME}: already placed`);
    return;
  }

  const ui1 = readSwfFile(UI1_SWF);
  const donor = readSymbolClasses(ui1).find((entry) => entry.name === BANNER_SYMBOL);
  if (!donor) throw new SwfLevelError(`no ${BANNER_SYMBOL} in ${path.basename(UI1_SWF)}`);
  const art = characterBounds(ui4, BANNER_CHAR);
  if (!art) throw new SwfLevelError(`${BANNER_SYMBOL} has no measurable bounds`);

  // The charm ring is already here; nothing is imported for it.
  const imported = BANNER_CHAR;
  const idMap = new Map<number, number>();

  // Centred on the seam between the header stone and the grid.
  const midX = (art.xMin + art.xMax) / 2;
  const midY = (art.yMin + art.yMax) / 2;
  const rebuilt = spriteIndexOf(ui4, panelId);
  const kept = spriteInnerTags(ui4.tags[rebuilt]);
  kept.unshift(
    buildPlaceObject2({
      depth: BANNER_DEPTH,
      charId: imported,
      name: BANNER_NAME,
      x: BANNER_CENTRE.x - (BANNER_SCALE * midX) / 20,
      y: BANNER_CENTRE.y - (BANNER_SCALE * midY) / 20,
      scaleX: BANNER_SCALE,
      scaleY: BANNER_SCALE,
    }),
  );
  const burst = characterBounds(ui4, BURST_CHAR);
  if (!burst) throw new SwfLevelError(`forge burst ${BURST_CHAR} has no measurable bounds`);
  kept.unshift(
    buildPlaceObject2({
      depth: BURST_DEPTH,
      charId: BURST_CHAR,
      name: BURST_NAME,
      x: BANNER_CENTRE.x - (BURST_SCALE * ((burst.xMin + burst.xMax) / 2)) / 20,
      y: BANNER_CENTRE.y - (BURST_SCALE * ((burst.yMin + burst.yMax) / 2)) / 20,
      scaleX: BURST_SCALE,
      scaleY: BURST_SCALE,
    }),
  );
  ui4.tags[rebuilt] = rebuildSprite(ui4.tags[rebuilt], kept);
  console.log(
    `  ${BURST_NAME}: forge sparkle ${BURST_CHAR} at depth ${BURST_DEPTH}, ` +
      `${Math.round(((burst.xMax - burst.xMin) / 20) * BURST_SCALE)}x${Math.round(((burst.yMax - burst.yMin) / 20) * BURST_SCALE)}px`,
  );
  console.log(
    `  ${BANNER_NAME}: ${BANNER_SYMBOL} imported as ${imported} (${idMap.size} characters), ` +
      `${Math.round(((art.xMax - art.xMin) / 20) * BANNER_SCALE)}x${Math.round(((art.yMax - art.yMin) / 20) * BANNER_SCALE)}px ` +
      `centred on (${BANNER_CENTRE.x}, ${BANNER_CENTRE.y}) in panel space`,
  );
}

/** The grid the forty cells live in, inside the imported panel. */
function cofferGroupId(ui4: SwfFile): number {
  const host = screenSprite(ui4, HOST_SCREEN);
  let panelId: number | null = null;
  for (const tag of spriteInnerTags(ui4.tags[host.index])) {
    if (!isPlacement(tag.code)) continue;
    const place = parsePlace(tag);
    if (place.name === SKIN_NAME && place.charId !== null) panelId = place.charId;
  }
  if (panelId === null) throw new SwfLevelError(`${HOST_SCREEN} carries no ${SKIN_NAME}`);
  for (const tag of spriteInnerTags(ui4.tags[spriteIndexOf(ui4, panelId)])) {
    if (!isPlacement(tag.code)) continue;
    const place = parsePlace(tag);
    if (place.name === COFFER_GROUP_NAME && place.charId !== null) return place.charId;
  }
  throw new SwfLevelError(`${SKIN_NAME} carries no ${COFFER_GROUP_NAME}`);
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
  // The donor is only read above when the panel still has to be imported; the
  // animation needs it either way.
  children = swapChestForCoffer(seasonal ?? readSwfFile(SEASONAL_SWF), ui4, children);
  addPrizeBanner(ui4, panelId);
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
