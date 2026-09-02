/**
 * Turns the lockbox screen into the Hallow's Eve coffers board when a coffer is
 * what is being opened, and leaves it alone when a Treasure Trove is.
 *
 * ## The problem this exists for
 *
 * `class_73` / `a_ScreenLockBoxAD` is one screen serving two lockboxes: the
 * Treasure Trove (id 1) and the Hallow's Eve coffer (id 2, minted by
 * `patch_swz_hallows_eve_coffer.ts`). `patch-ui4-hallows-eve-coffer-skin.ts` lays
 * the seasonal panel into it as `am_HallowsEveSkin`, and with nothing to switch
 * that placement a trove opens wearing skulls and pumpkins too.
 *
 * Everything below is driven off `mLockboxData.mLockboxID`, which the client sets
 * from the bag item the player actually clicked, so the two screens can share one
 * class and still be two screens.
 *
 * ## The four blocks
 *
 * **`OnTickScreen` - the chrome.** The panel is shown for the coffer and hidden for
 * everything else, and the trove's own furniture goes the other way. Two lists,
 * because they are not the same problem:
 *
 *   - `HIDDEN_ALWAYS` is art the class never touches - the gold chest, the OPEN
 *     TROVES plate, the two counters standing on it. Nothing would ever put them
 *     back, so they are driven both ways: `visible = !isCoffer`.
 *   - `HIDDEN_ON_COFFER` is what the class shows and hides itself - the four
 *     mutually exclusive buttons and the OPEN TREASURE TROVE board. These are only
 *     ever forced *off*, on the coffer path; pushing them on would draw all four
 *     buttons at once.
 *
 *   The room, the hairline and the pedestal are not in either list: they are
 *   unnamed placements, so the art patch moves them under the panel instead, where
 *   being covered is as good as being hidden. `am_Ok` stays where it was authored
 *   and stays visible on both screens - it is the only way out of either.
 *
 *   The same block picks the prize column's helm. `am_CacheIcon` ships all three
 *   class hats stacked in one cell - `am_MageHelm`, `am_PallyHelm`, `am_RogueHelm`,
 *   in that depth order - so the Rogue hood was drawn over the other two for
 *   everyone. Each is shown only to the class that would actually be paid it, which
 *   is the same helm `HallowsEve.nextPrize` hands out.
 *
 * **`OnCreateScreen` - the wiring.** Every `am_Coffer0..39` gets `buttonMode` and a
 * click listener, once, when the screen is built. The listener is `method_782` -
 * the screen's *own* Open handler, the one the OPEN button used - so a click on a
 * skull spends a key and opens a coffer through exactly the path that was already
 * tested, including its "you have no keys" and "you have no boxes" branches. A
 * hidden clip receives no mouse events, so the cells are inert on the trove screen
 * without anything having to switch them off.
 *
 *   `addEventListener` with the same method closure twice is a no-op in AVM2 -
 *   `this.method_782 == this.method_782` - so this cannot stack a second listener
 *   even if the screen is somehow rebuilt on the same clip.
 *
 * **`OnInitDisplay` and `OnRefreshScreen` - the board.** Each cell is a three-frame
 * clip authored `Ready` / `Over` / `Inactive`: a skull, a lit skull, and an empty
 * socket. Nothing was stopping it, which is why all forty were flickering through
 * the three. Cell *i* is now stopped on `Ready` while `i < remaining` and on
 * `Inactive` otherwise, where `remaining` is the coffer's own `stackCount` - the
 * server keeps that equal to the number of cells left on the board
 * (`HallowsEve.boardRemaining`), so a key spent takes a skull off the wall and the
 * wall stays that way across sessions.
 *
 *   These two run on opening and on every lockbox update - which is exactly when a
 *   cell changes - rather than per frame: `getChildByName` down forty cells every
 *   tick is a linear scan forty times over, and re-issuing `gotoAndStop` would also
 *   restart each cell's glow animation every frame.
 *
 * ## How it is written
 *
 * Every child is reached with `getChildByName("...")`, never as a property, so no
 * multiname has to be minted for a name that is not already in a 5MB obfuscated
 * constant pool - only the strings themselves are appended, past the last one, so
 * no existing index moves. Each lookup is null-checked; a file whose art patch has
 * not been run yet finds nothing and does nothing.
 *
 * The forty cells are unrolled rather than looped. A loop would be a fortieth of
 * the bytes, but it puts a back edge in injected code, and a back edge is the one
 * shape in this codebase that has verified clean in FFDec and still thrown
 * VerifyError #1021 in real Flash. Every block here branches forward only.
 *
 * Each block is fenced by `pushstring MARKER; pop` at both ends so re-running swaps
 * it out instead of stacking a second copy in front of it.
 *
 * Usage: npm exec ts-node scripts/patch-dungeonblitz-hallows-eve-coffer-screen.ts [--verify]
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import {
  applyPatchesToBody,
  BytePatch,
  classIndexByName,
  disassemble,
  ensureBackup,
  Instruction,
  methodIdxForTrait,
  parseAbc,
  parseSwf,
  PatchError,
  readU30,
  SwfContext,
  u30OperandName,
  writeSwf,
  writeU30,
} from "./swfPatchUtils";

const DEFAULT_SWF = path.resolve(
  __dirname,
  "..",
  "..",
  "client",
  "content",
  "localhost",
  "p",
  "cbp",
  "DungeonBlitz.swf",
);
const INDEX_HTML = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "index.html");

/** The art half of this feature, hashed into the cache token alongside the client. */
const UI4_SWF = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p", "cbp", "UI_4.swf");

/** The cursor half, hashed in too - see `syncClientRev`. */
const UI1_SWF = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p", "cbp", "UI_1.swf");

const HOST_CLASS = "class_73";

/** Fences an injected block. Appears nowhere else in the client. */
const MARKER = "HallowsEveCofferScreen";

/** The placement `patch-ui4-hallows-eve-coffer-skin.ts` adds to the screen. */
const SKIN_NAME = "am_HallowsEveSkin";

/** The prize column, the icon strip inside it, and the grid of cells. */
const PRIZE_GROUP_NAME = "am_PrizeGroup";
const CACHE_ICON_NAME = "am_CacheIcon";
const COFFER_GROUP_NAME = "am_CofferGroup";
const COFFER_CELL_PREFIX = "am_Coffer";

/** The looping pulse inside a cell's `Ready` frame. */
const GLOW_NAME = "am_GlowAnim";

/** How many cells the seasonal panel authored, and what the board is worth. */
const COFFER_CELLS = 40;

/**
 * The cell clip's frames, by number.
 *
 * It is authored `Ready` (the skull), `Over` (the skull lit) and `Inactive` (an
 * empty socket) in that order. Numbers rather than labels, because a number is what
 * a cell that has never been stopped is sitting on.
 */
const FRAME_READY = 1;
const FRAME_INACTIVE = 3;

/**
 * Trove furniture the class never hides on its own, so this drives it both ways.
 *
 * The chest and the plate are the two things that still say *trove* over a board
 * made of skulls; the counters stand on the plate and would be left floating. The
 * sigil row along the bottom right is the same argument one step further out - it
 * is the trove's shop, and the coffers does not have one. `am_SigilPlate` is the
 * plate, the coin and the amount, which are three unnamed placements until
 * `patch-ui4-hallows-eve-coffer-skin.ts` wraps them under that one name; they sit
 * below the panel's bottom edge, so unlike the pedestal they cannot simply be
 * pushed underneath it.
 */
const HIDDEN_ALWAYS = [
  "am_OpenButtonBase",
  "am_KeyCounter",
  "am_LockboxCounter",
  "am_EarnedSigils",
  "am_OpenSigilStore",
  "am_SigilPlate",
  "am_LockBoxRoom",
  "am_Ok",
  // The gold chest never shows on the coffer screen now: the skull that opens in
  // its place is a separate child this block drives itself.
  "am_Lockbox",
];

/**
 * The chest, which is trove furniture right up until it is the prize reveal.
 *
 * `method_1148` - the reveal - is literally *open the chest*: it plays
 * `var_396.method_147("Open", "LockBox_Basic_Open")` and floats the prize out of
 * it. Hiding the chest outright therefore took the reward screen with it: the key
 * was spent, the server sent the prize, and it was revealed on something nobody
 * could see.
 *
 * So the chest is hidden while the board is idle and shown for exactly as long as
 * an open is in flight. `var_1883` is set when the open is sent and cleared when
 * the reveal lands; `var_1929` is set when the reveal starts and cleared when it
 * finishes, so between them they cover the click all the way to the prize. The
 * shipped code writes both with `initproperty`, which FFDec renders as a plain
 * assignment; the `getproperty` operand for each is in the pool all the same.
 */
const CHEST_NAME = "am_Lockbox";

/** The panel's own close button, which takes DONE's place and DONE's handler. */
const CLOSE_NAME = "am_Close";

/**
 * The opening skull, and the frames of its `Open` sequence.
 *
 * The clip is `a_EvilCofferOpenAnimation`, imported next to the chest rather than
 * over it: handing it to `class_33` as `am_Lockbox` took the whole screen down
 * twice. `Open` is labelled at frame 3 and the next label, `Loop2`, is at 63, so
 * the sequence this block walks is 3..62.
 */
const COFFER_ANIM_NAME = "am_HallowsEveOpen";
const COFFER_ANIM_FIRST = 3;
const COFFER_ANIM_LAST = 63;

/** How many frames count as "the reveal has only just started". */
const COFFER_ANIM_LATCH = 2;

/** The grid: eight columns of cells 80 by 85 apart, starting at (39, 53). */
const COFFER_GRID_X = 39;
const COFFER_GRID_Y = 53;
const COFFER_GRID_DX = 80;
const COFFER_GRID_DY = 85;
const COFFER_GRID_COLS = 8;

/**
 * The class timer that decides when the prize card appears, and what it becomes.
 *
 * 2600ms leaves the sixty-frame opening (61 frames at 40ms = 2440ms) to finish with
 * a beat to spare before the reward is floated out.
 */
const REVEAL_DELAY_CONST = "const_1176";
const REVEAL_DELAY_SHIPPED_MS = 1100;
const REVEAL_DELAY_MS = 1800;

/**
 * The two cursors the client already carries for this screen.
 *
 * Game registers sixteen with CustomMouse and selects fourteen; these two it only
 * registers. They were the coffers screens own, and nothing else wants them.
 */
const CURSOR_KEY = "a_CustomMouse_Key";
const CURSOR_KEY_WAITING = "a_CustomMouse_KeyWaiting";

/**
 * `MouseCursor.AUTO`, spelled out.
 *
 * What `CustomMouse` itself falls back to when it has no cursor of its own to apply
 * (`Mouse.cursor = this.var_2002 ? this.var_2002 : MouseCursor.AUTO`), so it is what
 * this file hands back in the same case.
 */
const CURSOR_AUTO = "auto";

/**
 * The prize banner, its text child, and where the prize name is read from.
 *
 * The banner is the world map header imported by the art patch; its own text child
 * is called am_Zone because that is what the map writes into it. The name is copied
 * off the reward card the class fills in, so the two can never disagree.
 */
const BANNER_NAME = "am_HallowsEveBanner";
const BANNER_TEXT = "am_Name";
const BANNER_LAST = 1;
const BANNER_PREFIX = "You got ";

const BANNER_MS_PER_FRAME = 45;

/**
 * The forge sparkle behind the banner.
 *
 * `patch-ui4-hallows-eve-coffer-skin.ts` places the forge screen own
 * `am_ParticleBurst` character in the panel as `am_HallowsEveBurst`, one depth
 * under the parchment. Eighteen frames of sparkles thrown outward - driven here off
 * the same reveal clock as the banner so the two land together, and parked on frame
 * one (a single frame of nothing) the rest of the time.
 */
const BURST_NAME = "am_HallowsEveBurst";
const BURST_LAST = 18;
const BURST_MS_PER_FRAME = 55;

/**
 * How long the skull takes to finish opening.
 *
 * `COFFER_ANIM_FIRST`..`COFFER_ANIM_LAST` at `COFFER_ANIM_MS_PER_FRAME` each. The
 * reward used to appear the moment the reveal *started* - `var_1929` goes true on
 * the click - so the banner unrolled over a skull that was still cracking open.
 * Nothing about the reward is shown until this much of the reveal has passed.
 */

/** The ring's empty icon socket, and the card's framed icon that fills it. */
const RING_SOCKET = "am_CharmHolder";
const CARD_ICON = "am_Icon";

/**
 * The frame the reward card is parked on before its icon is taken.
 *
 * The card is a sixty-two frame clip and the prize picture is a *frame*, not
 * something loaded into a holder - `var_1191` is only ever cleared in this class,
 * and the one place that fills it is the tooltip. Parking the card on frame 1 was
 * therefore parking it on the blank first frame of its own unroll, which is why the
 * ring kept coming up empty however the icon was moved. The last frame is the card
 * fully open, with the prize on it.
 */
const CARD_LAST_FRAME = 62;

/**
 * Where `am_Icon` sits on the card, so borrowing it can be undone.
 *
 * The icon is not a copy - there is one of it, and the class restages it on the
 * card for each new prize. Taking it away for good meant the first skull looked
 * right and every skull after it was stuck with the first one's picture, because
 * the class was updating an icon that no longer hung where it was put. So it is
 * borrowed for as long as the reward is on screen and handed straight back the
 * moment the next skull is opened.
 */
const CARD_ICON_X = 159;
const CARD_ICON_Y = 188;

/**
 * How the borrowed prize is fitted to the ring.
 *
 * `am_CharmHolder` is char 211: a 52x52 plate with a drawn border, and its face runs
 * (-2, -2) to (50, 50) in the space the borrowed holder lands in. Inside that border
 * there are about 48 units of flat plate, so a 46 box inset by 1 fills the frame with
 * a unit to spare on each side - clear of the rounded corners, and no plate showing
 * around the prize.
 *
 * The prizes do not agree on a size: `a_RewardTypeIcon_*` and an item's own `iconName`
 * are 48 square, `class_41.method_374` renders a pet or a mount at 58, and a gear
 * render is whatever `RenderGear` produced. A fixed scale therefore fits exactly one
 * of them and leaves the rest short or over, which is what 0.7 was doing. Writing
 * `width` and `height` sizes each of them to the frame instead.
 *
 * A `getBounds` fit stood here for one round and cost the prize entirely; this needs
 * no measurement, only the two setters.
 */
const RING_FIT = 46;
const RING_ICON_X = 1;
const RING_ICON_Y = 1;
/**
 * Where the prize holder sits when it is not on loan.
 *
 * `am_ItemIconHolder` is placed inside `am_Icon` at 85 twips - 4.25px - on both axes,
 * scaled 1.125. Ratios rather than literals: a fractional constant would need a new
 * entry in the ABC double pool, and both of these are exact as a division.
 */
const HOLDER_HOME_NUM = 17;
const HOLDER_HOME_DEN = 4;
const HOLDER_SCALE_NUM = 9;
const HOLDER_SCALE_DEN = 8;

/**
 * The prize column, and the numbers printed down it.
 *
 * The panel's left edge carries five icons with a count beside each, and the counts
 * are editable text fields with instance names - `am_PrizeCount0` at the top through
 * `am_PrizeCount4` at the bottom, inside `am_TextGroup`. So they are not drawn art:
 * they can be written, and this is where they are written from.
 *
 * The five numbers are `HALLOWS_EVE_BOARD` in `core/HallowsEve.ts`, in that table's
 * order - the mount, the helm, the candy shelf, the gold bags, the gold piles. The
 * server deals the board from that table and this column advertises it, so **the two
 * have to be changed together**; a wall that says x20 while the table holds 13 is
 * lying to the player about what is behind the skulls.
 *
 * The panel ships x1/x1/x8/x10/x20 authored into those fields, which is what the
 * board held when the art was drawn. Writing all five rather than only the two that
 * moved means the column is right whatever the art was left saying.
 */
const COUNT_GROUP = "am_TextGroup";
const PRIZE_COUNTS = ["x1", "x1", "x8", "x10", "x20"];
const FLOATER_NAME = "am_RewardFloater0";
const FLOATER_WRAP = "am_NameWrapper";
const FLOATER_TEXT = "am_Name";

