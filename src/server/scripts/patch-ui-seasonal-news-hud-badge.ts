/**
 * Hangs the Green Knight's skull under the news bar, as part of the bar's own artwork.
 *
 * ## Why not the icon slot
 *
 * The news HUD has an icon holder, and the server chooses what goes in it by **name**:
 *
 *     class_132.Refresh() -> method_12(am_IconHolder, mNewsData.var_2682)
 *                         -> class_4.method_16(name) -> currentDomain.getDefinition(name)
 *
 * On this server that lookup has never produced anything. The shipped `a_NewsGoldIcon` and
 * its siblings do not draw either - the bar has been icon-less for as long as anyone has
 * looked at it - so the holder is not a slot that can be relied on, whatever name is put in
 * it and whichever file that name is exported from. Two rounds went into proving that.
 *
 * ## What works instead
 *
 * The *screen's own artwork*. `class_32` builds a screen through the resource registry
 * (`var_530.method_990`), not through an application domain, which is why the challenge
 * panel draws its countdown, its price tag and its rift at all. So the badge is placed into
 * `a_NewsHUD` the same way those were placed into `a_ScreenHalloweenDungeonPrompt`: as a
 * plain child, under the bar, out of the announcement's way.
 *
 * `class_132` never reaches for it, so it cannot throw and it cannot be hidden by anything
 * except the bar itself - `am_TopLeftGroup` is hidden when the headline is empty, and the
 * badge deliberately sits *outside* it so the marker survives that.
 *
 * ## What it does not do
 *
 * It does not count. The only text on this HUD that the server can write and the player can
 * see without hovering is the headline, and that belongs to the studio's announcement. The
 * key count rides in the headline when there is actually a key to spend, and in the tooltip
 * the rest of the time - see `HallowsEve.newsHeadline`.
 *
 * Usage: npm exec ts-node scripts/patch-ui-seasonal-news-hud-badge.ts [--verify]
 *
 * Re-runnable: it re-seats the badge if it has moved, and is a no-op once it is in place.
 */
