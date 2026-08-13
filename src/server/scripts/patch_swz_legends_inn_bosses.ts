/**
 * The ten guardians a Legends' Inn stage ends on.
 *
 * A stage boss used to be whatever Dread Rogue mini-boss the roster roll reached,
 * which meant it had a mini-boss's health, a borrowed dungeon's two or three
 * powers and, three times over, a face and a health-bar caption the tour had
 * already used. This script mints one EntType per boss slot instead:
 *
 *   - `parent` is a shipped Dread Rogue, so the artwork, the realm, the sounds and
 *     the proportions all come across untouched - the same trick the rest of the
 *     bestiary is built on, and the reason none of this needs new art;
 *   - `EntRank` is `Boss`, which is what puts it on the boss reward tables;
 *   - `HitPoints` climbs from 6 at Wolf's End to 14 at Valhaven, against the 2 a
 *     mini-boss carries and the 3 the sturdiest shipped boss does;
 *   - `Powers` is the Rogue's whole book minus the discipline picks (abilities 4,
 *     5 and 6), and nothing else in the game carries that set.
 *
 * Both names are written for each: a Dread level asks the client for `<cue>Hard`
 * and the SWF can only name the base, exactly as `patch_swz_legends_inn_servant.ts`
 * explains. The base inherits the base body, the Dread one the Dread body, so a
 * guardian is the Dread version of its host in a Dread level and the plain one
 * anywhere else.
 *
 * `legendsInnBosses.ts` is the table; the SWF build renames each stage's boss cue
 * onto `ac_LegendsInnBoss<key>`, which is what actually puts these on the floor.
 *
 * Usage: npm exec ts-node scripts/patch_swz_legends_inn_bosses.ts [--verify]
 *
 * Re-runnable: every entry it owns is replaced rather than appended.
 */
import * as fs from "fs";
import * as path from "path";
import { ensureBackup, parseSwz, SwzPatchError, writeSwz } from "./swzPatchUtils";
import {
  LEGENDS_INN_BOSSES,
  LEGENDS_INN_BOSS_MELEE_POWER,
  LEGENDS_INN_BOSS_POWERS,
  bossEntName,
  getBossHitPoints,
} from "./legendsInnBosses";

const CLIENT_CONTENT = path.resolve(__dirname, "..", "..", "client", "content");
const SERVER_DATA = path.resolve(__dirname, "..", "data");

const ENT_SWZ_PATHS = [
  path.join(CLIENT_CONTENT, "localhost", "p", "cbp", "Login.swz"),
  path.join(CLIENT_CONTENT, "localhost", "p", "cbq", "Login.swz"),
];

/** Every EntType name this script owns, base and Dread. */
function ownedNames(): string[] {
  return LEGENDS_INN_BOSSES.flatMap((boss) => [bossEntName(boss), `${bossEntName(boss)}Hard`]);
}

/**
 * One guardian's fields, as a flat record.
 *
 * `hard` picks which half is being written: the base EntType inherits the base
 * body and the Dread one the Dread body, and nothing else differs between them.
 * Level and Realm are deliberately *not* set - they are inherited, and the level
 * is what `mBonusLevels` lifts onto row 50.
 */
function bossFields(index: number, hard: boolean): Record<string, string> {
  const boss = LEGENDS_INN_BOSSES[index];
  const body = hard ? boss.body : boss.body.replace(/Hard$/, "");
  return {
    EntName: hard ? `${bossEntName(boss)}Hard` : bossEntName(boss),
    parent: body,
    DisplayName: boss.displayName,
    DevStatus: "LegendsInn",
    EntRank: "Boss",
    HitPoints: String(getBossHitPoints(boss.stage)),
    MeleePower: LEGENDS_INN_BOSS_MELEE_POWER,
    Powers: LEGENDS_INN_BOSS_POWERS,
  };
}

function buildEntXml(newline: string): string {
  const blocks: string[] = [];
  LEGENDS_INN_BOSSES.forEach((_boss, index) => {
    for (const hard of [false, true]) {
      const fields = bossFields(index, hard);
      const { EntName, parent, ...rest } = fields;
      blocks.push(
        [
          `\t<EntType EntName="${EntName}" parent="${parent}">`,
          ...Object.entries(rest).map(([key, value]) => `\t\t<${key}>${value}</${key}>`),
          `\t</EntType>`,
        ].join(newline),
      );
    }
  });
  return blocks.join(newline);
}

