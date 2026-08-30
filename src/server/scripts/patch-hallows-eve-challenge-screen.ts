/**
 * Puts the shipped Green Knight's Challenge panel on screen, by handing it the
 * Class Tower's slot.
 *
 * ## The route
 *
 * `Game.method_668` branches on the clicked entity's cue name, and eight of its
 * arms open a screen. Exactly one of them is spare in this server -
 * `Special_ClassTower`, which opens `screenClassTowers` (`class_69`, bound to
 * `a_ScreenClassTower`) - and the Class Tower is a feature this server does not
 * use. So:
 *
 *   1. `a_ScreenClassTower` is renamed in `DungeonBlitz.swf`'s constant pool to
 *      `a_ScreenHalloweenDungeonPrompt`. That is one string. The screen name is a
 *      plain argument to `class_32`'s constructor, so the class now builds the
 *      seasonal panel instead of the tower.
 *   2. An entity cued `Special_ClassTower` stands beside the arch, so clicking it
 *      opens the panel. (`patch-levelssrn-hallows-eve-cues.ts` puts that cue in the
 *      room; `patch-dungeonblitz-hallows-eve-tower-gate.ts` opens the arm's last
 *      gate.)
 *
 * ## Why the dummies, and why there are so many of them
 *
 * `class_69.OnCreateScreen` reaches for a whole tree of children and hands each one
 * to a `class_33`, whose constructor does `param2.gotoAndStop(1)` with **no null
 * check**. A missing name is TypeError #1009 on the first line of the method, which
 * means `Display()` is reached, the screen never appears, and **nothing whatsoever
 * happens on screen** - indistinguishable from a click that never landed. That
 * ambiguity cost most of a session, twice, because the first two passes over this
 * only looked at the flat `var_2.am_*` reads and missed the ones that go deeper:
 *
 *   - `var_2.am_SpeedUpPanel.am_SpeedUp`, `.am_TrainTalentPanel.am_TrainTalent`,
 *     `.am_CancelPanel.am_CancelTraining`, `.am_CancelPanel.am_NeverMind`
 *   - `var_617.mMovieClip.am_Progress`, i.e. `am_ResearchProgressPanel.am_Progress`
 *   - a loop over `am_ClassTabs["am_ClassTab" + i]` for i in 0..2 (`const_224`),
 *     each tab then read for `.am_Portrait` and `.am_Selector`
 *   - **`mWindow.mMovieClip.am_GlobalUpgradePanel.am_Upgrade`**, which is not on
 *     `var_2` at all: `mWindow.mMovieClip` is the *screen root*, one level above the
 *     panel.
 *
 * So the spec below is a tree, not a list, and it is applied to two different
 * containers. Everything it adds is a one-frame empty sprite: present, addressable,
 * invisible, doing nothing.
 *
 * The names `class_69` reads *outside* `OnCreateScreen` - `am_Header`, `am_Level`,
 * `am_Gold`, `am_Gold2`, `am_Time` - are deliberately **not** added. They only ever
 * reach `MathUtil.method_2`, which is typed `(TextField, String)` and opens with a
 * null check: absent they are skipped, present as a MovieClip they would be a type
 * coercion failure.
 *
 * `am_Progress` on the panel is likewise left as a bare empty sprite. It goes to
 * `method_17(…, "Progress", …)`, which lands on `class_33.BeginHealthMode`, and that
 * returns early when `var_393["Progress"]` is absent.
 *
 * Usage: npm exec ts-node scripts/patch-hallows-eve-challenge-screen.ts [--verify]
 *
 * Re-runnable, and self-repairing: a panel carrying the flat dummies from an earlier
 * pass has the incomplete containers rebuilt and repointed in place, so this can be
 * run over a half-patched SWF without restoring it first.
 */
