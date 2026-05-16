import * as path from "path";
import {
  applyPatchesToBody,
  BytePatch,
  classIndexByName,
  disassemble,
  ensureBackup,
  methodIdxForTrait,
  parseAbc,
  parseSwf,
  PatchError,
  readU30,
  writeSwf,
  writeU30,
} from "./swfPatchUtils";

const DEFAULT_SWF = path.resolve(
  __dirname,
  "..",
  "..",
  "client",
  "content",
  "localhost",
  "p",
  "cbp",
  "DungeonBlitz.swf",
);

function parseArgs(argv: string[]): { swfPath: string; verify: boolean } {
  let swfPath = DEFAULT_SWF;
  let verify = false;

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--swf" || arg === "-s") {
      swfPath = path.resolve(argv[++index] || "");
      continue;
    }
    if (arg === "--verify" || arg === "--dry-run") {
      verify = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log([
        "Usage:",
        "  npm exec tsx src/server/scripts/patch-dungeonblitz-class123-render-null-guard.ts [--verify] [--swf <path>]",
        "",
        "Patches class_123.method_1808 so transient null render-cache entries",
        "return safely instead of crashing the client tick with Error #1009.",
      ].join("\n"));
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { swfPath, verify };
}

function opcode(op: number, operands: Buffer[] = []): Buffer {
  return Buffer.concat([Buffer.from([op]), ...operands]);
}

function buildReturnCatchHandler(localIndex: number): Buffer {
  return Buffer.concat([
    opcode(0xd0), // getlocal0
    opcode(0x30), // pushscope
    opcode(0x5a, [writeU30(0)]), // newcatch 0
    opcode(0x2a), // dup
    opcode(0x63, [writeU30(localIndex)]), // setlocal
    opcode(0x2a), // dup
    opcode(0x30), // pushscope
    opcode(0x2b), // swap
    opcode(0x6d, [writeU30(1)]), // setslot 1
    opcode(0x1d), // popscope
    opcode(0x08, [writeU30(localIndex)]), // kill
    opcode(0x47), // returnvoid
  ]);
}

function findRequiredMultiname(abc: ReturnType<typeof parseAbc>, name: string): number {
  const index = abc.multinameNames.findIndex((candidate) => candidate === name);
  if (index < 0) {
    throw new PatchError(`Multiname ${name} not found.`);
  }
  return index;
}

function getMethod1808(swfPath: string) {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);
  const classIndex = classIndexByName(abc, "class_123");
  if (classIndex === null) {
    throw new PatchError("class_123 class not found.");
  }

  const methodIdx = methodIdxForTrait(abc.instances[classIndex].traits, abc, "method_1808");
  if (methodIdx === null) {
    throw new PatchError("class_123.method_1808 not found.");
  }

  const methodBody = abc.methodBodies.get(methodIdx);
  if (!methodBody) {
    throw new PatchError(`class_123.method_1808 body not found (${methodIdx}).`);
  }

  const code = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
  const instructions = disassemble(code, `class_123.method_1808:${methodIdx}`);
  return { ctx, abc, methodBody, code, instructions };
}

function hasRenderNullGuard(swfPath: string): boolean {
  const { abc, methodBody, instructions } = getMethod1808(swfPath);
  const errorName = findRequiredMultiname(abc, "Error");
  return methodBody.exceptions.some((entry) => (
    entry.from === 0 &&
    entry.to === entry.target &&
    entry.type === errorName &&
    entry.target > 0 &&
    entry.target < methodBody.codeLen &&
    instructions.some((instruction) => instruction.offset === entry.target && instruction.opcode === 0xd0) &&
    instructions.some((instruction) => instruction.offset >= entry.target && instruction.opcode === 0x47)
  ));
}

function patchSwf(swfPath: string, verify: boolean): void {
  const { ctx, abc, methodBody, code } = getMethod1808(swfPath);
  const errorName = findRequiredMultiname(abc, "Error");
  const catchName = findRequiredMultiname(abc, "error");
  const [localCount] = readU30(ctx.body, methodBody.localCountPos, "class_123.method_1808.local_count");

  if (hasRenderNullGuard(swfPath)) {
    console.log(
      verify
        ? `${swfPath}: verified class_123.method_1808 render null guard.`
        : `${swfPath}: already patched (class_123.method_1808 render null guard present).`,
    );
    return;
  }

  if (verify) {
    throw new PatchError(`${swfPath}: verify failed; class_123.method_1808 render null guard is missing.`);
  }

  if (methodBody.exceptionCount !== 0) {
    throw new PatchError("class_123.method_1808 already has unexpected exception handlers.");
  }

  const handler = buildReturnCatchHandler(localCount);
  const patchedCode = Buffer.concat([code, handler]);
  const exceptionTable = Buffer.concat([
    writeU30(1),
    writeU30(0),
    writeU30(code.length),
    writeU30(code.length),
    writeU30(errorName),
    writeU30(catchName),
  ]);
  const localCountBytes = writeU30(localCount);

  const patches: BytePatch[] = [
    {
      key: "class_123.method_1808.localCount",
      start: methodBody.localCountPos,
      end: methodBody.localCountPos + localCountBytes.length,
      data: writeU30(localCount + 1),
      detail: "add render null catch local",
    },
    {
      key: "class_123.method_1808.maxScopeDepth",
      start: methodBody.maxScopeDepthPos,
      end: methodBody.codeLenPos,
      data: writeU30(Math.max(methodBody.maxScopeDepth, 6)),
      detail: "allow render null catch scope",
    },
    {
      key: "class_123.method_1808.code",
      start: methodBody.codeStart,
      end: methodBody.codeStart + methodBody.codeLen,
      data: patchedCode,
      detail: "append render null catch handler",
    },
    {
      key: "class_123.method_1808.codeLen",
      start: methodBody.codeLenPos,
      end: methodBody.codeStart,
      data: writeU30(patchedCode.length),
      detail: "update class_123.method_1808 code length",
    },
    {
      key: "class_123.method_1808.exceptionTable",
      start: methodBody.exceptionCountPos,
      end: methodBody.traitsCountPos,
      data: exceptionTable,
      detail: "catch render-cache null errors",
    },
  ];

  ensureBackup(swfPath);
  const { body, delta } = applyPatchesToBody(ctx.body, patches);
  writeSwf(ctx, body, delta);
  console.log(`${swfPath}: patched class_123.method_1808 render null guard.`);
}

const { swfPath, verify } = parseArgs(process.argv);
patchSwf(swfPath, verify);
