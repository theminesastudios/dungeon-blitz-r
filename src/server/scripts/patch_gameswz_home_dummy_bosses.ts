import * as fs from "fs";
import * as path from "path";
import { ensureBackup, parseSwz, SwzPatchError, writeSwz } from "./swzPatchUtils";

/**
 * Replaces the three CraftTown (home) training dummies with boss look-alikes.
 *
 * The dummies are placed by the home level SWF and referenced by EntName, so the
 * placement is kept: only the identity/appearance of HomeDummy1..3 is rewritten.
 * Behavior (HomeDummy), hit points, NoLoot and Speed 0 stay untouched so they
 * still behave as immortal practice targets.
 *
 * The Dread (Hard-mode) art sets are used, so the home dummies match what the
 * bosses look like inside Dread The West Wing / Dread Valhaven / Dread The East
 * Wing rather than their normal-difficulty appearance.
 *
 *   HomeDummy1 -> Dread Lotte, The 1st Daughter (TowerGuard1Hard, PaladinBase)
 *   HomeDummy2 -> Dread Prince Friedrich Hocke  (DefectorMageHard, MageBase)
 *   HomeDummy3 -> Dread Tanja, The 2nd Daughter (TowerGuard2Hard, RogueBase)
 */

type DummyBossDef = {
  entName: string;
  parent: string;
  displayName: string;
  width: string;
  height: string;
  genderFix?: string;
  soundDeathRattle?: string;
  soundHitGrunt?: string;
  soundBloodied?: string;
  gfx: string[];
};

