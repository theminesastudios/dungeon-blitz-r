import * as zlib from 'zlib';
import {
    applyPatchesToBody,
    classIndexByName,
    disassemble,
    methodIdxForTrait,
    parseAbc,
    parseSwf,
    u30OperandName,
    writeU30
} from '../scripts/swfPatchUtils';
import { Config } from './config';

export type DungeonBlitzSwfMode = 'local' | 'multiplayer';
export type DungeonBlitzSwfLocale = 'en' | 'tr';

const LOCAL_HOST = 'localhost';
const REMOTE_HOST = Config.MULTIPLAYER_HOST;
const LOCAL_ASSET_PATH = ':8000/p/';
const REMOTE_ASSET_PATH = '/p/';
const OLD_LOCAL_REFRESH_URL = 'http://localhost:8000/p/cbp/DungeonBlitz.swf?fv=cbq&gv=cbp';
const OLD_LOCAL_REFRESH_URL_LEGACY = 'http://localhost/p/cbp/DungeonBlitz.swf?fv=cbq&gv=cbp';
const OLD_REMOTE_REFRESH_URL = `http://${REMOTE_HOST}/p/cbp/DungeonBlitz.swf?fv=cbq&gv=cbp`;
const OLD_REMOTE_REFRESH_URL_LEGACY = `http://${REMOTE_HOST}/p/cbp/DungeonBlitz.swf?fv=cbq&gv=cbp`;
const PREVIOUS_LOCAL_REFRESH_URL = 'http://localhost:8000/p/cbp/DungeonBlitz.swf?fv=cbu&gv=cbt';
const PREVIOUS_LOCAL_REFRESH_URL_LEGACY = 'http://localhost/p/cbp/DungeonBlitz.swf?fv=cbu&gv=cbt';
const PREVIOUS_REMOTE_REFRESH_URL = `http://${REMOTE_HOST}/p/cbp/DungeonBlitz.swf?fv=cbu&gv=cbt`;
const PREVIOUS_REMOTE_REFRESH_URL_LEGACY = `http://${REMOTE_HOST}/p/cbp/DungeonBlitz.swf?fv=cbu&gv=cbt`;
const CURRENT_PREVIOUS_LOCAL_REFRESH_URL = 'http://localhost:8000/p/cbp/DungeonBlitz.swf?fv=cbv&gv=cbu';
const CURRENT_PREVIOUS_LOCAL_REFRESH_URL_LEGACY = 'http://localhost/p/cbp/DungeonBlitz.swf?fv=cbv&gv=cbu';
const CURRENT_PREVIOUS_REMOTE_REFRESH_URL = `http://${REMOTE_HOST}/p/cbp/DungeonBlitz.swf?fv=cbv&gv=cbu`;
const CURRENT_PREVIOUS_REMOTE_REFRESH_URL_LEGACY = `http://${REMOTE_HOST}/p/cbp/DungeonBlitz.swf?fv=cbv&gv=cbu`;
const LOCAL_REFRESH_URL = 'http://localhost:8000/p/cbp/DungeonBlitz.swf?fv=cbw&gv=cbv';
const LOCAL_REFRESH_URL_LEGACY = 'http://localhost/p/cbp/DungeonBlitz.swf?fv=cbw&gv=cbv';
const REMOTE_REFRESH_URL = `http://${REMOTE_HOST}/p/cbp/DungeonBlitz.swf?fv=cbw&gv=cbv`;
const REMOTE_REFRESH_URL_LEGACY = `http://${REMOTE_HOST}/p/cbp/DungeonBlitz.swf?fv=cbw&gv=cbv`;
const MOUNT_SPEED_PATCH_CLASS = 'CombatState';
const MOUNT_SPEED_PATCH_METHOD = 'method_960';
const MOUNT_SPEED_DUNGEON_FLAG = 'bInstanced';

type StringReplacement = {
    oldValue: string;
    newValue: string;
};

