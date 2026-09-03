/**
 * Puts a drawn copy of the mount icon in the coffer panel, for the reward ring to use.
 *
 * ## Why the ring cannot render one
 *
 * `class_18.method_996` draws a mount reward live: it takes the mount type out of
 * `class_14.var_362`, hands it to `class_41.method_168`, and that renders the entity's
 * `Icon` frame through `SuperAnimData`. Rendering needs the entity's art loaded, and
 * The Nightmare's art is `Animation_HorseMount.swf` - which, in a square where nobody
 * is mounted, is not. `method_374` logs its miss and returns an **empty `Bitmap`**, so
 * the call succeeds, the holder gets its one child, and the ring shows nothing.
 *
 * The client's own attempt fails the same way, which is why the first mount reveal
 * came up blank before this project drew anything itself. It is not a bug in either
 * call: there is simply no picture in memory to draw.
 *
 * ## What is used instead
 *
 * The panel already carries one. `am_CacheIcon` is the prize column down its left
 * edge, and the top row - the mount's row - is character 4480, the horned skull. That
 * is *drawn art*: it needs nothing loaded and it is the event's own picture for this
 * prize.
 *
 * So a second copy goes into the panel under a name of its own, and
 * `patch-dungeonblitz-hallows-eve-coffer-screen.ts` moves that copy into the ring when
 * the prize is the mount. The column keeps its own, unchanged.
 *
 * **It is wrapped rather than placed bare.** 4480's origin sits at the bottom right of
 * its art - the bounds run from (-122.65, -185.8) - and the ring's fit assumes a box
 * that starts where the object does, which is true of every other prize icon. The
 * wrapper places 4480 at the negative of those, so the sprite measures from its own
 * (0, 0) and the same `width`/`height` fit lands it on the plate.
 *
 * **And parked off the panel.** The screen patch positions it; until its first tick it
 * has to be somewhere that is not the middle of the board.
 *
 * Separate from `patch-ui4-hallows-eve-coffer-skin.ts` on purpose: that script imports
 * the whole panel and asserts the two screens were authored on one stage, which stops
 * being true the moment it has run once. This one only ever adds two tags, and checks
 * for its own result first.
 *
 * Usage: npm exec ts-node scripts/patch-ui4-hallows-eve-mount-icon.ts [--verify]
 */
import * as path from "path";
import {
  SwfFile,
  SwfLevelError,
  buildPlaceObject2,
  buildSprite,
  characterBounds,
  ensureBackup,
  importCharacters,
  readSymbolClasses,
  repointPlacement,
  encodeTag,
  SwfTag,
  TAG_SHOW_FRAME,
  TAG_END,
  maxCharacterId,
  parsePlace,
  readSwfFile,
  rebuildSprite,
  spriteInnerTags,
  writeSwfFile,
  TAG_DEFINE_SPRITE,
  TAG_PLACE_OBJECT2,
  TAG_PLACE_OBJECT3,
} from "./swfLevelUtils";

/** PlaceObject2 and PlaceObject3 - the two tags that put a child in a sprite. */
function isPlacement(code: number): boolean {
  return code === TAG_PLACE_OBJECT2 || code === TAG_PLACE_OBJECT3;
}

const CLIENT_CONTENT = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p");
const UI4_SWF = path.join(CLIENT_CONTENT, "cbp", "UI_4.swf");