/**
 * How the opening is paced, and where it sits over the cell it opens.
 *
 * 60ms a frame turns the 60-frame sequence into about three and a half seconds; one
 * frame per tick ran it in two and read as a flicker. The offsets put the clip's
 * centre on the cell's: a cell draws 190x195 at scale 0.43, so its middle is 41 and
 * 40 from its own origin, and this clip's middle is 4 and -18 from its origin at
 * scale 0.75.
 */
const COFFER_ANIM_MS_PER_FRAME = 28;
const REVEAL_SHOW_AFTER_MS = (COFFER_ANIM_LAST - COFFER_ANIM_FIRST) * COFFER_ANIM_MS_PER_FRAME;
const COFFER_ANIM_OFFSET_X = 37;
const COFFER_ANIM_OFFSET_Y = 58;

/**
 * Trove furniture the class shows and hides itself.
 *
 * Only ever forced off, and only on the coffer path: the first four are one button
 * in four states and pushing them all on would draw them over each other, and
 * `am_SigilFloatAnim` is a transient "+N" the class hides for itself on every
 * opening.
 */
const HIDDEN_ON_COFFER = [
  "am_Open",
  "am_OpenAnother",
  "am_GetKeys",
  "am_GetTroves",
  "am_RewardsTooltip",
  // The reward card and its second line - the coffers says what it paid on its own
  // parchment now, and the card was still printing the trove's Silver Sigils row.
  "am_RewardFloater0",
  "am_RewardFloater1",
  "am_SigilFloatAnim",
];

/**
 * The stacked helms, and the `EntType.className` each belongs to.
 *
 * The names are the seasonal panel's own; the class strings are what
 * `EntType.className` is set to for a player - "Paladin", "Rogue", "Mage" - not
 * `mMasterClass`, which is lowercase.
 */
const HELMS: Array<{ child: string; className: string }> = [
  { child: "am_MageHelm", className: "Mage" },
  { child: "am_PallyHelm", className: "Paladin" },
  { child: "am_RogueHelm", className: "Rogue" },
];

/** The class shown to a character whose entity has not arrived yet. */
const DEFAULT_CLASS = "Mage";

/** The event a cell listens for. `MouseEvent.CLICK`, spelled out. */
const CLICK_EVENT = "click";

/**
 * `HALLOWS_EVE_COFFER_LOCKBOX_ID`, on the client's side of the wire.
 *
 * Ids are sent in two bits, so this cannot drift far, but it does have to agree
 * with `core/HallowsEve.ts` and with `LockboxTypes.xml`.
 */
const COFFER_LOCKBOX_ID = 2;

/**
 * Scratch locals, appended past every host method's own count (the largest is 5).
 *
 * One base for all four blocks so a method that has already been patched - and so
 * declares the raised count - reads back the same way as one that has not.
 */
const L_CLIP = 10;
const L_DATA = 11;
const L_FLAG = 12;
const L_NOT = 13;
const L_GROUP = 14;
const L_READY = 15;
const L_WANT = 16;
const L_SKIN = 17;
const L_CAN_OPEN = 18;
const L_ENABLED = 19;
const L_REVEAL = 20;
const L_ANIM = 21;
const L_FRAME = 22;
const L_CELL = 23;
const L_CURSOR = 24;
const L_BANNER = 25;
const L_BURST = 26;
const L_ICON = 27;
const L_SHOW = 28;
const SCRATCH_BASE = 10;
const NEW_LOCAL_COUNT = 29;
// The hosts declare 5 and 8; the deepest emitted block needs 5. Ten leaves both
// covered with the margin the assembler insists on.
const NEW_MAX_STACK = 10;

const OP = {
  jump: 0x10,
  iftrue: 0x11,
  ifnlt: 0x0c,
  iffalse: 0x12,
  ifeq: 0x13,
  ifne: 0x14,
  // 0x15. 0x0c is ifnlt, which is what this said for one round: the board came out
  // inverted, spent cells showing skulls and live ones showing empty sockets.
  iflt: 0x15,
  pushbyte: 0x24,
  pushnull: 0x20,
  pushtrue: 0x26,
  pushfalse: 0x27,
  pop: 0x29,
  dup: 0x2a,
  pushstring: 0x2c,
  callproperty: 0x46,
  callpropvoid: 0x4f,
  getlex: 0x60,
  setproperty: 0x61,
  getlocal: 0x62,
  setlocal: 0x63,
  getproperty: 0x66,
  convert_b: 0x76,
  coerce_a: 0x82,
  not: 0x96,
  add: 0xa0,
  subtract: 0xa1,
  divide: 0xa3,
  convert_i: 0x73,
  pushshort: 0x25,
  swap: 0x2b,
  multiply: 0xa2,
  equals: 0xab,
} as const;

type Operand = [Instruction["operands"][number][0], number];
type Emitted =
  | { label: string }
  | { opcode: number; operands?: Operand[]; branchTo?: string; pop?: number; push?: number };

function parseArgs(argv: string[]): { swfPath: string; verify: boolean; remove: boolean; only: string[] | null } {
  let swfPath = DEFAULT_SWF;
  let verify = false;
  let remove = false;
  let only: string[] | null = null;

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--swf" || arg === "-s") {
      swfPath = path.resolve(argv[++index] || "");
      continue;
    }
    if (arg === "--verify" || arg === "--dry-run") {
      verify = true;
      continue;
    }
    if (arg === "--remove") {
      remove = true;
      continue;
    }
    if (arg === "--only") {
      only = (argv[++index] || "").split(",").map((name) => name.trim()).filter(Boolean);
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log(
        [
          "Usage:",
          "  ts-node src/server/scripts/patch-dungeonblitz-hallows-eve-coffer-screen.ts [--verify] [--swf <path>]",
          "",
          "Makes a_ScreenLockBoxAD the Hallow's Eve coffers board for lockbox 2 and the",
          "shipped Treasure Trove screen for everything else: switches the panel, takes",
          "the trove's furniture off, stops the forty cells flickering, wires each one to",
          "the screen's own Open handler, empties the cells the board has spent, and draws",
          "one class helm in the prize column instead of three.",
        ].join("\n"),
      );
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { swfPath, verify, remove, only };
}

/**
 * Moves the cache token, over **both** files this feature ships.
 *
 * `clientrev` is one token for every asset the client fetches, and every patch
 * script stamps it from a digest of the file it just wrote - which means a change
 * to `UI_4.swf` alone never moves it, and the panel would sit in browser caches
 * behind bytecode that expects it. This script is the one that runs after the art
 * patch, so it hashes the pair.
 */
