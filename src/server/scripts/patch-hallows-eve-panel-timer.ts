/**
 * Puts the Green Knight's countdown back on his panel.
 *
 * ## The two states the panel was authored with
 *
 * `a_ScreenHalloweenDungeonPrompt` ships three text fields stacked in one box:
 *
 *     am_DungeonReadyText   "The Green Knight has returned!"
 *     am_TimerHeaderText    "The Green Knight returns in:"
 *     am_Timer              "23:59:59"
 *
 * one line for the state where he can be fought and two for the state where he is
 * sleeping. Nothing switched between them here, so all three drew at once and the box
 * read as two sentences printed through each other. The timer pair was removed and the
 * ready line left standing - see `REMOVED_CHILDREN` in
 * `patch-hallows-eve-challenge-screen.ts` - and the panel has said "he has returned"
 * ever since, whether he had or not.
 *
 * ## What switches them now
 *
 * `class_69` switches two containers on the Class Tower's research flag, and this
 * panel is `class_69`:
 *
 *     mStatus == const_200 (busy)        else (idle)
 *     ---------------------------        --------------------------
 *     am_ResearchProgressPanel  Show     am_ResearchProgressPanel  Hide
 *     am_Notice                 Hide     am_Notice                 Show
 *
 * and on every tick, while busy, it writes the remaining time into
 * `am_ResearchProgressPanel.am_Progress.am_Time`. All three of those are empty dummies
 * this project minted, so the writes have been going nowhere.
 *
 * So the three authored fields are moved into the containers whose state they belong
 * to, and nothing else changes:
 *
 *   - **`am_DungeonReadyText` into `am_Notice`** - the ready line now hides itself
 *     while he is sleeping.
 *   - **`am_TimerHeaderText` into `am_ResearchProgressPanel`** - the header appears
 *     only while he is.
 *   - **`am_Timer` into `am_ResearchProgressPanel.am_Progress`, under the name
 *     `am_Time`** - which is the field `OnTickScreen` writes the clock into, so the
 *     authored `23:59:59` becomes a real countdown.
 *   - **`am_IdolGroup`, the twenty-idol price tag, into `am_ResearchProgressPanel`**,
 *     moved clear of the button. It is only true while there is a wait to buy out of,
 *     and now it is only drawn then.
 *
 * `am_Progress` is minted fresh rather than shared: the panel carries a *second*
 * `am_Progress` of its own (`var_1753`), and the two dummies were the same character.
 * A timer added to the shared one would have been drawn in both states.
 *
 * The server end is `HallowsEve.sendCooldownTimer`, and the packet that carries the
 * deadline is patched by `patch-dungeonblitz-hallows-eve-cooldown-timer.ts`. Without
 * that patch this one is harmless - the fields simply never receive anything.
 *
 * Usage: npm exec ts-node scripts/patch-hallows-eve-panel-timer.ts [--verify]
 *
 * Re-runnable: each move checks for its own result first.
 */