/**
 * The pet pictures, imported because nothing on this client can draw one here.
 *
 * A pet reward has no drawn icon anywhere - `class_128` builds `a_StoreIconPumpkin` and
 * `a_StoreIconGargoyle`, and neither is in any of the client's eighty-two SWFs - so the
 * only picture of these animals is their animation in `Animation_Pets.swf`. Three ways
 * to reach it from the coffer screen were tried and all three failed:
 *
 *   - `class_18.method_996`'s own render into the mask holder: a dark, unlit sketch;
 *   - the same render made fresh with `class_41.method_85`: the same sketch;
 *   - `class_4.method_16(gfxType.animClass)`: an empty clip, because that resolves
 *     against `ApplicationDomain.currentDomain` and the pet art has its own.
 *
 * So the art is imported instead. Drawn art needs nothing loaded and no domain to
 * resolve against - the same reasoning as the mount's picture above.
 *
 * **One picture per pet, and frozen.** The animation root places its parts on frame 1
 * and then walks them - twenty-three frames for a jack-o, twelve for a gargoyle - so an
 * imported copy plays, fast and unasked. Every imported sprite is therefore cut to its
 * first frame, which is a complete pose.
 *
 * The four colours differ by one placement: the face at depth 7 for a jack-o, the head
 * at depth 11 for a gargoyle. `a_PumpkinFace_PumpkinRed` and its siblings are separate
 * symbols, and the yellow of each family is the *base* part with no suffix - which is
 * why `FACE` below is allowed to be absent. Each pet gets its own copy of the root with
 * that one placement repointed, so the ring shows the animal the banner names.
 */
const PET_ICON_SOURCE = "Animation_Pets.swf";
const PET_ICON_PREFIX = "am_HallowsEvePet_";
const PET_ICON_DEPTH = 474;

/**
 * The three pumpkin helms, imported for the same reason the pets are.
 *
 * A gear reward is the third thing `class_18.method_996` *renders* - `Game.RenderGear`
 * into a live `SuperAnimInstance` - and once the reveal stops asking the client to
 * render anything (see `buildHallowsEveReward`), there is nothing left to borrow. `UI_2`
 * already carries a drawn icon for each of the three, so those come across whole.
 *
 * Named after the `GearName` the reveal sends, so the screen patch builds the name
 * rather than working out which class the helm belongs to.
 */
const HELM_ICON_SOURCE = "UI_2.swf";
const HELM_ICON_PREFIX = "am_HallowsEveHelm_";
const HELM_ICON_DEPTH = 484;
const HELM_ICONS: Array<{ gear: string; symbol: string }> = [
  { gear: "SpecialHalloweenHelmPaladin30", symbol: "a_PumpkinHelm_Paladin" },
  { gear: "SpecialHalloweenHelmMage30", symbol: "a_PumpkinHelm_Mage" },
  { gear: "SpecialHalloweenHelmRogue30", symbol: "a_PumpkinHelm_Rogue" },
];

/** Each pet, its family's animation root, and the part that carries its colour. */
const PET_ICONS: Array<{ pet: string; root: string; base: string; face: string | null }> = [
  { pet: "PumpkinRed", root: "a__AnimationPetPumpkin", base: "a_PumpkinFace", face: "a_PumpkinFace_PumpkinRed" },
  { pet: "PumpkinYellow", root: "a__AnimationPetPumpkin", base: "a_PumpkinFace", face: null },
  { pet: "PumpkinBlue", root: "a__AnimationPetPumpkin", base: "a_PumpkinFace", face: "a_PumpkinFace_PumpkinBlue" },
  { pet: "PumpkinGreen", root: "a__AnimationPetPumpkin", base: "a_PumpkinFace", face: "a_PumpkinFace_PumpkinGreen" },
  { pet: "GargoyleRed", root: "a__AnimationPetGargoyle", base: "a_GargoyleHead", face: "a_GargoyleHead_GargoyleRed" },
  { pet: "GargoyleYellow", root: "a__AnimationPetGargoyle", base: "a_GargoyleHead", face: null },
  { pet: "GargoyleBlue", root: "a__AnimationPetGargoyle", base: "a_GargoyleHead", face: "a_GargoyleHead_GargoyleBlue" },
  { pet: "GargoyleGreen", root: "a__AnimationPetGargoyle", base: "a_GargoyleHead", face: "a_GargoyleHead_GargoyleGreen" },
];
/** The prize column's own mount picture, and where the copy goes. */
const MOUNT_ICON_CHAR = 4480;
const MOUNT_ICON_NAME = "am_HallowsEveMountIcon";
const MOUNT_ICON_DEPTH = 472;

/** Off the panel, where nothing is drawn before the screen patch places it. */
const MOUNT_ICON_PARK = { x: -9000, y: -9000 };