function syncClientRev(swfPath: string): void {
  if (path.resolve(swfPath) !== DEFAULT_SWF || !fs.existsSync(INDEX_HTML)) {
    return;
  }
  const hash = crypto.createHash("sha1").update(fs.readFileSync(swfPath));
  for (const asset of [UI4_SWF, UI1_SWF]) {
    if (fs.existsSync(asset)) {
      hash.update(fs.readFileSync(asset));
    }
  }
  const digest = hash.digest("hex").slice(0, 12);
  const html = fs.readFileSync(INDEX_HTML, "utf8");
  const updated = html.replace(/clientrev=[^&`"'$]+/, `clientrev=swf-${digest}`);
  if (updated !== html) {
    fs.writeFileSync(INDEX_HTML, updated);
    console.log(`  index.html clientrev -> swf-${digest} (cache buster)`);
  }
}

function writeS24(value: number): Buffer {
  const out = Buffer.alloc(3);
  let encoded = value;
  if (encoded < 0) {
    encoded += 1 << 24;
  }
  out[0] = encoded & 0xff;
  out[1] = (encoded >>> 8) & 0xff;
  out[2] = (encoded >>> 16) & 0xff;
  return out;
}

function isBranchOpcode(opcode: number): boolean {
  return opcode >= 0x0c && opcode <= 0x1a;
}

function operandBytes(kind: Operand[0], value: number): Buffer {
  if (kind === "u30") {
    return writeU30(value);
  }
  if (kind === "s8") {
    return Buffer.from([value & 0xff]);
  }
  if (kind === "s24") {
    return writeS24(value);
  }
  throw new PatchError(`Unsupported operand kind ${kind}`);
}

/**
 * Constant pool detail parseAbc does not keep: the two positions needed to append
 * new strings, plus the namespace kinds behind the multiname table so a property
 * can be referenced by the exact QName the player VM will resolve.
 */
interface PoolInfo {
  strings: string[];
  stringCountPos: number;
  stringCountEnd: number;
  stringPoolEnd: number;
  publicQName(name: string): number;
  qNameIn(namespace: string, name: string): number;
}

function parsePool(ctx: SwfContext): PoolInfo {
  const d = ctx.body;
  let pos = ctx.abcStart + 4;
  let count: number;

  [count, pos] = readU30(d, pos, "pool.int");
  for (let i = 1; i < count; i += 1) {
    [, pos] = readU30(d, pos, "pool.int[]");
  }
  [count, pos] = readU30(d, pos, "pool.uint");
  for (let i = 1; i < count; i += 1) {
    [, pos] = readU30(d, pos, "pool.uint[]");
  }
  [count, pos] = readU30(d, pos, "pool.double");
  pos += 8 * (count - 1);

  const stringCountPos = pos;
  [count, pos] = readU30(d, pos, "pool.string");
  const stringCountEnd = pos;
  const strings = [""];
  for (let i = 1; i < count; i += 1) {
    let len: number;
    [len, pos] = readU30(d, pos, "pool.string[].len");
    strings.push(d.subarray(pos, pos + len).toString("utf8"));
    pos += len;
  }
  const stringPoolEnd = pos;

  [count, pos] = readU30(d, pos, "pool.ns");
  const nsKind = [0];
  const nsName = [0];
  for (let i = 1; i < count; i += 1) {
    nsKind.push(d[pos]);
    pos += 1;
    let name: number;
    [name, pos] = readU30(d, pos, "pool.ns[].name");
    nsName.push(name);
  }

  [count, pos] = readU30(d, pos, "pool.nsset");
  for (let i = 1; i < count; i += 1) {
    let entries: number;
    [entries, pos] = readU30(d, pos, "pool.nsset[].count");
    for (let j = 0; j < entries; j += 1) {
      [, pos] = readU30(d, pos, "pool.nsset[][]");
    }
  }

  let multinameCount: number;
  [multinameCount, pos] = readU30(d, pos, "pool.mn");
  const multinames: Array<{ kind: number; ns: number; name: number }> = [{ kind: 0, ns: 0, name: 0 }];
  for (let i = 1; i < multinameCount; i += 1) {
    const kind = d[pos];
    pos += 1;
    let ns = 0;
    let name = 0;
    if (kind === 0x07 || kind === 0x0d) {
      [ns, pos] = readU30(d, pos, "mn.ns");
      [name, pos] = readU30(d, pos, "mn.name");
    } else if (kind === 0x0f || kind === 0x10) {
      [name, pos] = readU30(d, pos, "mn.name");
    } else if (kind === 0x11 || kind === 0x12) {
      // runtime multiname, no operands
    } else if (kind === 0x09 || kind === 0x0e) {
      [name, pos] = readU30(d, pos, "mn.name");
      [, pos] = readU30(d, pos, "mn.nsset");
    } else if (kind === 0x1b || kind === 0x1c) {
      [, pos] = readU30(d, pos, "mn.nsset");
    } else if (kind === 0x1d) {
      [, pos] = readU30(d, pos, "mn.qname");
      let params: number;
      [params, pos] = readU30(d, pos, "mn.params");
      for (let j = 0; j < params; j += 1) {
        [, pos] = readU30(d, pos, "mn.param[]");
      }
    } else {
      throw new PatchError(`Unsupported multiname kind 0x${kind.toString(16)} at ${i}`);
    }
    multinames.push({ kind, ns, name });
  }

  function qNameIn(namespace: string, name: string): number {
    for (let i = 1; i < multinames.length; i += 1) {
      const mn = multinames[i];
      if (mn.kind !== 0x07 || strings[mn.name] !== name) {
        continue;
      }
      // 0x16 is PackageNamespace, the one public members and classes live in.
      if (nsKind[mn.ns] !== 0x16 || strings[nsName[mn.ns]] !== namespace) {
        continue;
      }
      return i;
    }
    throw new PatchError(`No QName for ${namespace || "public"}::${name} in the constant pool.`);
  }

  return {
    strings,
    stringCountPos,
    stringCountEnd,
    stringPoolEnd,
    publicQName: (name: string) => qNameIn("", name),
    qNameIn,
  };
}

/** New string constants, appended past the last one so no existing index moves. */
function appendStrings(pool: PoolInfo, wanted: string[]): { indexOf: Map<string, number>; patches: BytePatch[] } {
  const indexOf = new Map<string, number>();
  const missing: string[] = [];
  for (const value of wanted) {
    const existing = pool.strings.indexOf(value);
    if (existing > 0) {
      indexOf.set(value, existing);
      continue;
    }
    if (!missing.includes(value)) {
      missing.push(value);
    }
  }
  if (missing.length === 0) {
    return { indexOf, patches: [] };
  }

  let nextIndex = pool.strings.length;
  const chunks: Buffer[] = [];
  for (const value of missing) {
    const bytes = Buffer.from(value, "utf8");
    chunks.push(writeU30(bytes.length), bytes);
    indexOf.set(value, nextIndex);
    nextIndex += 1;
  }

  return {
    indexOf,
    patches: [
      {
        key: "abc.string_pool.append",
        start: pool.stringPoolEnd,
        end: pool.stringPoolEnd,
        data: Buffer.concat(chunks),
        detail: `append ${missing.length} string constants`,
      },
      {
        key: "abc.string_count",
        start: pool.stringCountPos,
        end: pool.stringCountEnd,
        data: writeU30(nextIndex),
        detail: `string_count -> ${nextIndex}`,
      },
    ],
  };
}

/**
 * Assembles a block and, on the way, checks it the way the player's verifier will:
 * every path reaching a label must arrive with the same operand stack depth, and
 * the block must leave the stack exactly as it found it. FFDec will happily
 * decompile a block that fails this; the player throws VerifyError.
 */
function assemble(program: Emitted[]): Buffer {
  const labels = new Map<string, number>();
  let offset = 0;
  for (const item of program) {
    if ("label" in item) {
      if (labels.has(item.label)) {
        throw new PatchError(`Duplicate label ${item.label}`);
      }
      labels.set(item.label, offset);
      continue;
    }
    offset += 1;
    if (item.branchTo) {
      offset += 3;
    } else {
      for (const [kind, value] of item.operands ?? []) {
        offset += operandBytes(kind, value).length;
      }
    }
  }

  const depthAt = new Map<string, number>();
  let depth = 0;
  let maxDepth = 0;
  let reachable = true;
  for (const item of program) {
    if ("label" in item) {
      const known = depthAt.get(item.label);
      if (known === undefined) {
        if (!reachable) {
          throw new PatchError(`Label ${item.label} is unreachable`);
        }
        depthAt.set(item.label, depth);
      } else {
        if (reachable && known !== depth) {
          throw new PatchError(`Stack depth mismatch at ${item.label}: ${known} vs ${depth}`);
        }
        depth = known;
      }
      reachable = true;
      continue;
    }
    if (!reachable) {
      throw new PatchError("Unreachable instruction in emitted block");
    }
    depth -= item.pop ?? 0;
    if (depth < 0) {
      throw new PatchError("Emitted block underflows the operand stack");
    }
    depth += item.push ?? 0;
    maxDepth = Math.max(maxDepth, depth);
    if (item.branchTo) {
      const known = depthAt.get(item.branchTo);
      if (known === undefined) {
        depthAt.set(item.branchTo, depth);
      } else if (known !== depth) {
        throw new PatchError(`Stack depth mismatch branching to ${item.branchTo}: ${known} vs ${depth}`);
      }
      if (item.opcode === OP.jump) {
        reachable = false;
      }
    }
  }
  if (reachable && depth !== 0) {
    throw new PatchError(`Emitted block leaves ${depth} values on the stack`);
  }
  if (maxDepth + 4 > NEW_MAX_STACK) {
    throw new PatchError(`Emitted block needs stack ${maxDepth}, budget is ${NEW_MAX_STACK}`);
  }

  const chunks: Buffer[] = [];
  const fixups: Array<{ pos: number; target: string }> = [];
  offset = 0;
  for (const item of program) {
    if ("label" in item) {
      continue;
    }
    const parts: Buffer[] = [Buffer.from([item.opcode])];
    offset += 1;
    if (item.branchTo) {
      parts.push(Buffer.alloc(3));
      fixups.push({ pos: offset, target: item.branchTo });
      offset += 3;
    } else {
      for (const [kind, value] of item.operands ?? []) {
        const bytes = operandBytes(kind, value);
        parts.push(bytes);
        offset += bytes.length;
      }
    }
    chunks.push(Buffer.concat(parts));
  }

  const assembled = Buffer.concat(chunks);
  for (const fixup of fixups) {
    const target = labels.get(fixup.target);
    if (target === undefined) {
      throw new PatchError(`Unknown branch label ${fixup.target}`);
    }
    writeS24(target - (fixup.pos + 3)).copy(assembled, fixup.pos);
  }
  return assembled;
}

/**
 * Splices `data` over [replaceStart, replaceEnd) -- an insertion when the two are
 * equal, a swap of a previously injected block otherwise -- and repoints every
 * branch in the surrounding method.
 */
function spliceAndAdjustBranches(
  originalCode: Buffer,
  instructions: Instruction[],
  replaceStart: number,
  replaceEnd: number,
  data: Buffer,
): Buffer {
  for (const inst of instructions) {
    if (!isBranchOpcode(inst.opcode) || (inst.offset >= replaceStart && inst.offset < replaceEnd)) {
      continue;
    }
    const target = inst.offset + inst.size + inst.operands[0][1];
    if (target >= replaceStart && target < Math.max(replaceEnd, replaceStart + 1)) {
      throw new PatchError(`A branch targets the injection point (${target}); refusing to splice there.`);
    }
  }

  const patched = Buffer.concat([
    originalCode.subarray(0, replaceStart),
    data,
    originalCode.subarray(replaceEnd),
  ]);

  const delta = data.length - (replaceEnd - replaceStart);
  const shift = (offset: number): number => (offset >= replaceEnd ? offset + delta : offset);

  for (const inst of instructions) {
    // Branches inside a block being replaced go away with it.
    if (!isBranchOpcode(inst.opcode) || (inst.offset >= replaceStart && inst.offset < replaceEnd)) {
      continue;
    }
    const branch = inst.operands[0];
    if (branch[0] !== "s24") {
      throw new PatchError(`Unexpected branch operand at ${inst.offset}`);
    }
    const oldEnd = inst.offset + inst.size;
    const newEnd = shift(inst.offset) + inst.size;
    writeS24(shift(oldEnd + branch[1]) - newEnd).copy(patched, shift(inst.offset) + 1);
  }

  return patched;
}

const getlocal = (index: number): Emitted =>
  index <= 3
    ? { opcode: 0xd0 + index, push: 1 }
    : { opcode: OP.getlocal, operands: [["u30", index]], push: 1 };
const setlocal = (index: number): Emitted =>
  index <= 3
    ? { opcode: 0xd4 + index, pop: 1 }
    : { opcode: OP.setlocal, operands: [["u30", index]], pop: 1 };

interface Names {
  var_1: number;
  var_2: number;
  mLockboxData: number;
  mLockboxID: number;
  mOwnedLockboxes: number;
  /** The `obj[expr]` multiname - a MultinameL, which has no readable name. */
  indexer: number;
  stackCount: number;
  mLockboxKeys: number;
  clientEnt: number;
  entType: number;
  className: number;
  visible: number;
  currentFrame: number;
  x: number;
  y: number;
  mTimeThisTick: number;
  mouseX: number;
  mouseY: number;
  mouseClass: number;
  cursor: number;
  customMouse: number;
  currentCursor: number;
  screenClosing: number;
  text: number;
  revealStart: number;
  getChildByName: number;
  gotoAndStop: number;
  buttonMode: number;
  mouseChildren: number;
  mouseEnabled: number;
  addEventListener: number;
  openHandler: number;
  closeHandler: number;
  openInFlight: number;
  revealRunning: number;
  lockboxAnim: number;
  animSound: number;
  iconHolder: number;
  width: number;
  height: number;
  maskHolder: number;
  parent: number;
  addChild: number;
  scaleX: number;
  scaleY: number;
  clearAnimation: number;
}

/** The shared shorthands every block is written with. */
function emitters(names: Names, str: (value: string) => number) {
  const get = (mn: number): Emitted => ({ opcode: OP.getproperty, operands: [["u30", mn]], pop: 1, push: 1 });
  const set = (mn: number): Emitted => ({ opcode: OP.setproperty, operands: [["u30", mn]], pop: 2 });
  const pushString = (value: string): Emitted => ({
    opcode: OP.pushstring,
    operands: [["u30", str(value)]],
    push: 1,
  });
  const child = (name: string): Emitted[] => [
    pushString(name),
    { opcode: OP.callproperty, operands: [["u30", names.getChildByName], ["u30", 1]], pop: 2, push: 1 },
  ];
  const marker: Emitted[] = [pushString(MARKER), { opcode: OP.pop, pop: 1 }];
  return { get, set, pushString, child, marker };
}

/**
 * `clip = var_2`, the screen root every child hangs off.
 *
 * Every block opens with this, and every block ends with the `bail` / `done` pair
 * the null check branches into.
 */
function prologue(names: Names): Emitted[] {
  return [
    { opcode: OP.getlex, operands: [["u30", names.var_2]], push: 1 },
    { opcode: OP.dup, push: 1 },
    { opcode: OP.iffalse, branchTo: "bail", pop: 1 },
    { opcode: OP.coerce_a },
    setlocal(L_CLIP),
  ];
}

function epilogue(): Emitted[] {
  return [
    { opcode: OP.jump, branchTo: "done" },
    // Every null check above lands here with its own dup still on the stack.
    { label: "bail" },
    { opcode: OP.pop, pop: 1 },
    { label: "done" },
  ];
}

/** `data = var_1.mLockboxData`, which both the id and the stack come off. */
function lockboxData(names: Names): Emitted[] {
  const { get } = emitters(names, () => 0);
  return [
    { opcode: OP.getlex, operands: [["u30", names.var_1]], push: 1 },
    { opcode: OP.dup, push: 1 },
    { opcode: OP.iffalse, branchTo: "bail", pop: 1 },
    get(names.mLockboxData),
    { opcode: OP.dup, push: 1 },
    { opcode: OP.iffalse, branchTo: "bail", pop: 1 },
    { opcode: OP.coerce_a },
    setlocal(L_DATA),
  ];
}

/**
 * The one `am_Icon` the class is actually filling, by identity.
 *
 * Leaves `this.var_1191.parent` on the stack - or null, which every caller checks.
 * `var_1191` is `am_RewardFloater0.am_Icon.am_ItemIconHolder`, read once in
 * `OnCreateScreen` and held from then on, so its parent is the original icon however
 * many copies the card's own timeline has since stacked up under the same name. See
 * "Which `am_Icon`" in `chromeProgram`.
 */
function theIcon(names: Names, tag: string): Emitted[] {
  const { get } = emitters(names, () => 0);
  return [
    getlocal(0),
    // `var_1085` - `am_MaskIconHolder` - rather than `var_1191`, and the difference
    // matters as soon as anything moves. Both are cached children of `am_Icon`, but
    // the item holder is the one this file lends to the ring, so while a prize is on
    // screen `var_1191.parent` is `am_CharmHolder` - and asking that for the icon and
    // then putting what came back on the card would have taken the ring's own socket,
    // plate and all, out of the ring. The mask holder is never moved by anything here
    // and `method_1148` only ever clears its children, so its parent is `am_Icon`
    // whatever else is going on.
    get(names.maskHolder),
    { opcode: OP.dup, push: 1 },
    // The null the class leaves behind in `OnDestroyScreen` stands in for the icon,
    // and every caller checks what it is handed, so there is one value on the stack
    // either way. Labels belong to a program, hence the tag: two of these in one
    // method cannot share them.
    { opcode: OP.iffalse, branchTo: `haveIcon${tag}`, pop: 1 },
    get(names.parent),
    { label: `haveIcon${tag}` },
  ];
}

/** `flag = data.mLockboxID == COFFER_LOCKBOX_ID`, into `L_FLAG`. */
function isCoffer(names: Names): Emitted[] {
  const { get } = emitters(names, () => 0);
  return [
    getlocal(L_DATA),
    get(names.mLockboxID),
    { opcode: OP.pushbyte, operands: [["s8", COFFER_LOCKBOX_ID]], push: 1 },
    { opcode: OP.equals, pop: 2, push: 1 },
    setlocal(L_FLAG),
  ];
}

/**
 * The chrome: which of the two screens this is, and what the other one's furniture
 * does about it.
 */
function chromeProgram(names: Names, str: (value: string) => number): Emitted[] {
  const { get, set, pushString, child, marker } = emitters(names, str);

  const program: Emitted[] = [
    ...marker,
    ...prologue(names),
    ...lockboxData(names),
    ...isCoffer(names),

    // The other half of the switch, computed once.
    getlocal(L_FLAG),
    { opcode: OP.not, pop: 1, push: 1 },
    setlocal(L_NOT),

    // The seasonal panel belongs to the coffer and to nothing else.
    getlocal(L_CLIP),
    ...child(SKIN_NAME),
    { opcode: OP.dup, push: 1 },
    { opcode: OP.iffalse, branchTo: "noSkin", pop: 1 },
    getlocal(L_FLAG),
    set(names.visible),
    { opcode: OP.jump, branchTo: "afterSkin" },
    { label: "noSkin" },
    { opcode: OP.pop, pop: 1 },
    { label: "afterSkin" },
  ];

  // remaining = the coffer's stack, which is also the index of the cell that was
  // just opened: the client decrements it locally the moment the open is sent.
  program.push(
    { opcode: OP.pushbyte, operands: [["s8", 0]], push: 1 },
    setlocal(L_READY),
    getlocal(L_DATA),
    get(names.mOwnedLockboxes),
    { opcode: OP.dup, push: 1 },
    { opcode: OP.iffalse, branchTo: "noEntry", pop: 1 },
    { opcode: OP.pushbyte, operands: [["s8", COFFER_LOCKBOX_ID]], push: 1 },
    { opcode: OP.getproperty, operands: [["u30", names.indexer]], pop: 2, push: 1 },
    { opcode: OP.dup, push: 1 },
    { opcode: OP.iffalse, branchTo: "noEntry", pop: 1 },
    get(names.stackCount),
    setlocal(L_READY),
    { opcode: OP.jump, branchTo: "haveReady" },
    { label: "noEntry" },
    { opcode: OP.pop, pop: 1 },
    { label: "haveReady" },
  );

  // revealing = openInFlight || revealRunning - the window from the click on a
  // skull to the end of the prize reveal.
  program.push(
    getlocal(0),
    get(names.openInFlight),
    { opcode: OP.iftrue, branchTo: "revealOn", pop: 1 },
    getlocal(0),
    get(names.revealRunning),
    { opcode: OP.convert_b, pop: 1, push: 1 },
    { opcode: OP.jump, branchTo: "revealSet" },
    { label: "revealOn" },
    { opcode: OP.pushtrue, push: 1 },
    { label: "revealSet" },
    setlocal(L_REVEAL),

    // **The opening skull, played by hand.**
    //
    // `class_33` cannot be asked to do this: handing it this clip as `am_Lockbox`
    // is what took the screen down twice, because its animation system wants a
    // label table the seasonal clip does not satisfy and it fails inside
    // `Display()`. So the clip stays out of the class's reach and this block walks
    // the timeline itself - `gotoAndStop(currentFrame + 1)` once per tick, which is
    // exactly what `class_33` does internally anyway.
    //
    // `Open` is frame 3 and the next label is `Loop2` at 63, so the sequence is
    // 3..62: parked at 3 while idle, advanced while a reveal is running, held on 62
    // once it is fully open.
    // The grid, which both the animation and the cell it opens over live inside.
    // The panel is kept on the way past: the banner below hangs off it, and reading
    // a local nobody had written is the one mistake in this file that has ever taken
    // the screen down.
    getlocal(L_CLIP),
    ...child(SKIN_NAME),
    { opcode: OP.dup, push: 1 },
    { opcode: OP.iffalse, branchTo: "noGroup2", pop: 1 },
    { opcode: OP.dup, push: 1 },
    { opcode: OP.coerce_a },
    setlocal(L_SKIN),
    ...child(COFFER_GROUP_NAME),
    { opcode: OP.dup, push: 1 },
    { opcode: OP.iffalse, branchTo: "noGroup2", pop: 1 },
    { opcode: OP.coerce_a },
    setlocal(L_GROUP),
    { opcode: OP.jump, branchTo: "haveGroup2" },
    { label: "noGroup2" },
    { opcode: OP.pop, pop: 1 },
    { opcode: OP.jump, branchTo: "done" },
    { label: "haveGroup2" },

    getlocal(L_GROUP),
    ...child(COFFER_ANIM_NAME),
    { opcode: OP.dup, push: 1 },
    { opcode: OP.iffalse, branchTo: "noAnim", pop: 1 },
    { opcode: OP.coerce_a },
    setlocal(L_ANIM),

    // Only while the reveal is actually running. `var_1883` covers the wait for the
    // server too, and during that wait `var_2206` still holds the *previous*
    // reveal's stamp - reading the clock against it would jump the skull straight to
    // fully open before anything had happened.
    getlocal(L_FLAG),
    { opcode: OP.iffalse, branchTo: "parkAnim", pop: 1 },
    getlocal(0),
    get(names.revealRunning),
    { opcode: OP.iffalse, branchTo: "parkAnim", pop: 1 },

    // **Paced off the clock, not off the frame rate.**
    //
    // `var_2206` is the millisecond stamp `method_1148` takes when the reveal
    // starts, so the frame is simply how far into the sequence the clock has got.
    // The sequence runs 3..63 - one past `Open`'s last drawn frame and onto `Loop2`,
    // the authored settled-open state, so it comes to rest instead of stopping dead.
    { opcode: OP.getlex, operands: [["u30", names.var_1]], push: 1 },
    get(names.mTimeThisTick),
    getlocal(0),
    get(names.revealStart),
    { opcode: OP.subtract, pop: 2, push: 1 },
    { opcode: OP.pushshort, operands: [["u30", COFFER_ANIM_MS_PER_FRAME]], push: 1 },
    { opcode: OP.divide, pop: 2, push: 1 },
    { opcode: OP.convert_i },
    { opcode: OP.pushbyte, operands: [["s8", COFFER_ANIM_FIRST]], push: 1 },
    { opcode: OP.add, pop: 2, push: 1 },
    { opcode: OP.dup, push: 1 },
    { opcode: OP.pushbyte, operands: [["s8", COFFER_ANIM_LAST]], push: 1 },
    { opcode: OP.ifnlt, branchTo: "clampAnim", pop: 2 },
    { opcode: OP.jump, branchTo: "haveFrame" },
    { label: "clampAnim" },
    { opcode: OP.pop, pop: 1 },
    { opcode: OP.pushbyte, operands: [["s8", COFFER_ANIM_LAST]], push: 1 },
    { label: "haveFrame" },
    setlocal(L_FRAME),

    getlocal(L_ANIM),
    { opcode: OP.pushtrue, push: 1 },
    set(names.visible),

    // **The skull the player actually clicked.**
    //
    // Nothing tells this block which cell was hit: all forty share one handler, and
    // the handler is the class's own. What it does have is the pointer - and on the
    // first tick of a reveal the pointer is still on the skull that started it. The
    // grid is a plain 8x5 of cells 80 by 85 apart starting at (39, 53), and the
    // animation is a child of that same grid, so `mouseX`/`mouseY` read straight off
    // it give the index without a single coordinate conversion.
    //
    // The latch is the frame itself: this runs only while the computed frame is
    // still the first one, which is true for the tick or two after `var_1929` goes
    // up and never again. No stored state, and nothing to get out of step.
    getlocal(L_FRAME),
    { opcode: OP.pushbyte, operands: [["s8", COFFER_ANIM_FIRST + COFFER_ANIM_LATCH]], push: 1 },
    { opcode: OP.ifnlt, branchTo: "noLatch", pop: 2 },

    getlocal(L_GROUP),
    get(names.mouseX),
    { opcode: OP.pushbyte, operands: [["s8", COFFER_GRID_X]], push: 1 },
    { opcode: OP.subtract, pop: 2, push: 1 },
    { opcode: OP.pushbyte, operands: [["s8", COFFER_GRID_DX]], push: 1 },
    { opcode: OP.divide, pop: 2, push: 1 },
    { opcode: OP.convert_i },
    getlocal(L_GROUP),
    get(names.mouseY),
    { opcode: OP.pushbyte, operands: [["s8", COFFER_GRID_Y]], push: 1 },
    { opcode: OP.subtract, pop: 2, push: 1 },
    { opcode: OP.pushbyte, operands: [["s8", COFFER_GRID_DY]], push: 1 },
    { opcode: OP.divide, pop: 2, push: 1 },
    { opcode: OP.convert_i },
    { opcode: OP.pushbyte, operands: [["s8", COFFER_GRID_COLS]], push: 1 },
    { opcode: OP.multiply, pop: 2, push: 1 },
    { opcode: OP.add, pop: 2, push: 1 },

    getlocal(L_GROUP),
    { opcode: OP.swap },
    pushString(COFFER_CELL_PREFIX),
    { opcode: OP.swap },
    { opcode: OP.add, pop: 2, push: 1 },
    { opcode: OP.callproperty, operands: [["u30", names.getChildByName], ["u30", 1]], pop: 2, push: 1 },
    { opcode: OP.dup, push: 1 },
    { opcode: OP.iffalse, branchTo: "noCell", pop: 1 },
    { opcode: OP.coerce_a },
    setlocal(L_CELL),

    // Over it...
    getlocal(L_ANIM),
    getlocal(L_CELL),
    get(names.x),
    { opcode: OP.pushbyte, operands: [["s8", COFFER_ANIM_OFFSET_X]], push: 1 },
    { opcode: OP.add, pop: 2, push: 1 },
    set(names.x),
    getlocal(L_ANIM),
    getlocal(L_CELL),
    get(names.y),
    { opcode: OP.pushbyte, operands: [["s8", COFFER_ANIM_OFFSET_Y]], push: 1 },
    { opcode: OP.add, pop: 2, push: 1 },
    set(names.y),

    // ...and that skull is spent, whichever one it was. This is what lets the board
    // be opened out of order: the count says how many are left, the display list
    // says which, and only the cell under the pointer goes dark.
    getlocal(L_CELL),
    { opcode: OP.pushbyte, operands: [["s8", FRAME_INACTIVE]], push: 1 },
    { opcode: OP.callpropvoid, operands: [["u30", names.gotoAndStop], ["u30", 1]], pop: 2 },
    // And it stops taking clicks the moment it is spent, not on the next opening.
    getlocal(L_CELL),
    { opcode: OP.pushfalse, push: 1 },
    set(names.mouseEnabled),
    { opcode: OP.jump, branchTo: "noLatch" },
    { label: "noCell" },
    { opcode: OP.pop, pop: 1 },
    { label: "noLatch" },

    getlocal(L_ANIM),
    getlocal(L_FRAME),
    { opcode: OP.callpropvoid, operands: [["u30", names.gotoAndStop], ["u30", 1]], pop: 2 },
    { opcode: OP.jump, branchTo: "afterAnim" },

    { label: "parkAnim" },
    getlocal(L_ANIM),
    { opcode: OP.pushfalse, push: 1 },
    set(names.visible),
    getlocal(L_ANIM),
    { opcode: OP.pushbyte, operands: [["s8", COFFER_ANIM_FIRST]], push: 1 },
    { opcode: OP.callpropvoid, operands: [["u30", names.gotoAndStop], ["u30", 1]], pop: 2 },
    { opcode: OP.jump, branchTo: "afterAnim" },
    { label: "noAnim" },
    { opcode: OP.pop, pop: 1 },
    { label: "afterAnim" },
  );

  // **Whether the reward may be shown yet.**
  //
  // See `REVEAL_SHOW_AFTER_MS`. Computed once, because the banner, the sparkle and
  // the ring icon all have to agree about it - three separate answers would show
  // the pieces of one reveal at three different moments.
  program.push(
    { opcode: OP.pushfalse, push: 1 },
    setlocal(L_SHOW),
    getlocal(L_FLAG),
    { opcode: OP.iffalse, branchTo: "showDone", pop: 1 },
    // Deliberately *not* gated on `var_1929`. That flag is the class own reveal,
    // and it drops as soon as the class is finished - which took the banner down
    // with it a moment after it appeared. What is asked for instead is a reward
    // that stays put, so the gate is `revealStart` alone: it holds the time of the
    // last skull opened, so the elapsed time below only falls back under the
    // threshold when the player opens the next one. Until they do, the banner,
    // the sparkle and the ring stay exactly where they are.
    getlocal(0),
    get(names.revealStart),
    { opcode: OP.iffalse, branchTo: "showDone", pop: 1 },
    { opcode: OP.getlex, operands: [["u30", names.var_1]], push: 1 },
    get(names.mTimeThisTick),
    getlocal(0),
    get(names.revealStart),
    { opcode: OP.subtract, pop: 2, push: 1 },
    { opcode: OP.pushshort, operands: [["u30", REVEAL_SHOW_AFTER_MS]], push: 1 },
    { opcode: OP.iflt, branchTo: "showDone", pop: 2 },
    { opcode: OP.pushtrue, push: 1 },
    setlocal(L_SHOW),
    { label: "showDone" },
  );

  // **Holding the class inside its own reveal.**
  //
  // `var_1929` is how the class knows a reward is on screen, and its tick clears
  // the card's icon holder once that goes false. The reward is asked to stay put
  // now, so the class was wiping the icon out from under a banner that was still
  // up - the icon appeared for about a tenth of a second and left an empty ring
  // behind. Holding the flag true for as long as the reward is shown keeps the
  // class from tidying away something the player is still looking at.
  //
  // It does not block the next skull: what gates opening is `var_994` and
  // `var_1883`, neither of which this touches.
  program.push(
    getlocal(L_SHOW),
    { opcode: OP.iffalse, branchTo: "afterHold", pop: 1 },
    // ...but let go the instant the next skull is clicked. The reward stays on
    // screen until then, so `L_SHOW` is still true through the whole click-to-packet
    // window, and holding the flag across it left the class unable to start a clean
    // reveal: the second skull and every one after it got no icon restaged and its
    // sound at the wrong moment. `var_1883` is exactly that window.
    getlocal(0),
    get(names.openInFlight),
    { opcode: OP.iftrue, branchTo: "afterHold", pop: 1 },
    getlocal(0),
    { opcode: OP.pushtrue, push: 1 },
    set(names.revealRunning),
    { label: "afterHold" },
  );

  // **The prize banner.**
  //
  // `am_HallowsEveBanner` is the world map's own parchment header, imported and hung
  // over the grid: twenty frames of unrolling with a text child, `am_Zone`, that the
  // map writes a zone name into. Here it unrolls when a coffer pays and carries the
  // prize instead - read straight off the reward card the class is already filling
  // in (`am_RewardFloater0.am_NameWrapper.am_Name`), so the two always agree and
  // nothing has to be told what was won.
  //
  // Paced off the same clock as the skull, one frame every `BANNER_MS_PER_FRAME`,
  // and held on the last frame once it is fully out.
  program.push(
    getlocal(L_SKIN),
    ...child(BANNER_NAME),
    { opcode: OP.dup, push: 1 },
    { opcode: OP.iffalse, branchTo: "noBanner", pop: 1 },
    { opcode: OP.coerce_a },
    setlocal(L_BANNER),

    getlocal(L_BANNER),
    getlocal(L_SHOW),
    set(names.visible),

    getlocal(L_SHOW),
    { opcode: OP.iffalse, branchTo: "parkBanner", pop: 1 },

    // The prize, copied from the card the class fills in.
    getlocal(L_CLIP),
    ...child(FLOATER_NAME),
    { opcode: OP.dup, push: 1 },
    { opcode: OP.iffalse, branchTo: "noPrizeText", pop: 1 },
    ...child(FLOATER_WRAP),
    { opcode: OP.dup, push: 1 },
    { opcode: OP.iffalse, branchTo: "noPrizeText", pop: 1 },
    ...child(FLOATER_TEXT),
    { opcode: OP.dup, push: 1 },
    { opcode: OP.iffalse, branchTo: "noPrizeText", pop: 1 },
    get(names.text),
    // "You got 250,000 Gold" rather than the bare name the card carries.
    pushString(BANNER_PREFIX),
    { opcode: OP.swap },
    { opcode: OP.add, pop: 2, push: 1 },
    getlocal(L_BANNER),
    { opcode: OP.swap },
    setlocal(L_CURSOR),
    // `am_Name` is the ribbon's own text field, a direct child of the ring - no
    // wrapper to step through the way the old parchment had.
    ...child(BANNER_TEXT),
    { opcode: OP.dup, push: 1 },
    { opcode: OP.iffalse, branchTo: "noPrizeText", pop: 1 },
    getlocal(L_CURSOR),
    set(names.text),
    { opcode: OP.jump, branchTo: "afterPrizeText" },
    { label: "noPrizeText" },
    { opcode: OP.pop, pop: 1 },
    { label: "afterPrizeText" },

    // ...and unroll it.
    getlocal(L_BANNER),
    { opcode: OP.getlex, operands: [["u30", names.var_1]], push: 1 },
    get(names.mTimeThisTick),
    getlocal(0),
    get(names.revealStart),
    { opcode: OP.subtract, pop: 2, push: 1 },
    { opcode: OP.pushshort, operands: [["u30", BANNER_MS_PER_FRAME]], push: 1 },
    { opcode: OP.divide, pop: 2, push: 1 },
    { opcode: OP.convert_i },
    { opcode: OP.pushbyte, operands: [["s8", 1]], push: 1 },
    { opcode: OP.add, pop: 2, push: 1 },
    { opcode: OP.dup, push: 1 },
    { opcode: OP.pushbyte, operands: [["s8", BANNER_LAST]], push: 1 },
    { opcode: OP.ifnlt, branchTo: "clampBanner", pop: 2 },
    { opcode: OP.jump, branchTo: "playBanner" },
    { label: "clampBanner" },
    { opcode: OP.pop, pop: 1 },
    { opcode: OP.pushbyte, operands: [["s8", BANNER_LAST]], push: 1 },
    { label: "playBanner" },
    { opcode: OP.callpropvoid, operands: [["u30", names.gotoAndStop], ["u30", 1]], pop: 2 },
    { opcode: OP.jump, branchTo: "afterBanner" },

    { label: "parkBanner" },
    getlocal(L_BANNER),
    { opcode: OP.pushbyte, operands: [["s8", 1]], push: 1 },
    { opcode: OP.callpropvoid, operands: [["u30", names.gotoAndStop], ["u30", 1]], pop: 2 },
    { opcode: OP.jump, branchTo: "afterBanner" },
    { label: "noBanner" },
    { opcode: OP.pop, pop: 1 },
    { label: "afterBanner" },

    // ...and the sparkle burst behind it, on the same clock.
    getlocal(L_SKIN),
    ...child(BURST_NAME),
    { opcode: OP.dup, push: 1 },
    { opcode: OP.iffalse, branchTo: "noBurst", pop: 1 },
    { opcode: OP.coerce_a },
    setlocal(L_BURST),

    getlocal(L_BURST),
    getlocal(L_SHOW),
    set(names.visible),

    getlocal(L_SHOW),
    { opcode: OP.iffalse, branchTo: "parkBurst", pop: 1 },

    getlocal(L_BURST),
    { opcode: OP.getlex, operands: [["u30", names.var_1]], push: 1 },
    get(names.mTimeThisTick),
    getlocal(0),
    get(names.revealStart),
    { opcode: OP.subtract, pop: 2, push: 1 },
    { opcode: OP.pushshort, operands: [["u30", BURST_MS_PER_FRAME]], push: 1 },
    { opcode: OP.divide, pop: 2, push: 1 },
    { opcode: OP.convert_i },
    { opcode: OP.pushbyte, operands: [["s8", 1]], push: 1 },
    { opcode: OP.add, pop: 2, push: 1 },
    { opcode: OP.dup, push: 1 },
    { opcode: OP.pushbyte, operands: [["s8", BURST_LAST]], push: 1 },
    { opcode: OP.ifnlt, branchTo: "clampBurst", pop: 2 },
    { opcode: OP.jump, branchTo: "playBurst" },
    { label: "clampBurst" },
    { opcode: OP.pop, pop: 1 },
    { opcode: OP.pushbyte, operands: [["s8", BURST_LAST]], push: 1 },
    { label: "playBurst" },
    { opcode: OP.callpropvoid, operands: [["u30", names.gotoAndStop], ["u30", 1]], pop: 2 },
    { opcode: OP.jump, branchTo: "afterBurst" },

    { label: "parkBurst" },
    getlocal(L_BURST),
    { opcode: OP.pushbyte, operands: [["s8", 1]], push: 1 },
    { opcode: OP.callpropvoid, operands: [["u30", names.gotoAndStop], ["u30", 1]], pop: 2 },
    { opcode: OP.jump, branchTo: "afterBurst" },
    { label: "noBurst" },
    { opcode: OP.pop, pop: 1 },
    { label: "afterBurst" },

    // **Silencing the treasure chest.**
    //
    // `var_396` is the `class_33` wrapper around the lockbox, and `method_1148` drives
    // it with `method_147("Open", "LockBox_Basic_Open")`: a treasure chest opening,
    // under a skull, which is not what a coffer sounds like. That call does not play
    // anything itself - it *parks* the name in `var_1129` for `class_33`s own update to
    // play when its animation reaches the frame that asks for it - so clearing both
    // every tick leaves the update nothing to play and nothing to play it against.
    //
    // Clearing the animation matters for more than the sound. A live `mActiveTimeline`
    // arms the class own "the reveal is over" branch, which is otherwise dead here, and
    // that branch drops `var_1929` under a reward that is still on screen. An inert
    // chest keeps it dead. The trove path never reaches this block, so its chest keeps
    // everything.
    //
    // The race this used to lose - the animation reaching its sound frame before the
    // next tick came round - is settled elsewhere now: `CHEST_SOUNDS` points every name
    // the chest can park at a string `SoundManager` will not find, so a tick that
    // arrives late costs nothing. This block only has to keep the timeline empty.
    getlocal(L_FLAG),
    { opcode: OP.iffalse, branchTo: "afterChest", pop: 1 },
    getlocal(0),
    get(names.lockboxAnim),
    { opcode: OP.dup, push: 1 },
    { opcode: OP.iffalse, branchTo: "noChestAnim", pop: 1 },
    { opcode: OP.dup, push: 1 },
    { opcode: OP.pushnull, push: 1 },
    set(names.animSound),
    { opcode: OP.callpropvoid, operands: [["u30", names.clearAnimation], ["u30", 0]], pop: 1 },
    { opcode: OP.jump, branchTo: "afterChest" },
    { label: "noChestAnim" },
    { opcode: OP.pop, pop: 1 },
    { label: "afterChest" },

    // **The prize, moved into the ring.**
    //
    // The ring ships an empty socket - `a_ScreenCharmComplete` fills it from the charm
    // being crafted, and nothing on this screen crafts anything. What is borrowed into
    // it is `var_1191`: `am_RewardFloater0.am_Icon.am_ItemIconHolder`, read once in
    // `OnCreateScreen` and held from then on, and the clip `class_18.method_996` draws
    // every prize into - `a_RewardTypeIcon_Gold*` for coin, an item's own `iconName`
    // for a consumable, a rendered 58x58 `Bitmap` for a pet or a mount.
    //
    // **Why the holder and not `am_Icon`.** Borrowing the icon looked right and read
    // right - it arrived in the socket, `parent` said `am_CharmHolder`, width 37.5,
    // alpha 1, visible true, its holder holding the prize - and drew an empty plate
    // every time. `am_Icon` is not a frame around the prize, it is five stacked
    // children: a 62.5 backing at depth 1, the item holder at 2, a clip mask at 4, the
    // mask holder at 5 and a cover at depth 8. Its own art is what reaches the screen,
    // and its bounds are that art's, which is why every number it reported looked
    // healthy while the prize did not show.
    //
    // The holder carries the prize and nothing else, so what lands in the ring is the
    // prize. It is also the one object in this chain that cannot be lost: the class
    // holds it by reference and refills it in place, so no timeline restaging the card
    // can hand back a copy - which is what a `getChildByName("am_Icon")` borrow did,
    // taking an empty duplicate while the class went on drawing into the original.
    //
    // `am_Icon` is put back on the card first, every tick. That is not for the card,
    // which is hidden here - it is so an icon an earlier build left in the socket
    // leaves it.
    getlocal(L_FLAG),
    { opcode: OP.iffalse, branchTo: "afterIconHome", pop: 1 },
    ...theIcon(names, "Home"),
    { opcode: OP.dup, push: 1 },
    { opcode: OP.iffalse, branchTo: "noIconHome", pop: 1 },
    { opcode: OP.coerce_a },
    setlocal(L_ICON),
    getlocal(L_CLIP),
    ...child(FLOATER_NAME),
    { opcode: OP.dup, push: 1 },
    { opcode: OP.iffalse, branchTo: "noIconHome", pop: 1 },
    getlocal(L_ICON),
    { opcode: OP.callpropvoid, operands: [["u30", names.addChild], ["u30", 1]], pop: 2 },
    getlocal(L_ICON),
    { opcode: OP.pushshort, operands: [["u30", CARD_ICON_X]], push: 1 },
    set(names.x),
    getlocal(L_ICON),
    { opcode: OP.pushshort, operands: [["u30", CARD_ICON_Y]], push: 1 },
    set(names.y),
    getlocal(L_ICON),
    { opcode: OP.pushbyte, operands: [["s8", 1]], push: 1 },
    set(names.scaleX),
    getlocal(L_ICON),
    { opcode: OP.pushbyte, operands: [["s8", 1]], push: 1 },
    set(names.scaleY),
    { opcode: OP.jump, branchTo: "afterIconHome" },
    { label: "noIconHome" },
    { opcode: OP.pop, pop: 1 },
    { label: "afterIconHome" },

    getlocal(L_SHOW),
    { opcode: OP.iffalse, branchTo: "holderHome", pop: 1 },
    getlocal(0),
    get(names.openInFlight),
    { opcode: OP.iftrue, branchTo: "holderHome", pop: 1 },

    // The card is parked on its last frame - the card fully open - so its own timeline
    // stops restaging children while the prize is on loan. It is hidden here anyway.
    getlocal(L_CLIP),
    ...child(FLOATER_NAME),
    { opcode: OP.dup, push: 1 },
    { opcode: OP.iffalse, branchTo: "noCardPark", pop: 1 },
    { opcode: OP.pushbyte, operands: [["s8", CARD_LAST_FRAME]], push: 1 },
    { opcode: OP.callpropvoid, operands: [["u30", names.gotoAndStop], ["u30", 1]], pop: 2 },
    { opcode: OP.jump, branchTo: "afterCardPark" },
    { label: "noCardPark" },
    { opcode: OP.pop, pop: 1 },
    { label: "afterCardPark" },

    getlocal(0),
    get(names.iconHolder),
    { opcode: OP.dup, push: 1 },
    { opcode: OP.iffalse, branchTo: "noHolder", pop: 1 },
    { opcode: OP.coerce_a },
    setlocal(L_ICON),

    getlocal(L_BANNER),
    ...child(RING_SOCKET),
    { opcode: OP.dup, push: 1 },
    { opcode: OP.iffalse, branchTo: "noRingSocket", pop: 1 },
    getlocal(L_ICON),
    { opcode: OP.callpropvoid, operands: [["u30", names.addChild], ["u30", 1]], pop: 2 },

    // Sized to the frame rather than scaled by a ratio. `width` and `height` are
    // setters as well as getters: writing one adjusts `scaleX`/`scaleY` so the drawn
    // box comes out at that many units, whatever the art measured to begin with. That
    // is what makes one rule fit all of them - a reward icon is 48 square, a rendered
    // pet is 58, a gear render is neither - without measuring anything, and it is the
    // same property the ring probe read back cleanly at 37.5, so the multiname is known
    // to resolve here.
    getlocal(L_ICON),
    { opcode: OP.pushbyte, operands: [["s8", RING_FIT]], push: 1 },
    set(names.width),
    getlocal(L_ICON),
    { opcode: OP.pushbyte, operands: [["s8", RING_FIT]], push: 1 },
    set(names.height),

    // Sizing does not move the origin, so the inset is set after it.
    getlocal(L_ICON),
    { opcode: OP.pushbyte, operands: [["s8", RING_ICON_X]], push: 1 },
    set(names.x),
    getlocal(L_ICON),
    { opcode: OP.pushbyte, operands: [["s8", RING_ICON_Y]], push: 1 },
    set(names.y),
    getlocal(L_ICON),
    { opcode: OP.pushtrue, push: 1 },
    set(names.visible),
    { opcode: OP.jump, branchTo: "afterRingIcon" },

    { label: "noHolder" },
    { opcode: OP.pop, pop: 1 },
    { opcode: OP.jump, branchTo: "afterRingIcon" },
    { label: "noRingSocket" },
    { opcode: OP.pop, pop: 1 },

    // **Handing the holder back.**
    //
    // See `HOLDER_HOME_NUM`. Anything not currently showing a reward puts the holder
    // back inside `am_Icon` on the placement the card authored for it, so the card is
    // whole for the trove - which is the same screen class, and the same holder.
    { label: "holderHome" },
    getlocal(L_FLAG),
    { opcode: OP.iffalse, branchTo: "afterRingIcon", pop: 1 },
    getlocal(0),
    get(names.iconHolder),
    { opcode: OP.dup, push: 1 },
    { opcode: OP.iffalse, branchTo: "noHolderHome", pop: 1 },
    { opcode: OP.coerce_a },
    setlocal(L_ICON),
    ...theIcon(names, "HolderHome"),
    { opcode: OP.dup, push: 1 },
    { opcode: OP.iffalse, branchTo: "noHolderHome", pop: 1 },
    getlocal(L_ICON),
    { opcode: OP.callpropvoid, operands: [["u30", names.addChild], ["u30", 1]], pop: 2 },
    getlocal(L_ICON),
    { opcode: OP.pushbyte, operands: [["s8", HOLDER_HOME_NUM]], push: 1 },
    { opcode: OP.pushbyte, operands: [["s8", HOLDER_HOME_DEN]], push: 1 },
    { opcode: OP.divide, pop: 2, push: 1 },
    set(names.x),
    getlocal(L_ICON),
    { opcode: OP.pushbyte, operands: [["s8", HOLDER_HOME_NUM]], push: 1 },
    { opcode: OP.pushbyte, operands: [["s8", HOLDER_HOME_DEN]], push: 1 },
    { opcode: OP.divide, pop: 2, push: 1 },
    set(names.y),
    getlocal(L_ICON),
    { opcode: OP.pushbyte, operands: [["s8", HOLDER_SCALE_NUM]], push: 1 },
    { opcode: OP.pushbyte, operands: [["s8", HOLDER_SCALE_DEN]], push: 1 },
    { opcode: OP.divide, pop: 2, push: 1 },
    set(names.scaleX),
    getlocal(L_ICON),
    { opcode: OP.pushbyte, operands: [["s8", HOLDER_SCALE_NUM]], push: 1 },
    { opcode: OP.pushbyte, operands: [["s8", HOLDER_SCALE_DEN]], push: 1 },
    { opcode: OP.divide, pop: 2, push: 1 },
    set(names.scaleY),
    { opcode: OP.jump, branchTo: "afterRingIcon" },
    { label: "noHolderHome" },
    { opcode: OP.pop, pop: 1 },

    { label: "afterRingIcon" },
  );

  // **The key cursor, which the client has been carrying all along.**
  //
  // `Game` registers sixteen custom cursors with `CustomMouse.method_66`, and two of
  // them - `a_CustomMouse_Key` and `a_CustomMouse_KeyWaiting` - are *only* ever
  // registered. Nothing in the shipped code selects them: they are the coffers
  // screen's cursors, left behind when that screen was cut. So the art is already
  // drawn, already registered, and nothing competes for it.
  //
  // Writing `Mouse.cursor` straight sticks because `CustomMouse.method_2003` returns
  // early when its own computed cursor has not changed - it only touches the mouse
  // on a transition. And the fallback here is that same computed value
  // (`CustomMouse.var_2002`), so stepping off a skull hands the cursor back rather
  // than clearing it.
  program.push(
    // **Not while the screen is going away.**
    //
    // `Hide` does not close a screen, it starts closing one: `class_32.method_265`
    // sets `var_790` and plays the close animation, and the screen goes on being
    // ticked until that finishes (`Display` clears the flag again on the way back in).
    // Every one of those ticks used to write the key cursor back over the hand-back
    // `Hide` had just done - and with a prize still on the ring `var_1929` is held
    // true, so the branch it took was the waiting key. That is the cursor that was
    // left on the world until the next swing changed what `CustomMouse` computed.
    getlocal(0),
    get(names.screenClosing),
    { opcode: OP.iffalse, branchTo: "curNotClosing", pop: 1 },
    ...handBackCursor(names, str, "Tick"),
    { opcode: OP.jump, branchTo: "afterCursor" },
    { label: "curNotClosing" },

    getlocal(0),
    get(names.revealRunning),
    { opcode: OP.iffalse, branchTo: "curNotReveal", pop: 1 },
    pushString(CURSOR_KEY_WAITING),
    setlocal(L_CURSOR),
    { opcode: OP.jump, branchTo: "curApply" },

    { label: "curNotReveal" },
    ...cellUnderPointer(names, str),
    { opcode: OP.dup, push: 1 },
    { opcode: OP.iffalse, branchTo: "curFallback", pop: 1 },
    { opcode: OP.getproperty, operands: [["u30", names.currentFrame]], pop: 1, push: 1 },
    { opcode: OP.pushbyte, operands: [["s8", FRAME_READY]], push: 1 },
    { opcode: OP.ifne, branchTo: "curMirror", pop: 2 },
    pushString(CURSOR_KEY),
    setlocal(L_CURSOR),
    { opcode: OP.jump, branchTo: "curApply" },

    { label: "curFallback" },
    { opcode: OP.pop, pop: 1 },
    { label: "curMirror" },
    { opcode: OP.getlex, operands: [["u30", names.var_1]], push: 1 },
    get(names.customMouse),
    { opcode: OP.dup, push: 1 },
    { opcode: OP.iffalse, branchTo: "curNone", pop: 1 },
    get(names.currentCursor),
    { opcode: OP.dup, push: 1 },
    { opcode: OP.iffalse, branchTo: "curNone", pop: 1 },
    setlocal(L_CURSOR),
    { opcode: OP.jump, branchTo: "curApply" },
    { label: "curNone" },
    { opcode: OP.pop, pop: 1 },
    { opcode: OP.jump, branchTo: "done" },

    { label: "curApply" },
    { opcode: OP.getlex, operands: [["u30", names.mouseClass]], push: 1 },
    getlocal(L_CURSOR),
    set(names.cursor),
    { label: "afterCursor" },
  );

  HIDDEN_ALWAYS.forEach((name, index) => {
    program.push(
      getlocal(L_CLIP),
      ...child(name),
      { opcode: OP.dup, push: 1 },
      { opcode: OP.iffalse, branchTo: `noAlways${index}`, pop: 1 },
      getlocal(L_NOT),
      set(names.visible),
      { opcode: OP.jump, branchTo: `afterAlways${index}` },
      { label: `noAlways${index}` },
      { opcode: OP.pop, pop: 1 },
      { label: `afterAlways${index}` },
    );
  });

  // Everything below dresses the coffer; a trove is left exactly as it shipped.
  program.push(getlocal(L_FLAG), { opcode: OP.iffalse, branchTo: "done", pop: 1 });

  // **The X, wired from here rather than from `OnCreateScreen`.**
  //
  // DONE is hidden with the rest of the trove furniture, so the panel's own close
  // button has to work or there is no way out of the screen. The binding lives in
  // this block because this block is the one that has been shown to run: the two
  // methods `Display()` calls before the screen appears are exactly the two that
  // could stop it appearing, and the board is only up again because they are empty.
  //
  // Re-binding every tick costs nothing. `addEventListener` ignores a listener it
  // already has, and in AVM2 `this.method_1132 == this.method_1132` - method
  // closures compare by receiver and method - so the second call and every one
  // after it is a no-op.
  program.push(
    getlocal(L_CLIP),
    ...child(SKIN_NAME),
    { opcode: OP.dup, push: 1 },
    { opcode: OP.iffalse, branchTo: "noClose", pop: 1 },
    ...child(CLOSE_NAME),
    { opcode: OP.dup, push: 1 },
    { opcode: OP.iffalse, branchTo: "noClose", pop: 1 },
    { opcode: OP.dup, push: 1 },
    { opcode: OP.pushtrue, push: 1 },
    set(names.buttonMode),
    // The X is a three-frame button like the cells, and like them nothing was
    // stopping it - so it cycled its own states forever. `class_33` would have held
    // it still, but the X is not one of the children the class binds.
    { opcode: OP.dup, push: 1 },
    { opcode: OP.pushbyte, operands: [["s8", FRAME_READY]], push: 1 },
    { opcode: OP.callpropvoid, operands: [["u30", names.gotoAndStop], ["u30", 1]], pop: 2 },
    pushString(CLICK_EVENT),
    getlocal(0),
    { opcode: OP.getproperty, operands: [["u30", names.closeHandler]], pop: 1, push: 1 },
    { opcode: OP.callpropvoid, operands: [["u30", names.addEventListener], ["u30", 2]], pop: 3 },
    { opcode: OP.jump, branchTo: "afterClose" },
    { label: "noClose" },
    { opcode: OP.pop, pop: 1 },
    { label: "afterClose" },
  );

  // The prize column's five counts. See `PRIZE_COUNTS`.
  PRIZE_COUNTS.forEach((count, index) => {
    program.push(
      getlocal(L_SKIN),
      ...child(COUNT_GROUP),
      { opcode: OP.dup, push: 1 },
      { opcode: OP.iffalse, branchTo: `noCount${index}`, pop: 1 },
      ...child(`am_PrizeCount${index}`),
      { opcode: OP.dup, push: 1 },
      { opcode: OP.iffalse, branchTo: `noCount${index}`, pop: 1 },
      pushString(count),
      set(names.text),
      { opcode: OP.jump, branchTo: `afterCount${index}` },
      { label: `noCount${index}` },
      { opcode: OP.pop, pop: 1 },
      { label: `afterCount${index}` },
    );
  });

  HIDDEN_ON_COFFER.forEach((name, index) => {
    program.push(
      getlocal(L_CLIP),
      ...child(name),
      { opcode: OP.dup, push: 1 },
      { opcode: OP.iffalse, branchTo: `noCoffer${index}`, pop: 1 },
      { opcode: OP.pushfalse, push: 1 },
      set(names.visible),
      { opcode: OP.jump, branchTo: `afterCoffer${index}` },
      { label: `noCoffer${index}` },
      { opcode: OP.pop, pop: 1 },
      { label: `afterCoffer${index}` },
    );
  });

  program.push(
    // cls = var_1.clientEnt.entType.className, or the default before it exists.
    pushString(DEFAULT_CLASS),
    { opcode: OP.coerce_a },
    setlocal(L_WANT),
    { opcode: OP.getlex, operands: [["u30", names.var_1]], push: 1 },
    get(names.clientEnt),
    { opcode: OP.dup, push: 1 },
    { opcode: OP.iffalse, branchTo: "noClass", pop: 1 },
    get(names.entType),
    { opcode: OP.dup, push: 1 },
    { opcode: OP.iffalse, branchTo: "noClass", pop: 1 },
    get(names.className),
    { opcode: OP.coerce_a },
    setlocal(L_WANT),
    { opcode: OP.jump, branchTo: "haveClass" },
    { label: "noClass" },
    { opcode: OP.pop, pop: 1 },
    { label: "haveClass" },

    // icons = skin.am_PrizeGroup.am_CacheIcon, the strip the helms are stacked in.
    getlocal(L_CLIP),
    ...child(SKIN_NAME),
    { opcode: OP.dup, push: 1 },
    { opcode: OP.iffalse, branchTo: "noIcons", pop: 1 },
    ...child(PRIZE_GROUP_NAME),
    { opcode: OP.dup, push: 1 },
    { opcode: OP.iffalse, branchTo: "noIcons", pop: 1 },
    ...child(CACHE_ICON_NAME),
    { opcode: OP.dup, push: 1 },
    { opcode: OP.iffalse, branchTo: "noIcons", pop: 1 },
    { opcode: OP.coerce_a },
    setlocal(L_GROUP),
    { opcode: OP.jump, branchTo: "haveIcons" },
    { label: "noIcons" },
    { opcode: OP.pop, pop: 1 },
    { opcode: OP.jump, branchTo: "done" },
    { label: "haveIcons" },
  );

  HELMS.forEach((helm, index) => {
    program.push(
      getlocal(L_GROUP),
      ...child(helm.child),
      { opcode: OP.dup, push: 1 },
      { opcode: OP.iffalse, branchTo: `noHelm${index}`, pop: 1 },
      getlocal(L_WANT),
      pushString(helm.className),
      { opcode: OP.equals, pop: 2, push: 1 },
      set(names.visible),
      { opcode: OP.jump, branchTo: `afterHelm${index}` },
      { label: `noHelm${index}` },
      { opcode: OP.pop, pop: 1 },
      { label: `afterHelm${index}` },
    );
  });

  program.push(...epilogue(), ...marker);
  return program;
}

/**
 * The grid cell the pointer is over, or null - leaves one value on the stack.
 *
 * The grid is a plain 8x5 of cells 80 by 85 apart starting at (39, 53), and this is
 * read in `am_CofferGroup`'s own space, so `mouseX`/`mouseY` off the group give the
 * index with no coordinate conversion. A pointer outside the grid lands on a
 * negative or out-of-range index, `getChildByName` answers null, and every caller
 * already has a branch for that.
 */
function cellUnderPointer(names: Names, str: (value: string) => number): Emitted[] {
  const { get, pushString } = emitters(names, str);
  return [
    getlocal(L_GROUP),
    get(names.mouseX),
    { opcode: OP.pushbyte, operands: [["s8", COFFER_GRID_X]], push: 1 },
    { opcode: OP.subtract, pop: 2, push: 1 },
    { opcode: OP.pushbyte, operands: [["s8", COFFER_GRID_DX]], push: 1 },
    { opcode: OP.divide, pop: 2, push: 1 },
    { opcode: OP.convert_i },
    getlocal(L_GROUP),
    get(names.mouseY),
    { opcode: OP.pushbyte, operands: [["s8", COFFER_GRID_Y]], push: 1 },
    { opcode: OP.subtract, pop: 2, push: 1 },
    { opcode: OP.pushbyte, operands: [["s8", COFFER_GRID_DY]], push: 1 },
    { opcode: OP.divide, pop: 2, push: 1 },
    { opcode: OP.convert_i },
    { opcode: OP.pushbyte, operands: [["s8", COFFER_GRID_COLS]], push: 1 },
    { opcode: OP.multiply, pop: 2, push: 1 },
    { opcode: OP.add, pop: 2, push: 1 },
    getlocal(L_GROUP),
    { opcode: OP.swap },
    pushString(COFFER_CELL_PREFIX),
    { opcode: OP.swap },
    { opcode: OP.add, pop: 2, push: 1 },
    { opcode: OP.callproperty, operands: [["u30", names.getChildByName], ["u30", 1]], pop: 2, push: 1 },
  ];
}

/** `skin = clip.am_HallowsEveSkin`, into `L_SKIN`. Nothing to do without it. */
function skinInto(names: Names, str: (value: string) => number): Emitted[] {
  const { child } = emitters(names, str);
  return [
    getlocal(L_CLIP),
    ...child(SKIN_NAME),
    { opcode: OP.dup, push: 1 },
    { opcode: OP.iffalse, branchTo: "noSkin", pop: 1 },
    { opcode: OP.coerce_a },
    setlocal(L_SKIN),
    { opcode: OP.jump, branchTo: "haveSkin" },
    { label: "noSkin" },
    { opcode: OP.pop, pop: 1 },
    { opcode: OP.jump, branchTo: "done" },
    { label: "haveSkin" },
  ];
}

/** `group = skin.am_CofferGroup`, into `L_GROUP`. */
function cofferGroup(names: Names, str: (value: string) => number): Emitted[] {
  const { child } = emitters(names, str);
  return [
    getlocal(L_SKIN),
    ...child(COFFER_GROUP_NAME),
    { opcode: OP.dup, push: 1 },
    { opcode: OP.iffalse, branchTo: "noGroup", pop: 1 },
    { opcode: OP.coerce_a },
    setlocal(L_GROUP),
    { opcode: OP.jump, branchTo: "haveGroup" },
    { label: "noGroup" },
    { opcode: OP.pop, pop: 1 },
    { opcode: OP.jump, branchTo: "done" },
    { label: "haveGroup" },
  ];
}

/**
 * Gives every cell a hand cursor and the screen's own Open handler, and the panel's
 * X the screen's own close handler.
 *
 * `mouseChildren` goes off on each cell so that the cell itself is what a click
 * lands on. That is what lets the board block switch a cell off with
 * `mouseEnabled`: with children still listening, a dead cell's skull would keep
 * taking clicks and bubbling them up.
 */
function wireProgram(names: Names, str: (value: string) => number): Emitted[] {
  const { set, pushString, child, marker } = emitters(names, str);

  const listener = (handler: number): Emitted[] => [
    pushString(CLICK_EVENT),
    getlocal(0),
    { opcode: OP.getproperty, operands: [["u30", handler]], pop: 1, push: 1 },
    { opcode: OP.callpropvoid, operands: [["u30", names.addEventListener], ["u30", 2]], pop: 3 },
  ];

  const program: Emitted[] = [
    ...marker,
    ...prologue(names),
    ...skinInto(names, str),

    // **The X is not wired while the screen is being bisected.**
    //
    // `OnCreateScreen` and `OnInitDisplay` are the only two of the four blocks that
    // run *inside* `Display()`, before the screen is made visible - so they are the
    // only two that can stop it appearing at all, which is the symptom. Everything
    // added to them in the rounds where the board stopped opening is off: this
    // binding, the `mouseChildren` write below, and the per-cell `mouseEnabled` in
    // the board block. DONE is visible again to close the screen with.

    ...cofferGroup(names, str),
  ];

  for (let index = 0; index < COFFER_CELLS; index += 1) {
    program.push(
      getlocal(L_GROUP),
      ...child(`${COFFER_CELL_PREFIX}${index}`),
      { opcode: OP.dup, push: 1 },
      { opcode: OP.iffalse, branchTo: `noCell${index}`, pop: 1 },
      // **No `buttonMode` here, and that is the point.**
      //
      // It was set for the hand cursor, back when there was nothing better. There is
      // now: `OnTickScreen` puts `a_CustomMouse_Key` over a live cell. `buttonMode`
      // makes Flash draw its own hand cursor over the object and that wins, so the
      // key never showed - and `useHandCursor`, which would turn the hand off while
      // keeping the mode, is not a name in this client's constant pool. Dropping the
      // mode costs nothing: it never did anything but the cursor, and the click
      // listener below is what makes a cell clickable.
      //
      // `mouseChildren` off makes the cell itself what a click lands on. That is what
      // lets a spent cell be switched off: with the skull and the glow still
      // listening underneath, turning the cell off would not stop a click reaching
      // the handler through them - which is how an empty socket was still spending
      // keys.
      { opcode: OP.dup, push: 1 },
      { opcode: OP.pushfalse, push: 1 },
      set(names.mouseChildren),
      ...listener(names.openHandler),
      { opcode: OP.jump, branchTo: `afterCell${index}` },
      { label: `noCell${index}` },
      { opcode: OP.pop, pop: 1 },
      { label: `afterCell${index}` },
    );
  }

  program.push(...epilogue(), ...marker);
  return program;
}

/**
 * Stops each cell on the frame the board says it should be on.
 *
 * `remaining` is the coffer's own `stackCount`, which the server keeps equal to the
 * number of cells left; anything past it is a socket the board has already paid
 * out.
 */
function boardProgram(names: Names, str: (value: string) => number): Emitted[] {
  const { get, set, child, marker } = emitters(names, str);

  const program: Emitted[] = [
    ...marker,
    ...prologue(names),
    ...lockboxData(names),
    ...isCoffer(names),
    getlocal(L_FLAG),
    { opcode: OP.iffalse, branchTo: "done", pop: 1 },

    // **This line is why the board stopped opening for four rounds.**
    //
    // `cofferGroup` reads the panel out of `L_SKIN`, and `L_SKIN` is filled by
    // `skinInto`. When the close-button wiring moved the panel lookup into that
    // helper, only `wireProgram` was given the call - so this block ran
    // `undefined.getChildByName("am_CofferGroup")`, threw TypeError #1009 inside
    // `Display()`, and the screen never appeared. Not a VerifyError, which is why
    // every static check on the bytecode came back clean: the code is perfectly
    // valid, it just read a local nobody had written.
    ...skinInto(names, str),

    // remaining = data.mOwnedLockboxes[COFFER_LOCKBOX_ID].stackCount, or none.
    { opcode: OP.pushbyte, operands: [["s8", 0]], push: 1 },
    setlocal(L_READY),
    getlocal(L_DATA),
    get(names.mOwnedLockboxes),
    { opcode: OP.dup, push: 1 },
    { opcode: OP.iffalse, branchTo: "noEntry", pop: 1 },
    { opcode: OP.pushbyte, operands: [["s8", COFFER_LOCKBOX_ID]], push: 1 },
    { opcode: OP.getproperty, operands: [["u30", names.indexer]], pop: 2, push: 1 },
    { opcode: OP.dup, push: 1 },
    { opcode: OP.iffalse, branchTo: "noEntry", pop: 1 },
    get(names.stackCount),
    setlocal(L_READY),
    { opcode: OP.jump, branchTo: "haveReady" },
    { label: "noEntry" },
    { opcode: OP.pop, pop: 1 },
    { label: "haveReady" },

    // A cell can only be clicked while there is a key to spend on it. Without this
    // the screen's Open handler is still reached on a dead board, and its own
    // no-key branch puts the *Treasure Trove purchase* screen up over the coffers.
    getlocal(L_DATA),
    get(names.mLockboxKeys),
    { opcode: OP.convert_b, pop: 1, push: 1 },
    setlocal(L_CAN_OPEN),

    ...cofferGroup(names, str),
  ];

  for (let index = 0; index < COFFER_CELLS; index += 1) {
    program.push(
      getlocal(L_GROUP),
      ...child(`${COFFER_CELL_PREFIX}${index}`),
      { opcode: OP.dup, push: 1 },
      { opcode: OP.iffalse, branchTo: `noCell${index}`, pop: 1 },
      // Kept back for the glow, which has to be reached after the frame is set.
      { opcode: OP.dup, push: 1 },

      // A cell still behind glass shows its skull and takes a click; one the board
      // has already paid out shows an empty socket and takes nothing. Both halves
      // matter: the listener sits on every cell whatever it is showing, so without
      // the second one an empty socket still spent a key.
      { opcode: OP.dup, push: 1 },
      { opcode: OP.pushbyte, operands: [["s8", index]], push: 1 },
      getlocal(L_READY),
      { opcode: OP.iflt, branchTo: `alive${index}`, pop: 2 },
      { opcode: OP.pushfalse, push: 1 },
      { opcode: OP.jump, branchTo: `enable${index}` },
      { label: `alive${index}` },
      { opcode: OP.pushtrue, push: 1 },
      { label: `enable${index}` },
      set(names.mouseEnabled),

      { opcode: OP.pushbyte, operands: [["s8", index]], push: 1 },
      getlocal(L_READY),
      { opcode: OP.iflt, branchTo: `live${index}`, pop: 2 },
      { opcode: OP.pushbyte, operands: [["s8", FRAME_INACTIVE]], push: 1 },
      { opcode: OP.jump, branchTo: `frame${index}` },
      { label: `live${index}` },
      { opcode: OP.pushbyte, operands: [["s8", FRAME_READY]], push: 1 },
      { label: `frame${index}` },

      // Unconditionally, and this matters: a cell arrives *playing*, and a playing
      // clip is on frame 1 a third of the time. Skipping the call when
      // `currentFrame` already reads the wanted frame therefore left every cell it
      // was sampled on still running - which is what the flicker was after the
      // first pass at this. `gotoAndStop` is what stops them; nothing else does.
      { opcode: OP.callpropvoid, operands: [["u30", names.gotoAndStop], ["u30", 1]], pop: 2 },

      // **Stopping a cell does not stop what is inside it.**
      //
      // `Ready` is authored as the skull *plus* `am_GlowAnim`, a looping pulse over
      // it, and a child clip keeps running its own timeline no matter what the
      // parent is doing - so a stopped board still had forty glows breathing in
      // unison, which reads as the whole thing flickering. The glow is a rollover
      // cue in the shipped screen, where `class_33` drives it; nothing drives it
      // here, so it goes off and the skulls sit as they do in the event's own art.
      ...child(GLOW_NAME),
      { opcode: OP.dup, push: 1 },
      { opcode: OP.iffalse, branchTo: `noCell${index}`, pop: 1 },
      { opcode: OP.pushfalse, push: 1 },
      set(names.visible),
      { opcode: OP.jump, branchTo: `afterCell${index}` },
      { label: `noCell${index}` },
      { opcode: OP.pop, pop: 1 },
      { label: `afterCell${index}` },
    );
  }

  program.push(...epilogue(), ...marker);
  return program;
}

/** The instruction after `getlocal0; pushscope`, where the scope stack is live. */
function findInjectionOffset(instructions: Instruction[], method: string): number {
  for (let index = 0; index < instructions.length - 1; index += 1) {
    if (instructions[index].opcode === 0xd0 && instructions[index + 1].opcode === 0x30) {
      return instructions[index + 2].offset;
    }
  }
  throw new PatchError(`Could not find \`getlocal0; pushscope\` in ${HOST_CLASS}.${method}.`);
}

/** The marker positions of a block an earlier run left behind. */
function findMarkers(instructions: Instruction[], strings: string[]): number[] {
  const found: number[] = [];
  for (const inst of instructions) {
    if (inst.opcode === OP.pushstring && strings[inst.operands[0][1]] === MARKER) {
      found.push(inst.offset);
    }
  }
  return found;
}

function classTraits(abc: ReturnType<typeof parseAbc>, className: string) {
  const classIndex = classIndexByName(abc, className);
  if (classIndex === null) {
    throw new PatchError(`Could not find ${className}.`);
  }
  return abc.instances[classIndex].traits;
}

function methodInstructions(
  ctx: SwfContext,
  abc: ReturnType<typeof parseAbc>,
  className: string,
  method: string,
): Instruction[] {
  const methodIdx = methodIdxForTrait(classTraits(abc, className), abc, method);
  if (methodIdx === null) {
    throw new PatchError(`Could not find ${className}.${method}.`);
  }
  const body = abc.methodBodies.get(methodIdx);
  if (!body) {
    throw new PatchError(`Could not find the body of ${className}.${method}.`);
  }
  return disassemble(ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen), `${className}.${method}`);
}

