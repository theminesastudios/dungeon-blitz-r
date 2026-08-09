import * as fs from "fs";
import * as path from "path";
import { defaultLoginSwzPath, ensureBackup, parseSwz, SwzPatchError, writeSwz } from "./swzPatchUtils";

/**
 * Adds the Mystic (rarity "Y", gear tier 3) variant of the eighteen class lockbox items.
 *
 * Each Mystic entry is a copy of that item's Legendary entry with the rarity letter swapped, so it
 * inherits the same art, runes and stat rune and differs only by tier. The client needs no new
 * lookup code for them: `GearType.method_18` keys `class_14.var_421` by
 * `String(gearID) + rarity.toUpperCase()`, so `<Rarity>Y</Rarity>` registers under "1171Y" by
 * itself. `patch-dungeonblitz-mystic-rarity.ts` is what teaches the client to *ask* for that key.
 *
 * GearTypes lives in two places and both have to be written:
 *  - `Login.swz` chunk 0 is what the Flash client actually reads.
 *  - `src/client/content/xml/GearTypes.xml` is the server-side copy that GameData and
 *    GearGoldBonuses parse. Its DisplayNames are the Turkish localisation.
 */
const MYSTIC_LETTER = "Y";

/**
 * The three classes' lockbox sets, in gearID order: Mage 1165-1170, Rogue 1171-1176, Paladin
 * 1177-1182. Slot order is identical in each set, which is what lets the ability chains in
 * `patch-mystic-power-mods.ts` be laid out slot-by-slot.
 */
const SLOTS = ["Sword", "Shield", "Hat", "Armor", "Gloves", "Boots"];
const ITEMS = [
  { className: "Mage", firstGearId: 1165 },
  { className: "Rogue", firstGearId: 1171 },
  { className: "Paladin", firstGearId: 1177 },
].flatMap(({ className, firstGearId }) =>
  SLOTS.map((slot, index) => ({
    gearId: firstGearId + index,
    base: `Unique${className}Lockbox01Gear${slot}30`,
  })),
);

const LOOSE_XML = path.resolve(__dirname, "..", "..", "client", "content", "xml", "GearTypes.xml");

function parseArgs(argv: string[]): { swzPath: string; xmlPath: string; verify: boolean } {
  let swzPath = defaultLoginSwzPath();
  let xmlPath = LOOSE_XML;
  let verify = false;

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--swz-path") {
      swzPath = path.resolve(argv[++index] || "");
      continue;
    }
    if (arg === "--xml-path") {
      xmlPath = path.resolve(argv[++index] || "");
      continue;
    }
    if (arg === "--verify" || arg === "--dry-run") {
      verify = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log([
        "Usage:",
        "  npx ts-node src/server/scripts/patch-mystic-gear-data.ts [--verify] [--swz-path <path>] [--xml-path <path>]",
        "",
        "Adds the Mystic (rarity Y) variant of the 18 class lockbox items to Login.swz and to the",
        "server-side GearTypes.xml copy.",
      ].join("\n"));
      process.exit(0);
    }
    throw new SwzPatchError(`Unknown argument: ${arg}`);
  }

  return { swzPath, xmlPath, verify };
}

/** Returns the `<Gear ...>...</Gear>` block for `gearName`, plus where it sits in `xml`. */
function findGearBlock(xml: string, gearName: string): { block: string; start: number; end: number } {
  const token = `<Gear GearName="${gearName}"`;
  const start = xml.indexOf(token);
  if (start === -1) throw new SwzPatchError(`Gear block ${gearName} not found.`);
  const closeIndex = xml.indexOf("</Gear>", start);
  if (closeIndex === -1) throw new SwzPatchError(`Gear block ${gearName} has no closing tag.`);
  const end = closeIndex + "</Gear>".length;
  return { block: xml.slice(start, end), start, end };
}

function buildMysticBlock(legendaryBlock: string, baseName: string, displayName: string | null): string {
  let block = legendaryBlock
    .replace(`GearName="${baseName}L"`, `GearName="${baseName}${MYSTIC_LETTER}"`)
    .replace(/<Rarity>L<\/Rarity>/, `<Rarity>${MYSTIC_LETTER}</Rarity>`);

  if (!block.includes(`GearName="${baseName}${MYSTIC_LETTER}"`)) {
    throw new SwzPatchError(`${baseName}L: GearName rewrite failed.`);
  }
  if (!block.includes(`<Rarity>${MYSTIC_LETTER}</Rarity>`)) {
    throw new SwzPatchError(`${baseName}L: expected <Rarity>L</Rarity> to replace.`);
  }
  if (displayName !== null) {
    block = block.replace(/<DisplayName>[\s\S]*?<\/DisplayName>/, `<DisplayName>${displayName}</DisplayName>`);
  }
  return block;
}

