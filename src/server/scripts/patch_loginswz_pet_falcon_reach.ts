import * as fs from "fs";
import * as path from "path";
import { ensureBackup, parseSwz, writeSwz } from "./swzPatchUtils";

/**
 * The Hunting Falcon can reach things above and below it.
 *
 * Its swoop is a Cleave, and Cleave does not use the power's own AoERadius for the vertical
 * axis at all -- CombatState.method_1322 gathers with the *caster's* own body height as the
 * half-extent:
 *
 *   GatherEntities(self, x, y, range, self.entType.height * 0.5, ENEMY | MELEEABLE)
 *
 * Every pet EntType authors Height 50 against a Base of 160, so the falcon swept a band 25
 * pixels above and below itself and sailed straight past anything on a different step,
 * ledge or slope. Nothing on PetFalcon itself could have fixed that: the power authors no
 * AoERadius, and adding one would not have mattered, because that branch never reads it.
 *
 * The existing reach tuning already raised the authored height from 50 to 160. Height 320
 * doubles that shipped vertical gather half-extent from 80 to 160 pixels.
 * Only the four PetFalcon EntTypes move -- the other pets keep their 50, since none of them
 * uses a Cleave.
 *
 * EntTypes ships in Login.swz rather than Game.swz, which is why this is its own script: the
 * pet ability tuning next door only ever opens Game.swz and would silently never see it.
 * Both the cbq and cbp copies are written where present, since cbq is what is actually
 * served and cbp is the one the older patch scripts default to.
 */

type PatchStats = {
  entBlocks: number;
  changes: number;
};

const EMPTY_STATS: PatchStats = { entBlocks: 0, changes: 0 };

const XML_DIR = path.resolve(__dirname, "..", "..", "client", "content", "xml");
const CONTENT_DIR = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p");
const ENT_XML = path.join(XML_DIR, "EntTypes.xml");

// Double the currently tuned 160. The original authored value before reach tuning was 50.
const FALCON_HEIGHT = "320"; // 160 tuned, 50 authored
const FALCON_ENTS = ["PetFalconRed", "PetFalconYellow", "PetFalconBlue", "PetFalconGreen"];

function cloneStats(): PatchStats {
  return { ...EMPTY_STATS };
}

function mergeStats(...stats: PatchStats[]): PatchStats {
  return stats.reduce(
    (merged, item) => ({ entBlocks: merged.entBlocks + item.entBlocks, changes: merged.changes + item.changes }),
    cloneStats(),
  );
}

export function patchEntTypes(xml: string): { xml: string; stats: PatchStats } {
  const stats = cloneStats();
  const patched = xml.replace(
    /<EntType EntName="([^"]+)"[^>]*>[\s\S]*?<\/EntType>/g,
    (block: string, entName: string) => {
      if (!FALCON_ENTS.includes(entName)) {
        return block;
      }

      const pattern = /<Height>[^<]*<\/Height>/;
      if (!pattern.test(block)) {
        // Never invent the tag: an EntType without a Height is not one of these four, and
        // guessing would change how the entity is placed rather than how far it reaches.
        return block;
      }

      stats.entBlocks += 1;
      const expected = `<Height>${FALCON_HEIGHT}</Height>`;
      return block.replace(pattern, (match) => {
        if (match === expected) {
          return match;
        }
        stats.changes += 1;
        return expected;
      });
    },
  );

  return { xml: patched, stats };
}

function patchFile(filePath: string, verifyOnly: boolean): PatchStats {
  const original = fs.readFileSync(filePath, "utf8");
  const patched = patchEntTypes(original);
  if (!verifyOnly && patched.xml !== original) {
    fs.writeFileSync(filePath, patched.xml, "utf8");
  }
  return patched.stats;
}

function patchSwz(swzPath: string, verifyOnly: boolean): PatchStats {
  const ctx = parseSwz(swzPath);
  const chunk = ctx.chunks.find((entry) => entry.xml.includes("<EntTypes"));
  if (!chunk) {
    return cloneStats();
  }

  const patched = patchEntTypes(chunk.xml);
  if (patched.xml !== chunk.xml && !verifyOnly) {
    chunk.xml = patched.xml;
    ensureBackup(swzPath);
    writeSwz(ctx);
  }
  return patched.stats;
}

export function patchConfiguredFalconReach(verifyOnly: boolean): PatchStats {
  const swzPaths = ["cbq/Login.swz", "cbp/Login.swz"]
    .map((rel) => path.join(CONTENT_DIR, rel))
    .filter(fs.existsSync);

  return mergeStats(patchFile(ENT_XML, verifyOnly), ...swzPaths.map((swzPath) => patchSwz(swzPath, verifyOnly)));
}

function main(): number {
  const verifyOnly = process.argv.includes("--verify") || process.argv.includes("--dry-run");
  try {
    const stats = patchConfiguredFalconReach(verifyOnly);
    console.log(JSON.stringify({ verifyOnly, stats }, null, 2));
    console.log(stats.changes === 0 ? "No changes needed." : verifyOnly ? "Patch required." : "Patch apply complete.");
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[patch_loginswz_pet_falcon_reach] ${message}`);
    return 1;
  }
}

if (require.main === module) {
  process.exit(main());
}
