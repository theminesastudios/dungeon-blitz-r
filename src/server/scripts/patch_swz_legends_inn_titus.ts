/**
 * Titus, the man standing under the Legends' Inn portal.
 *
 * He is the warning the dungeon needed: nine stages of Dread Rogues ending on
 * what is left of Telahair, and until now nothing between the player and the
 * first step but a portal on a tree. Titus stops them once, says his piece, and
 * lets them past - see `core/LegendsInnGate.ts` for the gate itself.
 *
 * This script is only his EntType. `parent="NPCTitus2"` is doing the work: the
 * game already ships a Titus, and he is a hooded wizard with a staff
 * (`Animation_NPC.swf/Wizard` over `.../Titus`, on the `ReadyStaff` idle rather
 * than `NPCTitus`'s looping `Casting` one, because this Titus stands on a path
 * rather than mid-spell). Inheriting from him means the man under the portal *is*
 * that character rather than a lookalike, and the art comes out of an animation
 * file that is loaded everywhere - including the keep, which is the one place he
 * has to render.
 *
 * The entry exists at all, rather than the entity simply naming `NPCTitus2`, so
 * that "the Legends' Inn gatekeeper" is a thing this project owns and can retune
 * without touching a shipped GlobalNPC.
 *
 * Written to every copy the two sides read: the client's Login.swz chunks (the
 * live ones), the loose reference XML, and the server's EntTypes.json.
 *
 * Usage: npm exec ts-node scripts/patch_swz_legends_inn_titus.ts [--verify]
 *
 * Re-runnable: the entry it owns is replaced rather than appended.
 */
import * as fs from "fs";
import * as path from "path";
import { ensureBackup, parseSwz, SwzPatchError, writeSwz } from "./swzPatchUtils";

const CLIENT_CONTENT = path.resolve(__dirname, "..", "..", "client", "content");
const SERVER_DATA = path.resolve(__dirname, "..", "data");

export const LEGENDS_INN_TITUS_ENT = "NPCLegendsInnTitus";

/** The shipped hooded-wizard Titus this one is drawn as. */
const TITUS_PARENT = "NPCTitus2";

const ENT_FIELDS: Array<[string, string]> = [
  ["DisplayName", "Titus"],
  ["DevStatus", "LegendsInn"],
];

const SWZ_PATHS = [
  path.join(CLIENT_CONTENT, "localhost", "p", "cbp", "Login.swz"),
  path.join(CLIENT_CONTENT, "localhost", "p", "cbq", "Login.swz"),
];

function buildEntXml(newline: string): string {
  return [
    `\t<EntType EntName="${LEGENDS_INN_TITUS_ENT}" parent="${TITUS_PARENT}">`,
    ...ENT_FIELDS.map(([tag, value]) => `\t\t<${tag}>${value}</${tag}>`),
    `\t</EntType>`,
  ].join(newline);
}

export function patchEntTypesXml(xml: string): { xml: string; changed: boolean } {
  const newline = xml.includes("\r\n") ? "\r\n" : "\n";
  const stripped = xml.replace(
    new RegExp(`[ \\t]*<EntType EntName="${LEGENDS_INN_TITUS_ENT}"[ >][\\s\\S]*?</EntType>\\r?\\n?`),
    "",
  );
  if (!stripped.includes(`EntName="${TITUS_PARENT}"`)) {
    throw new SwzPatchError(`EntTypes has no ${TITUS_PARENT} for Titus to inherit from`);
  }

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

function patchLooseXml(verifyOnly: boolean): boolean {
  const filePath = path.join(CLIENT_CONTENT, "xml", "EntTypes.xml");
  if (!fs.existsSync(filePath)) return false;
  const patched = patchEntTypesXml(fs.readFileSync(filePath, "utf8"));
  if (!verifyOnly && patched.changed) fs.writeFileSync(filePath, patched.xml);
  return patched.changed;
}

/** The server's own copy, which GameData reads when it resolves the entity. */
function patchServerJson(verifyOnly: boolean): boolean {
  const filePath = path.join(SERVER_DATA, "EntTypes.json");
  const raw = fs.readFileSync(filePath, "utf8");
  const bom = raw.startsWith("﻿") ? "﻿" : "";
  const parsed = JSON.parse(raw.replace(/^﻿/, "")) as {
    EntTypes: { EntType: Array<Record<string, string>> };
  };

  const entry: Record<string, string> = {
    EntName: LEGENDS_INN_TITUS_ENT,
    parent: TITUS_PARENT,
    ...Object.fromEntries(ENT_FIELDS),
  };
  const list = parsed.EntTypes.EntType;
  const index = list.findIndex((ent) => String(ent.EntName ?? "") === entry.EntName);
  const changed = index === -1 || JSON.stringify(list[index]) !== JSON.stringify(entry);
  if (index === -1) list.push(entry);
  else list[index] = entry;

  if (!verifyOnly && changed) {
    const text = `${bom}${JSON.stringify(parsed, null, 2)}\n`;
    fs.writeFileSync(filePath, raw.includes("\r\n") ? text.replace(/\r?\n/g, "\r\n") : text);
  }
  return changed;
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
