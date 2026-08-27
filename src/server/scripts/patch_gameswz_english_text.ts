import * as fs from "fs";
import * as path from "path";
import { ensureBackup, parseSwz, writeSwz } from "./swzPatchUtils";

/**
 * The English build was serving Turkish through most of its data.
 *
 * When the three locale archives collapsed to one, the chunk that survived per resource was
 * whichever the consolidation happened to keep -- and for most resources that was the
 * Turkish one. Missions, dyes, levels, mounts, materials, buildings and monster powers all
 * read Turkish in the served archive.
 *
 * Restoring Game.en.swz wholesale is the obvious move and it is wrong. That archive is
 * older than restore_english_power_texts, so its PlayerPowerTypes and PowerModTypes are
 * *Turkish* while the served archive's are English -- swapping the file in would regress
 * every power name and description, and take the balance work in those chunks with it.
 * Neither archive is English everywhere; English has to be taken per resource from
 * whichever one actually has it.
 *
 * So this restores text fields chunk by chunk, from the English archive, only for the
 * resources listed below. PlayerPowerTypes, PowerModTypes and PlayerBuffTypes are
 * deliberately absent: the served archive is already the English one there.
 *
 * Only text is touched -- names, descriptions, mission prose. Numbers, ids and references
 * are never read from the old archive, so nothing this does can undo a balance change.
 *
 * Idempotent by construction: the target converges on a fixed source file, so a second run
 * finds nothing to do.
 */

type PatchStats = {
  blocks: number;
  changes: number;
};

const EMPTY_STATS: PatchStats = { blocks: 0, changes: 0 };

const XML_DIR = path.resolve(__dirname, "..", "..", "client", "content", "xml");
const CBQ_DIR = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p", "cbq");
const ENGLISH_SOURCE = path.join(CBQ_DIR, "Game.en.swz.bak");

/** Player-visible prose. Anything not listed here is left exactly as it is. */
const TEXT_TAGS = [
  "DisplayName",
  "Description",
  "UpgradeDescription",
  "TrackerText",
  "TrackerReturn",
  "OfferText",
  "ActiveText",
  "ReturnText",
  "BonusInfo",
  "FlavorText",
  "LockedMessage",
  "PreReqText",
  "PraiseText",
  "ProgressText",
];

type ChunkSpec = {
  /** Root element, used to find the chunk in either archive. */
  root: string;
  /** Element that wraps one entry. */
  block: string;
  /** Attribute holding the entry's identity, when it has one. */
  keyAttr?: string;
  /** Child tag holding the entry's identity, for the chunks with no attribute. */
  keyTag?: string;
};

const CHUNKS: ChunkSpec[] = [
  { root: "BuildingTypes", block: "Building", keyTag: "DisplayName" },
  { root: "ConsumableTypes", block: "ConsumableType", keyAttr: "ConsumableName" },
  { root: "DyeTypes", block: "DyeType", keyTag: "DyeName" },
  { root: "EggTypes", block: "EggType", keyAttr: "EggName" },
  { root: "LevelTypes", block: "LevelType", keyAttr: "LevelName" },
  { root: "LockboxTypes", block: "LockboxType", keyAttr: "LockboxName" },
  { root: "MagicTypes", block: "MagicType", keyAttr: "MagicName" },
  { root: "MaterialTypes", block: "MaterialType", keyAttr: "MaterialName" },
  { root: "MissionGroups", block: "MissionGroup", keyAttr: "GroupName" },
  { root: "MissionTypes", block: "MissionType", keyTag: "MissionName" },
  { root: "MonsterPowerTypes", block: "Power", keyAttr: "PowerName" },
  { root: "MountTypes", block: "MountType", keyAttr: "MountName" },
  { root: "RoyalStoreTypes", block: "RoyalStoreType", keyAttr: "RoyalStoreName" },
  { root: "StatueTypes", block: "Statue", keyAttr: "StatueName" },
  // CharmTypes and PetTypes are deliberately absent. patch_gameswz_charm_text already owns
  // their English text -- pet names from the archive, charm descriptions generated from
  // each charm's own stats so the crit correction survives. Restoring them here as well
  // made the two patches overwrite each other every prebuild instead of settling.
];

function cloneStats(): PatchStats {
  return { ...EMPTY_STATS };
}

function mergeStats(...stats: PatchStats[]): PatchStats {
  return stats.reduce(
    (merged, item) => ({ blocks: merged.blocks + item.blocks, changes: merged.changes + item.changes }),
    cloneStats(),
  );
}