/** Replaces the EntType entries this script owns. */
export function patchEntTypesXml(xml: string): { xml: string; changed: boolean } {
  const newline = xml.includes("\r\n") ? "\r\n" : "\n";
  let stripped = xml;
  for (const name of ownedNames()) {
    stripped = stripped.replace(
      new RegExp(`[ \\t]*<EntType EntName="${name}"[ >][\\s\\S]*?</EntType>\\r?\\n?`),
      "",
    );
  }

  const closing = stripped.lastIndexOf("</EntTypes>");
  if (closing === -1) throw new SwzPatchError("EntTypes chunk has no closing tag");
  const patched = stripped.slice(0, closing) + buildEntXml(newline) + newline + stripped.slice(closing);
  return { xml: patched, changed: patched !== xml };
}

function patchSwzChunk(swzPath: string, verifyOnly: boolean): boolean {
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

/**
 * The server's own copy.
 *
 * It matters more here than it does for most EntType patches: the SWF build reads
 * this file to work out what a cue is, and `GameData` reads it for the boss ranks
 * the reward tables are keyed on.
 */
function patchServerJson(verifyOnly: boolean): boolean {
  const filePath = path.join(SERVER_DATA, "EntTypes.json");
  const raw = fs.readFileSync(filePath, "utf8");
  const bom = raw.startsWith("﻿") ? "﻿" : "";
  const parsed = JSON.parse(raw.replace(/^﻿/, "")) as {
    EntTypes: { EntType: Array<Record<string, string>> };
  };

  let changed = false;
  LEGENDS_INN_BOSSES.forEach((_boss, index) => {
    for (const hard of [false, true]) {
      const entry = bossFields(index, hard);
      const at = parsed.EntTypes.EntType.findIndex((ent) => String(ent.EntName ?? "") === entry.EntName);
      if (at === -1) {
        parsed.EntTypes.EntType.push(entry);
        changed = true;
      } else if (JSON.stringify(parsed.EntTypes.EntType[at]) !== JSON.stringify(entry)) {
        parsed.EntTypes.EntType[at] = entry;
        changed = true;
      }
    }
  });

  if (!verifyOnly && changed) {
    const text = `${bom}${JSON.stringify(parsed, null, 2)}\n`;
    fs.writeFileSync(filePath, raw.includes("\r\n") ? text.replace(/\r?\n/g, "\r\n") : text);
  }
  return changed;
}

/** Every body this table names has to exist, and has to be one a boss can be. */
function assertBodiesExist(): void {
  const parsed = JSON.parse(
    fs.readFileSync(path.join(SERVER_DATA, "EntTypes.json"), "utf8").replace(/^﻿/, ""),
  ) as { EntTypes: { EntType: Array<Record<string, string>> } };
  const byName = new Map(parsed.EntTypes.EntType.map((ent) => [String(ent.EntName ?? ""), ent]));

  const inherited = (name: string, field: string): string => {
    let current = byName.get(name);
    for (let depth = 0; current && depth < 12; depth += 1) {
      if (current[field] !== undefined) return String(current[field]);
      current = byName.get(String(current.parent ?? ""));
    }
    return "";
  };

  for (const boss of LEGENDS_INN_BOSSES) {
    for (const body of [boss.body, boss.body.replace(/Hard$/, "")]) {
      if (!byName.has(body)) throw new SwzPatchError(`${bossEntName(boss)}: no EntType ${body} to wear`);
    }
    // A guardian that stands back up never finishes dying, and the exit portal
    // waits for the body to be removed - see core/LegendsInn.ts.
    const behavior = inherited(boss.body, "Behavior");
    if (behavior && behavior !== "Basic") {
      throw new SwzPatchError(`${bossEntName(boss)}: ${boss.body} has Behavior ${behavior}, which never stays dead`);
    }
  }

  const names = new Set(LEGENDS_INN_BOSSES.map((boss) => boss.displayName));
  if (names.size !== LEGENDS_INN_BOSSES.length) {
    throw new SwzPatchError("two guardians share a name; each health bar has to read differently");
  }
}

function main(): void {
  const verifyOnly = process.argv.includes("--verify");
  assertBodiesExist();

  for (const swzPath of ENT_SWZ_PATHS) {
    const changed = patchSwzChunk(swzPath, verifyOnly);
    console.log(
      `${path.basename(path.dirname(swzPath))}/${path.basename(swzPath)} EntTypes: ${changed ? "written" : "already current"}`,
    );
  }
  console.log(`content/xml/EntTypes.xml: ${patchLooseXml(verifyOnly) ? "written" : "already current"}`);
  console.log(`data/EntTypes.json: ${patchServerJson(verifyOnly) ? "written" : "already current"}`);
  console.log(
    `${LEGENDS_INN_BOSSES.length} guardians, ${getBossHitPoints(1)}x -> ${getBossHitPoints(9)}x health, powers: ${LEGENDS_INN_BOSS_POWERS}`,
  );
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