/** The child every coffer panel has, and nothing else does: the prize counts. */
const PANEL_MARKER_CHILD = "am_TextGroup";

/** The sprite that holds `am_TextGroup` - the coffer panel, whatever id it was given. */
function findPanel(swf: SwfFile): number {
  for (const tag of swf.tags) {
    if (tag.code !== TAG_DEFINE_SPRITE) continue;
    const id = tag.data.readUInt16LE(0);
    for (const inner of spriteInnerTags(tag)) {
      if (!isPlacement(inner.code)) continue;
      let info;
      try {
        info = parsePlace(inner);
      } catch {
        continue;
      }
      if (info.name === PANEL_MARKER_CHILD) {
        return id;
      }
    }
  }
  throw new SwfLevelError(`no sprite in ${path.basename(UI4_SWF)} carries ${PANEL_MARKER_CHILD}`);
}

function spriteIndexOf(swf: SwfFile, charId: number): number {
  const index = swf.tags.findIndex(
    (tag) => tag.code === TAG_DEFINE_SPRITE && tag.data.readUInt16LE(0) === charId,
  );
  if (index < 0) throw new SwfLevelError(`sprite ${charId} is not in ${path.basename(UI4_SWF)}`);
  return index;
}

function hasChild(swf: SwfFile, panelId: number, name: string): boolean {
  return spriteInnerTags(swf.tags[spriteIndexOf(swf, panelId)]).some((tag) => {
    if (!isPlacement(tag.code)) return false;
    try {
      return parsePlace(tag).name === name;
    } catch {
      return false;
    }
  });
}

/** A sprite cut to its first frame: the placements before the first `ShowFrame`. */
function freezeSprite(tag: SwfTag): SwfTag {
  const inner = spriteInnerTags(tag);
  const cut = inner.findIndex((child) => child.code === TAG_SHOW_FRAME);
  if (cut < 0) return tag;
  const frozen = rebuildSprite(tag, inner.slice(0, cut));
  // `rebuildSprite` keeps the header's frame count; one frame is what is left.
  frozen.data.writeUInt16LE(1, 2);
  return frozen;
}

/**
 * Imports the pet art and hangs one frozen, colour-correct copy per pet in the panel.
 *
 * See `PET_ICONS`.
 */
