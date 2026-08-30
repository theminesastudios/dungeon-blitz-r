/**
 * Dresses the client's lockbox screen as the Hallow's Eve coffers.
 *
 * ## Why the art moves and not the class
 *
 * Clicking the skull grid opens `screenLockBox` - `class_73`, bound to
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
 * pure artwork - 92 sprites and shapes, no text, no fonts, no class binding - so it
 * is imported into `UI_4.swf` and laid into `a_ScreenLockBoxAD` **underneath all
 * eighteen of those children**, in place of the lockbox's own window frame. The
 * class is untouched, its bytecode is untouched, and every button still does what
 * it did.
 *
 * ## The fit
 *
 * The two panels were authored on the same screen: the seasonal panel's local
 * height and the lockbox backdrop's are both 13376 twips, to the twip. So the skin
 * goes in at scale 1 and only has to be centred - it is wider than the backdrop and
 * stands proud on both sides, which is the shape the event's own screen had.
 *
 * The panel's nested `am_Close` is dropped on the way in. The lockbox screen has no
 * close button at its root - it closes on `am_Ok` - so an X carried in on the
 * artwork would be a button that does nothing.
 *
 * ## What this costs
 *
 * `a_ScreenLockBoxAD` is also the Treasure Trove screen, so troves wear the coffer
 * skin too for as long as this is applied. That is the trade for touching no
 * bytecode.
 *
 * To take it back, `git checkout` `UI_4.swf` - **not** the `.bak`. `ensureBackup`
 * never overwrites an existing one, and this file already had a backup from the
 * gear-manager patch, so the `.bak` beside it is older than that patch and
 * restoring it would undo that too.
 *
 * Usage: npm exec ts-node scripts/patch-ui4-hallows-eve-coffer-skin.ts [--verify]
 *
 * Re-runnable: the skin is placed under an instance name, and its presence is the
 * check.
 */
import * as path from "path";
import {
  SwfFile,
  SwfLevelError,
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
  repointPlacement,
  spriteInnerTags,
  writeSwfFile,
  TAG_DEFINE_SPRITE,
  TAG_PLACE_OBJECT2,
  TAG_PLACE_OBJECT3,
} from "./swfLevelUtils";

const CLIENT_CONTENT = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p");
const SEASONAL_SWF = path.join(CLIENT_CONTENT, "cbo", "UI_Seasonal.swf");
const UI4_SWF = path.join(CLIENT_CONTENT, "cbp", "UI_4.swf");

/** The screen the coffer opens, and the seasonal screen it borrows its face from. */
const HOST_SCREEN = "a_ScreenLockBoxAD";
const DONOR_SCREEN = "a_ScreenHalloweenCoffers";

/** The donor's one root child - the whole panel. */
const DONOR_PANEL_CHILD = "am_Panel";

/** What the imported panel is placed under, and the marker that says it is done. */
const SKIN_NAME = "am_HallowsEveSkin";

/**
 * The host's own backdrop, which the skin replaces.
 *
 * Depth 1 is the lockbox window frame and depth 3 a hairline drawn on it. Both are
 * unnamed, so no code reads them; the frame is the one part of the old screen that
 * would still read as "lockbox" if it ever showed at an edge.
 */
const HOST_BACKDROP_DEPTHS = [1, 3];

/** Where the skin goes. Below the lowest child the class binds, which is depth 6. */
const SKIN_DEPTH = 1;

/**
 * Children kept, but emptied of their artwork.
 *
 * `am_RewardsTooltip` is the big brown "OPEN TREASURE TROVE" board - 613x668px,
 * standing down the left of the screen - and it is the one thing still shouting
 * *trove* over a panel that is meant to be a coffer. It also covers a third of the
 * skull grid the skin was imported for.
 *
 * It cannot simply be deleted: `class_73.OnCreateScreen` does
 * `method_1(var_2.am_RewardsTooltip)`, and `class_33`'s constructor calls
 * `gotoAndStop(1)` on whatever it is handed with no null check. So the placement
 * stays and keeps its instance name; only the character behind it is swapped for an
 * empty sprite. The lookup resolves, the wrapper is built, and nothing is drawn.
 */
const BLANKED_CHILDREN = ["am_RewardsTooltip"];

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

/** True once the skin is in. */
function alreadySkinned(ui4: SwfFile): boolean {
  const host = screenSprite(ui4, HOST_SCREEN);
  for (const inner of spriteInnerTags(ui4.tags[host.index])) {
    if (!isPlacement(inner.code)) continue;
    if (parsePlace(inner).name === SKIN_NAME) return true;
  }
  return false;
}

/**
 * Empties the children listed in `BLANKED_CHILDREN`.
 *
 * A character with no bounds is the done-marker: an empty sprite measures as
 * nothing, so re-running this finds them already blank.
 */
function blankChildren(ui4: SwfFile, hostIndex: number, emptyId: number, verify: boolean): string[] {
  const inner = spriteInnerTags(ui4.tags[hostIndex]);
  const done: string[] = [];
  for (let i = 0; i < inner.length; i += 1) {
    if (!isPlacement(inner[i].code)) continue;
    const place = parsePlace(inner[i]);
    if (!place.name || !BLANKED_CHILDREN.includes(place.name)) continue;
    if (place.charId === null || characterBounds(ui4, place.charId) === null) continue;
    done.push(place.name);
    if (!verify) inner[i] = repointPlacement(inner[i], emptyId);
  }
  if (done.length > 0 && !verify) ui4.tags[hostIndex] = rebuildSprite(ui4.tags[hostIndex], inner);
  return done;
}

