/**
 * Mints the Hallow's Eve Coffer as a **lockbox type**, which is what lets the
 * event borrow the client's own coffer-opening screen.
 *
 * ## Why a lockbox
 *
 * `Game.method_668` - the interact handler - branches on the clicked entity's
 * **`characterName`**, and one of its arms is:
 *
 *     if (characterName == "Special_TreasureTrove")
 *         if (mLockboxData.method_662())          // owns at least one lockbox
 *             mLockboxData.mLockboxID = mLockboxData.method_1459();
 *             screenLockBox.Display();            // the real opening screen
 *
 * That is the only path found in this client that lets the *server* open a screen
 * with no bytecode change at all: name an entity's cue `Special_TreasureTrove`
 * and clicking it opens the panel - with its Open button, its key counter, its
 * sparkle fountain and its reward reveal. Everything the Hallow's Eve coffer is
 * supposed to do, the lockbox screen already does.
 *
 * ## Why it needs an id of its own
 *
 * It would be simpler to grant Treasure Troves and be done. It would also be
 * wrong: `class_131.OpenLockbox` decrements `mOwnedLockboxes[id].stackCount` on
 * the client, so a coffer riding on id 1 would eat a trove the player had bought.
 * The coffer gets id 2 and is consumed on its own.
 *
 * Two is also the ceiling's edge and worth writing down: the id is sent in
 * `class_15.const_300` = **2 bits**, so lockbox ids can only ever be 0..3.
 *
 * ## Where this has to be written
 *
 * `LockboxTypes` lives in **`cbq/Game.swz`**, not in Login.swz where the EntTypes
 * are. `LinkUpdater` drops any owned lockbox whose id does not resolve in
 * `class_14.var_838`, so without this row the coffer never appears in the
 * client's inventory, `method_662()` stays false, and clicking the skulls says
 * *"Maybe that old man knows how to open this..."* instead of opening anything.
 *
 * Usage: npm exec ts-node scripts/patch_swz_hallows_eve_coffer.ts [--verify]
 *
 * Re-runnable: the entry is replaced rather than appended.
 */
import * as fs from "fs";
import * as path from "path";
import { ensureBackup, parseSwz, SwzPatchError, writeSwz } from "./swzPatchUtils";

const CLIENT_CONTENT = path.resolve(__dirname, "..", "..", "client", "content");

/** The one packed copy that carries LockboxTypes. */
const GAME_SWZ = path.join(CLIENT_CONTENT, "localhost", "p", "cbq", "Game.swz");

/** The loose reference copy the server side reads. */
const LOOSE_XML = path.join(CLIENT_CONTENT, "xml", "LockboxTypes.xml");

export const HALLOWS_EVE_COFFER_LOCKBOX_ID = 2;
export const HALLOWS_EVE_COFFER_LOCKBOX_NAME = "HallowsEveCoffer";

/**
 * The row.
 *
 * `CustomArt` and `IconName` borrow the Treasure Trove's, which is deliberate
 * rather than lazy: they are the two symbols the lockbox screen is laid out
 * around, they live in `UI_2.swf` which is always loaded, and a chest reads as a
 * coffer perfectly well. `UI_Seasonal.swf` does ship
 * `a_EvilCofferOpenAnimation`, and it *is* loaded (it has been in every
 * `masterFileList.xml` since the base game, `Stage="Core"`), so swapping these
 * two strings is the one-line way to try the seasonal artwork later - but the
 * screen sizes its holder to the trove's art, so that is a change to look at
 * rather than assume.
 *
 * `Droppable false` keeps it out of the ordinary loot tables: the only way to get
 * one is to beat the Green Knight.
 */
const COFFER_XML = [
  `\t<LockboxType LockboxName="${HALLOWS_EVE_COFFER_LOCKBOX_NAME}">`,
  `\t\t<LockboxID>${HALLOWS_EVE_COFFER_LOCKBOX_ID}</LockboxID>`,
  "\t\t<DisplayName>Hallow's Eve Coffer</DisplayName>",
  "\t\t<CustomArt>a_Lockbox01art</CustomArt>",
  "\t\t<IconName>a_Lockbox01icon</IconName>",
  "\t\t<Droppable>false</Droppable>",
  "\t\t<DroppableWeight>0</DroppableWeight>",
  "\t\t<Description>A coffer sealed on the Green Knight's barrow. Only his keys turn it.</Description>",
  "\t</LockboxType>",
];

export function patchLockboxTypesXml(xml: string): { xml: string; changed: boolean } {
  const newline = xml.includes("\r\n") ? "\r\n" : "\n";

  const stripped = xml.replace(
    new RegExp(`[ \\t]*<LockboxType LockboxName="${HALLOWS_EVE_COFFER_LOCKBOX_NAME}"[ >][\\s\\S]*?</LockboxType>\\r?\\n?`, "g"),
    "",
  );

  const closing = stripped.lastIndexOf("</LockboxTypes>");
  if (closing === -1) throw new SwzPatchError("LockboxTypes chunk has no closing tag");

  const patched = stripped.slice(0, closing) + COFFER_XML.join(newline) + newline + stripped.slice(closing);
  return { xml: patched, changed: patched !== xml };
}

function patchSwz(verifyOnly: boolean): boolean {
  const ctx = parseSwz(GAME_SWZ);
  const chunk = ctx.chunks.find((entry) => entry.xml.includes("<LockboxTypes"));
  if (!chunk) throw new SwzPatchError(`${path.basename(GAME_SWZ)} has no LockboxTypes chunk`);

  const patched = patchLockboxTypesXml(chunk.xml);
  if (!verifyOnly && patched.changed) {
    ensureBackup(GAME_SWZ);
    chunk.xml = patched.xml;
    writeSwz(ctx);
  }
  return patched.changed;
}

function patchLooseXml(verifyOnly: boolean): boolean {
  if (!fs.existsSync(LOOSE_XML)) return false;
  const xml = fs.readFileSync(LOOSE_XML, "utf8");
  const patched = patchLockboxTypesXml(xml);
  if (!verifyOnly && patched.changed) fs.writeFileSync(LOOSE_XML, patched.xml);
  return patched.changed;
}

function main(): void {
  const verifyOnly = process.argv.includes("--verify");
  console.log(`cbq/Game.swz: ${patchSwz(verifyOnly) ? "written" : "already current"}`);
  console.log(`content/xml/LockboxTypes.xml: ${patchLooseXml(verifyOnly) ? "written" : "already current"}`);
  console.log(`entry: ${HALLOWS_EVE_COFFER_LOCKBOX_NAME} (LockboxID ${HALLOWS_EVE_COFFER_LOCKBOX_ID})`);
  if (verifyOnly) console.log("verify only - nothing written");
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
