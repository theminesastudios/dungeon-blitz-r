import { strict as assert } from 'assert';
import fs from 'fs';
import path from 'path';
import { Character } from '../database/Database';
import { DialogueTranslationLoader } from '../data/DialogueTranslationLoader';
import { GlobalState } from '../core/GlobalState';
import { EntityTeam } from '../core/Entity';
import { SocialHandler } from '../handlers/SocialHandler';
import { LevelHandler } from '../handlers/LevelHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { BitReader } from '../network/protocol/bitReader';

type SentPacket = {
    id: number;
    payload: Buffer;
};

type FakeClient = {
    userId: number | null;
    character: Character;
    characters: Character[];
    sentPackets: SentPacket[];
    token?: number;
    currentLevel?: string;
    levelInstanceId?: string;
    playerSpawned?: boolean;
    entities: Map<number, any>;
    send: (id: number, payload: Buffer) => void;
    sendBitBuffer: (id: number, bb: BitBuffer) => void;
};

function createFakeClient(): FakeClient {
    const sentPackets: SentPacket[] = [];
    const character: Character = {
        name: 'LanguageTester',
        class: 'Paladin',
        gender: 'male',
        level: 1,
        dialogueLanguage: 'en'
    };

    return {
        userId: null,
        character,
        characters: [character],
        sentPackets,
        entities: new Map(),
        send(id: number, payload: Buffer) {
            sentPackets.push({ id, payload: Buffer.from(payload) });
        },
        sendBitBuffer(id: number, bb: BitBuffer) {
            sentPackets.push({ id, payload: bb.toBuffer() });
        }
    };
}

function createPublicChatPacket(message: string): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod9(0);
    bb.writeMethod13(message);
    return bb.toBuffer();
}

function decodeChatStatus(payload: Buffer): string {
    const br = new BitReader(payload);
    return br.readMethod13();
}

function createRoomThoughtPacket(entityId: number, text: string): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(entityId);
    bb.writeMethod13(text);
    return bb.toBuffer();
}

function decodeRoomThought(payload: Buffer): { entityId: number; text: string } {
    const br = new BitReader(payload);
    return {
        entityId: br.readMethod4(),
        text: br.readMethod13()
    };
}

async function testLanguageCommandSwitchesToTurkishWithoutBroadcasting(): Promise<void> {
    const client = createFakeClient();

    await SocialHandler.handlePublicChat(client as never, createPublicChatPacket('/lang: tr'));

    assert.equal(client.character.dialogueLanguage, 'tr');
    assert.equal(client.sentPackets.some((packet) => packet.id === 0x2c), false);

    const statusPacket = client.sentPackets.find((packet) => packet.id === 0x44);
    assert.ok(statusPacket, 'language command should send a local status message');
    assert.equal(
        decodeChatStatus(statusPacket!.payload),
        'NPC dialog dili Turkce olarak ayarlandi.'
    );
}

async function testLanguageCommandSwitchesBackToEnglish(): Promise<void> {
    const client = createFakeClient();
    client.character.dialogueLanguage = 'tr';

    await SocialHandler.handlePublicChat(client as never, createPublicChatPacket('/lang:en'));

    assert.equal(client.character.dialogueLanguage, 'en');

    const statusPacket = client.sentPackets.find((packet) => packet.id === 0x44);
    assert.ok(statusPacket, 'language command should acknowledge the language switch');
    assert.equal(
        decodeChatStatus(statusPacket!.payload),
        'NPC dialog language set to English.'
    );
}