function blockPattern(spec: ChunkSpec): RegExp {
  return spec.keyAttr
    ? new RegExp(`<${spec.block} ${spec.keyAttr}="([^"]*)"[^>]*>[\\s\\S]*?<\\/${spec.block}>`, "g")
    : new RegExp(`<${spec.block}>[\\s\\S]*?<\\/${spec.block}>`, "g");
}

function keyOf(spec: ChunkSpec, block: string, attrKey: string | undefined): string {
  if (spec.keyAttr) {
    return attrKey ?? "";
  }
  return block.match(new RegExp(`<${spec.keyTag}>([^<]*)<\\/${spec.keyTag}>`))?.[1]?.trim() ?? "";
}

function indexEnglish(spec: ChunkSpec, xml: string): Map<string, Record<string, string>> {
  const index = new Map<string, Record<string, string>>();
  for (const match of xml.matchAll(blockPattern(spec))) {
    const block = match[0];
    const key = keyOf(spec, block, match[1]);
    if (!key) {
      continue;
    }

    // MissionGroups repeats a key across several blocks and only the first carries the
    // text, so later blocks must not overwrite what the first one contributed -- indexing
    // last-wins left those groups with an empty string and nothing to restore from.
    const fields: Record<string, string> = index.get(key) ?? {};
    for (const tag of TEXT_TAGS) {
      const value = block.match(new RegExp(`<${tag}>([^<]*)<\\/${tag}>`))?.[1];
      if (value !== undefined && !fields[tag]) {
        fields[tag] = value;
      }
    }
    index.set(key, fields);
  }

  return index;
}

export function restoreEnglishText(spec: ChunkSpec, targetXml: string, englishXml: string): { xml: string; stats: PatchStats } {
  const stats = cloneStats();
  const english = indexEnglish(spec, englishXml);

  const patched = targetXml.replace(blockPattern(spec), (block: string, attrKey?: string) => {
    const key = keyOf(spec, block, attrKey);
    const fields = key ? english.get(key) : undefined;
    if (!fields) {
      return block;
    }

    stats.blocks += 1;
    let next = block;
    for (const [tag, value] of Object.entries(fields)) {
      const pattern = new RegExp(`<${tag}>[^<]*<\\/${tag}>`);
      if (!pattern.test(next)) {
        // Never introduce a field the served archive does not author.
        continue;
      }
      const expected = `<${tag}>${value}</${tag}>`;
      next = next.replace(pattern, (match: string) => {
        if (match === expected) {
          return match;
        }
        stats.changes += 1;
        return expected;
      });
    }
    return next;
  });

  return { xml: patched, stats };
}

function loadEnglishChunks(): Map<string, string> {
  const chunks = new Map<string, string>();
  for (const chunk of parseSwz(ENGLISH_SOURCE).chunks) {
    const root = chunk.xml.match(/<([A-Za-z]+)[ >]/)?.[1];
    if (root) {
      chunks.set(root, chunk.xml);
    }
  }
  return chunks;
}

function patchSwz(swzPath: string, english: Map<string, string>, verifyOnly: boolean): PatchStats {
  const ctx = parseSwz(swzPath);
  const collected: PatchStats[] = [];
  let changed = false;

  for (const spec of CHUNKS) {
    const englishXml = english.get(spec.root);
    const chunk = ctx.chunks.find((entry) => entry.xml.includes(`<${spec.root}`));
    if (!englishXml || !chunk) {
      continue;
    }

    const patched = restoreEnglishText(spec, chunk.xml, englishXml);
    collected.push(patched.stats);
    if (patched.xml !== chunk.xml) {
      changed = true;
      if (!verifyOnly) {
        chunk.xml = patched.xml;
      }
    }
  }

  // Patch child <Building> elements without BuildingName (rank variants)
  const buildingEnglish = english.get("BuildingTypes");
  const buildingChunk = ctx.chunks.find((entry) => entry.xml.includes("<BuildingTypes"));
  if (buildingEnglish && buildingChunk) {
    const childResult = patchChildBuildings(buildingChunk.xml, buildingEnglish, verifyOnly);
    collected.push(childResult.stats);
    if (childResult.xml !== buildingChunk.xml) {
      changed = true;
      if (!verifyOnly) {
        buildingChunk.xml = childResult.xml;
      }
    }
  }

  if (!verifyOnly && changed) {
    ensureBackup(swzPath);
    writeSwz(ctx);
  }

  return mergeStats(...collected);
}

