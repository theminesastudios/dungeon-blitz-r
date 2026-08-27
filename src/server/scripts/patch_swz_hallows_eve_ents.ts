/**
 * Mints and re-dresses the three EntTypes the Hallow's Eve event needs.
 *
 * The client already ships `NPCHalloweenWatcher`, `HalloweenCoffers` and
 * `HalloweenPortal` - they are in every copy of EntTypes and always have been -
 * but the event around them never was, and two of the three were left with
 * `a__EmptyAnimation`, i.e. no artwork at all. That is fine for an entry nothing
 * spawns and useless for one something does.
 *
 * The boss is deliberately *not* here. `GreenKnight` shipped with the game -
 * `DevStatus "Holiday Dungeon"`, Level 50, `KnightMelee` / `KnightFlames`, and a
 * whole paperdoll in `Gfx_Paladin_1.swf` down to `a_Hat_HatGhostGreenKnight` - so
 * there is nothing to mint. An earlier pass invented a `HallowsEveBoss` before that
 * turned up; `RETIRED_ENT` sweeps it back out of every copy.
 *
 * What this script owns:
 *
 *   - **`HalloweenCoffers`** - given the large treasure chest out of
 *     `Animation_Environmentals.swf`, recoloured to a lantern orange. It keeps
 *     `Behavior NPC` rather than becoming a `TreasureChest`: the coffers is
 *     talked to, not smashed, and a TreasureChest brain would let anyone in the
 *     square break it.
 *   - **`NPCHalloweenWatcher`** - artwork untouched (it is the only one of the
 *     three that shipped with real art: `Hood01` posed on `ReadyRobes2`), given a
 *     display name the square can show.
 *
 * Written to every copy the two sides read: the client's Login.swz chunks - the
 * live ones - the loose reference XML, and the server's EntTypes.json. The server
 * copy carries no `GfxType`, matching every other entry in that file.
 *
 * Usage: npm exec ts-node scripts/patch_swz_hallows_eve_ents.ts [--verify]
 *
 * Re-runnable: every entry it owns is replaced rather than appended.
 */
import * as fs from "fs";
import * as path from "path";
import { ensureBackup, parseSwz, SwzPatchError, writeSwz } from "./swzPatchUtils";

const CLIENT_CONTENT = path.resolve(__dirname, "..", "..", "client", "content");
const SERVER_DATA = path.resolve(__dirname, "..", "data");

/** Every packed copy of EntTypes the client might read. */
const SWZ_PATHS = [
  path.join(CLIENT_CONTENT, "localhost", "p", "cbp", "Login.swz"),
  path.join(CLIENT_CONTENT, "localhost", "p", "cbq", "Login.swz"),
];

export const HALLOWS_EVE_COFFERS_ENT = "HalloweenCoffers";
export const HALLOWS_EVE_WATCHER_ENT = "NPCHalloweenWatcher";

/**
 * EntTypes an earlier pass minted and no longer wants.
 *
 * `HallowsEveBoss` was a stand-in for a boss that turned out to already exist. It
 * has to be swept back out rather than merely stopped, or it lingers forever in
 * files nothing else rewrites.
 */
const RETIRED_ENT = /^HallowsEveBoss$/;

interface EntSpec {
  entName: string;
  parent: string;
  /** Server-relevant fields, in the order they are written. */
  fields: Array<[string, string]>;
  /** Client-only drawing fields. Omitted entirely when the entry keeps its shipped art. */
  gfx?: Array<[string, string]>;
}