import * as path from "path";
import {
  SwfFile,
  SwfLevelError,
  appendCharacterTag,
  buildPlaceObject2,
  buildSprite,
  characterTagsById,
  ensureBackup,
  maxCharacterId,
  parsePlace,
  readSwfFile,
  readSymbolClasses,
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

/**
 * The authored fields, by the name their placement carried on the panel.
 *
 * They are `DefineEditText` characters, which is the whole point - `MathUtil.method_2`
 * and `method_8` are typed `(TextField, String)` and skip anything else, so only a real
 * text field can receive what `class_69` writes.
 */
const READY_TEXT = "am_DungeonReadyText";
const TIMER_HEADER = "am_TimerHeaderText";
const TIMER_FIELD = "am_Timer";
const PRICE_TAG = "am_IdolGroup";

/** The containers `class_69` switches, and the field name it writes the clock into. */
const READY_CONTAINER = "am_Notice";
const BUSY_CONTAINER = "am_ResearchProgressPanel";
const PROGRESS_CHILD = "am_Progress";
const CLOCK_NAME = "am_Time";

/**
 * Where each field goes, in the panel's own coordinates.
 *
 * All four containers are placed at the panel's origin, so these are the matrices the
 * fields were authored with - read off the untouched file, not invented.
 *
 * The price tag is the one exception, and it is measured rather than authored. It was
 * drawn at x 266, tucked against the right end of the *Summon* button; the button that
 * is actually on the panel now is the wider `am_Enter` art, which reaches x 301.7. The
 * space it has to live in is what is left inside the dark box the button and the clock
 * sit in - `am_BaseUpper`'s panel at panel-local **50.2 to 367.0** - and the tag is
 * 64.5px wide, which is 0.8px more than that gap. So it is drawn at 0.85 and set down
 * with a few pixels of air on both sides, vertically centred on the button:
 *
 *     button   116.3 .. 301.7      tag  306.2 .. 361.0      box ends at 367.0
 *
 * At its full size and its first position (318) it hung 15px past the end of the box.
 */
const AUTHORED: Record<string, { x: number; y: number; scale?: number }> = {
  [READY_TEXT]: { x: 74.0, y: -212.3 },
  [TIMER_HEADER]: { x: 72.5, y: -210.1 },
  [TIMER_FIELD]: { x: 73.5, y: -186.6 },
  [PRICE_TAG]: { x: 306.2, y: -129.5, scale: 0.85 },
};

/**
 * The characters, by the name that used to place them.
 *
 * The removals took the *placements* out; every character is still in the file, which
 * is why this can put them back rather than import them again. They are looked up in
 * the backup - the untouched original - because that is the only copy that still says
 * which character each name belonged to.
 */
function authoredCharacters(): Map<string, number> {
  const original = readSwfFile(`${SEASONAL_SWF}.bak`);
  const symbols = readSymbolClasses(original);
  const screen = symbols.find((entry) => entry.name === SCREEN);
  if (!screen) throw new SwfLevelError(`${path.basename(SEASONAL_SWF)}.bak has no ${SCREEN}`);
  const panel = namedChildren(original, screen.id).get(PANEL_CHILD);
  if (panel === undefined || panel === null) throw new SwfLevelError(`${SCREEN} has no ${PANEL_CHILD}`);

  const wanted = [READY_TEXT, TIMER_HEADER, TIMER_FIELD, PRICE_TAG];
  const children = namedChildren(original, panel);
  const found = new Map<string, number>();
  for (const name of wanted) {
    const id = children.get(name);
    if (id === undefined || id === null) throw new SwfLevelError(`the original ${PANEL_CHILD} has no ${name}`);
    found.set(name, id);
  }
  return found;
}

function isPlacement(code: number): boolean {
  return code === TAG_PLACE_OBJECT2 || code === TAG_PLACE_OBJECT3;
}

/** name -> character id, for the named placements directly inside a sprite. */
function namedChildren(swf: SwfFile, charId: number): Map<string, number | null> {
  const found = new Map<string, number | null>();
  const tag = characterTagsById(swf).get(charId);
  if (!tag || tag.code !== TAG_DEFINE_SPRITE) return found;
  for (const inner of spriteInnerTags(tag)) {
    if (!isPlacement(inner.code)) continue;
    const place = parsePlace(inner);
    if (place.name) found.set(place.name, place.charId);
  }
  return found;
}

function spriteIndexOf(swf: SwfFile, charId: number): number {
  const index = swf.tags.findIndex(
    (tag) => tag.code === TAG_DEFINE_SPRITE && tag.data.readUInt16LE(0) === charId,
  );
  if (index === -1) throw new SwfLevelError(`character ${charId} is not a sprite in this SWF`);
  return index;
}

/** The first depth no placement in `charId` is using. */
function nextDepth(swf: SwfFile, charId: number): number {
  const tag = characterTagsById(swf).get(charId);
  if (!tag) return 1;
  let highest = 0;
  for (const inner of spriteInnerTags(tag)) {
    if (!isPlacement(inner.code)) continue;
    highest = Math.max(highest, parsePlace(inner).depth);
  }
  return highest + 1;
}

interface ChildSpec {
  charId: number;
  x: number;
  y: number;
  scale?: number;
  name?: string;
}

/** Adds one placement to a sprite, ahead of its ShowFrame so it lands on frame 1. */
function addChild(swf: SwfFile, hostId: number, spec: ChildSpec): void {
  const index = spriteIndexOf(swf, hostId);
  const inner = spriteInnerTags(swf.tags[index]);
  const showFrame = inner.findIndex((tag) => tag.code === 1);
  const at = showFrame === -1 ? Math.max(0, inner.length - 1) : showFrame;
  inner.splice(at, 0, placementFor(spec, nextDepth(swf, hostId)));
  swf.tags[index] = rebuildSprite(swf.tags[index], inner);
}

function placementFor(spec: ChildSpec, depth: number) {
  return buildPlaceObject2({
    depth,
    charId: spec.charId,
    x: spec.x,
    y: spec.y,
    scaleX: spec.scale ?? 1,
    scaleY: spec.scale ?? 1,
    name: spec.name,
  });
}

/**
 * Puts an existing placement back on the matrix it is supposed to have.
 *
 * The other three fields go in once and stay where the artwork put them; the price tag
 * is positioned by measurement, so its numbers get corrected - and a check that only
 * asks "is it there?" would leave the first, wrong placement in the file forever.
 * Returns false when it is already right, so a re-run is still a no-op.
 */
function reseatChild(swf: SwfFile, hostId: number, name: string, spec: ChildSpec): boolean {
  const index = spriteIndexOf(swf, hostId);
  const inner = spriteInnerTags(swf.tags[index]);
  let changed = false;
  const rebuilt = inner.map((tag) => {
    if (!isPlacement(tag.code)) return tag;
    const place = parsePlace(tag);
    if (place.name !== name) return tag;
    const wanted = placementFor(spec, place.depth);
    if (wanted.data.equals(tag.data)) return tag;
    changed = true;
    return wanted;
  });
  if (!changed) return false;
  swf.tags[index] = rebuildSprite(swf.tags[index], rebuilt);
  return true;
}

/** Drops the named placement from a sprite. Returns false when it is not there. */
function removeChild(swf: SwfFile, hostId: number, name: string): boolean {
  const index = spriteIndexOf(swf, hostId);
  const inner = spriteInnerTags(swf.tags[index]);
  const kept = inner.filter((tag) => !(isPlacement(tag.code) && parsePlace(tag).name === name));
  if (kept.length === inner.length) return false;
  swf.tags[index] = rebuildSprite(swf.tags[index], kept);
  return true;
}

function main(): void {
  const verify = process.argv.includes("--verify");
  const swf = readSwfFile(SEASONAL_SWF);
  const symbols = readSymbolClasses(swf);
  const screen = symbols.find((entry) => entry.name === SCREEN);
  if (!screen) throw new SwfLevelError(`${path.basename(SEASONAL_SWF)} has no ${SCREEN}`);

  const screenChildren = namedChildren(swf, screen.id);
  const panelId = screenChildren.get(PANEL_CHILD);
  if (panelId === undefined || panelId === null) throw new SwfLevelError(`${SCREEN} has no ${PANEL_CHILD}`);

  const panel = namedChildren(swf, panelId);
  const readyContainer = panel.get(READY_CONTAINER);
  const busyContainer = panel.get(BUSY_CONTAINER);
  if (!readyContainer || !busyContainer) {
    throw new SwfLevelError(
      `${PANEL_CHILD} is missing ${READY_CONTAINER} or ${BUSY_CONTAINER}; ` +
        `run patch-hallows-eve-challenge-screen.ts first`,
    );
  }

  const characters = authoredCharacters();
  const busy = namedChildren(swf, busyContainer);
  const ready = namedChildren(swf, readyContainer);
  const progressId = busy.get(PROGRESS_CHILD);
  if (progressId === undefined || progressId === null) {
    throw new SwfLevelError(`${BUSY_CONTAINER} has no ${PROGRESS_CHILD} to hang the clock in`);
  }

  const done: string[] = [];
  const already: string[] = [];

  // The ready line, into the container that is shown only when he is up.
  if (ready.has(READY_TEXT)) {
    already.push(`${READY_TEXT} is already inside ${READY_CONTAINER}`);
  } else if (!verify) {
    removeChild(swf, panelId, READY_TEXT);
    addChild(swf, readyContainer, {
      charId: characters.get(READY_TEXT) as number,
      ...AUTHORED[READY_TEXT],
      name: READY_TEXT,
    });
    done.push(`${READY_TEXT} -> ${READY_CONTAINER}`);
  } else {
    done.push(`${READY_TEXT} -> ${READY_CONTAINER}`);
  }

  // The header and the price tag, into the container shown only while he sleeps.
  for (const name of [TIMER_HEADER, PRICE_TAG] as const) {
    const spec = { charId: characters.get(name) as number, ...AUTHORED[name], name };
    if (busy.has(name)) {
      // Already in the right container: check it is on the right matrix as well.
      if (verify || !reseatChild(swf, busyContainer, name, spec)) {
        already.push(`${name} is already inside ${BUSY_CONTAINER}`);
        continue;
      }
      done.push(`${name} re-seated at (${spec.x}, ${spec.y})${spec.scale ? ` scale ${spec.scale}` : ""}`);
      continue;
    }
    if (!verify) {
      removeChild(swf, panelId, name);
      addChild(swf, busyContainer, spec);
    }
    done.push(`${name} -> ${BUSY_CONTAINER}`);
  }

  /**
   * The clock itself.
   *
   * `am_Progress` is replaced with a copy of its own before the field goes in, because
   * the panel's other `am_Progress` is the same character: a child added to the shared
   * dummy would be drawn in the ready state too, where nothing ever clears it.
   */
  const progress = namedChildren(swf, progressId);
  if (progress.has(CLOCK_NAME)) {
    already.push(`${CLOCK_NAME} is already inside ${BUSY_CONTAINER}.${PROGRESS_CHILD}`);
  } else {
    done.push(`${TIMER_FIELD} -> ${BUSY_CONTAINER}.${PROGRESS_CHILD}.${CLOCK_NAME}`);
    if (!verify) {
      const ownId = maxCharacterId(swf) + 1;
      appendCharacterTag(swf, buildSprite({ id: ownId, placements: [] }));
      addChild(swf, ownId, {
        charId: characters.get(TIMER_FIELD) as number,
        ...AUTHORED[TIMER_FIELD],
        name: CLOCK_NAME,
      });
      const index = spriteIndexOf(swf, busyContainer);
      const inner = spriteInnerTags(swf.tags[index]).map((tag) => {
        if (!isPlacement(tag.code) || parsePlace(tag).name !== PROGRESS_CHILD) return tag;
        return buildPlaceObject2({ depth: parsePlace(tag).depth, charId: ownId, x: 0, y: 0, name: PROGRESS_CHILD });
      });
      swf.tags[index] = rebuildSprite(swf.tags[index], inner);
      done.push(`${PROGRESS_CHILD} -> its own character ${ownId}`);
    }
  }

  for (const line of already) console.log(line);
  if (done.length === 0) {
    console.log("nothing to do - the panel already carries its countdown.");
    return;
  }
  for (const line of done) console.log(line);
  if (verify) {
    console.log("verify only - no file written.");
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