const DUMMY_BOSSES: DummyBossDef[] = [
  {
    entName: "HomeDummy1",
    parent: "PaladinBase",
    displayName: "Dread Lotte, The 1st Daughter",
    width: "130",
    height: "185",
    genderFix: "Female",
    soundDeathRattle: "snd_hurt_mage_03",
    soundHitGrunt: "snd_hurt_mage_01|snd_hurt_mage_02|snd_hurt_mage_03|snd_silence|snd_silence|snd_silence",
    soundBloodied: "snd_hurt_mage_02",
    gfx: [
      "<AnimScale>1.25</AnimScale>",
      "<MoveAnimSpeed>.7</MoveAnimSpeed>",
      "<CustomArt>Gfx_Paladin_1.swf/Null</CustomArt>",
      "<CustomArt2>Gfx_Paladin_1.swf/Female</CustomArt2>",
      "<CustomArt3>Gfx_Paladin_1.swf/TowerGuard</CustomArt3>",
      "<CustomArt4>Gfx_Paladin_1.swf/ArmorRegal</CustomArt4>",
      "<CustomArt5>Gfx_Paladin_1.swf/ArmorRegalFemale</CustomArt5>",
      "<CustomArt6>Gfx_Paladin_1.swf/FlapBig</CustomArt6>",
      "<CustomArt7>Gfx_Paladin_1.swf/BootHunter</CustomArt7>",
      "<CustomArt8>Gfx_Paladin_1.swf/GloveHunter</CustomArt8>",
      "<CustomArt9>Gfx_Paladin_1.swf/ShieldShaziri</CustomArt9>",
      "<CustomArt10>Gfx_Paladin_1.swf/SwordJester</CustomArt10>",
      "<CustomArt11>Gfx_Paladin_1.swf/FootBaseHeavy</CustomArt11>",
      "<ColorSwap>0xD0F0F0=0x6C8AFF</ColorSwap>",
      "<ColorSwap2>0x80C0F0=0x33FF</ColorSwap2>",
      "<ColorSwap3>0x0070E0=0x1F36A7</ColorSwap3>",
      "<ColorSwap4>0xFF9999=0x5C5C4E</ColorSwap4>",
      "<ColorSwap5>0xB00000=0x2C2C25</ColorSwap5>",
      "<ColorSwap6>0x600000=0x1A1A15</ColorSwap6>",
      "<ColorSwap7>0x86501A=0x3E484A</ColorSwap7>",
      "<ColorSwap8>0x8B6936=0x305759</ColorSwap8>",
      "<ColorSwap9>0x590000=0x2C2C25</ColorSwap9>",
      "<ColorSwap10>0x3C0000=0x1A1A15</ColorSwap10>"
    ]
  },
  {
    entName: "HomeDummy2",
    parent: "MageBase",
    displayName: "Dread Prince Friedrich Hocke",
    width: "80",
    height: "160",
    genderFix: "Male",
    soundHitGrunt: "snd_hurt_paladin_01|snd_hurt_paladin_02|snd_hurt_paladin_03|snd_silence|snd_silence|snd_silence",
    soundBloodied: "snd_hurt_paladin_01|snd_hurt_paladin_02|snd_hurt_paladin_03|snd_silence|snd_silence|snd_silence",
    gfx: [
      "<AnimScale>1.2</AnimScale>",
      "<CustomArt>Gfx_Mage_1.swf/Null</CustomArt>",
      "<CustomArt2>Gfx_Mage_1.swf/Male</CustomArt2>",
      "<CustomArt3>Gfx_Mage_1.swf/SlyDread</CustomArt3>",
      "<CustomArt4>Gfx_Mage_1.swf/DressJester</CustomArt4>",
      "<CustomArt5>Gfx_Mage_1.swf/DressJesterMale</CustomArt5>",
      "<CustomArt6>Gfx_Mage_1.swf/GlovesImperial</CustomArt6>",
      "<CustomArt7>Gfx_Mage_1.swf/ShoulderJester</CustomArt7>",
      "<CustomArt8>Gfx_Mage_1.swf/BootsImperial</CustomArt8>",
      "<CustomArt9>Gfx_Mage_1.swf/FocusJester</CustomArt9>",
      "<CustomArt10>Gfx_Mage_1.swf/StaffJester3</CustomArt10>",
      "<CustomArt11>Gfx_Mage_1.swf/HandInsect</CustomArt11>",
      "<ColorSwap>0xD0F0F0=0xD5F0E4</ColorSwap>",
      "<ColorSwap2>0x80C0F0=0xA4D3BF</ColorSwap2>",
      "<ColorSwap3>0x0070E0=0x7EA998</ColorSwap3>",
      "<ColorSwap4>0xFF9999=0x28404D</ColorSwap4>",
      "<ColorSwap5>0xB00000=0xF181D</ColorSwap5>",
      "<ColorSwap6>0x600000=0x50A0C</ColorSwap6>"
    ]
  },
  {
    entName: "HomeDummy3",
    parent: "RogueBase",
    displayName: "Dread Tanja, The 2nd Daughter",
    width: "90",
    height: "140",
    soundDeathRattle: "snd_hurt_mage_03",
    soundHitGrunt: "snd_hurt_mage_01|snd_hurt_mage_02|snd_hurt_mage_03|snd_silence|snd_silence|snd_silence",
    soundBloodied: "snd_hurt_mage_02",
    gfx: [
      "<AnimScale>1.25</AnimScale>",
      "<MoveAnimSpeed>.8</MoveAnimSpeed>",
      "<CustomArt>Gfx_Rogue_1.swf/Null</CustomArt>",
      "<CustomArt2>Animation_Rogue.swf/Female</CustomArt2>",
      "<CustomArt3>Gfx_Rogue_1.swf/TowerGuardHorn</CustomArt3>",
      "<CustomArt4>Gfx_Rogue_1.swf/SashRegal</CustomArt4>",
      "<CustomArt5>Gfx_Rogue_1.swf/GloveHunter</CustomArt5>",
      "<CustomArt6>Gfx_Rogue_1.swf/BootFootOni</CustomArt6>",
      "<CustomArt7>Gfx_Rogue_1.swf/GloveStudded</CustomArt7>",
      "<CustomArt8>Gfx_Paladin_1.swf/RapierOni</CustomArt8>",
      "<CustomArt9>Gfx_Paladin_1.swf/OffhandOni</CustomArt9>",
      "<ColorSwap>0xD0F0F0=0x6FBAFF</ColorSwap>",
      "<ColorSwap2>0x80C0F0=0x84FF</ColorSwap2>",
      "<ColorSwap3>0x0070E0=0x1463A3</ColorSwap3>",
      "<ColorSwap4>0xFF9999=0x8A7C79</ColorSwap4>",
      "<ColorSwap5>0xB00000=0x594F4D</ColorSwap5>",
      "<ColorSwap6>0x600000=0x393331</ColorSwap6>"
    ]
  }
];

const DUMMY_HIT_POINTS = "1000000";

type DummyBossStats = {
  updated: number;
  verified: number;
};

