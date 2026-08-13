/**
 * The summoning traps in the Legends' Inn stage-8 boss room.
 *
 * Shazari's boss room is built around four floating totems - `RageGuardianServant`,
 * `Behavior ServantSpawner` - standing in the `am_Adds` group. The room script
 * kills all four the moment the fight begins and revives one every twelve seconds,
 * and a revived totem calls a wave of small monsters while the boss shields itself.
 * They are the traps the fight is about.
 *
 * The bestiary swap used to replace them with ordinary Dread Rogues, which broke
 * the fight in the two ways it was reported: the traps were gone, and what the
 * player saw instead was four rogues lying dead on the floor from the first second,
 * standing back up one at a time. `PROP_BEHAVIORS` in legendsInnEnemies.ts now
 * leaves every spawner and trap alone, so the totems are totems again.
 *
 * That leaves what they *summon*. The shipped power calls `PuckShadowServant`, a
 * shadow puck - and Legends' Inn is a dungeon in which every hostile is a Dread
 * Rogue, Paladin or Mage. So this script mints a Legends' Inn servant that is the
 * Shazari one in every respect except the power it casts, and a power that calls a
 * Dread Rogue instead:
 *
 *   - `LegendsInnServant` / `LegendsInnServantHard` - `parent="RageGuardianServant"`,
 *     so the artwork, the flying, the brain and the sounds all come across
 *     untouched. Both names are needed: a Dread level asks the client for
 *     `<cue>Hard`, and the SWF can only name the base.
 *   - `LegendsInnServantSummon` - `ServantSpawnPuck` with `SpawnedMonsters` pointing
 *     at `BanditRogue`. The base name is deliberate: `CombatState` promotes a
 *     spawned monster to its `Hard` variant inside a Dread level and warns if that
 *     variant is missing, so naming the base is what gets the Dread rogue.
 *
 * The stage SWF renames its `ac_RageGuardianServant` cue onto the new EntType -
 * see build-legends-inn-stages.ts - which is why Shazari's own dungeon is
 * untouched by all of this.
 *
 * Usage: npm exec ts-node scripts/patch_swz_legends_inn_servant.ts [--verify]
 *
 * Re-runnable: every entry it owns is replaced rather than appended.
 */
import * as fs from "fs";
import * as path from "path";
import { ensureBackup, parseSwz, SwzPatchError, writeSwz } from "./swzPatchUtils";

const CLIENT_CONTENT = path.resolve(__dirname, "..", "..", "client", "content");
const SERVER_DATA = path.resolve(__dirname, "..", "data");

/** The cue the stage SWF names, without the `Hard` a Dread level appends. */
export const LEGENDS_INN_SERVANT_ENT = "LegendsInnServant";
export const LEGENDS_INN_SERVANT_POWER = "LegendsInnServantSummon";

/**
 * What the traps call.
 *
 * A base name, not a Dread one: `CombatState` appends `Hard` to a spawned monster
 * inside a Dread level when that EntType exists, so this is what puts a
 * `BanditRogueHard` on the sand.
 */
const SUMMONED_MONSTER = "BanditRogue";

/** Which of the shipped power's fields the Legends' Inn copy changes. */
const POWER_SOURCE = "ServantSpawnPuck";

const ENT_SWZ_PATHS = [
  path.join(CLIENT_CONTENT, "localhost", "p", "cbp", "Login.swz"),
  path.join(CLIENT_CONTENT, "localhost", "p", "cbq", "Login.swz"),
];
const POWER_SWZ_PATHS = [path.join(CLIENT_CONTENT, "localhost", "p", "cbq", "Game.swz")];

/**
 * The two EntTypes, as XML.
 *
 * Everything except the power is inherited. `RageGuardianServant` carries the
 * flying, the `ServantSpawner` brain, the health pool the room script's `Revive`
 * expects and the artwork, and none of that should differ here.
 */
function buildEntXml(newline: string): string {
  const entry = (name: string) =>
    [
      `\t<EntType EntName="${name}" parent="RageGuardianServant">`,
      `\t\t<DevStatus>LegendsInn</DevStatus>`,
      `\t\t<Powers>${LEGENDS_INN_SERVANT_POWER}</Powers>`,
      `\t</EntType>`,
    ].join(newline);
  return [entry(LEGENDS_INN_SERVANT_ENT), entry(`${LEGENDS_INN_SERVANT_ENT}Hard`)].join(newline);
}

