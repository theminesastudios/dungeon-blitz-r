/**
 * Opens the Green Knight's Challenge panel to players who own no Class Tower.
 *
 * ## The gate
 *
 * The panel is reached through the `Special_ClassTower` arm of `Game.method_668`,
 * and that arm ends in three tests:
 *
 *     if (clientEnt.mExpLevel < 10)        -> chat "This looks interesting..."
 *     if (!clientEnt.mMasterClass)         -> screenMasterClassSelection.Display()
 *     if (clientEnt.getTowerLevel() >= 1)  -> screenClassTowers.Display()
 *     else                                 -> break        // nothing at all
 *
 * The last one is the problem, and its failure is completely silent - no chat
 * line, no other screen, the arm simply falls out. A click on a correctly cued,
 * correctly placed entity looks exactly like a click on nothing.
 *
 * `Entity.getTowerLevel()` is
 *
 *     class_14.var_278[class_9.method_472(mMasterClass)].rank
 *
 * i.e. it reads `rank` off the **BuildingTypes row** for `<masterclass>tower`, not
 * off anything belonging to the player. `var_278` is keyed by `BuildingID`, and in
 * `BuildingTypes` only the first row of a building carries a `BuildingID` - the
 * rank rows that follow inherit the name but declare no id. So `var_278[4]` is
 * `SentinelTower`'s header row, whose `<Rank>` is **0**, and `getTowerLevel()`
 * returns 0 for every player of every class on this server. The gate can never
 * pass, and the panel can never open.
 *
 * The 0xDA building packet does not help: its handler (`LinkUpdater`) resolves the
 * delta through `class_9.method_216` and swaps the level art, and writes `rank`
 * nowhere. There is no server-side way to move this number.
 *
 * ## The patch
 *
 * One byte. The comparison is `pushbyte 1; ifnge`, so the immediate becomes 0 and
 * the test reads `getTowerLevel() >= 0` - always true, since the method is typed
 * `uint`. Nothing is inserted, nothing is removed, no branch offset moves, and the
 * verifier sees the same instruction stream it saw before. That matters here: this
 * is a 1.6MB obfuscated ABC, and every other kind of edit to it in this project has
 * had to be argued about (see the notes on back-edge trampolines and on FFDec
 * recompiles dropping byte patches).
 *
 * The anchor is the whole surrounding window rather than an offset, and it is
 * asserted to occur exactly once:
 *
 *     62 0e     getlocal 14
 *     2a        dup
 *     11 ...    iftrue
 *     29        pop
 *     d3        getlocal3
 *     76        convert_b
 *     12 ...    iffalse
 *     24 01     pushbyte 1          <- the byte
 *     0f ...    ifnge
 *     d0        getlocal0
 *
 * Three other `24 01 0f` sequences exist in the pool; none of them carries this
 * prologue.
 *
 * ## What it costs
 *
 * The Class Tower screen is repointed at `a_ScreenHalloweenDungeonPrompt` by
 * `patch-hallows-eve-challenge-screen.ts`, so this arm no longer leads to the tower
 * at all - the tower feature is not being loosened, it is being replaced. If the
 * Class Tower is ever restored, revert both patches together.
 *
 * Usage: npm exec ts-node scripts/patch-dungeonblitz-hallows-eve-tower-gate.ts [--verify]
 *
 * Re-runnable: it checks for its own result first.
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import {
  SwfFile,
  SwfLevelError,
  ensureBackup,
  readSwfFile,
  writeSwfFile,
  TAG_DO_ABC,
  TAG_DO_ABC_DEPRECATED,
} from "./swfLevelUtils";

const CLIENT_CONTENT = path.resolve(__dirname, "..", "..", "client", "content", "localhost");
const CLIENT_SWF = path.join(CLIENT_CONTENT, "p", "cbp", "DungeonBlitz.swf");
const INDEX_HTML = path.join(CLIENT_CONTENT, "index.html");

/**
 * The window around the comparison, with the branch displacements masked.
 *
 * `null` is a wildcard: the two `s24` displacements are the only bytes here that
 * would move if anything else in the method ever changed, so they are not matched.
 */