function findOperandInClass(
  ctx: SwfContext,
  abc: ReturnType<typeof parseAbc>,
  className: string,
  opcode: number,
  name: string,
): number {
  for (const trait of classTraits(abc, className)) {
    if (trait.methodIdx === null) {
      continue;
    }
    const body = abc.methodBodies.get(trait.methodIdx);
    if (!body) {
      continue;
    }
    let instructions: Instruction[];
    try {
      instructions = disassemble(ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen), className);
    } catch {
      continue;
    }
    for (const inst of instructions) {
      if (inst.opcode === opcode && u30OperandName(inst, abc.multinameNames) === name) {
        return inst.operands[0][1];
      }
    }
  }
  throw new PatchError(`Could not find a 0x${opcode.toString(16)} for "${name}" in ${className}.`);
}

/**
 * The `obj[expr]` multiname, read off the screen's own array access.
 *
 * A MultinameL carries a namespace set where a QName carries a name, so it cannot
 * be looked up by name at all - `u30OperandName` reads its nsset index as a string
 * index and answers with something unrelated. `OnRefreshScreen` opens with
 * `mOwnedLockboxes[mLockboxID]`, so the getproperty straight after the one for
 * `mLockboxID` is the indexer, and taking it from there means taking the one this
 * very class already uses on this very object.
 */
