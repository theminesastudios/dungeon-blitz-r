#!/usr/bin/env node

import * as path from "path";
import { ensureBackup, parseSwz, SwzPatchError, writeSwz } from "./swzPatchUtils";

/**
 * Hangs the Charon's Blades blood drip off the SeekingBlades buff.
 *
 * patch-sfx1-charon-blood-drip builds the looping animation into SFX_1.swf. This
 * is the whole of the wiring: the SeekingBlades buff ships with an empty
 * `<GfxType/>`, and filling it in makes the engine spawn and loop the animation
 * for exactly as long as the form is up. No client code, no timer, and no state
 * to latch -- the buff's own lifetime is the trigger, and Entity.method_391
 * already removes the buff when the form ends.
 *
 * BuffLoc Feet rather than anything nearer the blade: the engine's GFX anchors
 * are TargetCenter / Feet / TargetFeet / Ground / TargetHit / TargetPos / Center
 * / TargetHead / Socket, none of which is a weapon or a hand, and the blade tip
 * exists only inside the character's baked bitmap. Feet puts the sprite's origin
 * on the ground, which is what makes the drop land exactly on the floor; the
 * fall starts from a fixed height standing in for the blade.
 *
 * Mirrors the shape of the FireBrand buff, which is the client's own example of
 * a multi-frame looping buff animation (a_FireBrandBuff, 38 frames).
 */

const DEFAULT_SWZ = path.resolve(
  __dirname, "..", "..", "client", "content", "localhost", "p", "cbq", "Game.swz",
);

const BUFF_NAME = "SeekingBlades";
const ANIM_FILE = "SFX_1.swf";
/** Dead SFX_1 class rebuilt as the drip; keep in step with patch-sfx1-charon-blood-drip.js. */
const ANIM_CLASS = "a_Conflagration_old";
const ANIM_SCALE = "1";
const BUFF_LOC = "Feet";

const GFX_BLOCK =
  "\t\t<BuffLoc>" + BUFF_LOC + "</BuffLoc>\n" +
  "\t\t<GfxType>\n" +
  "\t\t\t<AnimScale>" + ANIM_SCALE + "</AnimScale>\n" +
  "\t\t\t<AnimFile>" + ANIM_FILE + "</AnimFile>\n" +
  "\t\t\t<AnimClass>" + ANIM_CLASS + "</AnimClass>\n" +
  "\t\t</GfxType>";

function parseArgs(argv: string[]): { swzPath: string; verify: boolean } {
  let swzPath = DEFAULT_SWZ;
  let verify = false;
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--swz" || arg === "-s") swzPath = path.resolve(argv[++i] || "");
    else if (arg === "--verify" || arg === "--dry-run") verify = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: ts-node patch_gameswz_charon_blood_drip.ts [--verify] [--swz <path>]\n" +
        "Attaches the blood drip animation to the SeekingBlades buff.",
      );
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return { swzPath, verify };
}

function main(): number {
  const { swzPath, verify } = parseArgs(process.argv);
  try {
    const ctx = parseSwz(swzPath);

    const chunk = ctx.chunks.find((c) => /<PlayerBuffTypes/.test(c.xml));
    if (!chunk) throw new SwzPatchError("No PlayerBuffTypes chunk in the swz");

    const buffRe = new RegExp(`(<BuffType BuffName="${BUFF_NAME}">)([\\s\\S]*?)(</BuffType>)`);
    const match = chunk.xml.match(buffRe);
    if (!match) throw new SwzPatchError(`BuffType ${BUFF_NAME} not found`);

    if (match[2].includes(ANIM_CLASS)) {
      console.log(`${swzPath}: already patched (${BUFF_NAME} carries the blood drip).`);
      return 0;
    }
    if (verify) {
      throw new SwzPatchError(`${swzPath}: verify failed; ${BUFF_NAME} has no drip GfxType.`);
    }

    // The stock entry ends with a self-closed <GfxType/> and has no BuffLoc.
    if (!/<GfxType\s*\/>/.test(match[2])) {
      throw new SwzPatchError(
        `${BUFF_NAME} already declares a GfxType body; refusing to overwrite it.`,
      );
    }
    if (/<BuffLoc>/.test(match[2])) {
      throw new SwzPatchError(`${BUFF_NAME} already declares a BuffLoc; refusing to overwrite it.`);
    }

    const body = match[2].replace(/\t*<GfxType\s*\/>/, GFX_BLOCK);
    chunk.xml = chunk.xml.replace(buffRe, `$1${body}$3`);

    ensureBackup(swzPath);
    writeSwz(ctx);
    console.log(
      `${swzPath}: ${BUFF_NAME} -> ${ANIM_FILE}/${ANIM_CLASS} at BuffLoc ${BUFF_LOC}.`,
    );
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

process.exit(main());