/** Drops the panel's own close button, which would be dead in its new home. */
function dropNestedClose(ui4: SwfFile, panelId: number): void {
  const index = spriteIndexOf(ui4, panelId);
  const inner = spriteInnerTags(ui4.tags[index]);
  const kept = inner.filter(
    (tag) => !(isPlacement(tag.code) && parsePlace(tag).name === "am_Close"),
  );
  if (kept.length === inner.length) {
    console.log("  the imported panel carries no am_Close; nothing dropped");
    return;
  }
  ui4.tags[index] = rebuildSprite(ui4.tags[index], kept);
  console.log(`  dropped ${inner.length - kept.length} am_Close placement(s) from the imported panel`);
}

function main(): void {
  const verify = process.argv.includes("--verify");

  const seasonal = readSwfFile(SEASONAL_SWF);
  const ui4 = readSwfFile(UI4_SWF);

  // The skin and the blanking are independent passes, so a file that already wears
  // the skin can still have a child blanked without being rebuilt.
  if (alreadySkinned(ui4)) {
    const host = screenSprite(ui4, HOST_SCREEN);
    const pending = blankChildren(ui4, host.index, 0, true);
    if (pending.length === 0) {
      console.log(`${HOST_SCREEN} already wears ${SKIN_NAME}, and nothing is left to blank.`);
      return;
    }
    console.log(`blanking ${pending.length} child(ren): ${pending.join(", ")}`);
    if (verify) {
      console.log("verify only - nothing written.");
      return;
    }
    const emptyId = maxCharacterId(ui4) + 1;
    appendCharacterTag(ui4, buildSprite({ id: emptyId, placements: [] }));
    blankChildren(ui4, screenSprite(ui4, HOST_SCREEN).index, emptyId, false);
    ensureBackup(UI4_SWF);
    writeSwfFile(UI4_SWF, ui4);
    console.log(`wrote ${UI4_SWF}`);
    return;
  }

  const panelId = donorPanelId(seasonal);
  const panel = characterBounds(seasonal, panelId);
  if (!panel) throw new SwfLevelError(`character ${panelId} in ${DONOR_SCREEN} has no measurable bounds`);
  const host = screenSprite(ui4, HOST_SCREEN);

  // The backdrop the skin replaces, measured so the two are centred on each other
  // rather than guessed at.
  const backdropIds: number[] = [];
  for (const inner of spriteInnerTags(ui4.tags[host.index])) {
    if (!isPlacement(inner.code)) continue;
    const place = parsePlace(inner);
    if (HOST_BACKDROP_DEPTHS.includes(place.depth) && place.charId !== null) {
      backdropIds.push(place.charId);
    }
  }
  if (backdropIds.length === 0) {
    throw new SwfLevelError(
      `${HOST_SCREEN} has no backdrop on depths ${HOST_BACKDROP_DEPTHS.join(", ")}`,
    );
  }
  const backdrop = characterBounds(ui4, backdropIds[0]);
  if (!backdrop) throw new SwfLevelError(`the ${HOST_SCREEN} backdrop has no measurable bounds`);

  const panelHeight = panel.yMax - panel.yMin;
  const backdropHeight = backdrop.yMax - backdrop.yMin;
  if (Math.abs(panelHeight - backdropHeight) > 40) {
    throw new SwfLevelError(
      `the two screens are not the same height (${panelHeight} vs ${backdropHeight} twips); ` +
        "this patch assumes they were authored on one screen and places the skin at scale 1",
    );
  }

  // Centre horizontally, and sit the top edges together.
  const translateX = (backdrop.xMin + backdrop.xMax) / 2 - (panel.xMin + panel.xMax) / 2;
  const translateY = backdrop.yMin - panel.yMin;

  console.log(`${DONOR_SCREEN}/${DONOR_PANEL_CHILD} = character ${panelId}`);
  console.log(`  panel    ${Math.round(panel.xMax - panel.xMin)} x ${Math.round(panelHeight)} twips`);
  console.log(`  backdrop ${Math.round(backdrop.xMax - backdrop.xMin)} x ${Math.round(backdropHeight)} twips`);
  console.log(
    `  -> ${HOST_SCREEN} depth ${SKIN_DEPTH} at (${Math.round(translateX)}, ${Math.round(translateY)})`,
  );
  if (verify) {
    console.log("verify only - nothing written.");
    return;
  }

  const { idMap } = importCharacters(seasonal, ui4, [panelId]);
  const importedPanelId = idMap.get(panelId);
  if (importedPanelId === undefined) throw new SwfLevelError("the panel did not come across");
  console.log(`imported ${idMap.size} characters; panel ${panelId} -> ${importedPanelId}`);
  dropNestedClose(ui4, importedPanelId);

  // The host has moved: importCharacters splices its tags in ahead of SymbolClass.
  const hostIndex = spriteIndexOf(ui4, host.id);
  const inner = spriteInnerTags(ui4.tags[hostIndex]);
  const kept = inner.filter(
    (tag) => !(isPlacement(tag.code) && HOST_BACKDROP_DEPTHS.includes(parsePlace(tag).depth)),
  );
  console.log(`dropped ${inner.length - kept.length} backdrop placement(s) from ${HOST_SCREEN}`);
  kept.unshift(
    buildPlaceObject2({
      depth: SKIN_DEPTH,
      charId: importedPanelId,
      x: translateX / 20,
      y: translateY / 20,
      name: SKIN_NAME,
    }),
  );
  ui4.tags[hostIndex] = rebuildSprite(ui4.tags[hostIndex], kept);

  const emptyId = maxCharacterId(ui4) + 1;
  appendCharacterTag(ui4, buildSprite({ id: emptyId, placements: [] }));
  const blanked = blankChildren(ui4, spriteIndexOf(ui4, host.id), emptyId, false);
  if (blanked.length > 0) console.log(`blanked ${blanked.length} child(ren): ${blanked.join(", ")}`);

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