function findIndexerOperand(ctx: SwfContext, abc: ReturnType<typeof parseAbc>): number {
  const instructions = methodInstructions(ctx, abc, HOST_CLASS, "OnRefreshScreen");
  for (let index = 0; index < instructions.length - 1; index += 1) {
    const inst = instructions[index];
    if (inst.opcode !== OP.getproperty || u30OperandName(inst, abc.multinameNames) !== "mLockboxID") {
      continue;
    }
    // Not every `mLockboxID` is an index: this file's own block reads it to compare
    // against the coffer's id, and its block sits ahead of the authored code.
    const next = instructions[index + 1];
    if (next.opcode !== OP.getproperty) {
      continue;
    }
    return next.operands[0][1];
  }
  throw new PatchError(`Could not find mOwnedLockboxes[mLockboxID] in ${HOST_CLASS}.OnRefreshScreen.`);
}

/**
 * Holds the prize back until the skull has finished opening.
 *
 * `method_1148` starts the reveal and sets `var_994 = const_1176`, a countdown after
 * which the class floats the prize out. `const_1176` ships as 1100ms - shorter than
 * the sixty-frame opening, so the reward card landed on a skull that was still
 * cracking. There is nothing in the reveal to hook: the wait is a class constant.
 *
 * So the constant moves. It is written once, in `class_73`'s own initialiser, as
 * `pushshort 1100; initproperty const_1176` - and the new value encodes to the same
 * two bytes, so this is a straight overwrite with no length change and no branch in
 * the file shifting by one.
 *
 * The Treasure Trove reveal uses the same timer and gets the same longer pause. Its
 * chest animation is 131 frames, so if anything it was the one being rushed.
 */
