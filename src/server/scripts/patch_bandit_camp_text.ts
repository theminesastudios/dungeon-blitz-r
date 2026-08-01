import * as fs from 'fs';
import * as path from 'path';
import { ensureBackup, parseSwz, writeSwz } from './swzPatchUtils';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const OLD_DREAD_DISPLAY = 'dehset Bandit Camp';
const NEW_DREAD_DISPLAY = 'Dread Bandit Camp';
const OLD_DESCRIPTION = 'The townsfolk shun aoutsiders, who often turn to banditry. To win their trust, you decide to tackle their bandit problem.';
const NEW_DESCRIPTION = 'The townsfolk shun outsiders, who often turn to banditry. To win their trust, you decide to tackle their bandit problem.';
// The game ships English only now; the per-locale archives are gone. Filter rather
// than drop the names, so restoring a localized build re-enables its patch on its own.
const GAME_SWZ_FILES = ['Game.swz', 'Game.en.swz', 'Game.tr.swz']
    .map((fileName) => path.join(ROOT, 'src', 'client', 'content', 'localhost', 'p', 'cbq', fileName))
    .filter((filePath) => fs.existsSync(filePath));
const BANDIT_MISSIONS = new Set(['DefeatBanditCamp', 'DefeatBanditCampHard']);

type PatchResult = {
    text: string;
    changes: number;
};

function replaceAllExact(text: string, from: string, to: string): PatchResult {
    const changes = text.split(from).length - 1;
    return {
        text: changes > 0 ? text.split(from).join(to) : text,
        changes
    };
}

function getMissionEntries(xml: string): string[] {
    return xml.match(/<MissionType>[\s\S]*?<\/MissionType>/g) ?? [];
}

function getTagValue(entry: string, tagName: string): string {
    return entry.match(new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`))?.[1]?.trim() ?? '';
}

function patchMissionXml(xml: string): PatchResult {
    let changes = 0;
    let nextXml = xml;

    for (const entry of getMissionEntries(xml)) {
        const missionName = getTagValue(entry, 'MissionName');
        if (!BANDIT_MISSIONS.has(missionName) || !entry.includes(OLD_DESCRIPTION)) {
            continue;
        }

        const patchedEntry = entry.split(OLD_DESCRIPTION).join(NEW_DESCRIPTION);
        nextXml = nextXml.replace(entry, patchedEntry);
        changes += 1;
    }

    return { text: nextXml, changes };
}

function verifyLevelXml(xml: string, label: string): void {
    if (xml.includes(OLD_DREAD_DISPLAY)) {
        throw new Error(`${label} still contains ${OLD_DREAD_DISPLAY}`);
    }
    const btMission1Hard = xml.match(/<LevelType LevelName="BT_Mission1Hard">[\s\S]*?<\/LevelType>/)?.[0] ?? '';
    if (!btMission1Hard.includes(`<DisplayName>${NEW_DREAD_DISPLAY}</DisplayName>`)) {
        throw new Error(`${label} does not expose ${NEW_DREAD_DISPLAY} for BT_Mission1Hard`);
    }
}

function verifyMissionXml(xml: string, label: string): void {
    if (xml.includes(OLD_DESCRIPTION)) {
        throw new Error(`${label} still contains aoutsiders typo`);
    }
    for (const entry of getMissionEntries(xml)) {
        const missionName = getTagValue(entry, 'MissionName');
        if (BANDIT_MISSIONS.has(missionName) && entry.includes('aoutsiders')) {
            throw new Error(`${label} ${missionName} still contains aoutsiders`);
        }
    }
}

function patchLooseLevelXml(verify: boolean): number {
    const filePath = path.join(ROOT, 'src', 'client', 'content', 'xml', 'LevelTypes.xml');
    const original = fs.readFileSync(filePath, 'utf8');
    if (verify) {
        verifyLevelXml(original, filePath);
        return 0;
    }

    const patched = replaceAllExact(original, OLD_DREAD_DISPLAY, NEW_DREAD_DISPLAY);
    if (patched.changes > 0) {
        fs.writeFileSync(filePath, patched.text, 'utf8');
    }
    verifyLevelXml(patched.text, filePath);
    return patched.changes;
}

function patchMissionJson(verify: boolean): number {
    const filePath = path.join(ROOT, 'src', 'server', 'data', 'MissionTypes.json');
    const original = fs.readFileSync(filePath, 'utf8');
    const patched = replaceAllExact(original, OLD_DESCRIPTION, NEW_DESCRIPTION);

    if (verify) {
        if (patched.changes > 0) {
            throw new Error(`${filePath} still contains ${patched.changes} aoutsiders typo(s)`);
        }
        return 0;
    }

    if (patched.changes > 0) {
        fs.writeFileSync(filePath, patched.text, 'utf8');
    }
    return patched.changes;
}

function patchDialogueTranslationKeys(verify: boolean): number {
    const filePath = path.join(ROOT, 'src', 'server', 'data', 'DialogueTranslations.tr.json');
    const original = fs.readFileSync(filePath, 'utf8');
    const oldKey = `"${OLD_DESCRIPTION}"`;
    const newKey = `"${NEW_DESCRIPTION}"`;
    if (!original.includes(oldKey)) {
        return 0;
    }

    if (verify) {
        throw new Error(`${filePath} still contains typo translation key`);
    }

    fs.writeFileSync(filePath, original.replace(oldKey, newKey), 'utf8');
    return 1;
}

function patchSwz(swzPath: string, verify: boolean): number {
    const ctx = parseSwz(swzPath);
    const levelTypes = ctx.chunks.find((chunk) => chunk.xml.match(/<LevelTypes[>\s]/));
    const missionTypes = ctx.chunks.find((chunk) => chunk.xml.match(/<MissionTypes[>\s]/));
    if (!levelTypes) {
        throw new Error(`${path.basename(swzPath)} is missing LevelTypes`);
    }
    if (!missionTypes) {
        throw new Error(`${path.basename(swzPath)} is missing MissionTypes`);
    }

    if (verify) {
        verifyLevelXml(levelTypes.xml, path.basename(swzPath));
        verifyMissionXml(missionTypes.xml, path.basename(swzPath));
        return 0;
    }

    let changes = 0;
    const patchedLevel = replaceAllExact(levelTypes.xml, OLD_DREAD_DISPLAY, NEW_DREAD_DISPLAY);
    if (patchedLevel.changes > 0) {
        levelTypes.xml = patchedLevel.text;
        changes += patchedLevel.changes;
    }

    const patchedMission = patchMissionXml(missionTypes.xml);
    if (patchedMission.changes > 0) {
        missionTypes.xml = patchedMission.text;
        changes += patchedMission.changes;
    }

    verifyLevelXml(levelTypes.xml, path.basename(swzPath));
    verifyMissionXml(missionTypes.xml, path.basename(swzPath));

    if (changes > 0) {
        ensureBackup(swzPath);
        writeSwz(ctx);
    }
    return changes;
}

function main(): void {
    const verify = process.argv.includes('--verify');
    let changes = 0;

    changes += patchLooseLevelXml(verify);
    changes += patchMissionJson(verify);
    changes += patchDialogueTranslationKeys(verify);
    for (const swzPath of GAME_SWZ_FILES) {
        changes += patchSwz(swzPath, verify);
    }

    console.log(`${verify ? 'Verified' : 'Patched'} Bandit Camp text (${changes} changes)`);
}

main();
