/**
 * Adds the Legends' Inn exit portal EntType.
 *
 * The portal a Legends' Inn stage opens when its boss dies is a server-spawned
 * entity rather than level art, because a room's children are built once at load
 * and can never be revealed part-way through a run. That makes the portal an
 * EntType, and this script is where it comes from.
 *
 * Three things about the entry are load-bearing, and all three are the reason it
 * is a new EntType rather than a reuse of the shipped `DoorPortal`:
 *
 *   - **No DisplayName.** An entity's floating name is its EntType's display
 *     name; leaving it out is what keeps the dungeon's name off the portal.
 *   - **Behavior NPC.** `DoorPortal` and `NephitPortal` are `SpawnerNephit`, and
 *     a client that builds that brain starts spawning nephits out of the exit.
 *     NPC is the inert brain - it stands there.
 *   - **HitPoints 0 / RewardClass NoLoot / Realm Object**, so nothing about it
 *     reads as a kill: no health bar, no loot roll, no contribution to a clear.
 *
 * The artwork is `Animation_Nephit.swf/a__NephitPortal`, the looping rift the
 * Astral Rifts in Deepgard are drawn from. It is a globally loaded animation
 * file, so it is present in all nine of the region SWFs the stages come from -
 * which is the same reason the stages' hostiles are all player-class bodies.
 *
 * Written to every copy the two sides read: the client's Login.swz chunks (the
 * live ones), the loose reference XML, and the server's EntTypes.json.
 *
 * Usage: npm exec ts-node scripts/patch_swz_legends_inn_portal_ent.ts [--verify]
 *
 * Re-runnable: every entry it owns is replaced rather than appended.
 */
import * as fs from "fs";
import * as path from "path";
import { ensureBackup, parseSwz, SwzPatchError, writeSwz } from "./swzPatchUtils";
import { LEGENDS_INN_PORTAL_ENT } from "./legendsInnStages";

const CLIENT_CONTENT = path.resolve(__dirname, "..", "..", "client", "content");
const SERVER_DATA = path.resolve(__dirname, "..", "data");

/** Every packed copy of EntTypes the client might read. */
const SWZ_PATHS = [
  path.join(CLIENT_CONTENT, "localhost", "p", "cbp", "Login.swz"),
  path.join(CLIENT_CONTENT, "localhost", "p", "cbq", "Login.swz"),
];

const ENT_FIELDS: Array<[string, string]> = [
  ["DevStatus", "LegendsInn"],
  ["Level", "0"],
  ["GroupLevel", "0"],
  ["MeleeDamage", "0"],
  ["MagicDamage", "0"],
  ["ArmorClass", "0"],
  ["HitPoints", "0"],
  ["RewardClass", "NoLoot"],
  ["Realm", "Object"],
  ["Speed", "0"],
  ["Width", "200"],
  ["Height", "250"],
  ["Behavior", "NPC"],
  // Gravity off. The portal is placed by the server on a point derived from the
  // boss room's `am_Boss` anchor, and an entity dropped onto that point is at the
  // mercy of whatever collision happens to be under it: the client gives a
  // server-spawned entity no floor snap, so a rift that lands a few pixels off the
  // walkable surface - or beside it, since the portal stands off to one side of
  // the boss - falls out of the bottom of the dungeon and is gone.
  //
  // `Flying` is the client's own "this body ignores gravity" flag, which is what
  // makes a hovering rift the right shape for it rather than a workaround: the
  // portal now stays exactly where it is put in all nine stages. It never chases
  // anything the way a flying *mob* would, because `Behavior NPC` has no brain
  // that moves and `Speed` is 0.
  ["Flying", "True"],
];

const GFX_FIELDS: Array<[string, string]> = [
  ["AnimClass", "a__NephitPortal"],
  ["AnimFile", "Animation_Nephit.swf"],
  ["Shadow", "None"],
  ["AnimScale", "1.0"],
];

function buildEntXml(newline: string): string {
  const lines = [
    `\t<EntType EntName="${LEGENDS_INN_PORTAL_ENT}" parent="Base">`,
    ...ENT_FIELDS.map(([tag, value]) => `\t\t<${tag}>${value}</${tag}>`),
    "\t\t<EquippedGear/>",
    "\t\t<GfxType>",
    ...GFX_FIELDS.map(([tag, value]) => `\t\t\t<${tag}>${value}</${tag}>`),
    "\t\t</GfxType>",
    "\t</EntType>",
  ];
  return lines.join(newline);
}