import * as path from "path";
import {
  SwfFile,
  SwfLevelError,
  appendCharacterTag,
  buildPlaceObject2,
  buildSprite,
  characterBounds,
  characterTagsById,
  encodeTag,
  ensureBackup,
  maxCharacterId,
  parsePlace,
  readAbcStrings,
  readSwfFile,
  readSymbolClasses,
  rebuildSprite,
  renameAbcStrings,
  repointPlacement,
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
const CLIENT_SWF = path.join(CLIENT_CONTENT, "cbp", "DungeonBlitz.swf");

/** The screen `class_69` is bound to today, and what it becomes. */
const DONOR_SCREEN = "a_ScreenClassTower";
const SEASONAL_SCREEN = "a_ScreenHalloweenDungeonPrompt";

/** The seasonal screen's one real child, which is what `var_2` resolves to. */
const PANEL_CHILD = "am_Panel";

/** A child to guarantee, and the children it must carry in turn. */
interface ChildSpec {
  name: string;
  children?: ChildSpec[];
}

/** `const_224` in `class_69` - the number of class tabs the loop walks. */
const CLASS_TAB_COUNT = 3;

const CLASS_TABS: ChildSpec[] = Array.from({ length: CLASS_TAB_COUNT }, (_unused, index) => ({
  name: `am_ClassTab${index}`,
  children: [{ name: "am_Portrait" }, { name: "am_Selector" }],
}));

/**
 * What must hang off `am_Panel`.
 *
 * `am_Close` is not here: the seasonal panel already has a real one, and it should
 * stay real, since it is the button that closes the window.
 */
const PANEL_CHILDREN: ChildSpec[] = [
  { name: "am_BuildingTooLow" },
  { name: "am_Cancel" },
  { name: "am_CancelPanel", children: [{ name: "am_CancelTraining" }, { name: "am_NeverMind" }] },
  { name: "am_ClassTabs", children: CLASS_TABS },
  { name: "am_Illustration" },
  { name: "am_LockAnimation" },
  { name: "am_Notice" },
  { name: "am_Progress" },
  { name: "am_ResearchProgressPanel", children: [{ name: "am_Progress" }] },
  { name: "am_SpeedUpPanel", children: [{ name: "am_SpeedUp" }] },
  { name: "am_TalentProgHeader" },
  { name: "am_TalentsMastered" },
  { name: "am_Tooltip" },
  { name: "am_TrainTalentPanel", children: [{ name: "am_TrainTalent" }] },
  { name: "am_TutorialInteraction" },
  { name: "am_WarningAnim" },
];

/**
 * What must hang off the **screen root**, beside `am_Panel`.
 *
 * `class_69` reads this one off `mWindow.mMovieClip`, not off `var_2`.
 */
const ROOT_CHILDREN: ChildSpec[] = [
  { name: "am_GlobalUpgradePanel", children: [{ name: "am_Upgrade" }] },
];

/**
 * Depths for the dummies.
 *
 * Above anything either container uses - the panel's highest is `am_Close` on 542,
 * the root's only child is on 1 - so nothing real is displaced. They are empty, so
 * being on top costs nothing.
 */
const DUMMY_DEPTH_BASE = 900;

/**
 * `am_Enter` ("Enter Dungeon"), emptied.
 *
 * The panel belongs to a state machine this build no longer has: one state offers
 * Enter, the other offers Summon. Both are drawn, and with nothing switching between
 * them they stack. Enter is the one that goes, because the arch beside the panel is
 * already the way in - the player closes the window and walks through it.
 *
 * The placement and its name stay, so putting it back is deleting one entry here and
 * re-running; it would want a line in `FROZEN_CHILDREN` too, since it is a 3-frame
 * clip like every other button.
 */
const EMPTIED_CHILDREN = ["am_Enter", "am_ClearTimer"];

/**
 * **The Summon button, given a handler.**
 *
 * `am_ClearTimer` ("Summon Knight Now") is the panel's own art and `class_69` has
 * never heard of it, so on its own placement it is unbound: it flickers (a 3-frame
 * clip nothing calls `gotoAndStop` on) and a click does nothing.
 *
 * `class_69` *does* bind one button that spends Mammoth Idols -
 * `method_10(var_2.am_SpeedUpPanel.am_SpeedUp, method_1410)`, the Class Tower's
 * "speed up the research" button. Semantically it is the same purchase: pay idols,
 * skip a timer. So the art is moved into that slot: `am_SpeedUpPanel` stops being an
 * empty dummy and becomes a container carrying **the real button, at the exact
 * matrix its own placement used**, under the name `am_SpeedUp`. The original
 * `am_ClearTimer` placement is emptied so only one button is drawn.
 *
 * Two things fall out of binding it, both wanted:
 *
 *   - `class_33`'s constructor calls `gotoAndStop(1)` on whatever it wraps, so the
 *     flicker is fixed by the binding itself rather than by freezing the character,
 *     and the button keeps its hover and pressed frames.
 *   - `method_1410` sends `LinkUpdater.const_1284`, and **that constant is `0xE0`**
 *     (derived from `LinkUpdater`'s cinit; the derivation checks out against the two
 *     ids this server already registers, `0xBA` apply-dyes and `0x7A` talk-to-npc).
 *     `class_69.method_1410` is the *only* sender of it in the whole client, and
 *     `class_69` is now this panel - so a `0xE0` can only mean "Summon pressed".
 *
 * The client computes a cost from the Class Tower's own timer and writes it into the
 * packet; the server ignores that number and charges its own price. See
 * `HallowsEve.summonCostIdols` and the Hallow's Eve branch in
 * `TalentHandler.handleTalentSpeedup`.
 */
const SUMMON_BUTTON_SOURCE = "am_ClearTimer";
const SUMMON_BUTTON_CONTAINER = "am_SpeedUpPanel";
const SUMMON_BUTTON_CHILD = "am_SpeedUp";

/**
 * The panel's own buttons, stopped on their first frame.
 *
 * `am_ClearTimer` ("Summon Knight Now") is a **3-frame** clip - the up/over/down
 * states every button in this UI is drawn as. In AS3 a MovieClip with more than one
 * frame plays on its own unless something stops it, and the only thing that stops
 * these is `class_33`'s constructor calling `gotoAndStop(1)`. `class_69` wraps
 * `am_Close` (which is why that one sits still) but has never heard of this one, so
 * it cycled its three frames forever: the button visibly flickering open and shut.
 *
 * Cutting the character down to one frame stops it for good, with no code involved.
 *
 * **It is decorative.** Nothing can be bound to it. Every handler `class_69` offers
 * is a Class Tower action, and the one that spends gems - `method_1410`, the
 * "speed up the research" button, which is the closest thing in the class to
 * "summon the Knight now" - opens with
 *
 *     var _loc2_:int = var_1.mMasterClassTower.mEndtime - var_1.mServerGameTime;
 *
 * unguarded, and `mMasterClassTower` is assigned **null** at the only place in the
 * whole client that touches it. Wiring the button to that handler would be a
 * TypeError on the first click. The other candidate, `method_1100`, spends gold and
 * upgrades a building.
 */
const FROZEN_CHILDREN: string[] = [];

/**
 * The countdown, dropped.
 *
 * The panel ships three text fields stacked in one box, a state per field:
 *
 *     am_DungeonReadyText   "The Green Knight has returned!"
 *     am_TimerHeaderText    "The Green Knight returns in:"
 *     am_Timer              "23:59:59"
 *
 * Its own driver would have shown one and hidden the others. Nothing drives them
 * here, so all three drew at once and the box read as
 * `eThe(Green Knight)returns in:e / ha23:59:59d!` - two sentences printed through
 * each other, over a countdown frozen at its authored placeholder.
 *
 * The twelve-hour gate is server state and cannot reach a text field in this build,
 * so a timer is a promise the panel cannot keep. The header and the clock go; the
 * ready line stays. The Herald is the one who knows when the next key is due, and he
 * says so when asked.
 *
 * These are `DefineEditText` characters, which the SWF utilities here do not model,
 * so the placements are removed outright rather than repointed at an empty sprite.
 * That is safe *because* `class_69` never reaches for either name - unlike
 * everything in `PANEL_CHILDREN`, which is why those are emptied instead of deleted.
 */
const REMOVED_CHILDREN = ["am_TimerHeaderText", "am_Timer"];

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

/** name -> character id, for the named placements directly inside a sprite. */
function namedChildren(swf: SwfFile, charId: number): Map<string, number | null> {
  const found = new Map<string, number | null>();
  const chars = characterTagsById(swf);
  const tag = chars.get(charId);
  if (!tag || tag.code !== TAG_DEFINE_SPRITE) return found;
  for (const inner of spriteInnerTags(tag)) {
    if (!isPlacement(inner.code)) continue;
    const place = parsePlace(inner);
    if (place.name) found.set(place.name, place.charId);
  }
  return found;
}

/** True when `charId` already carries `specs`, all the way down. */
function satisfies(swf: SwfFile, charId: number | null, specs: ChildSpec[]): boolean {
  if (specs.length === 0) return true;
  if (charId === null) return false;
  const present = namedChildren(swf, charId);
  for (const spec of specs) {
    if (!present.has(spec.name)) return false;
    if (spec.children && !satisfies(swf, present.get(spec.name) ?? null, spec.children)) return false;
  }
  return true;
}

/** Mints an empty sprite carrying `spec`'s subtree, and returns its character id. */
function mint(swf: SwfFile, spec: ChildSpec, nextId: { value: number }): number {
  const children = (spec.children ?? []).map((child) => ({
    name: child.name,
    id: mint(swf, child, nextId),
  }));
  const id = nextId.value;
  nextId.value += 1;
  appendCharacterTag(
    swf,
    buildSprite({
      id,
      placements: children.map((child, offset) => ({
        depth: offset + 1,
        charId: child.id,
        x: 0,
        y: 0,
        name: child.name,
      })),
    }),
  );
  return id;
}

/**
 * Adds what is missing from a container and repairs what is there but hollow.
 *
 * Returns the names it touched. With `verify`, nothing is written.
 */
function ensureChildren(
  swf: SwfFile,
  containerId: number,
  specs: ChildSpec[],
  nextId: { value: number },
  verify: boolean,
): string[] {
  const index = spriteIndexOf(swf, containerId);
  const inner = spriteInnerTags(swf.tags[index]);

  const at = new Map<string, number>();
  for (let i = 0; i < inner.length; i += 1) {
    if (!isPlacement(inner[i].code)) continue;
    const name = parsePlace(inner[i]).name;
    if (name) at.set(name, i);
  }

  const missing: ChildSpec[] = [];
  const hollow: ChildSpec[] = [];
  for (const spec of specs) {
    const pos = at.get(spec.name);
    if (pos === undefined) {
      missing.push(spec);
      continue;
    }
    if (spec.children && !satisfies(swf, parsePlace(inner[pos]).charId, spec.children)) {
      hollow.push(spec);
    }
  }
  const touched = [...missing, ...hollow].map((spec) => spec.name);
  if (touched.length === 0 || verify) return touched;

  for (const spec of hollow) {
    const pos = at.get(spec.name) as number;
    inner[pos] = repointPlacement(inner[pos], mint(swf, spec, nextId));
  }

  const showFrame = inner.findIndex((tag) => tag.code === 1);
  const insertAt = showFrame === -1 ? Math.max(0, inner.length - 1) : showFrame;
  inner.splice(
    insertAt,
    0,
    ...missing.map((spec, offset) =>
      buildPlaceObject2({
        depth: DUMMY_DEPTH_BASE + offset,
        charId: mint(swf, spec, nextId),
        x: 0,
        y: 0,
        name: spec.name,
      }),
    ),
  );
  swf.tags[index] = rebuildSprite(swf.tags[index], inner);
  return touched;
}

function screenCharId(seasonal: SwfFile): number {
  const screen = readSymbolClasses(seasonal).find((entry) => entry.name === SEASONAL_SCREEN);
  if (!screen) throw new SwfLevelError(`UI_Seasonal.swf has no ${SEASONAL_SCREEN}`);
  return screen.id;
}

function panelCharId(seasonal: SwfFile, screenId: number): number {
  const child = namedChildren(seasonal, screenId).get(PANEL_CHILD);
  if (child === undefined || child === null) {
    throw new SwfLevelError(`${SEASONAL_SCREEN} has no ${PANEL_CHILD}`);
  }
  return child;
}

/**
 * Swaps a child's artwork for an empty sprite, keeping the placement and its name.
 *
 * A character with no bounds is the done-marker: an empty sprite measures as
 * nothing, so a re-run finds them already empty.
 */
function emptyChildren(swf: SwfFile, containerId: number, nextId: { value: number }, verify: boolean): string[] {
  const index = spriteIndexOf(swf, containerId);
  const inner = spriteInnerTags(swf.tags[index]);
  const done: string[] = [];
  for (let i = 0; i < inner.length; i += 1) {
    if (!isPlacement(inner[i].code)) continue;
    const place = parsePlace(inner[i]);
    if (!place.name || !EMPTIED_CHILDREN.includes(place.name)) continue;
    if (place.charId === null || characterBounds(swf, place.charId) === null) continue;
    done.push(place.name);
    if (!verify) inner[i] = repointPlacement(inner[i], mint(swf, { name: place.name }, nextId));
  }
  if (done.length > 0 && !verify) swf.tags[index] = rebuildSprite(swf.tags[index], inner);
  return done;
}

/**
 * Moves the Summon button's art into the one slot `class_69` binds a handler to.
 *
 * Runs after `ensureChildren`, which will have built `am_SpeedUpPanel` as an empty
 * container with an empty `am_SpeedUp` inside it. This replaces that container with
 * one holding the real button at its own placement's matrix. See
 * `SUMMON_BUTTON_SOURCE` for why.
 */
function wireSummonButton(swf: SwfFile, panelId: number, nextId: { value: number }, verify: boolean): boolean {
  const index = spriteIndexOf(swf, panelId);
  const inner = spriteInnerTags(swf.tags[index]);

  let source: ReturnType<typeof parsePlace> | null = null;
  let containerAt = -1;
  for (let i = 0; i < inner.length; i += 1) {
    if (!isPlacement(inner[i].code)) continue;
    const place = parsePlace(inner[i]);
    if (place.name === SUMMON_BUTTON_SOURCE) source = place;
    if (place.name === SUMMON_BUTTON_CONTAINER) containerAt = i;
  }
  if (!source || source.charId === null || containerAt === -1) {
    throw new SwfLevelError(
      `cannot wire the Summon button: ${SUMMON_BUTTON_SOURCE} or ${SUMMON_BUTTON_CONTAINER} is missing`,
    );
  }

  // Already wired when the container's child points at something drawable.
  // Already wired when the container's child points at the real button, which is a
  // multi-frame clip; every dummy this script mints has exactly one frame.
  const containerId = parsePlace(inner[containerAt]).charId;
  const existing = containerId === null ? undefined : namedChildren(swf, containerId).get(SUMMON_BUTTON_CHILD);
  if (existing !== undefined && existing !== null) {
    const at = swf.tags.findIndex(
      (tag) => tag.code === TAG_DEFINE_SPRITE && tag.data.readUInt16LE(0) === existing,
    );
    if (at !== -1 && swf.tags[at].data.readUInt16LE(2) > 1) return false;
  }
  if (verify) return true;

  const container = nextId.value;
  nextId.value += 1;
  appendCharacterTag(
    swf,
    buildSprite({
      id: container,
      placements: [
        {
          depth: 1,
          charId: source.charId,
          name: SUMMON_BUTTON_CHILD,
          x: (source.matrix?.translateX ?? 0) / 20,
          y: (source.matrix?.translateY ?? 0) / 20,
          scaleX: source.matrix?.scaleX ?? 1,
          scaleY: source.matrix?.scaleY ?? 1,
        },
      ],
    }),
  );
  inner[containerAt] = repointPlacement(inner[containerAt], container);
  swf.tags[index] = rebuildSprite(swf.tags[index], inner);
  return true;
}

/**
 * Cuts a multi-frame character down to its first frame, so it stops playing.
 *
 * `rebuildSprite` keeps the sprite header verbatim, so the frame count is rewritten
 * here as well as the tag list truncated - a sprite whose header still claimed three
 * frames while carrying one would be a malformed character.
 */
function freezeChildren(swf: SwfFile, containerId: number, verify: boolean): string[] {
  const frozen: string[] = [];
  for (const [name, charId] of namedChildren(swf, containerId)) {
    if (!FROZEN_CHILDREN.includes(name) || charId === null) continue;
    const index = swf.tags.findIndex(
      (tag) => tag.code === TAG_DEFINE_SPRITE && tag.data.readUInt16LE(0) === charId,
    );
    if (index === -1 || swf.tags[index].data.readUInt16LE(2) <= 1) continue;
    frozen.push(name);
    if (verify) continue;

    const inner = spriteInnerTags(swf.tags[index]);
    const firstFrame = inner.findIndex((tag) => tag.code === TAG_SHOW_FRAME);
    const kept = firstFrame === -1 ? inner.slice() : inner.slice(0, firstFrame + 1);
    kept.push({ code: TAG_END, data: Buffer.alloc(0) });

    const head = Buffer.from(swf.tags[index].data.subarray(0, 4));
    head.writeUInt16LE(1, 2);
    swf.tags[index] = {
      code: TAG_DEFINE_SPRITE,
      data: Buffer.concat([head, ...kept.map(encodeTag)]),
    };
  }
  return frozen;
}

/** Drops the placements named in `REMOVED_CHILDREN` outright. */
function removeChildren(swf: SwfFile, containerId: number, verify: boolean): string[] {
  const index = spriteIndexOf(swf, containerId);
  const inner = spriteInnerTags(swf.tags[index]);
  const gone: string[] = [];
  const kept = inner.filter((tag) => {
    if (!isPlacement(tag.code)) return true;
    const name = parsePlace(tag).name;
    if (!name || !REMOVED_CHILDREN.includes(name)) return true;
    gone.push(name);
    return false;
  });
  if (gone.length > 0 && !verify) swf.tags[index] = rebuildSprite(swf.tags[index], kept);
  return gone;
}

/** Builds out both containers. */
function addDummies(seasonal: SwfFile, verify: boolean): boolean {
  const screenId = screenCharId(seasonal);
  const panelId = panelCharId(seasonal, screenId);

  if (!namedChildren(seasonal, panelId).has("am_Close")) {
    throw new SwfLevelError("the panel has no am_Close; refusing to build a window that cannot be closed");
  }

  const nextId = { value: maxCharacterId(seasonal) + 1 };
  const onPanel = ensureChildren(seasonal, panelId, PANEL_CHILDREN, nextId, verify);
  const onRoot = ensureChildren(seasonal, screenId, ROOT_CHILDREN, nextId, verify);
  // Wired first: `emptyChildren` blanks am_ClearTimer, and the wiring copies that
  // very character. Emptying first would move an empty sprite into the button slot.
  const wired = wireSummonButton(seasonal, panelId, nextId, verify);
  if (wired) console.log("summon button wired into " + SUMMON_BUTTON_CONTAINER + "." + SUMMON_BUTTON_CHILD);
  const emptied = emptyChildren(seasonal, panelId, nextId, verify);
  if (emptied.length > 0) console.log(`emptied: ${emptied.join(", ")}`);
  const frozen = freezeChildren(seasonal, panelId, verify);
  if (frozen.length > 0) console.log("frozen to one frame: " + frozen.join(", "));
  const removed = removeChildren(seasonal, panelId, verify);
  if (removed.length > 0) console.log(`removed: ${removed.join(", ")}`);

  if (onPanel.length === 0 && onRoot.length === 0 && emptied.length === 0 && removed.length === 0 && frozen.length === 0 && !wired) {
    console.log(`${SEASONAL_SCREEN} already carries every child class_69 reaches for.`);
    return false;
  }
  if (onPanel.length > 0) console.log(`${PANEL_CHILD} (character ${panelId}): ${onPanel.join(", ")}`);
  if (onRoot.length > 0) console.log(`screen root (character ${screenId}): ${onRoot.join(", ")}`);
  return true;
}

/** Repoints `class_69` at the seasonal panel. One string. */
function repointScreen(client: SwfFile, verify: boolean): boolean {
  const strings = new Set(readAbcStrings(client));
  if (strings.has(SEASONAL_SCREEN)) {
    console.log(`${SEASONAL_SCREEN} is already in the constant pool; screen already repointed.`);
    return false;
  }
  if (!strings.has(DONOR_SCREEN)) {
    throw new SwfLevelError(`DungeonBlitz.swf has no ${DONOR_SCREEN} to rename`);
  }
  console.log(`${DONOR_SCREEN} -> ${SEASONAL_SCREEN}`);
  if (verify) return true;

  const renamed = renameAbcStrings(client, new Map([[DONOR_SCREEN, SEASONAL_SCREEN]]));
  if (renamed === 0) throw new SwfLevelError(`renaming ${DONOR_SCREEN} changed nothing`);
  console.log(`renamed ${renamed} constant-pool entries`);
  return true;
}

function main(): void {
  const verify = process.argv.includes("--verify");

  const seasonal = readSwfFile(SEASONAL_SWF);
  const dummiesAdded = addDummies(seasonal, verify);

  const client = readSwfFile(CLIENT_SWF);
  const repointed = repointScreen(client, verify);

  if (!dummiesAdded && !repointed) {
    console.log("nothing to do - the challenge screen is already wired.");
    return;
  }
  if (verify) {
    console.log("verify only - nothing written.");
    return;
  }

  if (dummiesAdded) {
    ensureBackup(SEASONAL_SWF);
    writeSwfFile(SEASONAL_SWF, seasonal);
    console.log(`wrote ${SEASONAL_SWF}`);
  }
  if (repointed) {
    ensureBackup(CLIENT_SWF);
    writeSwfFile(CLIENT_SWF, client);
    const size = client.tags.reduce((total, tag) => total + encodeTag(tag).length, 0);
    console.log(`wrote ${CLIENT_SWF} (${size} bytes of tags)`);
    console.log("remember to bump the clientrev token in index.html, or nobody gets this.");
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
