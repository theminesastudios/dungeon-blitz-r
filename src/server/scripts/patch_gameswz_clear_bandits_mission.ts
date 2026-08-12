import * as fs from 'fs';
import * as path from 'path';
import { ensureBackup, parseSwz, SwzPatchError, writeSwz } from './swzPatchUtils';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const CBQ_DIR = path.join(ROOT, 'src', 'client', 'content', 'localhost', 'p', 'cbq');
const LOOSE_MISSION_TYPES = path.join(ROOT, 'src', 'client', 'content', 'xml', 'MissionTypes.xml');
const MISSION_ID = '293';
const MISSION_NAME = 'ACTales6Embassy';
const GAME_ASSET_VERSION = 'cdr';
const MANIFEST_NAMES = ['masterFileList.xml', 'masterFileList_1.xml', 'masterFileList_2.xml'];
const MISSION_XML = `\t<MissionType>
\t\t<MissionName>ACTales6Embassy</MissionName>
\t\t<MissionID>293</MissionID>
\t\t<PreReqMissions>ACTales0GetStarted</PreReqMissions>
\t\t<ZoneSet>Castle</ZoneSet>
\t\t<Priority>Dungeon</Priority>
\t\t<ContactName>AC_Mayor01</ContactName>
\t\t<ReturnName>AC_Mayor01</ReturnName>
\t\t<CompleteCount>1</CompleteCount>
\t\t<Dungeon>AC_Tales5Embassy</Dungeon>
\t\t<MissionLevel>33</MissionLevel>
\t\t<ExpReward>M</ExpReward>
\t\t<GoldReward>M</GoldReward>
\t\t<DisplayName>TODO</DisplayName>
\t\t<TrackerText>TODO</TrackerText>
\t\t<TrackerReturn>TODO</TrackerReturn>
\t\t<Description>TODO</Description>
\t\t<OfferText>TODO</OfferText>
\t\t<ActiveText>TODO</ActiveText>
\t\t<ReturnText>TODO</ReturnText>
\t\t<PraiseText>YAPILACAKLAR</PraiseText>
\t</MissionType>`;

function defaultGameSwzPaths(): string[] {
    return ['Game.swz', 'Game.en.swz', 'Game.tr.swz']
        .map((fileName) => path.join(CBQ_DIR, fileName))
        .filter((swzPath) => fs.existsSync(swzPath));
}

function parseArgs(argv: string[]): { swzPaths: string[]; verify: boolean } {
    const swzPaths: string[] = [];
    let verify = false;

    for (let index = 2; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--verify' || arg === '--dry-run') {
            verify = true;
        } else if (arg === '--swz-path') {
            const value = argv[++index];
            if (!value) {
                throw new Error('--swz-path requires a value');
            }
            swzPaths.push(path.resolve(process.cwd(), value));
        } else {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }

    return { swzPaths: swzPaths.length ? swzPaths : defaultGameSwzPaths(), verify };
}

function getMissionEntries(xml: string): string[] {
    return xml.match(/<MissionType>[\s\S]*?<\/MissionType>/g) ?? [];
}