/** The chest sounds, and the strings they are pointed at instead. */
const CHEST_SOUNDS = ["LockBox_Spawn", "LockBox_Basic_Open"];
const CHEST_SILENT_CANDIDATES = [CLOSE_NAME, COFFER_GROUP_NAME, SKIN_NAME, GLOW_NAME];

/**
 * Takes the treasure chest's voice off the coffers - and, with it, off the trove.
 *
 * There is no chest on the coffer screen. There is a carved skull opening, with its
 * own sound on its own timeline, and behind it `class_73` driving the lockbox chest it
 * always drove: `method_147("Drop", "LockBox_Spawn")` when the board is staged, and
 * `method_147("Open", "LockBox_Basic_Open")` when a prize lands. Neither call plays
 * anything on the spot - each *parks* its name in `var_1129` for `class_33`'s own
 * update to play when the animation reaches the frame that asks for it - and both were
 * being heard over the skull as a chest coming down on stone.
 *
 * Three runtime attempts to intercept that lost the same race. Clearing `var_1129`
 * from this screen's tick left the first skull of a session silent and every one after
 * it rattling: the open goes out between ticks, and the animation reaches its sound
 * frame before the next tick comes round. Clearing the animation outright had the same
 * gap. Moving the work to `OnRefreshScreen` - the one callback that does fire on every
 * open - cost the reward icon, because that method already carries a patch of its own
 * for clearing `am_IconHolder`.
 *
 * There is no race if the sound is never named. Every `pushstring` of either name is
 * pointed at a string that is not a sound, so what gets parked - or, on the branch
 * `method_1148` takes when a reveal is already running, handed straight to
 * `SoundManager.Play` - is a name `SoundManager` will not find, and the play is a
 * no-op. The operand is rewritten in place, so the replacement has to encode to the
 * same width; anything wider would move every byte after it.
 *
 * The Treasure Trove shares these call sites and goes quiet with them. That is the
 * price of settling it without a race, and a chest that no longer thumps is a smaller
 * loss than a skull that rattles.
 */