function testTurkishDialogueFilesCoverAllSourceDialogue(): void {
    const dataDir = path.resolve(__dirname, '../data');
    const missions = JSON.parse(fs.readFileSync(path.join(dataDir, 'MissionTypes.json'), 'utf8')) as Array<Record<string, unknown>>;
    const missionTr = JSON.parse(fs.readFileSync(path.join(dataDir, 'MissionDialogues.tr.json'), 'utf8')) as {
        missions?: Record<string, Record<string, unknown>>;
    };
    const npcSource = JSON.parse(fs.readFileSync(path.join(dataDir, 'NpcDialogues.json'), 'utf8')) as {
        levels?: Record<string, Record<string, unknown>>;
    };
    const npcTr = JSON.parse(fs.readFileSync(path.join(dataDir, 'NpcDialogues.tr.json'), 'utf8')) as {
        levels?: Record<string, Record<string, { defaultLines?: unknown[]; conditionalLines?: unknown[] }>>;
    };

    const dialogueFields = ['OfferText', 'ActiveText', 'ReturnText', 'PraiseText'] as const;
    const missingMissionFields: string[] = [];
    for (const mission of missions) {
        const missionId = String(mission.MissionID ?? '').trim();
        if (!missionId) {
            continue;
        }

        for (const field of dialogueFields) {
            if (!String(mission[field] ?? '').trim()) {
                continue;
            }

            if (!String(missionTr.missions?.[missionId]?.[field] ?? '').trim()) {
                missingMissionFields.push(`${missionId}.${field}`);
            }
        }
    }

    const missingNpcEntries: string[] = [];
    for (const [levelName, npcs] of Object.entries(npcSource.levels ?? {})) {
        for (const npcKey of Object.keys(npcs ?? {})) {
            const translated = npcTr.levels?.[levelName]?.[npcKey];
            if (!translated?.defaultLines?.length && !translated?.conditionalLines?.length) {
                missingNpcEntries.push(`${levelName}.${npcKey}`);
            }
        }
    }

    assert.deepEqual(missingMissionFields, [], 'Turkish mission dialogue should cover every source dialogue field');
    assert.deepEqual(missingNpcEntries, [], 'Turkish NPC dialogue should cover every source NPC entry');
}

function testTurkishRoomThoughtUsesTranslationTable(): void {
    const dataDir = path.resolve(__dirname, '../data');
    DialogueTranslationLoader.load(dataDir);

    const client = createFakeClient();
    client.character.dialogueLanguage = 'tr';
    client.token = 51001;
    client.currentLevel = 'CraftTownTutorial';
    client.levelInstanceId = '';
    client.playerSpawned = true;

    GlobalState.sessionsByToken.set(client.token, client as never);
    try {
        SocialHandler.handleRoomThought(
            client as never,
            createRoomThoughtPacket(77, 'To me! Protect your home!')
        );
    } finally {
        GlobalState.sessionsByToken.delete(client.token);
    }

    const packet = client.sentPackets.find((entry) => entry.id === 0x76);
    assert.ok(packet, 'Turkish room thought should be relayed as an NPC bubble');
    assert.deepEqual(decodeRoomThought(packet!.payload), {
        entityId: 77,
        text: 'Bana gelin! Yuvanizi koruyun!'
    });
}

function testTurkishRoomThoughtFallbackPreventsEnemyEnglish(): void {
    const dataDir = path.resolve(__dirname, '../data');
    DialogueTranslationLoader.load(dataDir);

    const client = createFakeClient();
    client.character.dialogueLanguage = 'tr';
    client.token = 51002;
    client.currentLevel = 'CraftTownTutorial';
    client.levelInstanceId = '';
    client.playerSpawned = true;
    client.entities.set(88, {
        id: 88,
        name: 'FallbackEnemy',
        team: EntityTeam.ENEMY
    });

    GlobalState.sessionsByToken.set(client.token, client as never);
    try {
        SocialHandler.handleRoomThought(
            client as never,
            createRoomThoughtPacket(88, 'Untranslated enemy sentence!')
        );
    } finally {
        GlobalState.sessionsByToken.delete(client.token);
    }

    const packet = client.sentPackets.find((entry) => entry.id === 0x76);
    assert.ok(packet, 'enemy room thought should still be relayed');
    assert.equal(decodeRoomThought(packet!.payload).text, 'Saldirin!');
}

