/**
 * Renames the consumable the coffer's candy prize borrows, so the reward card says
 * "Candy Corn".
 *
 * ## Why a rename, and why this one
 *
 * The reward card does not show the name the server sends. `sendLockboxReveal`
 * carries a *slot index* into the client's own twenty-entry reward table, and the
 * client draws the card - icon and label - from its entry for that index. Candy Corn
 * has no entry of its own, so it borrows slot 15, the minor rare catalyst, which is
 * the closest thing in the table to a crafting material. That is why the card kept
 * announcing "Inventor's Trinket" while the character was credited real candy.
 *
 * ## What this costs
 *
 * This is not a lockbox-table row. It is `MinorRareCatalyst`'s own `DisplayName` in
 * `ConsumableTypes`, so the rename is global: the catalyst is called Candy Corn
 * everywhere it appears - in the backpack, in the Treasure Trove, in the forge. The
 * item itself is untouched; only what it is called changes.
 *
 * Usage: npm exec ts-node scripts/patch_gameswz_hallows_eve_candy_name.ts [--verify]
 *
 * Re-runnable: it checks for the new name first. To undo, restore the `.bak` the
 * first run writes, or run with `--revert`.
 */
import * as fs from "fs";
import * as path from "path";
import { ensureBackup, parseSwz, SwzPatchError, writeSwz } from "./swzPatchUtils";

/** The consumable whose name the coffer's candy rides in on. */
const CONSUMABLE_NAME = "MinorRareCatalyst";
const SHIPPED_LABEL = "Inventor's Trinket";
const CANDY_LABEL = "Candy Corn";

/**
 * The picture as well as the name.
 *
 * Renaming the row got the card saying Candy Corn while still drawing the
 * catalyst's own primordial heart. Both come from the same `ConsumableType`, so
 * both have to move. All six kingdom variants of the event material exist in
 * `UI_2.swf` alongside the heart, so this is a swap between symbols that are
 * already loaded - nothing is imported.
 */
const SHIPPED_ICON = "a_Icon_PrimordialHeart";
const CANDY_ICON = "a_MaterialIcon_Undead_Halloween";

function gameSwzPaths(): string[] {
  const dir = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p", "cbq");
  const found = fs
    .readdirSync(dir)
    .filter((name) => /^Game.*\.swz$/i.test(name))
    .map((name) => path.join(dir, name));
  if (found.length === 0) {
    throw new SwzPatchError(`no Game*.swz under ${dir}`);
  }
  return found;
}

/**
 * Rewrites the one `DisplayName` that belongs to this consumable.
 *
 * Anchored on the `ConsumableName` attribute rather than on the label alone - the
 * shipped label is short enough to appear elsewhere, and a blind string swap over a
 * whole chunk of game data is how unrelated things quietly get renamed.
 */
export function renameCandyLabel(
  xml: string,
  to: string,
  icon: string,
): { xml: string; changed: number } {
  let changed = 0;
  const rewrite = (field: string, value: string, source: string): string =>
    source.replace(
      new RegExp(
        `(<ConsumableType ConsumableName="${CONSUMABLE_NAME}">[\\s\\S]{0,400}?<${field}>)([^<]*)(</${field}>)`,
        "g",
      ),
      (match, open: string, current: string, close: string) => {
        if (current === value) {
          return match;
        }
        changed += 1;
        return `${open}${value}${close}`;
      },
    );
  const next = rewrite("IconName", icon, rewrite("DisplayName", to, xml));
  return { xml: next, changed };
}

function main(): void {
  const args = process.argv.slice(2);
  const verify = args.includes("--verify");
  const revert = args.includes("--revert");
  const target = revert ? SHIPPED_LABEL : CANDY_LABEL;
  const icon = revert ? SHIPPED_ICON : CANDY_ICON;

  for (const swzPath of gameSwzPaths()) {
    const ctx = parseSwz(swzPath);
    const chunk = ctx.chunks.find((c) => c.xml.includes(`ConsumableName="${CONSUMABLE_NAME}"`));
    if (!chunk) {
      console.log(`${path.basename(swzPath)}: no ${CONSUMABLE_NAME}; skipped`);
      continue;
    }

    const { xml, changed } = renameCandyLabel(chunk.xml, target, icon);
    if (changed === 0) {
      console.log(`${path.basename(swzPath)}: already "${target}"`);
      continue;
    }
    if (verify) {
      console.log(`${path.basename(swzPath)}: would set ${CONSUMABLE_NAME} -> "${target}" / ${icon}`);
      continue;
    }

    ensureBackup(swzPath);
    chunk.xml = xml;
    writeSwz(ctx);
    console.log(`${path.basename(swzPath)}: ${CONSUMABLE_NAME} -> "${target}" / ${icon}`);
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
