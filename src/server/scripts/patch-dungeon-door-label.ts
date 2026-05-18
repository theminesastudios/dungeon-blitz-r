import * as path from "path";
import {
  applyPatchesToBody,
  BytePatch,
  classIndexByName,
  disassemble,
  methodIdxForTrait,
  parseAbc,
  parseSwf,
  PatchError,
  u30OperandName,
  writeSwf,
  writeU30,
} from "./swfPatchUtils";

const DEFAULT_SWF_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  "client",
  "content",
  "localhost",
  "p",
  "cbp",
  "DungeonBlitz.swf"
);

function restoreSharedDungeonDoorLabel(swfPath: string): void {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);
  const patchedTravelMatches: number[] = [];
  const dungeonMatches: number[] = [];

  for (let i = 1; i < abc.stringValues.length; i += 1) {
    if (
      abc.stringValues[i] === "Travel to" &&
      abc.stringValues[i - 1] === "Trap" &&
      abc.stringValues[i + 1] === "TravelToTownOne"
    ) {
      patchedTravelMatches.push(i);
    } else if (
      abc.stringValues[i] === "Dungeon" &&
      abc.stringValues[i - 1] === "Trap" &&
      abc.stringValues[i + 1] === "TravelToTownOne"
    ) {
      dungeonMatches.push(i);
    }
  }

  if (dungeonMatches.length === 1 && patchedTravelMatches.length === 0) {
    console.log(`Shared dungeon door label already correct in ${path.basename(swfPath)}`);
    return;
  }

  if (patchedTravelMatches.length !== 1 || dungeonMatches.length !== 0) {
    throw new PatchError(
      `Expected exactly one shared door label to restore, found travel=${patchedTravelMatches.length}, dungeon=${dungeonMatches.length}`
    );
  }

  const stringIndex = patchedTravelMatches[0];
  const newText = "Dungeon";
  const newBytes = Buffer.from(newText, "utf8");
  const patch: BytePatch = {
    key: "shared-dungeon-door-label",
    start: abc.stringLenPositions[stringIndex],
    end: abc.stringDataPositions[stringIndex] + Buffer.byteLength("Travel to", "utf8"),
    data: Buffer.concat([writeU30(newBytes.length), newBytes]),
    detail: `"Travel to" -> "${newText}"`,
  };

  const { body, delta } = applyPatchesToBody(ctx.body, [patch]);
  writeSwf(ctx, body, delta);
  console.log(`Restored ${path.basename(swfPath)} shared dungeon door label: ${patch.detail}`);
}

function normalizeTravelDoorLabel(swfPath: string): void {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);
  const returnToMatches: number[] = [];
  const travelToMatches: number[] = [];

  for (let i = 1; i < abc.stringValues.length; i += 1) {
    if (abc.stringValues[i] === "Return to") {
      returnToMatches.push(i);
    } else if (abc.stringValues[i] === "Travel to") {
      travelToMatches.push(i);
    }
  }

  if (travelToMatches.length === 1 && returnToMatches.length === 0) {
    console.log(`Travel door label already normalized in ${path.basename(swfPath)}`);
    return;
  }

  if (returnToMatches.length !== 1 || travelToMatches.length !== 0) {
    throw new PatchError(
      `Expected exactly one travel label to normalize, found return=${returnToMatches.length}, travel=${travelToMatches.length}`
    );
  }

  const stringIndex = returnToMatches[0];
  const newText = "Travel to";
  const newBytes = Buffer.from(newText, "utf8");
  const patch: BytePatch = {
    key: "travel-door-label-text",
    start: abc.stringLenPositions[stringIndex],
    end: abc.stringDataPositions[stringIndex] + Buffer.byteLength("Return to", "utf8"),
    data: Buffer.concat([writeU30(newBytes.length), newBytes]),
    detail: `"Return to" -> "${newText}"`,
  };

  const { body, delta } = applyPatchesToBody(ctx.body, [patch]);
  writeSwf(ctx, body, delta);
  console.log(`Normalized ${path.basename(swfPath)} travel door label: ${patch.detail}`);
}