const TURKISH_DISCIPLINE_REPLACEMENTS: StringReplacement[] = [
    {
        oldValue: 'Blessed by the Storm Gods, you draw enemy wrath upon your impregnable form and focus the tempest until you become the Lightning Avatar and smite all who stand before you.',
        newValue: 'Firtina Tanrilari tarafindan kutsanmis olarak dusmanlarin ofkesini sarsilmaz bedenine cekersin; firtinayi odaklayip Simsek Avatarina donusur, karsina cikan herkesi cezalandirirsin.'
    },
    {
        oldValue: 'With righteous fury from the Flame of Justice coursing through your body, you leap into the fray, a blaze of attacks swirling through the enemy ranks.',
        newValue: 'Adalet Alevi bedeninde dolasan hakli ofkeyle savasa atlarsin; dusman saflarinin icinde alevli saldirilarla donersin.'
    },
    {
        oldValue: 'Infused with the Numinous Essence, you shine a searing, sacred light into the darkest places, healing the worthy and inflicting blinding agony upon the wicked.',
        newValue: 'Numinous Oz ile dolarak en karanlik yerlere yakici kutsal isik sacarsin; layik olanlari iyilestirir, kotulere kor edici aci verirsin.'
    },
    {
        oldValue: 'You have forsaken all safety for the Pure Death; you know the perfect strike, the incurable venom, the hidden cut that dooms your chosen foe to certain annihilation.',
        newValue: 'Saf Olum ugruna tum guvenligi biraktin; kusursuz darbeyi, caresiz zehri ve sectigin dusmani kesin yok olusa goturen gizli kesigi bilirsin.'
    },
    {
        oldValue: 'You have sacrificed yourself to the Shadow Court, becoming a deadly trickster who strikes from afar, appears everywhere at once, and terrorizes enemies from the darkness.',
        newValue: 'Kendini Golge Sarayi\'na adadin; uzaktan vuran, ayni anda her yerde beliren ve karanliktan dusmanlara dehset salan olumcul bir hilekara donustun.'
    },
    {
        oldValue: 'You have mastered the heresies of the Codex Carnifex; you know that true pain comes with the death of the soul and that true victory takes a foe’s life force as your dark reward.',
        newValue: 'Codex Carnifex\'in sapkin ogretilerinde ustalastin; gercek acinin ruhun olumunden geldigini ve gercek zaferin dusmanin yasam gucunu karanlik odul olarak almak oldugunu bilirsin.'
    },
    {
        oldValue: 'Touched by an Essence of Fire, you throw caution to the wind with every explosive inferno you unleash upon the enemy, incinerating all but leaving you vulnerable among the ashes.',
        newValue: 'Ates Ozunun dokundugu biri olarak, saldigin her patlayici cehennemle tedbiri elden birakirsin; dusmani yakip kul eder ama kullerin arasinda savunmasiz kalirsin.'
    },
    {
        oldValue: 'Channeling the Eternal Winter, your icy conjurations keep the enemy hordes at bay and protect you from harm while a frozen doom descends upon all who oppose you.',
        newValue: 'Ebedi Kisi kanalize ederek buzlu yaratilimlarinla dusman surulerini uzakta tutar, sana zarar gelmesini onlersin; karsi koyanlarin uzerine donmus bir son coker.'
    },
    {
        oldValue: 'Tainted by the Curse of Undeath, you fear no foe, raising armies of hungry ghouls to feast upon your unfortunate enemies, your own power and immortal essence grows with every victim they claim.',
        newValue: 'Olumsuzluk Lanetiyle lekelenmis olarak hicbir dusmandan korkmazsin; talihsiz dusmanlarina saldirdigin ac gulyabani ordulari kurarsin ve aldiklari her kurbanla gucun ve olumsuz ozun buyur.'
    },
    { oldValue: 'Wizardry Guild', newValue: 'Buyuculuk Loncasi' },
    { oldValue: 'Winter Order', newValue: 'Kis Tarikati' },
    { oldValue: 'Infernal Circle', newValue: 'Cehennem Cemberi' },
    { oldValue: 'Accursed Coven', newValue: 'Lanetli Meclis' },
    { oldValue: 'Tricks o’ Trade', newValue: 'Meslegin Hileleri' },
    { oldValue: 'Ambush & Onslaught', newValue: 'Pusu ve Taarruz' },
    { oldValue: 'From the Shadows', newValue: 'Golgelerden' },
    { oldValue: 'The Dark Arts', newValue: 'Kara Sanatlar' },
    { oldValue: 'Martial Techniques', newValue: 'Savas Teknikleri' },
    { oldValue: 'Chivalric Prowess', newValue: 'Sovalye Mahareti' },
    { oldValue: 'Sacred Castigations', newValue: 'Kutsal Cezalar' },
    { oldValue: 'Theurgical Devotions', newValue: 'Ilahi Adanmalar' },
    { oldValue: 'Discipline Masteries', newValue: 'Disiplin Ustaligi' }
];

// The original SWF had English disconnect strings ("Lost Connection", "Client
// Error") but they were overwritten with Turkish ("Baglanti Koptu", "Istemci
// Hatasi") directly in the string pool, so every locale sees Turkish text.
const DISCONNECT_SCREEN_RESTORE_ENGLISH: StringReplacement[] = [
    { oldValue: 'Baglanti Koptu', newValue: 'Lost Connection' },
    { oldValue: 'Istemci Hatasi', newValue: 'Client Error' },
];