/** Replaces the EntType entries this script owns. */
export function patchEntTypesXml(xml: string): { xml: string; changed: boolean } {
  const newline = xml.includes("\r\n") ? "\r\n" : "\n";
  let stripped = xml;
  for (const name of [LEGENDS_INN_SERVANT_ENT, `${LEGENDS_INN_SERVANT_ENT}Hard`]) {
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

/**
 * The power, copied from the shipped one so every timing, sound and effect is
 * identical and only the summoned monster differs.
 *
 * The id is taken from the end of the block rather than declared, because a
 * `PowerID` that collides with a shipped power silently replaces it.
 */
export function patchMonsterPowerTypesXml(xml: string): { xml: string; changed: boolean } {
  const newline = xml.includes("\r\n") ? "\r\n" : "\n";
  const stripped = xml.replace(
    new RegExp(`[ \\t]*<Power PowerName="${LEGENDS_INN_SERVANT_POWER}"[ >][\\s\\S]*?</Power>\\r?\\n?`),
    "",
  );

  const source = new RegExp(`[ \\t]*<Power PowerName="${POWER_SOURCE}"[ >][\\s\\S]*?</Power>`).exec(stripped);
  if (!source) throw new SwzPatchError(`MonsterPowerTypes has no ${POWER_SOURCE} to copy`);

  const ids = [...stripped.matchAll(/<PowerID>(\d+)<\/PowerID>/g)].map((match) => Number(match[1]));
  const nextId = Math.max(0, ...ids) + 1;

  const block = source[0]
    .replace(`PowerName="${POWER_SOURCE}"`, `PowerName="${LEGENDS_INN_SERVANT_POWER}"`)
    .replace(/<PowerID>\d+<\/PowerID>/, `<PowerID>${nextId}</PowerID>`)
    .replace(/<SpawnedMonsters>[^<]*<\/SpawnedMonsters>/, `<SpawnedMonsters>${SUMMONED_MONSTER}</SpawnedMonsters>`);

  const closing = stripped.lastIndexOf("</MonsterPowerTypes>");
  if (closing === -1) throw new SwzPatchError("MonsterPowerTypes chunk has no closing tag");
  const patched = stripped.slice(0, closing) + block + newline + stripped.slice(closing);
  return { xml: patched, changed: patched !== xml };
}

function patchSwzChunk(
  swzPath: string,
  marker: string,
  patch: (xml: string) => { xml: string; changed: boolean },
  verifyOnly: boolean,
): boolean {
  if (!fs.existsSync(swzPath)) return false;

  const ctx = parseSwz(swzPath);
  const chunk = ctx.chunks.find((entry) => entry.xml.includes(marker));
  if (!chunk) throw new SwzPatchError(`${path.basename(swzPath)} has no ${marker} chunk`);

  const patched = patch(chunk.xml);
  if (!verifyOnly && patched.changed) {
    ensureBackup(swzPath);
    chunk.xml = patched.xml;
    writeSwz(ctx);
  }
  return patched.changed;
}

function patchLooseXml(fileName: string, patch: (xml: string) => { xml: string; changed: boolean }, verifyOnly: boolean): boolean {
  const filePath = path.join(CLIENT_CONTENT, "xml", fileName);
  if (!fs.existsSync(filePath)) return false;
  const patched = patch(fs.readFileSync(filePath, "utf8"));
  if (!verifyOnly && patched.changed) fs.writeFileSync(filePath, patched.xml);
  return patched.changed;
}

/** The server's own copy, which GameData reads for behaviour and hit points. */
function patchServerJson(verifyOnly: boolean): boolean {
  const filePath = path.join(SERVER_DATA, "EntTypes.json");
  const raw = fs.readFileSync(filePath, "utf8");
  const bom = raw.startsWith("﻿") ? "﻿" : "";
  const parsed = JSON.parse(raw.replace(/^﻿/, "")) as {
    EntTypes: { EntType: Array<Record<string, string>> };
  };

  let changed = false;
  for (const name of [LEGENDS_INN_SERVANT_ENT, `${LEGENDS_INN_SERVANT_ENT}Hard`]) {
    const entry: Record<string, string> = {
      EntName: name,
      parent: "RageGuardianServant",
      DevStatus: "LegendsInn",
      Powers: LEGENDS_INN_SERVANT_POWER,
    };
    const index = parsed.EntTypes.EntType.findIndex((ent) => String(ent.EntName ?? "") === name);
    if (index === -1) {
      parsed.EntTypes.EntType.push(entry);
      changed = true;
    } else if (JSON.stringify(parsed.EntTypes.EntType[index]) !== JSON.stringify(entry)) {
      parsed.EntTypes.EntType[index] = entry;
      changed = true;
    }
  }

  if (!verifyOnly && changed) {
    const text = `${bom}${JSON.stringify(parsed, null, 2)}\n`;
    fs.writeFileSync(filePath, raw.includes("\r\n") ? text.replace(/\r?\n/g, "\r\n") : text);
  }
  return changed;
}

function main(): void {
  const verifyOnly = process.argv.includes("--verify");
  for (const swzPath of ENT_SWZ_PATHS) {
    const changed = patchSwzChunk(swzPath, "<EntTypes", patchEntTypesXml, verifyOnly);
    console.log(`${path.basename(path.dirname(swzPath))}/${path.basename(swzPath)} EntTypes: ${changed ? "written" : "already current"}`);
  }
  for (const swzPath of POWER_SWZ_PATHS) {
    const changed = patchSwzChunk(swzPath, "<MonsterPowerTypes", patchMonsterPowerTypesXml, verifyOnly);
    console.log(`${path.basename(path.dirname(swzPath))}/${path.basename(swzPath)} MonsterPowerTypes: ${changed ? "written" : "already current"}`);
  }
  console.log(`content/xml/EntTypes.xml: ${patchLooseXml("EntTypes.xml", patchEntTypesXml, verifyOnly) ? "written" : "already current"}`);
  console.log(`content/xml/MonsterPowerTypes.xml: ${patchLooseXml("MonsterPowerTypes.xml", patchMonsterPowerTypesXml, verifyOnly) ? "written" : "already current"}`);
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