import * as path from "path";
import {
  SwfFile,
  SwfLevelError,
  SwfTag,
  appendCharacterTag,
  maxCharacterId,
  movePlacement,
  buildPlaceObject2,
  characterBounds,
  characterTagsById,
  ensureBackup,
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

/** The HUD the badge goes on, and the HUD it is taken from. */
const NEWS_SCREEN = "a_NewsHUD";
const NEWS_PANEL = "am_Panel";
const EVENT_SCREEN = "a_ScreenHalloweenHUD";
const EVENT_PANEL = "am_Panel";
const EVENT_SKULL = "am_Icon";

/**
 * The still frame inside the medallion.
 *
 * `am_Icon` is a **three-frame** clip - the up/over/down states everything in this UI is
 * drawn as - and in AS3 a MovieClip with more than one frame plays on its own unless
 * something stops it. Nothing here does: `class_132` has never heard of this child, so the
 * medallion sat in the bar flicking through its three states forever.
 *
 * `am_CacheIcon` is the one-frame drawing inside it, so the badge places that instead of
 * its parent. No character is edited and the event's own HUD keeps its states.
 */
const EVENT_SKULL_STILL = "am_CacheIcon";

/** The key plate - the gold key and the `x` - off the same HUD. */
const EVENT_KEY_GROUP = "am_KeyGroup";
const EVENT_KEY_PLATE = "am_CacheIcon";

/**
 * The key plate, and the one text field the server can write.
 *
 * `am_KeyGroup`'s plate - the gold key with the `x` in front of the number - is placed
 * beside the medallion. The number itself is the problem this solves: nothing in
 * `class_132` writes a second text field, and the only one it does write is the bar's
 * headline, `am_TopLeftGroup.am_Title`.
 *
 * So the two swap jobs. The **headline moves down here**, next to the plate, and the
 * server sends the count into it (`HallowsEve.newsHeadline` -> `x0`, `x2`, ...). The
 * announcement the headline used to carry becomes a **static text field** in the bar, in
 * the same place, in the same font, saying the one thing it always said.
 *
 * `am_Title` keeps its path - it is still `am_TopLeftGroup.am_Title`, only at different
 * coordinates - because `OnCreateScreen` wraps it by that path and a rename would be a
 * null wrapper and a #1009. It also keeps its own placement tag, moved with
 * `movePlacement`, because it is a `PlaceObject3` carrying more than a matrix.
 *
 * One consequence, deliberately: `am_TopLeftGroup` is hidden whenever the headline is
 * empty, and that group is the whole bar. The server therefore never sends an empty
 * title - after the event it sends a single space, which keeps the announcement up and
 * leaves the count blank.
 */
const KEY_PLATE_NAME = "am_HallowsEveKeys";
const HEADLINE_NAME = "am_StudioHeadline";
const TITLE_CHILD = "am_Title";
const GROUP_CHILD = "am_TopLeftGroup";

/** What the bar says now that its text is artwork. Was `WorldEnter.DEFAULT_NEWS_EVENT`. */
const STUDIO_HEADLINE = "The Minesa Studios";

/**
 * Where the plate and the count sit, in the news panel's own coordinates.
 *
 * The plate is 103x22 and goes to the right of the 59px medallion; the count starts where
 * `am_KeyGroup` put its own counter, just past the plate's `x`.
 */
const KEY_PLATE = { x: 44, y: 42 };
const KEY_COUNT = { x: 70, y: 45 };

/** What the badge's placement is called, so a re-run can find its own work. */
const BADGE_NAME = "am_HallowsEveBadge";

/**
 * Where it sits, in the news panel's own coordinates.
 *
 * The bar's plate starts at panel-local 19.6 and is about 23px tall, so the badge hangs
 * below it and 18px further left than the plate's own edge - tucked into the corner of the
 * HUD frame rather than floating a gap away from it. On screen panel-local 0 lands about
 * 18px inside that frame, which is what -18 is measured against; any further left and the
 * medallion starts going under the stone.
 *
 * The medallion is 85px and is drawn at 0.7 - 59px, the size it is on the event's own HUD.
 */
const BADGE = { x: -18, y: 28, scale: 0.7 };

/**
 * Below the tooltip, above everything else on the panel.
 *
 * The panel places `am_TopLeftGroup` on 1, `am_ExternalLink` on 8 and `am_Tooltip` on 29.
 * The badge sits under the tooltip so that opening it covers the medallion rather than the
 * medallion being drawn on top of the text.
 */
const BADGE_DEPTH = 15;

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

/** The `am_Panel` of a screen, by the screen's class name. */
function panelOf(swf: SwfFile, screenName: string, panelName: string): number {
  const screen = readSymbolClasses(swf).find((entry) => entry.name === screenName);
  if (!screen) throw new SwfLevelError(`${path.basename(SEASONAL_SWF)} has no ${screenName}`);
  const panel = namedChildren(swf, screen.id).get(panelName);
  if (panel === undefined || panel === null) throw new SwfLevelError(`${screenName} has no ${panelName}`);
  return panel;
}

function spriteIndexOf(swf: SwfFile, charId: number): number {
  const index = swf.tags.findIndex(
    (tag) => tag.code === TAG_DEFINE_SPRITE && tag.data.readUInt16LE(0) === charId,
  );
  if (index === -1) throw new SwfLevelError(`character ${charId} is not a sprite in this SWF`);
  return index;
}

/** `DefineEditText`, which `swfLevelUtils` does not index by character id. */
const TAG_DEFINE_EDIT_TEXT = 37;

/** The tags a glyph can be drawn by: DefineText, DefineText2, DefineEditText. */
const TEXT_TAGS = new Set([11, 33, 37]);

function editTextTag(swf: SwfFile, charId: number): SwfTag {
  const tag = swf.tags.find(
    (entry) => entry.code === TAG_DEFINE_EDIT_TEXT && entry.data.length >= 2 && entry.data.readUInt16LE(0) === charId,
  );
  if (!tag) throw new SwfLevelError(`character ${charId} is not a DefineEditText`);
  return tag;
}

/**
 * A copy of a text field with a different id and a different string in it.
 *
 * `DefineEditText` ends with `VariableName` and, when `HasText` is set, `InitialText` -
 * two null-terminated strings and nothing after them - so the last string in the tag is
 * the text on screen. The font is left alone: this copy stays in the file it came from,
 * so its `FontID` still points at the same font.
 */
function cloneEditText(tag: SwfTag, id: number, text: string): SwfTag {
  const data = tag.data;
  let start = data.length - 2;
  while (start >= 0 && data[start] !== 0) start -= 1;
  const out = Buffer.concat([Buffer.from(data.subarray(0, start + 1)), Buffer.from(text, "utf8"), Buffer.from([0])]);
  out.writeUInt16LE(id, 0);
  return { code: tag.code, data: out };
}

/**
 * A copy of the key plate with its own `x` taken out.
 *
 * `am_KeyGroup`'s plate is three placements: the bar, the key, and a **dark `x`** drawn as
 * a text character. The count that goes beside it is written into a light text field, and
 * that field supplies its own `x` - so with the authored one still there the HUD read
 * `xx0`. Dropping the placement is enough; the character stays in the file for the event's
 * own HUD, which still uses the untouched plate.
 *
 * Returns `reuse` when it is already the trimmed copy, so a re-run mints nothing.
 */
function plateWithoutTheX(swf: SwfFile, plateId: number, reuse?: number | null): number {
  const textIds = new Set(
    swf.tags.filter((tag) => TEXT_TAGS.has(tag.code) && tag.data.length >= 2).map((tag) => tag.data.readUInt16LE(0)),
  );
  const hasText = (charId: number): boolean =>
    spriteInnerTags(characterTagsById(swf).get(charId) as SwfTag)
      .filter((tag) => isPlacement(tag.code))
      .some((tag) => {
        const child = parsePlace(tag).charId;
        return child !== null && textIds.has(child);
      });

  if (reuse !== undefined && reuse !== null && reuse !== plateId && characterTagsById(swf).get(reuse) && !hasText(reuse)) {
    return reuse;
  }

  const source = characterTagsById(swf).get(plateId) as SwfTag;
  const kept = spriteInnerTags(source).filter((tag) => {
    if (!isPlacement(tag.code)) return true;
    const child = parsePlace(tag).charId;
    return child === null || !textIds.has(child);
  });
  const id = maxCharacterId(swf) + 1;
  const copy = rebuildSprite(source, kept);
  copy.data.writeUInt16LE(id, 0);
  appendCharacterTag(swf, copy);
  return id;
}

/** Replaces the named placement in a sprite, or adds it. Returns false when unchanged. */
function ensurePlacement(swf: SwfFile, hostId: number, name: string, placement: SwfTag): boolean {
  const index = spriteIndexOf(swf, hostId);
  const inner = spriteInnerTags(swf.tags[index]);
  const existing = inner.find((tag) => isPlacement(tag.code) && parsePlace(tag).name === name);
  if (existing && existing.data.equals(placement.data)) return false;
  const kept = inner.filter((tag) => !(isPlacement(tag.code) && parsePlace(tag).name === name));
  const showFrame = kept.findIndex((tag) => tag.code === 1);
  kept.splice(showFrame === -1 ? Math.max(0, kept.length - 1) : showFrame, 0, placement);
  swf.tags[index] = rebuildSprite(swf.tags[index], kept);
  return true;
}

function main(): void {
  const verify = process.argv.includes("--verify");
  const swf = readSwfFile(SEASONAL_SWF);

  const newsPanel = panelOf(swf, NEWS_SCREEN, NEWS_PANEL);
  const eventPanel = panelOf(swf, EVENT_SCREEN, EVENT_PANEL);
  const medallion = namedChildren(swf, eventPanel).get(EVENT_SKULL);
  if (medallion === undefined || medallion === null) throw new SwfLevelError(`${EVENT_SCREEN} has no ${EVENT_SKULL}`);

  // The still frame, or the medallion itself if it turns out to have only one.
  const still = namedChildren(swf, medallion).get(EVENT_SKULL_STILL);
  const frames = characterTagsById(swf).get(medallion)?.data.readUInt16LE(2) ?? 1;
  const skull = frames > 1 && still ? still : medallion;
  if (frames > 1 && !still) {
    throw new SwfLevelError(
      `${EVENT_SKULL} has ${frames} frames and no ${EVENT_SKULL_STILL} to take instead; it would flicker`,
    );
  }

  const bounds = characterBounds(swf, skull);
  if (!bounds) throw new SwfLevelError(`${EVENT_SKULL} (character ${skull}) draws nothing`);
  const size = ((bounds.xMax - bounds.xMin) / 20) * BADGE.scale;

  // Drawn from its own origin, so the medallion's own top-left is put on the badge point.
  const placement = buildPlaceObject2({
    depth: BADGE_DEPTH,
    charId: skull,
    name: BADGE_NAME,
    x: BADGE.x - (bounds.xMin / 20) * BADGE.scale,
    y: BADGE.y - (bounds.yMin / 20) * BADGE.scale,
    scaleX: BADGE.scale,
    scaleY: BADGE.scale,
  });

  const changed: string[] = [];

  // 1. The medallion.
  if (ensurePlacement(swf, newsPanel, BADGE_NAME, placement)) {
    changed.push(
      `${BADGE_NAME}: ${EVENT_SKULL} is character ${medallion} (${frames} frames), taking its still ` +
        `${skull}, drawn at ${BADGE.scale} (${size.toFixed(0)}px) on (${BADGE.x}, ${BADGE.y}) depth ${BADGE_DEPTH}`,
    );
  }

  // 2. The key plate, beside it.
  const keyGroup = namedChildren(swf, eventPanel).get(EVENT_KEY_GROUP);
  if (keyGroup === undefined || keyGroup === null) throw new SwfLevelError(`${EVENT_SCREEN} has no ${EVENT_KEY_GROUP}`);
  const plate = namedChildren(swf, keyGroup).get(EVENT_KEY_PLATE);
  if (plate === undefined || plate === null) throw new SwfLevelError(`${EVENT_KEY_GROUP} has no ${EVENT_KEY_PLATE}`);
  const trimmed = plateWithoutTheX(swf, plate, namedChildren(swf, newsPanel).get(KEY_PLATE_NAME));
  if (
    ensurePlacement(
      swf,
      newsPanel,
      KEY_PLATE_NAME,
      buildPlaceObject2({ depth: BADGE_DEPTH + 1, charId: trimmed, name: KEY_PLATE_NAME, x: KEY_PLATE.x, y: KEY_PLATE.y }),
    )
  ) {
    changed.push(
      `${KEY_PLATE_NAME}: character ${plate} without its own x -> ${trimmed}, ` +
        `on (${KEY_PLATE.x}, ${KEY_PLATE.y}) depth ${BADGE_DEPTH + 1}`,
    );
  }

  /**
   * 3. The announcement, as artwork, and the headline moved onto the count.
   *
   * Both halves of the swap are done together or not at all: a moved `am_Title` with no
   * static headline behind it would leave the bar blank, and a static headline with
   * `am_Title` still in the bar would print the count over the top of it.
   */
  const group = namedChildren(swf, newsPanel).get(GROUP_CHILD);
  if (group === undefined || group === null) throw new SwfLevelError(`${NEWS_PANEL} has no ${GROUP_CHILD}`);
  const title = namedChildren(swf, group).get(TITLE_CHILD);
  if (title === undefined || title === null) throw new SwfLevelError(`${GROUP_CHILD} has no ${TITLE_CHILD}`);

  const groupIndex = spriteIndexOf(swf, group);
  const groupInner = spriteInnerTags(swf.tags[groupIndex]);
  const titleTag = groupInner.find((tag) => isPlacement(tag.code) && parsePlace(tag).name === TITLE_CHILD);
  if (!titleTag) throw new SwfLevelError(`${GROUP_CHILD} does not place ${TITLE_CHILD}`);
  const titleAt = parsePlace(titleTag).matrix;
  if (!titleAt) throw new SwfLevelError(`${TITLE_CHILD} has no matrix to move`);

  // Group-local, since both live inside `am_TopLeftGroup`, which sits at (-2.4, -2.4).
  const groupOffset = parsePlace(
    spriteInnerTags(swf.tags[spriteIndexOf(swf, newsPanel)]).find(
      (tag) => isPlacement(tag.code) && parsePlace(tag).name === GROUP_CHILD,
    ) as SwfTag,
  ).matrix;
  const wantX = KEY_COUNT.x - (groupOffset ? groupOffset.translateX / 20 : 0);
  const wantY = KEY_COUNT.y - (groupOffset ? groupOffset.translateY / 20 : 0);
  const dx = wantX - titleAt.translateX / 20;
  const dy = wantY - titleAt.translateY / 20;

  const headlineHere = namedChildren(swf, group).has(HEADLINE_NAME);
  if (Math.abs(dx) > 0.05 || Math.abs(dy) > 0.05 || !headlineHere) {
    if (!verify) {
      // The static announcement first, on the matrix the headline is about to leave.
      if (!headlineHere) {
        const clone = maxCharacterId(swf) + 1;
        appendCharacterTag(swf, cloneEditText(editTextTag(swf, title), clone, STUDIO_HEADLINE));
        ensurePlacement(
          swf,
          group,
          HEADLINE_NAME,
          buildPlaceObject2({
            depth: parsePlace(titleTag).depth - 1,
            charId: clone,
            name: HEADLINE_NAME,
            x: titleAt.translateX / 20,
            y: titleAt.translateY / 20,
          }),
        );
        changed.push(`${HEADLINE_NAME}: character ${clone} reading "${STUDIO_HEADLINE}", where ${TITLE_CHILD} was`);
      }
      // `movePlacement` rather than a rebuilt tag: this is a PlaceObject3 and carries more
      // than a matrix.
      const moved = spriteInnerTags(swf.tags[spriteIndexOf(swf, group)]).map((tag) =>
        isPlacement(tag.code) && parsePlace(tag).name === TITLE_CHILD ? movePlacement(tag, dx, dy) : tag,
      );
      swf.tags[spriteIndexOf(swf, group)] = rebuildSprite(swf.tags[spriteIndexOf(swf, group)], moved);
    }
    changed.push(`${TITLE_CHILD}: moved ${dx.toFixed(1)}, ${dy.toFixed(1)} onto the count at (${KEY_COUNT.x}, ${KEY_COUNT.y})`);
  }

  if (changed.length === 0) {
    console.log(`${NEWS_SCREEN} already carries the badge, the plate and the moved headline; nothing to do.`);
    return;
  }
  for (const line of changed) console.log(`  ${line}`);
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
