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

const METHODS = ["method_930", "method_1325"];

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
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { swfPath, verify };
}

function findGameMethodBody(abc: ReturnType<typeof parseAbc>, methodName: string) {
  const classIndex = classIndexByName(abc, "Game");
  if (classIndex === null) {
    throw new PatchError("Game class not found.");
  }

  const methodIdx = methodIdxForTrait(abc.instances[classIndex].traits, abc, methodName);
  if (methodIdx === null) {
    throw new PatchError(`Game.${methodName} not found.`);
  }

  const methodBody = abc.methodBodies.get(methodIdx);
  if (!methodBody) {
    throw new PatchError(`Game.${methodName} body not found.`);
  }
  return methodBody;
}

function repairSwf(swfPath: string, verify: boolean): void {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);
  const patches: BytePatch[] = [];
  const unsafeMethods: string[] = [];
  const shallowMethods: string[] = [];

  for (const methodName of METHODS) {
    const methodBody = findGameMethodBody(abc, methodName);
    if (methodBody.maxScopeDepth < 6) {
      shallowMethods.push(methodName);
    }
    patches.push({
      key: `Game.${methodName}.maxScopeDepth`,
      start: methodBody.maxScopeDepthPos,
      end: methodBody.codeLenPos,
      data: Buffer.from([0x06]),
      detail: "allow Game plus catch scope",
    });
    for (const exception of methodBody.exceptions) {
      const handlerStart = methodBody.codeStart + exception.target;
      const first = ctx.body[handlerStart];
      const second = ctx.body[handlerStart + 1];
      if (first === 0x02 && second === 0x02) {
        unsafeMethods.push(methodName);
        patches.push({
          key: `Game.${methodName}.catchGameScope`,
          start: handlerStart,
          end: handlerStart + 2,
          data: Buffer.from([0xd0, 0x30]),
          detail: "restore Game scope before catch scope",
        });
      }
    }
  }

  if (verify) {
    if (unsafeMethods.length || shallowMethods.length) {
      const failures = [
        unsafeMethods.length ? `missing Game scope in ${unsafeMethods.join(", ")}` : "",
        shallowMethods.length ? `max_scope_depth < 6 in ${shallowMethods.join(", ")}` : "",
      ].filter(Boolean).join("; ");
      throw new PatchError(`${swfPath}: verify failed; catch handlers still have invalid scope (${failures}).`);
    }
    console.log(`${swfPath}: verified Game catch handlers keep valid scope stack.`);
    return;
  }

  ensureBackup(swfPath);
  const { body, delta } = applyPatchesToBody(ctx.body, patches);
  writeSwf(ctx, body, delta);
  console.log(`${swfPath}: repaired Game catch handler scope stack.`);
}

const { swfPath, verify } = parseArgs(process.argv);
repairSwf(swfPath, verify);