function chestSoundPatch(
  ctx: SwfContext,
  abc: ReturnType<typeof parseAbc>,
  pool: PoolInfo,
): BytePatch[] {
  const targets: Array<{ sound: string; index: number; width: number; silent: number }> = [];
  for (const sound of CHEST_SOUNDS) {
    const soundIdx = pool.strings.indexOf(sound);
    if (soundIdx <= 0) {
      continue;
    }
    const width = writeU30(soundIdx).length;
    const silent = CHEST_SILENT_CANDIDATES.map((name) => pool.strings.indexOf(name)).find(
      (idx) => idx > 0 && writeU30(idx).length === width,
    );
    if (silent === undefined) {
      throw new PatchError(
        `no stand-in string has a pool index the same width as "${sound}"; ` +
          `an in-place rewrite would shift the code.`,
      );
    }
    targets.push({ sound, index: soundIdx, width, silent });
  }

  const patches: BytePatch[] = [];
  for (const trait of classTraits(abc, HOST_CLASS)) {
    const name = abc.multinameNames[trait.nameIdx] ?? String(trait.nameIdx);
    const methodIdx = methodIdxForTrait([trait], abc, name);
    if (methodIdx === null) continue;
    const body = abc.methodBodies.get(methodIdx);
    if (!body) continue;
    const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
    for (const inst of disassemble(code, `${HOST_CLASS}.${name}`)) {
      if (inst.opcode !== OP.pushstring) continue;
      const target = targets.find((entry) => entry.index === inst.operands[0][1]);
      if (!target) continue;
      const at = body.codeStart + inst.offset + 1;
      patches.push({
        key: `${HOST_CLASS}.${name}.chestSound@${inst.offset}`,
        start: at,
        end: at + target.width,
        data: writeU30(target.silent),
        detail: `${name}: pushstring "${target.sound}" -> "${pool.strings[target.silent]}"`,
      });
    }
  }
  return patches;
}

function revealDelayPatch(ctx: SwfContext, abc: ReturnType<typeof parseAbc>): BytePatch[] {
  const instructions = methodInstructions(ctx, abc, HOST_CLASS, "method_1148");
  const read = instructions.find((inst) => u30OperandName(inst, abc.multinameNames) === REVEAL_DELAY_CONST);
  if (!read) {
    throw new PatchError(`Could not find ${REVEAL_DELAY_CONST} in ${HOST_CLASS}.method_1148.`);
  }
  const multiname = writeU30(read.operands[0][1]);
  const wanted = writeU30(REVEAL_DELAY_MS);
  const shipped = writeU30(REVEAL_DELAY_SHIPPED_MS);
  if (wanted.length !== shipped.length) {
    throw new PatchError(
      `${REVEAL_DELAY_MS} does not encode to the same width as ${REVEAL_DELAY_SHIPPED_MS}; the splice would move every byte after it.`,
    );
  }

  const site = (value: Buffer): number =>
    ctx.body.indexOf(
      Buffer.concat([Buffer.from([OP.pushshort]), value, Buffer.from([0x68]), multiname]),
      ctx.abcStart,
    );
  if (site(wanted) !== -1) {
    return [];
  }
  // The site may already carry a *previous* choice of delay rather than the shipped
  // one - this constant has been retuned more than once - so any value of the same
  // width sitting in front of this initproperty is a valid thing to overwrite.
  let at = site(shipped);
  let from: number = REVEAL_DELAY_SHIPPED_MS;
  if (at === -1) {
    for (let candidate = 0; candidate < 16384; candidate += 1) {
      const encoded = writeU30(candidate);
      if (encoded.length !== wanted.length) {
        continue;
      }
      const found = site(encoded);
      if (found !== -1) {
        at = found;
        from = candidate;
        break;
      }
    }
  }
  if (at === -1) {
    throw new PatchError(
      `Could not find a pushshort/initproperty ${REVEAL_DELAY_CONST} site in the ABC.`,
    );
  }
  return [
    {
      key: `${HOST_CLASS}.${REVEAL_DELAY_CONST}`,
      start: at + 1,
      end: at + 1 + wanted.length,
      data: wanted,
      detail: `${REVEAL_DELAY_CONST} ${from} -> ${REVEAL_DELAY_MS}ms`,
    },
  ];
}

/**
 * Puts the mouse back in `CustomMouse`'s hands.
 *
 * Writes the cursor that class last applied - or `MouseCursor.AUTO` when it has none,
 * which is its own fallback - and then clears its memory of what it applied, so its
 * next tick finds a difference and takes the cursor back. Both halves are needed: a
 * cleared memory against a computed null is no difference at all, and the mouse would
 * be left showing whatever this file wrote last.
 *
 * Labels belong to a program, hence the tag: the tick and `Hide` both emit this.
 */
function handBackCursor(names: Names, str: (value: string) => number, tag: string): Emitted[] {
  const { get, set, pushString } = emitters(names, str);

  return [
    { opcode: OP.getlex, operands: [["u30", names.var_1]], push: 1 },
    get(names.customMouse),
    { opcode: OP.dup, push: 1 },
    { opcode: OP.iffalse, branchTo: `noMouse${tag}`, pop: 1 },
    { opcode: OP.coerce_a },
    setlocal(L_CURSOR),

    // `Mouse.cursor = cm.var_2002 ? cm.var_2002 : "auto"`.
    { opcode: OP.getlex, operands: [["u30", names.mouseClass]], push: 1 },
    getlocal(L_CURSOR),
    get(names.currentCursor),
    { opcode: OP.dup, push: 1 },
    { opcode: OP.iffalse, branchTo: `cursorAuto${tag}`, pop: 1 },
    { opcode: OP.jump, branchTo: `cursorApply${tag}` },
    { label: `cursorAuto${tag}` },
    { opcode: OP.pop, pop: 1 },
    pushString(CURSOR_AUTO),
    { label: `cursorApply${tag}` },
    set(names.cursor),

    getlocal(L_CURSOR),
    { opcode: OP.pushnull, push: 1 },
    set(names.currentCursor),
    { opcode: OP.jump, branchTo: `afterMouse${tag}` },
    { label: `noMouse${tag}` },
    { opcode: OP.pop, pop: 1 },
    { label: `afterMouse${tag}` },
  ];
}

/**
 * Gives the mouse back on the way out.
 *
 * The board writes `Mouse.cursor` directly - that is the whole reason the key cursor
 * works at all, since `CustomMouse.method_2003` only touches the mouse on a
 * transition - and the bill for it comes due when the screen closes:
 *
 *     _loc1_ = var_1.method_1416();        // the cursor the game wants now
 *     if (_loc1_ == this.var_2002) return; // nothing to do, it thinks
 *     this.var_2002 = _loc1_;
 *     Mouse.cursor = this.var_2002 ? this.var_2002 : MouseCursor.AUTO;
 *
 * `var_2002` is that class's memory of what it last applied, and this file has been
 * writing the mouse behind its back, so the memory no longer matches the screen. Close
 * the panel with the pointer on a skull and the key stays: `method_1416` still computes
 * the same world cursor it computed before, that still equals `var_2002`, and the
 * method returns without ever writing. It comes right on the first swing because that
 * is the first thing to *change* the computed value - which is exactly the shape of the
 * bug that was reported.
 *
 * So closing does two things. It puts the remembered cursor back on the mouse, which
 * is instant and leaves no frame of key on the world; and it clears the memory, so the
 * next tick of `method_2003` finds a difference and takes ownership of the cursor
 * again. Clearing alone would not do - a cleared memory against a computed null is
 * still no difference - which is why the fallback is written rather than assumed.
 *
 * `Hide` is the hook because every way out arrives there: the panel's own X (which is
 * bound to the screen's `method_1132`), the trove's DONE, and whatever else closes a
 * screen. It is also called when the class refuses to close - `Hide` opens with
 * `if (!this.method_972())` and a busy screen returns early - and that costs nothing:
 * the board's own tick writes the key cursor again on the very next frame.
 */
function cursorProgram(names: Names, str: (value: string) => number): Emitted[] {
  const { get, set, pushString, marker } = emitters(names, str);

  return [
    ...marker,
    ...prologue(names),
    ...lockboxData(names),
    ...isCoffer(names),

    getlocal(L_FLAG),
    { opcode: OP.iffalse, branchTo: "done", pop: 1 },

    ...handBackCursor(names, str, "Close"),

    ...epilogue(),
    ...marker,
  ];
}

interface Site {
  method: string;
  detail: string;
  build(names: Names, str: (value: string) => number): Emitted[];
}

/**
 * The reset every skull click runs, before the open even goes out.
 *
 * Two things about a reveal are only right the first time it happens on a board,
 * and both for the same reason: the tick was being asked to undo the *previous*
 * reveal, and a tick is not a moment - it is a race against the reply.
 *
 * **The sound.** `method_1148` parks "LockBox_Basic_Open" on the chest with
 * `method_147`, and `class_33` plays it when its animation crosses the sound frame,
 * which is what makes it land with the skull finishing instead of with the click.
 * Two things spoil that. `ClearAnimation` from the tick tears down the timeline the
 * reveal has just parked against, and whether it beats the sound or not is decided by
 * which of `class_33.Display` and `OnTickScreen` runs first that frame. And a timeline
 * left parked on the last open s final frame is refused by `PlayAnimation` - it
 * returns early when the animation it is handed is already the active one - so there
 * is no crossing left to make and the sound never comes.
 *
 * **The icon.** The tick lends the card s `am_Icon` to the banner s ring for as long
 * as a prize is up, and hands it back when `var_1883` goes true. On a local server the
 * reply can land in the same frame as the click, so `method_1148` restages a card
 * whose icon is still hanging in the ring: `am_RewardFloater0.am_Icon` resolves to
 * nothing and the ring keeps showing the prize before it.
 *
 * A click always precedes the reply, so doing both here is not a race at all: the
 * chest timeline is empty and the card is whole before the reveal starts. `var_1929`
 * goes with them - the tick holds it true so the class cannot tidy a reward away
 * while it is still on screen, and that hold has no business surviving into the next
 * open.
 *
 * Nothing else about the screen is touched. `method_782` is the class s own Open
 * handler and every cell is wired to it, so this runs on exactly the clicks that
 * matter and on no others; a click that turns out to be short of keys opens the buy
 * screen having reset a board that was about to be reset anyway.
 */
function openProgram(names: Names, str: (value: string) => number): Emitted[] {
  const { get, set, child, marker } = emitters(names, str);

  return [
    ...marker,
    ...prologue(names),
    ...lockboxData(names),
    ...isCoffer(names),

    getlocal(L_FLAG),
    { opcode: OP.iffalse, branchTo: "done", pop: 1 },

    // The reveal the tick has been holding open is over the moment another skull is
    // clicked. Left standing, it drives the opening animation off the *previous*
    // reveal s stamp for the whole wait on the server - the skull just clicked snaps
    // to fully open before anything has happened.
    getlocal(0),
    { opcode: OP.pushfalse, push: 1 },
    set(names.revealRunning),

    // The parked sound, and the timeline it was parked against. Both have to go, and
    // both have to go now: `method_147` will not restart an animation that is still
    // the active one.
    getlocal(0),
    get(names.lockboxAnim),
    { opcode: OP.dup, push: 1 },
    { opcode: OP.iffalse, branchTo: "noChest", pop: 1 },
    { opcode: OP.dup, push: 1 },
    { opcode: OP.pushnull, push: 1 },
    set(names.animSound),
    { opcode: OP.callpropvoid, operands: [["u30", names.clearAnimation], ["u30", 0]], pop: 1 },
    { opcode: OP.jump, branchTo: "afterChest" },
    { label: "noChest" },
    { opcode: OP.pop, pop: 1 },
    { label: "afterChest" },

    // The borrowed icon, back on the card at the coordinates it was taken from, so
    // the reveal about to land restages something whole. Found through `var_1191`,
    // the class own cached holder, rather than by name - see `theIcon`.
    // The holder, back inside `am_Icon` on its authored placement, so `method_1148`
    // refills a card that is whole. See `HOLDER_HOME_NUM`.
    getlocal(0),
    get(names.iconHolder),
    { opcode: OP.dup, push: 1 },
    { opcode: OP.iffalse, branchTo: "noHolderClick", pop: 1 },
    { opcode: OP.coerce_a },
    setlocal(L_ICON),
    ...theIcon(names, "ClickHolder"),
    { opcode: OP.dup, push: 1 },
    { opcode: OP.iffalse, branchTo: "noHolderClick", pop: 1 },
    getlocal(L_ICON),
    { opcode: OP.callpropvoid, operands: [["u30", names.addChild], ["u30", 1]], pop: 2 },
    getlocal(L_ICON),
    { opcode: OP.pushbyte, operands: [["s8", HOLDER_HOME_NUM]], push: 1 },
    { opcode: OP.pushbyte, operands: [["s8", HOLDER_HOME_DEN]], push: 1 },
    { opcode: OP.divide, pop: 2, push: 1 },
    set(names.x),
    getlocal(L_ICON),
    { opcode: OP.pushbyte, operands: [["s8", HOLDER_HOME_NUM]], push: 1 },
    { opcode: OP.pushbyte, operands: [["s8", HOLDER_HOME_DEN]], push: 1 },
    { opcode: OP.divide, pop: 2, push: 1 },
    set(names.y),
    getlocal(L_ICON),
    { opcode: OP.pushbyte, operands: [["s8", HOLDER_SCALE_NUM]], push: 1 },
    { opcode: OP.pushbyte, operands: [["s8", HOLDER_SCALE_DEN]], push: 1 },
    { opcode: OP.divide, pop: 2, push: 1 },
    set(names.scaleX),
    getlocal(L_ICON),
    { opcode: OP.pushbyte, operands: [["s8", HOLDER_SCALE_NUM]], push: 1 },
    { opcode: OP.pushbyte, operands: [["s8", HOLDER_SCALE_DEN]], push: 1 },
    { opcode: OP.divide, pop: 2, push: 1 },
    set(names.scaleY),
    { opcode: OP.jump, branchTo: "afterHolderClick" },
    { label: "noHolderClick" },
    { opcode: OP.pop, pop: 1 },
    { label: "afterHolderClick" },

    ...theIcon(names, "Click"),
    { opcode: OP.dup, push: 1 },
    { opcode: OP.iffalse, branchTo: "noIcon", pop: 1 },
    { opcode: OP.coerce_a },
    setlocal(L_ICON),

    getlocal(L_CLIP),
    ...child(FLOATER_NAME),
    { opcode: OP.dup, push: 1 },
    { opcode: OP.iffalse, branchTo: "noIcon", pop: 1 },
    getlocal(L_ICON),
    { opcode: OP.callpropvoid, operands: [["u30", names.addChild], ["u30", 1]], pop: 2 },
    getlocal(L_ICON),
    { opcode: OP.pushshort, operands: [["u30", CARD_ICON_X]], push: 1 },
    set(names.x),
    getlocal(L_ICON),
    { opcode: OP.pushshort, operands: [["u30", CARD_ICON_Y]], push: 1 },
    set(names.y),
    getlocal(L_ICON),
    { opcode: OP.pushbyte, operands: [["s8", 1]], push: 1 },
    set(names.scaleX),
    getlocal(L_ICON),
    { opcode: OP.pushbyte, operands: [["s8", 1]], push: 1 },
    set(names.scaleY),
    { opcode: OP.jump, branchTo: "afterIcon" },
    { label: "noIcon" },
    { opcode: OP.pop, pop: 1 },
    { label: "afterIcon" },

    ...epilogue(),
    ...marker,
  ];
}