function getTag(entry: string, tagName: string): string {
    return entry.match(new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`))?.[1]?.trim() ?? '';
}

export function patchMissionTypes(xml: string): { xml: string; changed: boolean } {
    const entry = getMissionEntries(xml).find((candidate) => getTag(candidate, 'MissionID') === MISSION_ID);
    if (!entry) {
        throw new SwzPatchError(`MissionTypes is missing reserved mission slot ${MISSION_ID}`);
    }

    const replacement = MISSION_XML.trimStart();
    const nextXml = xml.replace(entry, replacement);
    return { xml: nextXml, changed: nextXml !== xml };
}

function verifyMissionTypes(xml: string, label: string): void {
    const entry = getMissionEntries(xml).find((candidate) => getTag(candidate, 'MissionID') === MISSION_ID);
    if (!entry || getTag(entry, 'MissionName') !== MISSION_NAME) {
        throw new SwzPatchError(`${label} is missing ${MISSION_NAME} in mission slot ${MISSION_ID}`);
    }
    for (const [tag, expected] of [
        ['PreReqMissions', 'ACTales0GetStarted'],
        ['ZoneSet', 'Castle'],
        ['Priority', 'Dungeon'],
        ['ContactName', 'AC_Mayor01'],
        ['ReturnName', 'AC_Mayor01'],
        ['CompleteCount', '1'],
        ['Dungeon', 'AC_Tales5Embassy'],
        ['DisplayName', 'TODO']
    ] as const) {
        if (getTag(entry, tag) !== expected) {
            throw new SwzPatchError(`${label} has invalid ${MISSION_NAME}.${tag}`);
        }
    }
}

function patchLooseMissionTypes(verifyOnly: boolean): boolean {
    const original = fs.readFileSync(LOOSE_MISSION_TYPES, 'utf8');
    const patched = patchMissionTypes(original);
    if (verifyOnly) {
        verifyMissionTypes(original, path.basename(LOOSE_MISSION_TYPES));
        return false;
    }
    if (patched.changed) {
        fs.writeFileSync(LOOSE_MISSION_TYPES, patched.xml, 'utf8');
    }
    verifyMissionTypes(patched.xml, path.basename(LOOSE_MISSION_TYPES));
    return patched.changed;
}

function patchSwz(swzPath: string, verifyOnly: boolean): boolean {
    const context = parseSwz(swzPath);
    const missionTypes = context.chunks.find((chunk) => /<MissionTypes[>\s]/.test(chunk.xml));
    if (!missionTypes) {
        throw new SwzPatchError(`${path.basename(swzPath)} is missing MissionTypes`);
    }

    if (verifyOnly) {
        verifyMissionTypes(missionTypes.xml, path.basename(swzPath));
        console.log(`${path.basename(swzPath)}: ${MISSION_NAME} ok`);
        return false;
    }

    const patched = patchMissionTypes(missionTypes.xml);
    if (patched.changed) {
        missionTypes.xml = patched.xml;
        ensureBackup(swzPath);
        writeSwz(context);
    }
    verifyMissionTypes(patched.xml, path.basename(swzPath));
    console.log(`${path.basename(swzPath)}: ${patched.changed ? 'patched' : 'already patched'}`);
    return patched.changed;
}

function patchManifest(manifestPath: string, verifyOnly: boolean): boolean {
    const xml = fs.readFileSync(manifestPath, 'utf8');
    const pattern = /(<File\s+Version=")[^"]+("\s+Stage="Game"\s+Size="[^"]+"\s+Name="Game\.swz"\s*\/>)/;
    if (!pattern.test(xml)) {
        throw new SwzPatchError(`${path.basename(manifestPath)} is missing the Game.swz entry`);
    }

    const nextXml = xml.replace(pattern, `$1${GAME_ASSET_VERSION}$2`);
    if (verifyOnly) {
        if (nextXml !== xml) {
            throw new SwzPatchError(`${path.basename(manifestPath)} does not use Game asset version ${GAME_ASSET_VERSION}`);
        }
        console.log(`${path.basename(manifestPath)}: Game asset version ok`);
        return false;
    }
    if (nextXml !== xml) {
        fs.writeFileSync(manifestPath, nextXml, 'utf8');
    }
    return nextXml !== xml;
}

function main(): void {
    const { swzPaths, verify } = parseArgs(process.argv);
    if (!swzPaths.length) {
        throw new SwzPatchError('No Game SWZ files found');
    }

    let changed = patchLooseMissionTypes(verify) ? 1 : 0;
    for (const swzPath of swzPaths) {
        changed += patchSwz(swzPath, verify) ? 1 : 0;
    }
    for (const manifestName of MANIFEST_NAMES) {
        changed += patchManifest(path.join(CBQ_DIR, manifestName), verify) ? 1 : 0;
    }
    if (!verify) {
        console.log(`Updated ${changed} Clear the Bandits client asset file(s).`);
    }
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error(`[patch_gameswz_clear_bandits_mission] ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    }
}