function buildEntTypeBlock(def: DummyBossDef): string {
  const lines: string[] = [];
  lines.push(`<EntType EntName="${def.entName}" parent="${def.parent}">`);
  lines.push(`\t\t<DisplayName>${def.displayName}</DisplayName>`);
  lines.push("\t\t<DevStatus>New House</DevStatus>");
  lines.push("\t\t<Level>1</Level>");
  lines.push("\t\t<GroupLevel>1</GroupLevel>");
  lines.push("\t\t<EntRank>Minion</EntRank>");
  lines.push("\t\t<MeleeDamage>0</MeleeDamage>");
  lines.push("\t\t<MagicDamage>1</MagicDamage>");
  lines.push("\t\t<ArmorClass>1</ArmorClass>");
  lines.push(`\t\t<HitPoints>${DUMMY_HIT_POINTS}</HitPoints>`);
  lines.push("\t\t<RewardClass>NoLoot</RewardClass>");
  lines.push("\t\t<Realm>Object</Realm>");
  lines.push("\t\t<Speed>0</Speed>");
  lines.push(`\t\t<Width>${def.width}</Width>`);
  lines.push(`\t\t<Height>${def.height}</Height>`);
  if (def.genderFix) {
    lines.push(`\t\t<GenderFix>${def.genderFix}</GenderFix>`);
  }
  if (def.soundDeathRattle) {
    lines.push(`\t\t<SoundDeathRattle>${def.soundDeathRattle}</SoundDeathRattle>`);
  }
  if (def.soundHitGrunt) {
    lines.push(`\t\t<SoundHitGrunt>${def.soundHitGrunt}</SoundHitGrunt>`);
  }
  if (def.soundBloodied) {
    lines.push(`\t\t<SoundBloodied>${def.soundBloodied}</SoundBloodied>`);
  }
  lines.push("\t\t<Behavior>HomeDummy</Behavior>");
  lines.push("\t\t<EquippedGear/>");
  lines.push("\t\t<GfxType>");
  for (const entry of def.gfx) {
    lines.push(`\t\t\t${entry}`);
  }
  lines.push("\t\t</GfxType>");
  lines.push("\t</EntType>");
  return lines.join("\n");
}

export function patchHomeDummyBossXml(xml: string): { xml: string; stats: DummyBossStats } {
  let updated = 0;
  let verified = 0;
  let patchedXml = xml;

  for (const def of DUMMY_BOSSES) {
    const blockPattern = new RegExp(`<EntType EntName="${def.entName}"[^>]*>[\\s\\S]*?<\\/EntType>`);
    const target = buildEntTypeBlock(def);
    let matched = false;
    patchedXml = patchedXml.replace(blockPattern, (block: string) => {
      matched = true;
      verified += 1;
      if (block !== target) {
        updated += 1;
      }
      return target;
    });
    if (!matched) {
      throw new SwzPatchError(`missing EntType ${def.entName}`);
    }
  }

  return { xml: patchedXml, stats: { updated, verified } };
}

function assertHomeDummyBossXml(xml: string, label: string): DummyBossStats {
  const patched = patchHomeDummyBossXml(xml);
  if (patched.stats.verified !== DUMMY_BOSSES.length || patched.stats.updated !== 0) {
    throw new SwzPatchError(`${label} HomeDummy boss appearances are not applied`);
  }
  return patched.stats;
}

function defaultSourceXmlPath(): string {
  return path.resolve(__dirname, "..", "..", "client", "content", "xml", "EntTypes.xml");
}

function defaultServerJsonPaths(): string[] {
  return [
    path.resolve(__dirname, "..", "data", "EntTypes.json"),
    path.resolve(__dirname, "..", "dist", "data", "EntTypes.json")
  ].filter((jsonPath) => fs.existsSync(jsonPath));
}

function defaultGameSwzPaths(): string[] {
  const cbqDir = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p", "cbq");
  return ["Login.swz", "Game.swz", "Game.en.swz", "Game.tr.swz"]
    .map((name) => path.join(cbqDir, name))
    .filter((swzPath) => fs.existsSync(swzPath))
    .filter((swzPath) => {
      try {
        return parseSwz(swzPath).chunks.some((entry) => entry.xml.includes("<EntTypes"));
      } catch {
        return false;
      }
    });
}

function resolveArgPaths(args: string[], flag: string, defaults: string[]): string[] {
  const resolved: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== flag) {
      continue;
    }
    const value = args[index + 1];
    if (!value) {
      throw new SwzPatchError(`Missing value for ${flag}`);
    }
    resolved.push(path.resolve(process.cwd(), value));
    index += 1;
  }
  return resolved.length > 0 ? resolved : defaults;
}

function resolveArgPath(args: string[], flag: string, defaultPath: string): string {
  const index = args.indexOf(flag);
  if (index < 0) {
    return defaultPath;
  }
  const value = args[index + 1];
  if (!value) {
    throw new SwzPatchError(`Missing value for ${flag}`);
  }
  return path.resolve(process.cwd(), value);
}