const ENTS: EntSpec[] = [
  {
    entName: HALLOWS_EVE_COFFERS_ENT,
    parent: "Base",
    fields: [
      ["DisplayName", "Hallow's Eve Coffers"],
      ["DevStatus", "HallowsEve"],
      ["Level", "0"],
      ["ArmorClass", "1"],
      ["HitPoints", "0"],
      ["RewardClass", "NoLoot"],
      ["Realm", "Villager"],
      ["Speed", "0"],
      // Sized to the stonework rather than to a chest: the skull-grid ruin runs
      // room-local 600..942 and stands about 210px above the floor line, so this
      // box covers the lower half of the wall - the part a player walks up to.
      ["Width", "300"],
      ["Height", "160"],
      // Not TreasureChest: the coffers is talked to, not broken open.
      ["Behavior", "NPC"],
    ],
    /**
     * **No artwork at all - the ruin *is* the coffers.**
     *
     * `a__EmptyAnimation` is what this EntType shipped with, and it is back:
     * the reward point is the square's second ruin, so the entity only has to
     * carry the interaction, standing invisibly against the stonework it belongs
     * to. A chest parked in front of the wall was the thing that read as clutter.
     *
     * **This is the part to watch.** A click lands on an entity's *body*, and this
     * one no longer draws one - the hope is that the hit box comes from `Width`
     * and `Height` above rather than from the rendered art. If the ruin turns out
     * not to be clickable, the fallback is to give it a stone or skull `CustomArt`
     * that reads as part of the wall, which restores a real body without putting a
     * chest back in the square.
     */
    gfx: [
      ["AnimClass", "a__EmptyAnimation"],
      ["Shadow", "None"],
    ],
  },
  {
    entName: HALLOWS_EVE_WATCHER_ENT,
    parent: "Base",
    fields: [
      ["DisplayName", "The Hollow Watcher"],
      ["DevStatus", "HallowsEve"],
      ["Level", "0"],
      ["ArmorClass", "1"],
      ["HitPoints", "0"],
      ["Realm", "Villager"],
      ["Speed", "5"],
      ["Width", "80"],
      ["Height", "130"],
      ["Behavior", "NPC"],
    ],
    // The shipped robed hood, kept exactly as it was.
    gfx: [
      ["AnimFile", "Animation_NPC.swf"],
      ["FlipAnim", "TRUE"],
      ["BaseAnim", "ReadyRobes2"],
      ["AnimScale", ".8"],
      ["CustomArt", "Animation_NPC.swf/Hood01"],
    ],
  },
];

function buildEntXml(spec: EntSpec, newline: string): string {
  const lines = [
    `\t<EntType EntName="${spec.entName}" parent="${spec.parent}">`,
    ...spec.fields.map(([tag, value]) => `\t\t<${tag}>${value}</${tag}>`),
  ];
  if (spec.gfx) {
    lines.push("\t\t<EquippedGear/>", "\t\t<GfxType>");
    lines.push(...spec.gfx.map(([tag, value]) => `\t\t\t<${tag}>${value}</${tag}>`));
    lines.push("\t\t</GfxType>");
  }
  lines.push("\t</EntType>");
  return lines.join(newline);
}

/** Replaces every entry this script owns. */
export function patchEntTypesXml(xml: string): { xml: string; changed: boolean } {
  const newline = xml.includes("\r\n") ? "\r\n" : "\n";

  let stripped = xml;
  for (const spec of ENTS) {
    stripped = stripped.replace(
      new RegExp(`[ \\t]*<EntType EntName="${spec.entName}"[ >][\\s\\S]*?</EntType>\\r?\\n?`, "g"),
      "",
    );
  }
  stripped = stripped.replace(/[ \t]*<EntType EntName="([^"]*)"[ >][\s\S]*?<\/EntType>\r?\n?/g, (block, name) =>
    RETIRED_ENT.test(String(name)) ? "" : block,
  );

  const closing = stripped.lastIndexOf("</EntTypes>");
  if (closing === -1) throw new SwzPatchError("EntTypes chunk has no closing tag");

  const block = ENTS.map((spec) => buildEntXml(spec, newline)).join(newline) + newline;
  const patched = stripped.slice(0, closing) + block + stripped.slice(closing);
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
  const before = parsed.EntTypes.EntType.length;
  parsed.EntTypes.EntType = parsed.EntTypes.EntType.filter((ent) => !RETIRED_ENT.test(String(ent.EntName ?? "")));
  const list = parsed.EntTypes.EntType;

  let changed = list.length !== before;
  for (const spec of ENTS) {
    const entry: Record<string, string> = {
      EntName: spec.entName,
      parent: spec.parent,
      ...Object.fromEntries(spec.fields),
    };
    const index = list.findIndex((ent) => String(ent.EntName ?? "") === spec.entName);
    if (index === -1) {
      list.push(entry);
      changed = true;
    } else if (JSON.stringify(list[index]) !== JSON.stringify(entry)) {
      list[index] = entry;
      changed = true;
    }
  }

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
    console.log(
      `${path.basename(path.dirname(swzPath))}/${path.basename(swzPath)}: ${changed ? "written" : "already current"}`,
    );
  }
  console.log(`content/xml/EntTypes.xml: ${patchLooseXml(verifyOnly) ? "written" : "already current"}`);
  console.log(`data/EntTypes.json: ${patchServerJson(verifyOnly) ? "written" : "already current"}`);
  console.log(`entries: ${ENTS.map((spec) => spec.entName).join(", ")}`);
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
