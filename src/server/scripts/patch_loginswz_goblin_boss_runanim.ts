import * as path from "path";
import { defaultLoginSwzPath, ensureBackup, parseSwz, SwzPatchError, writeSwz } from "./swzPatchUtils";

const RUN_ANIM_TAG = "\t\t\t<RunAnim>Run</RunAnim>\r\n";
const MOVE_SPEED_TAG = "\t\t\t<MoveAnimSpeed>0.75</MoveAnimSpeed>\r\n";
const TARGETS = ["GoblinBoss2", "GoblinBoss2Hard"];

function resolveSwzPath(args: string[]): string {
  const idx = args.indexOf("--swz-path");
  if (idx !== -1 && idx + 1 < args.length) {
    return path.resolve(args[idx + 1]);
  }
  return defaultLoginSwzPath();
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function patchEntTypeBlock(xml: string, entName: string): { xml: string; changed: boolean } {
  const startToken = `<EntType EntName="${entName}"`;
  const start = xml.indexOf(startToken);
  if (start === -1) {
    throw new SwzPatchError(`${entName} block not found`);
  }
  const end = xml.indexOf("</EntType>", start);
  if (end === -1) {
    throw new SwzPatchError(`${entName} closing tag not found`);
  }

  const blockEnd = end + "</EntType>".length;
  const block = xml.slice(start, blockEnd);
  const gfxStart = block.indexOf("<GfxType>");
  const gfxEnd = block.indexOf("</GfxType>");
  if (gfxStart === -1 || gfxEnd === -1) {
    throw new SwzPatchError(`${entName} GfxType block not found`);
  }

  const gfxClose = gfxEnd + "</GfxType>".length;
  const gfxBlock = block.slice(gfxStart, gfxClose);
  if (gfxBlock.includes("<RunAnim>Run</RunAnim>")) {
    return { xml, changed: false };
  }
  if (gfxBlock.includes("<RunAnim>Charge</RunAnim>")) {
    const updatedBlock = gfxBlock.replace("<RunAnim>Charge</RunAnim>", "<RunAnim>Run</RunAnim>");
    return {
      xml: `${xml.slice(0, start + gfxStart)}${updatedBlock}${xml.slice(start + gfxClose)}`,
      changed: true,
    };
  }
  if (gfxBlock.includes("<RunAnim>")) {
    throw new SwzPatchError(`${entName} already has a non-Run RunAnim override`);
  }

  const moveSpeedIndex = gfxBlock.indexOf(MOVE_SPEED_TAG);
  if (moveSpeedIndex === -1) {
    throw new SwzPatchError(`${entName} MoveAnimSpeed tag not found`);
  }

  const insertAt = start + gfxStart + moveSpeedIndex + MOVE_SPEED_TAG.length;
  const updatedXml = `${xml.slice(0, insertAt)}${RUN_ANIM_TAG}${xml.slice(insertAt)}`;
  return { xml: updatedXml, changed: true };
}

function main(): number {
  const args = process.argv.slice(2);
  const swzPath = resolveSwzPath(args);
  const verifyOnly = hasFlag(args, "--verify") || hasFlag(args, "--dry-run");

  try {
    const ctx = parseSwz(swzPath);
    const chunk = ctx.chunks.find((entry) => entry.xml.includes('<EntType EntName="GoblinBoss2"'));
    if (!chunk) {
      throw new SwzPatchError("EntTypes chunk not found in Login.swz");
    }

    let xml = chunk.xml;
    let changed = false;
    for (const entName of TARGETS) {
      const patched = patchEntTypeBlock(xml, entName);
      xml = patched.xml;
      changed = changed || patched.changed;
    }

    const status = TARGETS.map((entName) => `${entName}: ${xml.includes(`<EntType EntName="${entName}"`) && xml.includes(`<RunAnim>Run</RunAnim>`) ? "Run" : "missing"}`);
    console.log(`SWZ: ${swzPath}`);
    for (const line of status) {
      console.log(line);
    }

    if (!changed) {
      console.log("No changes needed.");
      return 0;
    }

    if (verifyOnly) {
      console.log("Patch required.");
      return 0;
    }

    ensureBackup(swzPath);
    chunk.xml = xml;
    writeSwz(ctx);
    console.log("Patch apply complete.");
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Patch error: ${message}`);
    return 1;
  }
}

process.exit(main());