function addPetIcons(ui4: SwfFile, panelId: number): void {
  const source = readSwfFile(path.join(CLIENT_CONTENT, "cbp", PET_ICON_SOURCE));
  const symbols = readSymbolClasses(source);
  const idOf = (name: string): number => {
    const symbol = symbols.find((entry) => entry.name === name);
    if (!symbol) throw new SwfLevelError(`no ${name} in ${PET_ICON_SOURCE}`);
    return symbol.id;
  };

  const wanted = PET_ICONS.filter((icon) => !hasChild(ui4, panelId, `${PET_ICON_PREFIX}${icon.pet}`));
  if (wanted.length === 0) {
    console.log(`${UI4_SWF}: every pet icon is already placed.`);
    return;
  }

  // One import for everything: the roots, and the faces that are not already a
  // dependency of one.
  const roots = new Set<number>();
  for (const icon of wanted) {
    roots.add(idOf(icon.root));
    if (icon.face) roots.add(idOf(icon.face));
  }
  const { idMap } = importCharacters(source, ui4, [...roots]);

  // Nothing imported is allowed to play.
  for (const imported of idMap.values()) {
    const index = ui4.tags.findIndex(
      (tag) => tag.code === TAG_DEFINE_SPRITE && tag.data.readUInt16LE(0) === imported,
    );
    if (index >= 0) ui4.tags[index] = freezeSprite(ui4.tags[index]);
  }

  for (const [offset, icon] of wanted.entries()) {
    const name = `${PET_ICON_PREFIX}${icon.pet}`;
    const rootId = idMap.get(idOf(icon.root));
    const baseId = idMap.get(idOf(icon.base));
    if (rootId === undefined || baseId === undefined) {
      throw new SwfLevelError(`${icon.pet}: the root or its base part was not imported`);
    }
    const faceId = icon.face ? idMap.get(idOf(icon.face)) : baseId;
    if (faceId === undefined) throw new SwfLevelError(`${icon.pet}: ${icon.face} was not imported`);

    // This pet's own copy of the pose, with the one coloured part swapped in.
    const rootIndex = ui4.tags.findIndex(
      (tag) => tag.code === TAG_DEFINE_SPRITE && tag.data.readUInt16LE(0) === rootId,
    );
    if (rootIndex < 0) throw new SwfLevelError(`${icon.pet}: imported root ${rootId} is missing`);
    const posed = spriteInnerTags(ui4.tags[rootIndex]).map((tag) => {
      if (!isPlacement(tag.code)) return tag;
      let info;
      try { info = parsePlace(tag); } catch { return tag; }
      return info.charId === baseId ? repointPlacement(tag, faceId) : tag;
    });

    const poseId = maxCharacterId(ui4) + 1;
    const head = Buffer.alloc(4);
    head.writeUInt16LE(poseId, 0);
    head.writeUInt16LE(1, 2);
    const pose: SwfTag = {
      code: TAG_DEFINE_SPRITE,
      data: Buffer.concat([
        head,
        ...posed.map(encodeTag),
        encodeTag({ code: TAG_SHOW_FRAME, data: Buffer.alloc(0) }),
        encodeTag({ code: TAG_END, data: Buffer.alloc(0) }),
      ]),
    };
    ui4.tags.splice(spriteIndexOf(ui4, panelId), 0, pose);

    const art = characterBounds(ui4, poseId);
    if (!art) throw new SwfLevelError(`${icon.pet} has no measurable bounds`);
    const wrapperId = maxCharacterId(ui4) + 1;
    ui4.tags.splice(
      spriteIndexOf(ui4, panelId),
      0,
      buildSprite({
        id: wrapperId,
        placements: [{ depth: 1, charId: poseId, x: -art.xMin / 20, y: -art.yMin / 20 }],
      }),
    );

    const at = spriteIndexOf(ui4, panelId);
    const children = spriteInnerTags(ui4.tags[at]);
    children.unshift(
      buildPlaceObject2({
        depth: PET_ICON_DEPTH + offset,
        charId: wrapperId,
        name,
        x: MOUNT_ICON_PARK.x,
        y: MOUNT_ICON_PARK.y,
      }),
    );
    ui4.tags[at] = rebuildSprite(ui4.tags[at], children);
    console.log(
      `${UI4_SWF}: ${name} = ${icon.root} frame 1 with ${icon.face ?? icon.base}, ` +
        `${Math.round((art.xMax - art.xMin) / 20)}x${Math.round((art.yMax - art.yMin) / 20)}px.`,
    );
  }
}
/** Imports the three helm icons and parks one per gear name in the panel. */
function addHelmIcons(ui4: SwfFile, panelId: number): void {
  const wanted = HELM_ICONS.filter((icon) => !hasChild(ui4, panelId, `${HELM_ICON_PREFIX}${icon.gear}`));
  if (wanted.length === 0) {
    console.log(`${UI4_SWF}: every helm icon is already placed.`);
    return;
  }

  const source = readSwfFile(path.join(CLIENT_CONTENT, "cbp", HELM_ICON_SOURCE));
  const symbols = readSymbolClasses(source);
  for (const [offset, icon] of wanted.entries()) {
    const symbol = symbols.find((entry) => entry.name === icon.symbol);
    if (!symbol) throw new SwfLevelError(`no ${icon.symbol} in ${HELM_ICON_SOURCE}`);
    const { idMap } = importCharacters(source, ui4, [symbol.id]);
    const imported = idMap.get(symbol.id);
    if (imported === undefined) throw new SwfLevelError(`${icon.symbol} was not imported`);

    const art = characterBounds(ui4, imported);
    if (!art) throw new SwfLevelError(`${icon.symbol} has no measurable bounds`);
    const wrapperId = maxCharacterId(ui4) + 1;
    ui4.tags.splice(
      spriteIndexOf(ui4, panelId),
      0,
      buildSprite({
        id: wrapperId,
        placements: [{ depth: 1, charId: imported, x: -art.xMin / 20, y: -art.yMin / 20 }],
      }),
    );

    const at = spriteIndexOf(ui4, panelId);
    const children = spriteInnerTags(ui4.tags[at]);
    children.unshift(
      buildPlaceObject2({
        depth: HELM_ICON_DEPTH + offset,
        charId: wrapperId,
        name: `${HELM_ICON_PREFIX}${icon.gear}`,
        x: MOUNT_ICON_PARK.x,
        y: MOUNT_ICON_PARK.y,
      }),
    );
    ui4.tags[at] = rebuildSprite(ui4.tags[at], children);
    console.log(
      `${UI4_SWF}: ${HELM_ICON_PREFIX}${icon.gear} = ${icon.symbol} imported as ${imported}, ` +
        `${Math.round((art.xMax - art.xMin) / 20)}x${Math.round((art.yMax - art.yMin) / 20)}px.`,
    );
  }
}

