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
        "  npm exec tsx src/server/scripts/patch-dungeonblitz-linkupdater-method1072-null-guard.ts [--verify] [--swf <path>]",
        "",
        "Patches LinkUpdater.method_1072 so stale/null entity graphics during",
        "server entity-state updates are ignored instead of crashing the Flash client.",
      ].join("\n"));
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { swfPath, verify };
}

function getLinkUpdaterMethod1072(swfPath: string) {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);
  const classIndex = classIndexByName(abc, "LinkUpdater");
  if (classIndex === null) {
    throw new PatchError("Could not find LinkUpdater class.");
  }

  const methodIdx = methodIdxForTrait(abc.instances[classIndex].traits, abc, "method_1072");
  if (methodIdx === null) {
    throw new PatchError("Could not find LinkUpdater.method_1072.");
  }

  const methodBody = abc.methodBodies.get(methodIdx);
  if (!methodBody) {
    throw new PatchError(`Could not find method body for LinkUpdater.method_1072 (${methodIdx}).`);
  }

  const code = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
  return { ctx, methodBody, code };
}

function method1072AlreadyPatched(
  methodBody: ReturnType<typeof getLinkUpdaterMethod1072>["methodBody"],
  code: Buffer,
): boolean {
  return methodBody.exceptions.some((exception) => {
    if (exception.from !== 0 || exception.target < code.length - 2) {
      return false;
    }
    return code[exception.target] === 0x29 && code[exception.target + 1] === 0x47;
  });
}

function patchSwf(swfPath: string, verify: boolean): void {
  const { ctx, methodBody, code } = getLinkUpdaterMethod1072(swfPath);
  if (method1072AlreadyPatched(methodBody, code)) {
    console.log(`${swfPath}: already patched (LinkUpdater.method_1072 null guard present).`);
    return;
  }

  if (methodBody.exceptionCount !== 0) {
    throw new PatchError(`${swfPath}: LinkUpdater.method_1072 has an unexpected exception table.`);
  }

  if (verify) {
    throw new PatchError(`${swfPath}: verify failed; LinkUpdater.method_1072 null guard is missing.`);
  }

  const catchOffset = code.length;
  const patchedCode = Buffer.concat([code, Buffer.from([0x29, 0x47])]);
  const exceptionEntry = Buffer.concat([
    writeU30(0),
    writeU30(catchOffset),
    writeU30(catchOffset),
    writeU30(0),
    writeU30(0),
  ]);

  const patches: BytePatch[] = [
    {
      key: "LinkUpdater.method_1072.code",
      start: methodBody.codeStart,
      end: methodBody.codeStart + methodBody.codeLen,
      data: patchedCode,
      detail: "append null-reference catch handler",
    },
    {
      key: "LinkUpdater.method_1072.codeLen",
      start: methodBody.codeLenPos,
      end: methodBody.codeStart,
      data: writeU30(patchedCode.length),
      detail: "update LinkUpdater.method_1072 code length",
    },
    {
      key: "LinkUpdater.method_1072.exceptionCount",
      start: methodBody.exceptionCountPos,
      end: methodBody.exceptionCountPos + 1,
      data: writeU30(1),
      detail: "add LinkUpdater.method_1072 exception entry",
    },
    {
      key: "LinkUpdater.method_1072.exception",
      start: methodBody.traitsCountPos,
      end: methodBody.traitsCountPos,
      data: exceptionEntry,
      detail: "catch stale entity-state null references",
    },
  ];

  ensureBackup(swfPath);
  const { body, delta } = applyPatchesToBody(ctx.body, patches);
  writeSwf(ctx, body, delta);
  console.log(`${swfPath}: patched LinkUpdater.method_1072 null guard.`);
}

const { swfPath, verify } = parseArgs(process.argv);
patchSwf(swfPath, verify);