function testSpecificDungeonRoomThoughtTranslation(): void {
    const dataDir = path.resolve(__dirname, '../data');
    DialogueTranslationLoader.load(dataDir);

    const client = createFakeClient();
    client.character.dialogueLanguage = 'tr';
    client.token = 51004;
    client.currentLevel = 'SD_Mission2';
    client.levelInstanceId = '';
    client.playerSpawned = true;

    GlobalState.sessionsByToken.set(client.token, client as never);
    try {
        SocialHandler.handleRoomThought(
            client as never,
            createRoomThoughtPacket(79, 'This temple is ancient. I wonder who built that')
        );
    } finally {
        GlobalState.sessionsByToken.delete(client.token);
    }

    const packet = client.sentPackets.find((entry) => entry.id === 0x76);
    assert.ok(packet, 'specific dungeon room thought should be relayed');
    assert.deepEqual(decodeRoomThought(packet!.payload), {
        entityId: 79,
        text: 'Bu tapinak cok eski. Acaba bunu kim yapti'
    });
}

function testSplitDungeonRoomThoughtTranslation(): void {
    const dataDir = path.resolve(__dirname, '../data');
    DialogueTranslationLoader.load(dataDir);

    const client = createFakeClient();
    client.character.dialogueLanguage = 'tr';
    client.token = 51005;
    client.currentLevel = 'SD_Mission2';
    client.levelInstanceId = '';
    client.playerSpawned = true;

    GlobalState.sessionsByToken.set(client.token, client as never);
    try {
        SocialHandler.handleRoomThought(
            client as never,
            createRoomThoughtPacket(80, 'I wonder who built it?')
        );
    } finally {
        GlobalState.sessionsByToken.delete(client.token);
    }

    const packet = client.sentPackets.find((entry) => entry.id === 0x76);
    assert.ok(packet, 'split dungeon room thought should be relayed');
    assert.deepEqual(decodeRoomThought(packet!.payload), {
        entityId: 80,
        text: 'Acaba bunu kim yapti?'
    });
}

function testLevelHandlerRoomThoughtUsesRecipientLanguage(): void {
    const dataDir = path.resolve(__dirname, '../data');
    DialogueTranslationLoader.load(dataDir);

    const client = createFakeClient();
    client.character.dialogueLanguage = 'tr';
    client.token = 51003;
    client.currentLevel = 'CraftTownTutorial';
    client.levelInstanceId = '';
    client.playerSpawned = true;

    GlobalState.sessionsByToken.set(client.token, client as never);
    GlobalState.levelEntities.set('CraftTownTutorial', new Map([
        [99, { id: 99, name: 'TutorialBoss', team: EntityTeam.ENEMY }]
    ]));

    try {
        (LevelHandler as any).sendRoomThought(
            'CraftTownTutorial',
            99,
            'I will not fall! To me, brothers!',
            ''
        );
    } finally {
        GlobalState.sessionsByToken.delete(client.token);
        GlobalState.levelEntities.delete('CraftTownTutorial');
    }

    const packet = client.sentPackets.find((entry) => entry.id === 0x76);
    assert.ok(packet, 'server-authored room thought should be sent');
    assert.deepEqual(decodeRoomThought(packet!.payload), {
        entityId: 99,
        text: 'Dusmeyecegim! Bana gelin kardesler!'
    });
}

async function main(): Promise<void> {
    await testLanguageCommandSwitchesToTurkishWithoutBroadcasting();
    await testLanguageCommandSwitchesBackToEnglish();
    testTurkishDialogueFilesCoverAllSourceDialogue();
    testTurkishRoomThoughtUsesTranslationTable();
    testTurkishRoomThoughtFallbackPreventsEnemyEnglish();
    testSpecificDungeonRoomThoughtTranslation();
    testSplitDungeonRoomThoughtTranslation();
    testLevelHandlerRoomThoughtUsesRecipientLanguage();
    console.log('dialogue_language_regression: ok');
}

void main().catch((error) => {
    console.error('dialogue_language_regression: failed');
    console.error(error);
    process.exitCode = 1;
});