function getReplacements(mode: DungeonBlitzSwfMode, locale: DungeonBlitzSwfLocale): StringReplacement[] {
    const localeReplacements = locale === 'tr'
        ? TURKISH_DISCIPLINE_REPLACEMENTS
        : DISCONNECT_SCREEN_RESTORE_ENGLISH;
    if (mode === 'local') {
        return [
            { oldValue: REMOTE_HOST, newValue: LOCAL_HOST },
            { oldValue: REMOTE_ASSET_PATH, newValue: LOCAL_ASSET_PATH },
            { oldValue: OLD_REMOTE_REFRESH_URL, newValue: LOCAL_REFRESH_URL },
            { oldValue: OLD_REMOTE_REFRESH_URL_LEGACY, newValue: LOCAL_REFRESH_URL },
            { oldValue: OLD_LOCAL_REFRESH_URL, newValue: LOCAL_REFRESH_URL },
            { oldValue: OLD_LOCAL_REFRESH_URL_LEGACY, newValue: LOCAL_REFRESH_URL },
            { oldValue: PREVIOUS_REMOTE_REFRESH_URL, newValue: LOCAL_REFRESH_URL },
            { oldValue: PREVIOUS_REMOTE_REFRESH_URL_LEGACY, newValue: LOCAL_REFRESH_URL },
            { oldValue: PREVIOUS_LOCAL_REFRESH_URL, newValue: LOCAL_REFRESH_URL },
            { oldValue: PREVIOUS_LOCAL_REFRESH_URL_LEGACY, newValue: LOCAL_REFRESH_URL },
            { oldValue: CURRENT_PREVIOUS_REMOTE_REFRESH_URL, newValue: LOCAL_REFRESH_URL },
            { oldValue: CURRENT_PREVIOUS_REMOTE_REFRESH_URL_LEGACY, newValue: LOCAL_REFRESH_URL },
            { oldValue: CURRENT_PREVIOUS_LOCAL_REFRESH_URL, newValue: LOCAL_REFRESH_URL },
            { oldValue: CURRENT_PREVIOUS_LOCAL_REFRESH_URL_LEGACY, newValue: LOCAL_REFRESH_URL },
            { oldValue: REMOTE_REFRESH_URL, newValue: LOCAL_REFRESH_URL },
            { oldValue: REMOTE_REFRESH_URL_LEGACY, newValue: LOCAL_REFRESH_URL },
            { oldValue: LOCAL_REFRESH_URL_LEGACY, newValue: LOCAL_REFRESH_URL },
            ...localeReplacements
        ];
    }

    return [
        { oldValue: LOCAL_HOST, newValue: REMOTE_HOST },
        { oldValue: LOCAL_ASSET_PATH, newValue: REMOTE_ASSET_PATH },
        { oldValue: OLD_LOCAL_REFRESH_URL, newValue: REMOTE_REFRESH_URL },
        { oldValue: OLD_LOCAL_REFRESH_URL_LEGACY, newValue: REMOTE_REFRESH_URL },
        { oldValue: OLD_REMOTE_REFRESH_URL, newValue: REMOTE_REFRESH_URL },
        { oldValue: OLD_REMOTE_REFRESH_URL_LEGACY, newValue: REMOTE_REFRESH_URL },
        { oldValue: PREVIOUS_LOCAL_REFRESH_URL, newValue: REMOTE_REFRESH_URL },
        { oldValue: PREVIOUS_LOCAL_REFRESH_URL_LEGACY, newValue: REMOTE_REFRESH_URL },
        { oldValue: PREVIOUS_REMOTE_REFRESH_URL, newValue: REMOTE_REFRESH_URL },
        { oldValue: PREVIOUS_REMOTE_REFRESH_URL_LEGACY, newValue: REMOTE_REFRESH_URL },
        { oldValue: CURRENT_PREVIOUS_LOCAL_REFRESH_URL, newValue: REMOTE_REFRESH_URL },
        { oldValue: CURRENT_PREVIOUS_LOCAL_REFRESH_URL_LEGACY, newValue: REMOTE_REFRESH_URL },
        { oldValue: CURRENT_PREVIOUS_REMOTE_REFRESH_URL, newValue: REMOTE_REFRESH_URL },
        { oldValue: CURRENT_PREVIOUS_REMOTE_REFRESH_URL_LEGACY, newValue: REMOTE_REFRESH_URL },
        { oldValue: LOCAL_REFRESH_URL, newValue: REMOTE_REFRESH_URL },
        { oldValue: REMOTE_REFRESH_URL_LEGACY, newValue: REMOTE_REFRESH_URL },
        { oldValue: LOCAL_REFRESH_URL_LEGACY, newValue: REMOTE_REFRESH_URL },
        ...localeReplacements
    ];
}

