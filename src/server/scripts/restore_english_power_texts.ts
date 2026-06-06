import * as fs from "fs";
import * as path from "path";
import { parseSwz, writeSwz } from "./swzPatchUtils";

const ROOT = path.resolve(__dirname, "..", "..", "..");
const CBQ_DIR = path.join(ROOT, "src", "client", "content", "localhost", "p", "cbq");
const XML_DIR = path.join(ROOT, "src", "client", "content", "xml");
const BACKUP_SWZ = path.join(CBQ_DIR, "Game.swz.bak");
const TEXT_TAGS = ["DisplayName", "Description", "UpgradeDescription"] as const;
const DRAGON_SOUL_DESCRIPTION =
  "Summon a Spirit of Flame that copies your Fire Brand shots and shoots at your targets. Gain increased damage for the duration.";

type TextTag = (typeof TEXT_TAGS)[number];
type TextMap = Map<string, Partial<Record<TextTag, string>>>;

function collectRecordTexts(xml: string, recordTag: string, keyPattern: RegExp): TextMap {
  const records: TextMap = new Map();
  const recordPattern = new RegExp(`<${recordTag}\\b[\\s\\S]*?<\\/${recordTag}>`, "g");

  for (const match of xml.matchAll(recordPattern)) {
    const record = match[0];
    const key = keyPattern.exec(record)?.[1];
    if (!key) {
      continue;
    }

    const texts: Partial<Record<TextTag, string>> = {};
    for (const tag of TEXT_TAGS) {
      const text = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`).exec(record)?.[1];
      if (text !== undefined) {
        texts[tag] = text;
      }
    }

    records.set(key, texts);
  }

  return records;
}

function replaceTag(record: string, tag: TextTag, value: string): string {
  const pattern = new RegExp(`<${tag}>[\\s\\S]*?<\\/${tag}>`);
  if (pattern.test(record)) {
    return record.replace(pattern, `<${tag}>${value}</${tag}>`);
  }

  return record;
}

function restoreRecordTexts(xml: string, recordTag: string, keyPattern: RegExp, sourceTexts: TextMap): string {
  const recordPattern = new RegExp(`<${recordTag}\\b[\\s\\S]*?<\\/${recordTag}>`, "g");

  return xml.replace(recordPattern, (record) => {
    const key = keyPattern.exec(record)?.[1];
    if (!key) {
      return record;
    }

    const source = sourceTexts.get(key);
    if (!source) {
      return record;
    }

    let updated = record;
    for (const tag of TEXT_TAGS) {
      const value = source[tag];
      if (value !== undefined) {
        updated = replaceTag(updated, tag, value);
      }
    }

    return updated;
  });
}

function setTextForRecord(xml: string, recordTag: string, keyTag: string, key: string, tag: TextTag, value: string): string {
  const recordPattern = new RegExp(`<${recordTag}\\b[\\s\\S]*?<\\/${recordTag}>`, "g");

  return xml.replace(recordPattern, (record) => {
    if (!new RegExp(`<${keyTag}>${key}<\\/${keyTag}>`).test(record)) {
      return record;
    }

    return replaceTag(record, tag, value);
  });
}

function setTextForPower(xml: string, powerName: string, tag: TextTag, value: string): string {
  const recordPattern = new RegExp(`<Power\\b[^>]*\\bPowerName="${powerName}"[\\s\\S]*?<\\/Power>`, "g");
  return xml.replace(recordPattern, (record) => replaceTag(record, tag, value));
}

function applyCurrentEnglishPowerDescriptions(xml: string): string {
  let updated = xml;

  for (const suffix of ["", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]) {
    updated = setTextForPower(updated, `SummonDragonSoul${suffix}`, "Description", DRAGON_SOUL_DESCRIPTION);
  }
  updated = setTextForPower(updated, "SummonDragonSoul1", "UpgradeDescription", DRAGON_SOUL_DESCRIPTION);

  return updated;
}

function applyCurrentEnglishTalentDescriptions(xml: string): string {
  let updated = xml;

  updated = setTextForRecord(
    updated,
    "PowerModType",
    "ModName",
    "BurnDmg1",
    "Description",
    "Increases Burn Damage@Burn Damage:, +7%, +14%, +21%, +28%, +35%"
  );
  updated = setTextForRecord(
    updated,
    "PowerModType",
    "ModName",
    "ChilblainsDmg1",
    "Description",
    "Increases Chilblains Damage@Chilblains Damage:, +4%, +12%, +24%, +40%, +50%"
  );
  updated = setTextForRecord(
    updated,
    "PowerModType",
    "ModName",
    "DryIce1",
    "Description",
    "Increases Ice damage based on your Expertise.@Damage (%Expertise):, 75%, 150%, 250%, 375%, 500%"
  );
  updated = setTextForRecord(
    updated,
    "PowerModType",
    "ModName",
    "IceCasket1",
    "Description",
    "Increases Freeze Durability based on your Expertise.@Durability (%Expertise):, 100%, 200%, 300%, 400%, 500%"
  );
  updated = setTextForRecord(
    updated,
    "PowerModType",
    "ModName",
    "ColdHeart1",
    "Description",
    "Reduces the target's healing effects.@Healing Reduction:, 10%, 20%, 30%, 40%, 50%"
  );
  updated = setTextForRecord(
    updated,
    "PowerModType",
    "ModName",
    "IgniteCrit1",
    "Description",
    "Gain a Poison Damage bonus against Cursed targets.@Poison Damage Bonus:, 2%, 4%, 6%, 8%, 10%"
  );
  updated = setTextForRecord(
    updated,
    "PowerModType",
    "ModName",
    "PoisonDmg1",
    "Description",
    "Increases Poison Damage@Poison Damage:, +7%, +14%, +21%, +28%, +35%"
  );

  return updated;
}

function restorePowerTexts(playerPowerXml: string, powerModXml: string, backupPlayerPowerXml: string, backupPowerModXml: string): { playerPowerXml: string; powerModXml: string } {
  const powerTexts = collectRecordTexts(backupPlayerPowerXml, "Power", /<Power\b[^>]*\bPowerName="([^"]+)"/);
  const modTexts = collectRecordTexts(backupPowerModXml, "PowerModType", /<ModName>([^<]+)<\/ModName>/);

  return {
    playerPowerXml: applyCurrentEnglishPowerDescriptions(
      restoreRecordTexts(playerPowerXml, "Power", /<Power\b[^>]*\bPowerName="([^"]+)"/, powerTexts)
    ),
    powerModXml: applyCurrentEnglishTalentDescriptions(
      restoreRecordTexts(powerModXml, "PowerModType", /<ModName>([^<]+)<\/ModName>/, modTexts)
    ),
  };
}

function backupChunks(): { playerPowerXml: string; powerModXml: string } {
  const backup = parseSwz(BACKUP_SWZ);
  const playerPowerXml = backup.chunks.find((chunk) => /<PlayerPowerTypes\b/.test(chunk.xml))?.xml;
  const powerModXml = backup.chunks.find((chunk) => /<PowerModTypes\b/.test(chunk.xml))?.xml;
  if (!playerPowerXml || !powerModXml) {
    throw new Error("Game.swz.bak must contain PlayerPowerTypes and PowerModTypes chunks");
  }

  return { playerPowerXml, powerModXml };
}

function patchXmlFiles(backupPlayerPowerXml: string, backupPowerModXml: string): void {
  const playerPowerPath = path.join(XML_DIR, "PlayerPowerTypes.xml");
  const powerModPath = path.join(XML_DIR, "PowerModTypes.xml");
  const result = restorePowerTexts(
    fs.readFileSync(playerPowerPath, "utf8"),
    fs.readFileSync(powerModPath, "utf8"),
    backupPlayerPowerXml,
    backupPowerModXml
  );

  fs.writeFileSync(playerPowerPath, result.playerPowerXml);
  fs.writeFileSync(powerModPath, result.powerModXml);
}

function patchSwzFiles(backupPlayerPowerXml: string, backupPowerModXml: string): void {
  for (const fileName of ["Game.swz", "Game.en.swz"]) {
    const swzPath = path.join(CBQ_DIR, fileName);
    const ctx = parseSwz(swzPath);
    const playerPowerChunk = ctx.chunks.find((chunk) => /<PlayerPowerTypes\b/.test(chunk.xml));
    const powerModChunk = ctx.chunks.find((chunk) => /<PowerModTypes\b/.test(chunk.xml));
    if (!playerPowerChunk || !powerModChunk) {
      throw new Error(`${fileName} must contain PlayerPowerTypes and PowerModTypes chunks`);
    }

    const result = restorePowerTexts(playerPowerChunk.xml, powerModChunk.xml, backupPlayerPowerXml, backupPowerModXml);
    playerPowerChunk.xml = result.playerPowerXml;
    powerModChunk.xml = result.powerModXml;
    writeSwz(ctx);
    console.log(`Restored English power text in ${fileName}`);
  }
}

function main(): void {
  const backup = backupChunks();
  patchXmlFiles(backup.playerPowerXml, backup.powerModXml);
  patchSwzFiles(backup.playerPowerXml, backup.powerModXml);
}

main();