function patchWorldTravelDoorHeaderCondition(swfPath: string): void {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);
  const entityClassIndex = classIndexByName(abc, "Entity");
  if (entityClassIndex === null) {
    throw new PatchError("Entity class not found");
  }

  const methodIndex = methodIdxForTrait(abc.instances[entityClassIndex].traits, abc, "method_579");
  if (methodIndex === null) {
    throw new PatchError("Entity.method_579 not found");
  }

  const methodBody = abc.methodBodies.get(methodIndex);
  if (!methodBody) {
    throw new PatchError("Entity.method_579 body not found");
  }

  const code = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
  const instructions = disassemble(code, "Entity.method_579");
  let originalMatch: { pushByteOffset: number; equalsOffset: number } | null = null;
  let patchedMatchFound = false;

  for (let i = 0; i <= instructions.length - 4; i += 1) {
    const [getLocal, getProperty, pushByte, comparison] = instructions.slice(i, i + 4);
    if (
      getLocal.opcode !== 0xd1 ||
      getProperty.opcode !== 0x66 ||
      u30OperandName(getProperty, abc.multinameNames) !== "doorID" ||
      pushByte.opcode !== 0x24
    ) {
      continue;
    }

    const pushValue = pushByte.operands[0]?.[1];
    if (pushValue === 2 && comparison.opcode === 0xab) {
      if (originalMatch) {
        throw new PatchError("Found multiple doorID == 2 header checks in Entity.method_579");
      }
      originalMatch = {
        pushByteOffset: methodBody.codeStart + pushByte.offset + 1,
        equalsOffset: methodBody.codeStart + comparison.offset,
      };
    } else if (pushValue === 100 && comparison.opcode === 0xb0) {
      patchedMatchFound = true;
    }
  }

  if (!originalMatch) {
    if (patchedMatchFound) {
      console.log(`World travel door header condition already patched in ${path.basename(swfPath)}`);
      return;
    }
    throw new PatchError("Could not find doorID == 2 header check in Entity.method_579");
  }

  const patches: BytePatch[] = [
    {
      key: "world-travel-door-id-threshold",
      start: originalMatch.pushByteOffset,
      end: originalMatch.pushByteOffset + 1,
      data: Buffer.from([100]),
      detail: "doorID 2 -> doorID 100",
    },
    {
      key: "world-travel-door-compare",
      start: originalMatch.equalsOffset,
      end: originalMatch.equalsOffset + 1,
      data: Buffer.from([0xb0]),
      detail: "equals -> greaterequals",
    },
  ];

  const { body, delta } = applyPatchesToBody(ctx.body, patches);
  writeSwf(ctx, body, delta);
  console.log(`Patched ${path.basename(swfPath)} world travel header rule: doorID < 100 -> Travel to`);
}

function preserveDoorPlateAssetHeader(swfPath: string): void {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);
  const entityClassIndex = classIndexByName(abc, "Entity");
  if (entityClassIndex === null) {
    throw new PatchError("Entity class not found");
  }

  const methodIndex = methodIdxForTrait(abc.instances[entityClassIndex].traits, abc, "method_579");
  if (methodIndex === null) {
    throw new PatchError("Entity.method_579 not found");
  }

  const methodBody = abc.methodBodies.get(methodIndex);
  if (!methodBody) {
    throw new PatchError("Entity.method_579 body not found");
  }

  const code = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
  const instructions = disassemble(code, "Entity.method_579");
  let patchStart = -1;
  let patchEnd = -1;
  let alreadyPatched = false;

  for (let i = 0; i <= instructions.length - 7; i += 1) {
    const [label, getLex, getLocalPlate, getHeader, getLocalHeaderText, callSetText, jump] = instructions.slice(i, i + 7);
    if (
      label.opcode !== 0x09 ||
      getLex.opcode !== 0x60 ||
      getLocalPlate.opcode !== 0x62 ||
      getLocalPlate.operands[0]?.[1] !== 8 ||
      getHeader.opcode !== 0x66 ||
      getLocalHeaderText.opcode !== 0x62 ||
      getLocalHeaderText.operands[0]?.[1] !== 10 ||
      callSetText.opcode !== 0x4f ||
      callSetText.operands[1]?.[1] !== 2 ||
      jump.opcode !== 0x10
    ) {
      continue;
    }

    patchStart = methodBody.codeStart + getLex.offset;
    patchEnd = methodBody.codeStart + jump.offset;
    break;
  }

  if (patchStart === -1) {
    for (let i = 0; i <= instructions.length - 3; i += 1) {
      const label = instructions[i];
      const firstNop = instructions[i + 1];
      if (label.opcode !== 0x09 || firstNop.opcode !== 0x02) {
        continue;
      }

      let cursor = i + 1;
      while (cursor < instructions.length && instructions[cursor].opcode === 0x02) {
        cursor += 1;
      }

      const jump = instructions[cursor];
      if (!jump || jump.opcode !== 0x10) {
        continue;
      }

      const start = methodBody.codeStart + firstNop.offset;
      const end = methodBody.codeStart + jump.offset;
      if (end > start && end - start >= 8 && ctx.body.subarray(start, end).every((byte) => byte === 0x02)) {
        alreadyPatched = true;
        break;
      }
    }
  }

  if (alreadyPatched) {
    console.log(`Door plate asset header already preserved in ${path.basename(swfPath)}`);
    return;
  }

  if (patchStart === -1 || patchEnd <= patchStart) {
    throw new PatchError("Could not find am_Header overwrite block in Entity.method_579");
  }

  const patch: BytePatch = {
    key: "preserve-door-plate-asset-header",
    start: patchStart,
    end: patchEnd,
    data: Buffer.alloc(patchEnd - patchStart, 0x02),
    detail: "replace dynamic am_Header overwrite with nops",
  };

  const { body, delta } = applyPatchesToBody(ctx.body, [patch]);
  writeSwf(ctx, body, delta);
  console.log(`Patched ${path.basename(swfPath)} door plate header: ${patch.detail}`);
}

try {
  const swfPath = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_SWF_PATH;
  restoreSharedDungeonDoorLabel(swfPath);
  normalizeTravelDoorLabel(swfPath);
  patchWorldTravelDoorHeaderCondition(swfPath);
  preserveDoorPlateAssetHeader(swfPath);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
