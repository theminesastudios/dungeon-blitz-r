import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import {
  applyPatchesToBody,
  BytePatch,
  disassemble,
  ensureBackup,
  Instruction,
  parseAbc,
  parseSwf,
  PatchError,
  writeSwf,
  writeU30,
} from "./swfPatchUtils";

const DEFAULT_SWF = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p", "cbp", "DungeonBlitz.swf");
const INDEX_HTML = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "index.html");

function parseArgs(argv: string[]): { swfPath: string; verify: boolean } {
  let swfPath = DEFAULT_SWF;
  let verify = false;
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--swf" || arg === "-s") swfPath = path.resolve(argv[++index] || "");
    else if (arg === "--verify" || arg === "--dry-run") verify = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return { swfPath, verify };
}

function stringValue(abc: ReturnType<typeof parseAbc>, inst: Instruction): string | null {
  const operand = inst.operands[0];
  return inst.opcode === 0x2c && operand?.[0] === "u30" ? abc.stringValues[operand[1]] ?? null : null;
}

function doubleValue(abc: ReturnType<typeof parseAbc>, inst: Instruction): number | null {
  const operand = inst.operands[0];
  return inst.opcode === 0x2f && operand?.[0] === "u30" ? abc.doubleValues[operand[1]] ?? null : null;
}

function requiredDouble(abc: ReturnType<typeof parseAbc>, value: number): number {
  const index = abc.doubleValues.indexOf(value);
  if (index < 0) throw new PatchError(`Double constant ${value} not found.`);
  return index;
}

function buildPatches(swfPath: string): { ctx: ReturnType<typeof parseSwf>; patches: BytePatch[]; state: string } {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);
  const desiredStorm = requiredDouble(abc, 0.8);
  const desiredHeart = requiredDouble(abc, 0.4);

  for (const body of abc.methodBodies.values()) {
    const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
    let instructions: Instruction[];
    try {
      instructions = disassemble(code, "Black Miasma conditional damage");
    } catch {
      continue;
    }

    for (let index = 0; index < instructions.length - 4; index += 1) {
      const stormName = instructions[index];
      const condition = instructions[index + 1];
      const stormBonus = instructions[index + 2];
      const jump = instructions[index + 3];
      const heartBonus = instructions[index + 4];
      if (
        stringValue(abc, stormName) !== "BlackStorm" ||
        condition.opcode !== 0x14 ||
        stormBonus.opcode !== 0x2f ||
        jump.opcode !== 0x10 ||
        heartBonus.opcode !== 0x2f
      ) continue;

      const currentStorm = doubleValue(abc, stormBonus);
      const currentHeart = doubleValue(abc, heartBonus);
      if (currentStorm === 0.8 && currentHeart === 0.4) return { ctx, patches: [], state: "desired" };
      if (currentStorm !== 1.6 || currentHeart !== 0.8) {
        throw new PatchError(`Unexpected Black Miasma bonuses: Black Storm ${currentStorm}, Heart Seeker ${currentHeart}.`);
      }

      const patches: BytePatch[] = [
        {
          key: "CombatState.blackMiasma.blackStormBonus",
          start: body.codeStart + stormBonus.offset,
          end: body.codeStart + stormBonus.offset + stormBonus.size,
          data: Buffer.concat([Buffer.from([0x2f]), writeU30(desiredStorm)]),
          detail: "reduce Black Storm Black Miasma bonus from 160% to 80%",
        },
        {
          key: "CombatState.blackMiasma.heartSeekerBonus",
          start: body.codeStart + heartBonus.offset,
          end: body.codeStart + heartBonus.offset + heartBonus.size,
          data: Buffer.concat([Buffer.from([0x2f]), writeU30(desiredHeart)]),
          detail: "reduce Heart Seeker Black Miasma bonus from 80% to 40%",
        },
      ];
      if (patches.some((patch) => patch.data.length !== patch.end - patch.start)) {
        throw new PatchError("Black Miasma bonus patch must remain byte-for-byte length stable.");
      }
      return { ctx, patches, state: "legacy" };
    }
  }
  throw new PatchError("Black Miasma conditional damage sequence not found.");
}

function syncClientRevision(swfPath: string, verifyOnly: boolean): void {
  if (path.resolve(swfPath) !== path.resolve(DEFAULT_SWF)) return;
  const digest = crypto.createHash("sha256").update(fs.readFileSync(swfPath)).digest("hex").slice(0, 12);
  const expected = `clientrev=swf-${digest}`;
  const html = fs.readFileSync(INDEX_HTML, "utf8");
  if (html.includes(expected)) return;
  if (verifyOnly) throw new PatchError(`index.html is missing ${expected}.`);
  const updated = html.replace(/clientrev=[^&`"'$]+/, expected);
  if (updated === html) throw new PatchError("index.html clientrev token not found.");
  fs.writeFileSync(INDEX_HTML, updated, "utf8");
}

export function patchShadowstalkerMiasmaBonus(swfPath: string, verifyOnly = false): void {
  const first = buildPatches(swfPath);
  if (verifyOnly && first.patches.length) throw new PatchError(`${swfPath}: legacy Black Miasma bonuses remain.`);
  if (first.patches.length) {
    ensureBackup(swfPath);
    const { body, delta } = applyPatchesToBody(first.ctx.body, first.patches);
    writeSwf(first.ctx, body, delta);
  }
  const verified = buildPatches(swfPath);
  if (verified.state !== "desired") throw new PatchError("Black Miasma bonus verification failed.");
  syncClientRevision(swfPath, verifyOnly);
  console.log(`${verifyOnly ? "Verified" : first.patches.length ? "Patched" : "Already patched"} Heart Seeker +40% / Black Storm +80% Black Miasma bonuses in ${swfPath}`);
}

const { swfPath, verify } = parseArgs(process.argv);
patchShadowstalkerMiasmaBonus(swfPath, verify);