/**
 * `localiseTurkish` renames the Turkish server-side copy from "Efsanevi ..." (Legendary) to
 * "Mistik ...". The English swz keeps the item's real name, which is rarity independent.
 */
function localiseTurkish(legendaryBlock: string): string | null {
  const current = legendaryBlock.match(/<DisplayName>([\s\S]*?)<\/DisplayName>/)?.[1];
  if (!current) return null;
  return current.startsWith("Efsanevi ") ? `Mistik ${current.slice("Efsanevi ".length)}` : `Mistik ${current}`;
}

/**
 * UNUSED. Kept for reference: stripping the proc runes freed two tooltip lines, but the proc
 * *effects* are applied by literal string compare in Entity/CombatState ("Haste", "CritChance",
 * "ProcMassive", ...), so removing the runes silently removed the item bonuses too. The lines are
 * reclaimed by reserving space in the ability text instead.
 *
 * Removes the crit-proc runes from existing Mystic blocks. The tooltip card has fixed positions for
 * the two proc lines and cannot grow (the layout-shift epilogue proved unreachable), so on a Mystic
 * item the multi-line ability text renders across them. Dropping the procs frees exactly those two
 * lines; the ability bonuses are the item's identity anyway. Trade-off: Mystic copies lose the
 * on-critical-hit procs the Legendary versions have.
 */
function stripMysticProcs(xml: string): { xml: string; changed: number } {
  let out = xml;
  let changed = 0;
  for (const item of ITEMS) {
    const block = findGearBlock(out, `${item.base}${MYSTIC_LETTER}`);
    const stripped = block.block.replace(/[ \t]*<ProcRune2?>[\s\S]*?<\/ProcRune2?>\r?\n/g, "");
    if (stripped !== block.block) {
      out = `${out.slice(0, block.start)}${stripped}${out.slice(block.end)}`;
      changed += 1;
    }
  }
  return { xml: out, changed };
}

/** Inserts each Mystic block directly after its Legendary sibling. Idempotent. */
function addMysticGear(xml: string, turkish: boolean, label: string): { xml: string; added: number } {
  let out = xml;
  let added = 0;

  for (const item of ITEMS) {
    const mysticName = `${item.base}${MYSTIC_LETTER}`;
    if (out.includes(`<Gear GearName="${mysticName}"`)) continue;

    const legendary = findGearBlock(out, `${item.base}L`);
    if (!legendary.block.includes(`GearID="${item.gearId}"`)) {
      throw new SwzPatchError(`${label}: ${item.base}L is not GearID ${item.gearId}.`);
    }

    const displayName = turkish ? localiseTurkish(legendary.block) : null;
    const mystic = buildMysticBlock(legendary.block, item.base, displayName);

    // Match the separator the surrounding entries already use so the file keeps one style.
    const separator = out.slice(legendary.end).startsWith("\r\n") ? "\r\n\t" : "\n\t";
    out = `${out.slice(0, legendary.end)}${separator}${mystic}${out.slice(legendary.end)}`;
    added += 1;
  }

  return { xml: out, added };
}

function patch(swzPath: string, xmlPath: string, verify: boolean): void {
  const swz = parseSwz(swzPath);
  const gearChunk = swz.chunks.find((chunk) => chunk.xml.startsWith("<?xml") && chunk.xml.includes("<GearTypes"));
  if (!gearChunk) throw new SwzPatchError(`${swzPath} has no GearTypes chunk.`);

  const swzAdded = addMysticGear(gearChunk.xml, false, path.basename(swzPath));
  const swzResult = { xml: swzAdded.xml, changed: 0 };

  const looseXml = fs.readFileSync(xmlPath, "utf8");
  const looseAdded = addMysticGear(looseXml, true, path.basename(xmlPath));
  const looseResult = { xml: looseAdded.xml, changed: 0 };

  const changes = swzAdded.added + swzResult.changed + looseAdded.added + looseResult.changed;
  const summary =
    `${path.basename(swzPath)}: +${swzAdded.added} entries, ${swzResult.changed} proc-stripped; ` +
    `${path.basename(xmlPath)}: +${looseAdded.added} entries, ${looseResult.changed} proc-stripped`;

  if (changes === 0) {
    console.log(`Already patched — ${summary}.`);
    return;
  }
  if (verify) {
    console.log(`WOULD PATCH — ${summary}.`);
    return;
  }

  if (swzAdded.added > 0 || swzResult.changed > 0) {
    ensureBackup(swzPath);
    gearChunk.xml = swzResult.xml;
    writeSwz(swz);
  }
  if (looseAdded.added > 0 || looseResult.changed > 0) {
    ensureBackup(xmlPath);
    fs.writeFileSync(xmlPath, looseResult.xml, "utf8");
  }

  console.log(`Patched — ${summary}.`);
}

const { swzPath, xmlPath, verify } = parseArgs(process.argv);
patch(swzPath, xmlPath, verify);