function patchSourceXml(xmlPath: string, verifyOnly: boolean): DummyBossStats {
  const original = fs.readFileSync(xmlPath, "utf8");
  const patched = patchHomeDummyBossXml(original);
  if (verifyOnly) {
    return assertHomeDummyBossXml(original, "source XML");
  }
  if (patched.xml !== original) {
    fs.writeFileSync(xmlPath, patched.xml, "utf8");
  }
  return assertHomeDummyBossXml(patched.xml, "source XML");
}

function findEntTypeArray(data: any): any[] {
  const direct = data?.EntTypes?.EntType;
  if (Array.isArray(direct)) {
    return direct;
  }
  const nested = data?.EntTypes?.EntTypes?.EntType;
  if (Array.isArray(nested)) {
    return nested;
  }
  throw new SwzPatchError("server JSON has no EntTypes.EntType array");
}

function patchServerJson(jsonPath: string, verifyOnly: boolean): DummyBossStats {
  const original = fs.readFileSync(jsonPath, "utf8");
  const hasBom = original.charCodeAt(0) === 0xfeff;
  const data = JSON.parse(hasBom ? original.slice(1) : original);
  const entTypes = findEntTypeArray(data);
  let updated = 0;
  let verified = 0;

  for (const def of DUMMY_BOSSES) {
    const entry = entTypes.find((candidate: { EntName?: string }) => candidate.EntName === def.entName);
    if (!entry) {
      throw new SwzPatchError(`server JSON missing ${def.entName}`);
    }
    verified += 1;

    const desired: Record<string, string> = {
      parent: def.parent,
      DisplayName: def.displayName,
      Width: def.width,
      Height: def.height
    };
    if (def.genderFix) {
      desired.GenderFix = def.genderFix;
    }

    for (const [key, value] of Object.entries(desired)) {
      if (entry[key] !== value) {
        updated += 1;
        entry[key] = value;
      }
    }
    if (entry.HitPoints !== DUMMY_HIT_POINTS || entry.Behavior !== "HomeDummy") {
      throw new SwzPatchError(`server JSON ${def.entName} lost its dummy behavior`);
    }
  }

  if (verifyOnly && updated !== 0) {
    throw new SwzPatchError("server JSON HomeDummy boss appearances are not applied");
  }
  if (!verifyOnly && updated !== 0) {
    fs.writeFileSync(jsonPath, `${hasBom ? "﻿" : ""}${JSON.stringify(data, null, 2)}\n`, "utf8");
  }
  return { updated: verifyOnly ? 0 : updated, verified };
}

function patchGameSwz(swzPath: string, verifyOnly: boolean): DummyBossStats {
  const ctx = parseSwz(swzPath);
  const chunk = ctx.chunks.find((entry) => entry.xml.includes("<EntTypes"));
  if (!chunk) {
    throw new SwzPatchError(`${path.basename(swzPath)} missing EntTypes`);
  }

  const original = chunk.xml;
  if (verifyOnly) {
    return assertHomeDummyBossXml(original, path.basename(swzPath));
  }

  const patched = patchHomeDummyBossXml(original);
  if (patched.xml !== original) {
    ensureBackup(swzPath);
    chunk.xml = patched.xml;
    writeSwz(ctx);
  }
  return assertHomeDummyBossXml(patched.xml, path.basename(swzPath));
}

function main(): void {
  const args = process.argv.slice(2);
  const verifyOnly = args.includes("--verify");
  const xmlPath = resolveArgPath(args, "--xml-path", defaultSourceXmlPath());
  const jsonPaths = resolveArgPaths(args, "--json-path", defaultServerJsonPaths());
  const swzPaths = resolveArgPaths(args, "--swz-path", defaultGameSwzPaths());

  console.log(`XML: ${xmlPath}`);
  console.log(JSON.stringify(patchSourceXml(xmlPath, verifyOnly)));

  for (const jsonPath of jsonPaths) {
    console.log(`JSON: ${jsonPath}`);
    console.log(JSON.stringify(patchServerJson(jsonPath, verifyOnly)));
  }

  for (const swzPath of swzPaths) {
    console.log(`SWZ: ${swzPath}`);
    console.log(JSON.stringify(patchGameSwz(swzPath, verifyOnly)));
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[patch_gameswz_home_dummy_bosses] ${message}`);
    process.exitCode = 1;
  }
}