function main(): void {
  const verify = process.argv.slice(2).includes("--verify");
  const ui4 = readSwfFile(UI4_SWF);
  const panelId = findPanel(ui4);

  const mountPlaced = hasChild(ui4, panelId, MOUNT_ICON_NAME);
  const petsPlaced = PET_ICONS.every((icon) => hasChild(ui4, panelId, `${PET_ICON_PREFIX}${icon.pet}`));
  const helmsPlaced = HELM_ICONS.every((icon) => hasChild(ui4, panelId, `${HELM_ICON_PREFIX}${icon.gear}`));
  if (mountPlaced && petsPlaced && helmsPlaced) {
    console.log(`${UI4_SWF}: every prize icon is already placed in panel ${panelId}.`);
    return;
  }
  if (verify) {
    throw new SwfLevelError(`${UI4_SWF}: a prize icon is missing from panel ${panelId}.`);
  }
  if (mountPlaced) {
    addPetIcons(ui4, panelId);
  addHelmIcons(ui4, panelId);
    ensureBackup(UI4_SWF);
    writeSwfFile(UI4_SWF, ui4);
    console.log(`${UI4_SWF}: prize icons placed in panel ${panelId}.`);
    return;
  }

  const art = characterBounds(ui4, MOUNT_ICON_CHAR);
  if (!art) throw new SwfLevelError(`mount icon ${MOUNT_ICON_CHAR} has no measurable bounds`);

  const wrapperId = maxCharacterId(ui4) + 1;
  const wrapper = buildSprite({
    id: wrapperId,
    placements: [
      {
        depth: 1,
        charId: MOUNT_ICON_CHAR,
        x: -art.xMin / 20,
        y: -art.yMin / 20,
      },
    ],
  });
  // Before the panel, because a character has to be defined before it is placed.
  ui4.tags.splice(spriteIndexOf(ui4, panelId), 0, wrapper);

  const index = spriteIndexOf(ui4, panelId);
  const children = spriteInnerTags(ui4.tags[index]);
  children.unshift(
    buildPlaceObject2({
      depth: MOUNT_ICON_DEPTH,
      charId: wrapperId,
      name: MOUNT_ICON_NAME,
      x: MOUNT_ICON_PARK.x,
      y: MOUNT_ICON_PARK.y,
    }),
  );
  ui4.tags[index] = rebuildSprite(ui4.tags[index], children);

  addPetIcons(ui4, panelId);
  addHelmIcons(ui4, panelId);

  ensureBackup(UI4_SWF);
  writeSwfFile(UI4_SWF, ui4);
  console.log(
    `${UI4_SWF}: ${MOUNT_ICON_NAME} = character ${MOUNT_ICON_CHAR} wrapped as ${wrapperId}, ` +
      `${Math.round((art.xMax - art.xMin) / 20)}x${Math.round((art.yMax - art.yMin) / 20)}px at its own origin, ` +
      `placed in panel ${panelId} at depth ${MOUNT_ICON_DEPTH}.`,
  );
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