// `OnRefreshScreen` is deliberately absent. Two earlier attempts to drive it from
// here went wrong in the same place: the board program erased skulls opened out of
// order, and the mute program cost the reward icon. It is the one method on this
// screen that already carries a patch of its own - `patch-dungeonblitz-hallows-eve-
// refresh-guard.ts` exists because it was clearing `am_IconHolder` - so it is left
// to that patch alone.
const SITES: Site[] = [
  { method: "OnTickScreen", detail: "coffer/trove chrome and the class helm", build: chromeProgram },
  { method: "OnCreateScreen", detail: "forty cells wired to the Open handler", build: wireProgram },
  { method: "OnInitDisplay", detail: "board state on opening", build: boardProgram },
  // The class own Open handler, which every cell is wired to. See `openProgram`.
  { method: "method_782", detail: "chest timeline and borrowed icon reset on every click", build: openProgram },
  { method: "Hide", detail: "the key cursor handed back when the panel closes", build: cursorProgram },
];

function patchSwf(swfPath: string, verify: boolean, only: string[] | null): void {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);
  const pool = parsePool(ctx);

  const cellNames = Array.from({ length: COFFER_CELLS }, (_, index) => `${COFFER_CELL_PREFIX}${index}`);
  const wantedStrings = [
    MARKER,
    SKIN_NAME,
    PRIZE_GROUP_NAME,
    CACHE_ICON_NAME,
    COFFER_GROUP_NAME,
    COFFER_ANIM_NAME,
    COFFER_CELL_PREFIX,
    GLOW_NAME,
    CLICK_EVENT,
    CLOSE_NAME,
    CURSOR_KEY,
    CURSOR_KEY_WAITING,
    CURSOR_AUTO,
    BANNER_NAME,
    BANNER_TEXT,
    BANNER_PREFIX,
    COUNT_GROUP,
    ...PRIZE_COUNTS,
    ...PRIZE_COUNTS.map((_, index) => `am_PrizeCount${index}`),
    BURST_NAME,
    RING_SOCKET,
    CARD_ICON,
    FLOATER_NAME,
    FLOATER_WRAP,
    FLOATER_TEXT,
    DEFAULT_CLASS,
    ...cellNames,
    CHEST_NAME,
    ...HIDDEN_ALWAYS,
    ...HIDDEN_ON_COFFER,
    ...HELMS.map((helm) => helm.child),
    ...HELMS.map((helm) => helm.className),
  ];
  const { indexOf, patches: stringPatches } = appendStrings(pool, wantedStrings);
  const str = (value: string): number => {
    const index = indexOf.get(value);
    if (index === undefined) {
      throw new PatchError(`String "${value}" was never resolved`);
    }
    return index;
  };

  const inClass = (opcode: number, name: string): number =>
    findOperandInClass(ctx, abc, HOST_CLASS, opcode, name);

  const names: Names = {
    var_1: inClass(OP.getlex, "var_1"),
    var_2: inClass(OP.getlex, "var_2"),
    mLockboxData: inClass(OP.getproperty, "mLockboxData"),
    mLockboxID: inClass(OP.getproperty, "mLockboxID"),
    mOwnedLockboxes: inClass(OP.getproperty, "mOwnedLockboxes"),
    indexer: findIndexerOperand(ctx, abc),
    stackCount: inClass(OP.getproperty, "stackCount"),
    mLockboxKeys: inClass(OP.getproperty, "mLockboxKeys"),
    clientEnt: inClass(OP.getproperty, "clientEnt"),
    entType: inClass(OP.getproperty, "entType"),
    className: inClass(OP.getproperty, "className"),
    visible: inClass(OP.setproperty, "visible"),
    currentFrame: pool.publicQName("currentFrame"),
    x: pool.publicQName("x"),
    y: pool.publicQName("y"),
    mTimeThisTick: inClass(OP.getproperty, "mTimeThisTick"),
    mouseX: pool.publicQName("mouseX"),
    mouseY: pool.publicQName("mouseY"),
    mouseClass: pool.qNameIn("flash.ui", "Mouse"),
    cursor: pool.publicQName("cursor"),
    customMouse: findOperandInClass(ctx, abc, "Game", OP.getproperty, "var_137"),
    currentCursor: findOperandInClass(ctx, abc, "CustomMouse", OP.getproperty, "var_2002"),
    // `class_32.var_790` - the screen's own "a close is playing" flag. Private to that
    // class, which is no obstacle: a private name is a namespace, and reading it with
    // the very multiname that class uses resolves to the same slot.
    screenClosing: findOperandInClass(ctx, abc, "class_32", OP.getproperty, "var_790"),
    text: pool.publicQName("text"),
    revealStart: inClass(OP.getproperty, "var_2206"),
    openHandler: inClass(OP.getproperty, "method_782"),
    closeHandler: inClass(OP.getproperty, "method_1132"),
    openInFlight: inClass(OP.getproperty, "var_1883"),
    revealRunning: inClass(OP.getproperty, "var_1929"),
    lockboxAnim: inClass(OP.getproperty, "var_396"),
    animSound: pool.publicQName("var_1129"),
    iconHolder: inClass(OP.getproperty, "var_1191"),
    width: pool.publicQName("width"),
    height: pool.publicQName("height"),
    maskHolder: inClass(OP.getproperty, "var_1085"),
    parent: pool.publicQName("parent"),
    addChild: pool.publicQName("addChild"),
    scaleX: pool.publicQName("scaleX"),
    scaleY: pool.publicQName("scaleY"),
    clearAnimation: pool.publicQName("ClearAnimation"),
    getChildByName: pool.publicQName("getChildByName"),
    gotoAndStop: pool.publicQName("gotoAndStop"),
    buttonMode: pool.publicQName("buttonMode"),
    mouseChildren: pool.publicQName("mouseChildren"),
    mouseEnabled: pool.publicQName("mouseEnabled"),
    addEventListener: pool.publicQName("addEventListener"),
  };

  const patches: BytePatch[] = [
    ...stringPatches,
    ...revealDelayPatch(ctx, abc),
    ...chestSoundPatch(ctx, abc, pool),
  ];
  const applied: string[] = [];
  let allPresent = true;

  for (const site of SITES) {
    if (only && !only.includes(site.method)) {
      continue;
    }
    const methodIdx = methodIdxForTrait(classTraits(abc, HOST_CLASS), abc, site.method);
    if (methodIdx === null) {
      throw new PatchError(`Could not find ${HOST_CLASS}.${site.method}.`);
    }
    const methodBody = abc.methodBodies.get(methodIdx);
    if (!methodBody) {
      throw new PatchError(`Could not find the body of ${HOST_CLASS}.${site.method}.`);
    }
    if (methodBody.exceptionCount !== 0) {
      throw new PatchError(
        `${HOST_CLASS}.${site.method} has exception handlers; their ranges would need shifting.`,
      );
    }
    const code = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
    const instructions = disassemble(code, `${HOST_CLASS}.${site.method}`);

    const block = assemble(site.build(names, str));
    const blockStart = findInjectionOffset(instructions, site.method);

    const markers = findMarkers(instructions, pool.strings);
    if (markers.length !== 0 && markers.length !== 2) {
      throw new PatchError(
        `${swfPath}: found ${markers.length} ${MARKER} markers in ${site.method}; refusing to guess the block.`,
      );
    }
    let blockEnd = blockStart;
    if (markers.length === 2) {
      if (markers[0] !== blockStart) {
        throw new PatchError(
          `${swfPath}: the block in ${site.method} starts at ${markers[0]}, not at ${blockStart}.`,
        );
      }
      // The closing marker is `pushstring MARKER; pop`; the block ends after the pop.
      const trailing = instructions.find((inst) => inst.offset > markers[1]);
      if (!trailing || trailing.opcode !== OP.pop) {
        throw new PatchError(`${swfPath}: the closing marker in ${site.method} is not followed by a pop.`);
      }
      blockEnd = trailing.offset + trailing.size;
    }

    if (markers.length === 2 && code.subarray(blockStart, blockEnd).equals(block)) {
      continue;
    }
    allPresent = false;
    if (verify) {
      continue;
    }

    const patchedCode = spliceAndAdjustBranches(code, instructions, blockStart, blockEnd, block);

    // local_count is a u30 of its own; read it back rather than assuming a width.
    const [localCount, localCountEnd] = readU30(
      ctx.body,
      methodBody.localCountPos,
      `${site.method}.local_count`,
    );
    // What matters is not what the method *declares* but what it *uses*: this
    // script raises `local_count` and `--remove` leaves it raised, so a declared
    // count above the scratch base usually just means "we have been here". Reading
    // the host's own highest local answers the real question - would the scratch
    // block land on top of something the method is still holding.
    let hostHighestLocal = 0;
    for (const inst of instructions) {
      if (inst.offset >= blockStart && inst.offset < blockEnd) continue;
      if (inst.opcode === OP.getlocal || inst.opcode === OP.setlocal) {
        hostHighestLocal = Math.max(hostHighestLocal, inst.operands[0][1]);
      }
    }
    if (hostHighestLocal >= SCRATCH_BASE) {
      throw new PatchError(
        `${HOST_CLASS}.${site.method} uses local ${hostHighestLocal}; the scratch block would overwrite it.`,
      );
    }

    patches.push(
      {
        key: `${HOST_CLASS}.${site.method}.maxStack`,
        start: methodBody.maxStackPos,
        end: methodBody.localCountPos,
        data: writeU30(NEW_MAX_STACK),
        detail: `maxstack -> ${NEW_MAX_STACK}`,
      },
      {
        key: `${HOST_CLASS}.${site.method}.localCount`,
        start: methodBody.localCountPos,
        end: localCountEnd,
        data: writeU30(NEW_LOCAL_COUNT),
        detail: `localcount -> ${NEW_LOCAL_COUNT}`,
      },
      {
        key: `${HOST_CLASS}.${site.method}.code`,
        start: methodBody.codeStart,
        end: methodBody.codeStart + methodBody.codeLen,
        data: patchedCode,
        detail: site.detail,
      },
      {
        key: `${HOST_CLASS}.${site.method}.codeLen`,
        start: methodBody.codeLenPos,
        end: methodBody.codeStart,
        data: writeU30(patchedCode.length),
        detail: `update ${site.method} code length`,
      },
    );
    applied.push(`${site.method} (${block.length} bytes, ${site.detail})`);
  }

  // The byte patches are checked too, not just the injected blocks: retuning a
  // constant or repointing an operand leaves every block already in place, and an
  // early exit on the blocks alone would report success without writing the change.
  if (allPresent && patches.length === 0) {
    console.log(`${swfPath}: already patched (every ${HOST_CLASS} block and byte patch present).`);
    if (!verify) {
      syncClientRev(swfPath);
    }
    return;
  }
  if (verify) {
    throw new PatchError(`${swfPath}: verify failed; the coffers board is missing or stale.`);
  }

  ensureBackup(swfPath);
  const { body, delta } = applyPatchesToBody(ctx.body, patches);
  writeSwf(ctx, body, delta);
  for (const line of applied) {
    console.log(`  ${HOST_CLASS}.${line}`);
  }
  console.log(`${swfPath}: patched ${applied.length} method(s).`);
  syncClientRev(swfPath);
}

/**
 * Takes every injected block back out, leaving `class_73` exactly as it shipped.
 *
 * This is the experiment that ends an argument no amount of static checking has
 * been able to settle. The board stopped opening, and the two candidates are "the
 * bytecode this file writes is rejected by the player's verifier" and "something
 * else entirely" - a `VerifyError` is thrown when a method is first *called*, so a
 * bad `OnCreateScreen` shows up as `Display()` doing nothing at all, which is the
 * symptom exactly. With the blocks gone the screen is the shipped lockbox panel:
 * if it opens, this file is the cause and there is no more guessing; if it still
 * does not, this file never was.
 *
 * The blocks are marker-fenced, so removing them is the same splice that replaces
 * them, with an empty buffer. `max_stack` and `local_count` are left raised, which
 * costs nothing - a method may always declare more than it uses.
 */
function removeBlocks(swfPath: string): void {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);
  const pool = parsePool(ctx);
  const patches: BytePatch[] = [];
  const removed: string[] = [];

  for (const site of SITES) {
    const methodIdx = methodIdxForTrait(classTraits(abc, HOST_CLASS), abc, site.method);
    if (methodIdx === null) continue;
    const methodBody = abc.methodBodies.get(methodIdx);
    if (!methodBody) continue;
    const code = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
    const instructions = disassemble(code, `${HOST_CLASS}.${site.method}`);

    const markers = findMarkers(instructions, pool.strings);
    if (markers.length === 0) continue;
    if (markers.length !== 2) {
      throw new PatchError(`${site.method} carries ${markers.length} markers; refusing to guess the block.`);
    }
    const trailing = instructions.find((inst) => inst.offset > markers[1]);
    if (!trailing || trailing.opcode !== OP.pop) {
      throw new PatchError(`${site.method}: the closing marker is not followed by a pop.`);
    }
    const blockStart = markers[0];
    const blockEnd = trailing.offset + trailing.size;
    const stripped = spliceAndAdjustBranches(code, instructions, blockStart, blockEnd, Buffer.alloc(0));

    patches.push(
      {
        key: `${HOST_CLASS}.${site.method}.code`,
        start: methodBody.codeStart,
        end: methodBody.codeStart + methodBody.codeLen,
        data: stripped,
        detail: `remove the ${site.method} block`,
      },
      {
        key: `${HOST_CLASS}.${site.method}.codeLen`,
        start: methodBody.codeLenPos,
        end: methodBody.codeStart,
        data: writeU30(stripped.length),
        detail: `update ${site.method} code length`,
      },
    );
    removed.push(`${site.method} (-${blockEnd - blockStart} bytes)`);
  }

  if (removed.length === 0) {
    console.log(`${swfPath}: no injected blocks found; nothing to remove.`);
    return;
  }

  ensureBackup(swfPath);
  const { body, delta } = applyPatchesToBody(ctx.body, patches);
  writeSwf(ctx, body, delta);
  for (const line of removed) console.log(`  ${HOST_CLASS}.${line}`);
  console.log(`${swfPath}: removed ${removed.length} block(s); class_73 is now as it shipped.`);
  syncClientRev(swfPath);
}

function main(): void {
  const { swfPath, verify, remove, only } = parseArgs(process.argv);
  if (remove) {
    removeBlocks(swfPath);
    return;
  }
  patchSwf(swfPath, verify, only);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