/**
 * Patch child <Building> elements that lack a BuildingName attribute.
 *
 * The BuildingTypes chunk has parent entries keyed by BuildingName and child entries
 * (rank variants) that carry no key. restoreEnglishText can only match the parents.
 * This function groups children under each parent, pairs them with the English archive's
 * children by ordinal position, and replaces text fields.
 */
function patchChildBuildings(
  targetXml: string,
  englishXml: string,
  verifyOnly: boolean,
): { xml: string; stats: PatchStats } {
  const stats = cloneStats();

  const BLOCK_RE = /<Building(?:\s+BuildingName="([^"]*)")?>[\s\S]*?<\/Building>/g;

  function groupByParent(xml: string): Map<string, string[]> {
    const groups = new Map<string, string[]>();
    let currentParent = "---Template---";
    let m: RegExpExecArray | null;
    BLOCK_RE.lastIndex = 0;
    while ((m = BLOCK_RE.exec(xml)) !== null) {
      if (m[1]) {
        currentParent = m[1];
      } else {
        // child without BuildingName
        if (!groups.has(currentParent)) {
          groups.set(currentParent, []);
        }
        groups.get(currentParent)!.push(m[0]);
      }
    }
    return groups;
  }

  const trGroups = groupByParent(targetXml);
  const enGroups = groupByParent(englishXml);

  let changed = false;
  for (const [parent, trChildren] of trGroups) {
    const enChildren = enGroups.get(parent);
    if (!enChildren) {
      continue;
    }
    for (let i = 0; i < trChildren.length && i < enChildren.length; i++) {
      const trBlock = trChildren[i];
      const enBlock = enChildren[i];
      stats.blocks += 1;
      let next = trBlock;
      for (const tag of TEXT_TAGS) {
        const trVal = next.match(new RegExp(`<${tag}>([^<]*)<\/${tag}>`))?.[1];
        const enVal = enBlock.match(new RegExp(`<${tag}>([^<]*)<\/${tag}>`))?.[1];
        if (trVal !== undefined && enVal !== undefined && trVal !== enVal) {
          const pattern = new RegExp(`<${tag}>[^<]*<\/${tag}>`);
          next = next.replace(pattern, `<${tag}>${enVal}</${tag}>`);
          stats.changes += 1;
          changed = true;
        }
      }
      if (next !== trBlock) {
        targetXml = targetXml.replace(trBlock, next);
      }
    }
  }

  if (!verifyOnly && changed) {
    // Return the full xml with replacements applied
    return { xml: targetXml, stats };
  }
  return { xml: targetXml, stats };
}

/** The loose XML alongside the archive, where a resource has one. */
function patchXmlFiles(english: Map<string, string>, verifyOnly: boolean): PatchStats {
  const collected: PatchStats[] = [];
  for (const spec of CHUNKS) {
    const englishXml = english.get(spec.root);
    const filePath = path.join(XML_DIR, `${spec.root}.xml`);
    if (!englishXml || !fs.existsSync(filePath)) {
      continue;
    }

    const original = fs.readFileSync(filePath, "utf8");
    const patched = restoreEnglishText(spec, original, englishXml);
    collected.push(patched.stats);
    if (!verifyOnly && patched.xml !== original) {
      fs.writeFileSync(filePath, patched.xml, "utf8");
    }
  }

  return mergeStats(...collected);
}

export function patchConfiguredEnglishText(verifyOnly: boolean): PatchStats {
  if (!fs.existsSync(ENGLISH_SOURCE)) {
    console.warn(`[patch_gameswz_english_text] ${ENGLISH_SOURCE} is missing; nothing to restore from.`);
    return cloneStats();
  }

  const english = loadEnglishChunks();
  const swzPaths = ["Game.swz", "Game.en.swz", "Game.tr.swz"]
    .map((fileName) => path.join(CBQ_DIR, fileName))
    .filter(fs.existsSync);

  return mergeStats(
    patchXmlFiles(english, verifyOnly),
    ...swzPaths.map((swzPath) => patchSwz(swzPath, english, verifyOnly)),
  );
}

function main(): number {
  const verifyOnly = process.argv.includes("--verify") || process.argv.includes("--dry-run");
  try {
    const stats = patchConfiguredEnglishText(verifyOnly);
    console.log(JSON.stringify({ verifyOnly, stats }, null, 2));
    console.log(stats.changes === 0 ? "No changes needed." : verifyOnly ? "Patch required." : "Patch apply complete.");
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[patch_gameswz_english_text] ${message}`);
    return 1;
  }
}

if (require.main === module) {
  process.exit(main());
}