const ANCHOR: Array<number | null> = [
  0x62, 0x0e, // getlocal 14
  0x2a, // dup
  0x11, null, null, null, // iftrue <s24>
  0x29, // pop
  0xd3, // getlocal3
  0x76, // convert_b
  0x12, null, null, null, // iffalse <s24>
  0x24, 0x01, // pushbyte 1   <- index 15 is the byte this patch rewrites
  0x0f, null, null, null, // ifnge <s24>
  0xd0, // getlocal0
];

/** Where the immediate sits inside `ANCHOR`. */
const IMMEDIATE_INDEX = 15;

/** What it becomes: `getTowerLevel() >= 0`. */
const PATCHED_IMMEDIATE = 0x00;

function abcTag(swf: SwfFile) {
  const index = swf.tags.findIndex(
    (tag) => tag.code === TAG_DO_ABC || tag.code === TAG_DO_ABC_DEPRECATED,
  );
  if (index === -1) throw new SwfLevelError("DungeonBlitz.swf has no DoABC tag");
  return { index, data: swf.tags[index].data };
}

/** Every offset where `ANCHOR` matches, with `immediate` substituted in. */
function findAnchor(data: Buffer, immediate: number): number[] {
  const hits: number[] = [];
  const first = ANCHOR[0] as number;
  for (let i = 0; i + ANCHOR.length <= data.length; i += 1) {
    if (data[i] !== first) continue;
    let ok = true;
    for (let j = 1; j < ANCHOR.length; j += 1) {
      const want = j === IMMEDIATE_INDEX ? immediate : ANCHOR[j];
      if (want === null) continue;
      if (data[i + j] !== want) {
        ok = false;
        break;
      }
    }
    if (ok) hits.push(i);
  }
  return hits;
}

/** Keeps index.html's cache token in step, or nobody is served the patch. */
function syncClientRevision(): void {
  const digest = crypto.createHash("sha1").update(fs.readFileSync(CLIENT_SWF)).digest("hex").slice(0, 12);
  const html = fs.readFileSync(INDEX_HTML, "utf8");
  const updated = html.replace(/clientrev=swf-[A-Za-z0-9]+/, `clientrev=swf-${digest}`);
  if (updated === html) {
    console.log("  no clientrev token moved in index.html - check it by hand.");
    return;
  }
  fs.writeFileSync(INDEX_HTML, updated);
  console.log(`  clientrev -> swf-${digest}`);
}

function main(): void {
  const verify = process.argv.includes("--verify");
  const swf = readSwfFile(CLIENT_SWF);
  const { index, data } = abcTag(swf);

  if (findAnchor(data, PATCHED_IMMEDIATE).length > 0) {
    console.log("the tower gate is already open; nothing to do.");
    return;
  }

  const hits = findAnchor(data, 0x01);
  if (hits.length === 0) {
    throw new SwfLevelError(
      "the getTowerLevel comparison was not found - the ABC is not the one this patch was written against",
    );
  }
  if (hits.length > 1) {
    throw new SwfLevelError(
      `the anchor matched ${hits.length} times; it is meant to be unique, so refusing to guess`,
    );
  }

  const at = hits[0] + IMMEDIATE_INDEX;
  console.log(`getTowerLevel() >= 1  ->  >= 0   (one byte at ABC offset ${at})`);
  if (verify) {
    console.log("verify only - nothing written.");
    return;
  }

  data[at] = PATCHED_IMMEDIATE;
  swf.tags[index] = { code: swf.tags[index].code, data };

  ensureBackup(CLIENT_SWF);
  writeSwfFile(CLIENT_SWF, swf);
  console.log(`wrote ${CLIENT_SWF}`);
  syncClientRevision();
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