/**
 * EntTypes an earlier version of this feature minted and no longer wants.
 *
 * Airborne cues were briefly given a Dread Mage cloned with `Flying`. It worked -
 * and read badly: a hovering mob rises with the player and never comes down to be
 * fought. The airborne *placements* are moved onto the floor by the SWF build
 * instead, so the clones have to be swept back out of every copy of EntTypes
 * rather than merely stopped, or they linger forever in files nothing rewrites.
 */
const RETIRED_ENT = /Aloft/;

/** Replaces the entry this script owns and drops the retired ones. */
export function patchEntTypesXml(xml: string): { xml: string; changed: boolean } {
  const newline = xml.includes("\r\n") ? "\r\n" : "\n";

  const stripped = xml
    .replace(new RegExp(`[ \\t]*<EntType EntName="${LEGENDS_INN_PORTAL_ENT}"[ >][\\s\\S]*?</EntType>\\r?\\n?`), "")
    .replace(/[ \t]*<EntType EntName="([^"]*)"[ >][\s\S]*?<\/EntType>\r?\n?/g, (block, name) =>
      RETIRED_ENT.test(String(name)) ? "" : block,
    );

  const closing = stripped.lastIndexOf("</EntTypes>");
  if (closing === -1) throw new SwzPatchError("EntTypes chunk has no closing tag");

  const patched = stripped.slice(0, closing) + buildEntXml(newline) + newline + stripped.slice(closing);
  return { xml: patched, changed: patched !== xml };
}

function patchSwz(swzPath: string, verifyOnly: boolean): boolean {
  if (!fs.existsSync(swzPath)) return false;

  const ctx = parseSwz(swzPath);
  const chunk = ctx.chunks.find((entry) => entry.xml.includes("<EntTypes"));
  if (!chunk) throw new SwzPatchError(`${path.basename(swzPath)} has no EntTypes chunk`);

  const patched = patchEntTypesXml(chunk.xml);
  if (!verifyOnly && patched.changed) {
    ensureBackup(swzPath);
    chunk.xml = patched.xml;
    writeSwz(ctx);
  }
  return patched.changed;
}

/** The server's own copy, which GameData reads for hit points and behaviour. */
function patchServerJson(verifyOnly: boolean): boolean {
  const filePath = path.join(SERVER_DATA, "EntTypes.json");
  const raw = fs.readFileSync(filePath, "utf8");
  const bom = raw.startsWith("﻿") ? "﻿" : "";
  const parsed = JSON.parse(raw.replace(/^﻿/, "")) as {
    EntTypes: { EntType: Array<Record<string, string>> };
  };

  const retired = parsed.EntTypes.EntType.filter((ent) => RETIRED_ENT.test(String(ent.EntName ?? "")));
  parsed.EntTypes.EntType = parsed.EntTypes.EntType.filter((ent) => !RETIRED_ENT.test(String(ent.EntName ?? "")));
  const list = parsed.EntTypes.EntType;

  const entry: Record<string, string> = {
    EntName: LEGENDS_INN_PORTAL_ENT,
    parent: "Base",
    ...Object.fromEntries(ENT_FIELDS),
  };
  const index = list.findIndex((ent) => String(ent.EntName ?? "") === entry.EntName);
  let changed = retired.length > 0 || index === -1 || JSON.stringify(list[index]) !== JSON.stringify(entry);
  if (index === -1) list.push(entry);
  else list[index] = entry;

  if (!verifyOnly && changed) {
    const crlf = raw.includes("\r\n");
    const text = `${bom}${JSON.stringify(parsed, null, 2)}\n`;
    fs.writeFileSync(filePath, crlf ? text.replace(/\r?\n/g, "\r\n") : text);
  }
  return changed;
}

function patchLooseXml(verifyOnly: boolean): boolean {
  const filePath = path.join(CLIENT_CONTENT, "xml", "EntTypes.xml");
  if (!fs.existsSync(filePath)) return false;

  const xml = fs.readFileSync(filePath, "utf8");
  const patched = patchEntTypesXml(xml);
  if (!verifyOnly && patched.changed) fs.writeFileSync(filePath, patched.xml);
  return patched.changed;
}

function main(): void {
  const verifyOnly = process.argv.includes("--verify");
  for (const swzPath of SWZ_PATHS) {
    const changed = patchSwz(swzPath, verifyOnly);
    console.log(`${path.basename(path.dirname(swzPath))}/${path.basename(swzPath)}: ${changed ? "written" : "already current"}`);
  }
  console.log(`content/xml/EntTypes.xml: ${patchLooseXml(verifyOnly) ? "written" : "already current"}`);
  console.log(`data/EntTypes.json: ${patchServerJson(verifyOnly) ? "written" : "already current"}`);
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
