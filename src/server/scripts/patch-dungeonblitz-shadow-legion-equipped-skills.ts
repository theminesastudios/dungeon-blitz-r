import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import {
  applyPatchesToBody,
  BytePatch,
  classIndexByName,
  ensureBackup,
  methodIdxForTrait,
  parseAbc,
  parseSwf,
  PatchError,
  writeSwf,
  writeU30,
} from "./swfPatchUtils";

const ROOT = path.resolve(__dirname, "..", "..", "..");
const DEFAULT_SWF = path.join(ROOT, "src", "client", "content", "localhost", "p", "cbp", "DungeonBlitz.swf");
const INDEX_HTML = path.join(ROOT, "src", "client", "content", "localhost", "index.html");
/**
 * The three clone skill ranks used to be addressed as locals 55, 56 and 57, which is how
 * FireThisPower numbered them in the SWF this patch was first written against. Local numbers are
 * not stable: any script that decompiles and recompiles CombatState -- the Sentinel Form exit
 * cooldown and the Shadow Legion rotation both do -- makes FFDec renumber the whole method, and
 * the hardcoded triple then matched nothing and failed the build even though the gating itself
 * had round-tripped through the recompile untouched.
 *
 * So the invariant is stated directly instead: FireThisPower must not read the power's rank
 * (var_7) into any local at all. Unpatched there are exactly three such reads, one per clone;
 * patched there are none, whatever the locals are called this build.
 */
const MAX_LOCAL = 255;

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

function occurrences(haystack: Buffer, needle: Buffer): number[] {
  const offsets: number[] = [];
  for (let offset = haystack.indexOf(needle); offset >= 0; offset = haystack.indexOf(needle, offset + 1)) {
    offsets.push(offset);
  }
  return offsets;
}

function rankPatterns(var7Multiname: number, local: number): { unequipped: Buffer; equippedOnly: Buffer } {
  const unequipped = Buffer.concat([
    Buffer.from([0xd1, 0x66]), // getlocal_1; getproperty var_7
    writeU30(var7Multiname),
    Buffer.from([0x73, 0x63]), // convert_i; setlocal
    writeU30(local),
  ]);
  const equippedOnlyCore = Buffer.concat([
    Buffer.from([0x24, 0x00, 0x73, 0x63]), // pushbyte 0; convert_i; setlocal
    writeU30(local),
  ]);
  if (equippedOnlyCore.length > unequipped.length) {
    throw new PatchError(`Shadow Legion rank patch grew for local ${local}.`);
  }
  return {
    unequipped,
    equippedOnly: Buffer.concat([equippedOnlyCore, Buffer.alloc(unequipped.length - equippedOnlyCore.length, 0x02)]),
  };
}

function syncClientRevision(swfPath: string, verify: boolean): void {
  if (path.resolve(swfPath) !== path.resolve(DEFAULT_SWF)) return;
  const digest = crypto.createHash("sha1").update(fs.readFileSync(swfPath)).digest("hex").slice(0, 12);
  const expected = `clientrev=swf-${digest}`;
  const html = fs.readFileSync(INDEX_HTML, "utf8");
  if (html.includes(expected)) return;
  if (verify) throw new PatchError(`index.html is missing ${expected}.`);
  const updated = html.replace(/clientrev=[^&`"'$]+/, expected);
  if (updated === html) throw new PatchError("index.html clientrev token not found.");
  fs.writeFileSync(INDEX_HTML, updated, "utf8");
}

function patchShadowLegionEquippedSkills(swfPath: string, verify: boolean): void {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);
  const classIndex = classIndexByName(abc, "CombatState");
  if (classIndex === null) throw new PatchError("CombatState class not found.");
  const methodIndex = methodIdxForTrait(abc.instances[classIndex].traits, abc, "FireThisPower");
  if (methodIndex === null) throw new PatchError("CombatState.FireThisPower not found.");
  const methodBody = abc.methodBodies.get(methodIndex);
  if (!methodBody) throw new PatchError("CombatState.FireThisPower body not found.");
  const var7Multiname = abc.multinameNames.findIndex((name) => name === "var_7");
  if (var7Multiname < 0) throw new PatchError("var_7 multiname not found.");
  const code = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);

  const patches: BytePatch[] = [];
  for (let local = 0; local <= MAX_LOCAL; local += 1) {
    const patterns = rankPatterns(var7Multiname, local);
    for (const offset of occurrences(code, patterns.unequipped)) {
      patches.push({
        key: `CombatState.FireThisPower.shadowLegionEquippedRank${local}@${offset}`,
        start: methodBody.codeStart + offset,
        end: methodBody.codeStart + offset + patterns.unequipped.length,
        data: patterns.equippedOnly,
        detail: `initialize Shadow Legion clone skill rank local ${local} to zero until found among equipped powers`,
      });
    }
  }
  if (patches.length > 3) {
    throw new PatchError(
      `CombatState.FireThisPower reads the power rank into ${patches.length} locals, expected at most the three clone skill ranks.`,
    );
  }

  if (verify && patches.length > 0) {
    throw new PatchError(`${swfPath}: Shadow Legion clones can still use unequipped inner skills.`);
  }
  if (patches.length > 0) {
    ensureBackup(swfPath);
    const { body, delta } = applyPatchesToBody(ctx.body, patches);
    writeSwf(ctx, body, delta);
  }
  syncClientRevision(swfPath, verify);
  console.log(`${swfPath}: ${patches.length > 0 ? "patched" : "verified"} Shadow Legion equipped-skill gating.`);
}

const { swfPath, verify } = parseArgs(process.argv);
patchShadowLegionEquippedSkills(swfPath, verify);