function buildMountedSpeedPatch(ctx: ReturnType<typeof parseSwf>) {
    const abc = parseAbc(ctx);
    const classIndex = classIndexByName(abc, MOUNT_SPEED_PATCH_CLASS);
    if (classIndex === null) {
        throw new Error(`${MOUNT_SPEED_PATCH_CLASS} class not found in ${ctx.path}`);
    }

    const methodIdx = methodIdxForTrait(abc.instances[classIndex].traits, abc, MOUNT_SPEED_PATCH_METHOD);
    if (methodIdx === null) {
        throw new Error(`${MOUNT_SPEED_PATCH_CLASS}.${MOUNT_SPEED_PATCH_METHOD} not found in ${ctx.path}`);
    }

    const methodBody = abc.methodBodies.get(methodIdx);
    if (!methodBody) {
        throw new Error(`${MOUNT_SPEED_PATCH_CLASS}.${MOUNT_SPEED_PATCH_METHOD} body not found in ${ctx.path}`);
    }

    const code = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
    const instructions = disassemble(code, `${MOUNT_SPEED_PATCH_CLASS}.${MOUNT_SPEED_PATCH_METHOD}`);
    const mountedGuardIndex = instructions.findIndex(
        (instruction) => u30OperandName(instruction, abc.multinameNames) === 'var_270'
    );
    if (mountedGuardIndex === -1) {
        throw new Error(`Mounted guard not found in ${MOUNT_SPEED_PATCH_CLASS}.${MOUNT_SPEED_PATCH_METHOD}`);
    }

    const dungeonFlagInstruction = instructions.find(
        (instruction, index) =>
            index > mountedGuardIndex &&
            instruction.opcode === 0x66 &&
            u30OperandName(instruction, abc.multinameNames) === MOUNT_SPEED_DUNGEON_FLAG
    );
    if (!dungeonFlagInstruction) {
        throw new Error(`${MOUNT_SPEED_DUNGEON_FLAG} access not found in ${MOUNT_SPEED_PATCH_CLASS}.${MOUNT_SPEED_PATCH_METHOD}`);
    }

    const patchedSequence = Buffer.from([0x29, 0x27, 0x02]);
    const currentSequence = code.subarray(
        dungeonFlagInstruction.offset,
        dungeonFlagInstruction.offset + patchedSequence.length
    );
    if (currentSequence.equals(patchedSequence)) {
        return [];
    }

    return [
        {
            key: `${MOUNT_SPEED_PATCH_CLASS}.${MOUNT_SPEED_PATCH_METHOD}.dungeonFlag`,
            start: methodBody.codeStart + dungeonFlagInstruction.offset,
            end: methodBody.codeStart + dungeonFlagInstruction.offset + patchedSequence.length,
            data: patchedSequence,
            detail: 'replace dungeon mount-speed flag read with false'
        }
    ];
}

export function buildDungeonBlitzSwfVariantBuffer(
    swfPath: string,
    mode: DungeonBlitzSwfMode,
    locale: DungeonBlitzSwfLocale = 'en'
): Buffer {
    const ctx = parseSwf(swfPath);
    const abc = parseAbc(ctx);
    const patches = [];

    for (const replacement of getReplacements(mode, locale)) {
        for (let index = 1; index < abc.stringValues.length; index++) {
            if (abc.stringValues[index] !== replacement.oldValue) {
                continue;
            }

            const replacementBytes = Buffer.from(replacement.newValue, 'utf8');
            const originalBytes = Buffer.from(replacement.oldValue, 'utf8');
            patches.push({
                key: `string:${replacement.oldValue}:${index}`,
                start: abc.stringLenPositions[index],
                end: abc.stringDataPositions[index] + originalBytes.length,
                data: Buffer.concat([writeU30(replacementBytes.length), replacementBytes]),
                detail: `${replacement.oldValue} -> ${replacement.newValue}`
            });
        }
    }

    patches.push(...buildMountedSpeedPatch(ctx));

    const { body, delta } = applyPatchesToBody(ctx.body, patches);
    const outBody = Buffer.from(body);
    if (delta !== 0) {
        outBody.writeUInt32LE(ctx.doabcLen + delta, ctx.doabcLenFieldPos);
    }

    const header = Buffer.alloc(8);
    header.write(ctx.signature, 0, 'ascii');
    header[3] = ctx.version;
    header.writeUInt32LE(8 + outBody.length, 4);

    return ctx.signature === 'CWS'
        ? Buffer.concat([header, zlib.deflateSync(outBody)])
        : Buffer.concat([header, outBody]);
}
