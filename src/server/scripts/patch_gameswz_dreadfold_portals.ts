import * as path from "path";
import { ensureBackup, parseSwz, SwzPatchError, writeSwz } from "./swzPatchUtils";

type PortalSpec = {
  mapName: string;
  targetMapName: string;
  requireCapstone: boolean;
};

const PORTAL_SPECS: PortalSpec[] = [
  { mapName: "BridgeTown", targetMapName: "BridgeTownHard", requireCapstone: true },
  { mapName: "EmeraldGlades", targetMapName: "EmeraldGladesHard", requireCapstone: true },
  { mapName: "ShazariDesert", targetMapName: "ShazariDesertHard", requireCapstone: true },
  { mapName: "JadeCity", targetMapName: "JadeCityHard", requireCapstone: true },
  { mapName: "BridgeTownHard", targetMapName: "BridgeTown", requireCapstone: false },
  { mapName: "EmeraldGladesHard", targetMapName: "EmeraldGlades", requireCapstone: false },
  { mapName: "ShazariDesertHard", targetMapName: "ShazariDesert", requireCapstone: false },
  { mapName: "JadeCityHard", targetMapName: "JadeCity", requireCapstone: false },
];

export type DreadfoldPortalPatchStats = {
  doorTypesChunkFound: boolean;
  replacements: number;
};

function defaultGameSwzPath(): string {
  return path.resolve(
    __dirname,
    "..",
    "..",
    "client",
    "content",
    "localhost",
    "p",
    "cbq",
    "Game.swz",
  );
}

function resolveArgPath(args: string[], flag: string, fallback: string): string {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) {
    return path.resolve(args[idx + 1]);
  }
  return fallback;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function getPortalBlock(xml: string, mapName: string): string {
  const match = xml.match(
    new RegExp(`\\t<DoorType>\\r?\\n\\t\\t<MapName>${mapName}<\\/MapName>\\r?\\n\\t\\t<DoorID>300<\\/DoorID>[\\s\\S]*?\\r?\\n\\t<\\/DoorType>`),
  );
  if (!match) {
    throw new SwzPatchError(`${mapName} Dreadfold portal block not found`);
  }
  return match[0];
}

function getEntryLockedMessage(xml: string): string {
  const match = getPortalBlock(xml, "BridgeTown").match(/<LockedMessage>([\s\S]*?)<\/LockedMessage>/);
  if (!match) {
    throw new SwzPatchError("BridgeTown Dreadfold locked message not found");
  }
  return match[1];
}

function buildPortalBlock(spec: PortalSpec, lockedMessage: string, newline: string): string {
  const lines = [
    "\t<DoorType>",
    `\t\t<MapName>${spec.mapName}</MapName>`,
    "\t\t<DoorID>300</DoorID>",
    `\t\t<TargetMapName>${spec.targetMapName}</TargetMapName>`,
    "\t\t<TargetDoorID>300</TargetDoorID>",
  ];

  if (spec.requireCapstone) {
    lines.push(`\t\t<LockedMessage>${lockedMessage}</LockedMessage>`);
    lines.push("\t\t<CompletedMissions>Capstone</CompletedMissions>");
  }

  lines.push("\t</DoorType>");
  return lines.join(newline);
}

export function patchDreadfoldPortalRequirements(xml: string): { xml: string; stats: DreadfoldPortalPatchStats } {
  const newline = xml.includes("\r\n") ? "\r\n" : "\n";
  const lockedMessage = getEntryLockedMessage(xml);
  let patchedXml = xml;
  let replacements = 0;

  for (const spec of PORTAL_SPECS) {
    const blockRe = new RegExp(
      `\\t<DoorType>\\r?\\n\\t\\t<MapName>${spec.mapName}<\\/MapName>\\r?\\n\\t\\t<DoorID>300<\\/DoorID>[\\s\\S]*?\\r?\\n\\t<\\/DoorType>`,
    );
    const replacement = buildPortalBlock(spec, lockedMessage, newline);
    patchedXml = patchedXml.replace(blockRe, (match: string) => {
      if (match.replace(/\r\n/g, "\n") === replacement.replace(/\r\n/g, "\n")) {
        return match;
      }
      replacements += 1;
      return replacement;
    });
  }

  return {
    xml: patchedXml,
    stats: {
      doorTypesChunkFound: true,
      replacements,
    },
  };
}

function patchGameSwz(swzPath: string, verifyOnly: boolean): DreadfoldPortalPatchStats {
  const ctx = parseSwz(swzPath);
  const doorTypesChunk = ctx.chunks.find((chunk) => chunk.xml.includes("<DoorTypes"));
  if (!doorTypesChunk) {
    throw new SwzPatchError("DoorTypes chunk not found in Game.swz");
  }

  const patched = patchDreadfoldPortalRequirements(doorTypesChunk.xml);
  if (!verifyOnly && patched.stats.replacements > 0) {
    ensureBackup(swzPath);
    doorTypesChunk.xml = patched.xml;
    writeSwz(ctx);
  }

  return patched.stats;
}

function main(): void {
  const args = process.argv.slice(2);
  const swzPath = resolveArgPath(args, "--swz-path", defaultGameSwzPath());
  const verifyOnly = hasFlag(args, "--verify");
  const stats = patchGameSwz(swzPath, verifyOnly);

  console.log(`SWZ: ${swzPath}`);
  console.log(`DoorTypes found: ${stats.doorTypesChunkFound}`);
  console.log(`Portal blocks updated: ${stats.replacements}`);

  if (verifyOnly && stats.replacements > 0) {
    throw new SwzPatchError("Game.swz verification failed");
  }
}

if (require.main === module) {
  main();
}
