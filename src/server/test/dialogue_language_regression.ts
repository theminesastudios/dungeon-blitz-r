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

function getChatStatusTexts(client: FakeClient): string[] {
    return client.sentPackets
        .filter((packet) => packet.id === 0x44)
        .map((packet) => decodeChatStatus(packet.payload));
}

function createRoomThoughtPacket(entityId: number, text: string): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(entityId);
    bb.writeMethod13(text);
    return bb.toBuffer();
}

function createStartSkitPacket(entityId: number, text: string): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod9(entityId);
    bb.writeMethod15(false);
    bb.writeMethod26(text);
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
    assert.ok(
        getChatStatusTexts(client).includes('DB_LOCALIZATION_RELOAD:http://localhost:8000/p/cbp/DungeonBlitz.swf?fv=cbw&gv=cbv&lang=tr'),
        'language command should ask the patched client to reload the Turkish SWF variant'
    );
    assert.ok(
        getChatStatusTexts(client).includes('Language saved. In Adobe Flash Player, restart the game to apply everything.'),
        'language command should tell standalone Flash users to restart after saving the preference'
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
    assert.ok(
        getChatStatusTexts(client).includes('DB_LOCALIZATION_RELOAD:http://localhost:8000/p/cbp/DungeonBlitz.swf?fv=cbw&gv=cbv&lang=en'),
        'language command should ask the patched client to reload the English SWF variant'
    );
    assert.ok(
        getChatStatusTexts(client).includes('Language saved. In Adobe Flash Player, restart the game to apply everything.'),
        'language command should tell standalone Flash users to restart after saving the preference'
    );
}

async function testPortugueseLanguageCommandAliasesSwitchToBrazilianPortuguese(): Promise<void> {
    for (const command of ['/lang:br', '/lang:ptbr']) {
        const client = createFakeClient();

        await SocialHandler.handlePublicChat(client as never, createPublicChatPacket(command));

        assert.equal(client.character.dialogueLanguage, 'pt-br');
        const statusTexts = getChatStatusTexts(client);
        assert.ok(statusTexts.includes('Dialogos de NPC definidos para Portugues do Brasil.'), `${command} should acknowledge the language switch`);
        assert.ok(
            statusTexts.includes('Idioma salvo. No Adobe Flash Player, reinicie o jogo para aplicar tudo.'),
            `${command} should tell standalone Flash users to restart after saving the preference`
        );
        assert.ok(
            statusTexts.includes('DB_LOCALIZATION_RELOAD:http://localhost:8000/p/cbp/DungeonBlitz.swf?fv=cbw&gv=cbv&lang=pt-br'),
            `${command} should request a hard reload with the current PT-BR SWF URL`
        );
    }
}

async function testPortuguesePortugalAliasIsNotAcceptedAsBrazilianPortuguese(): Promise<void> {
    const client = createFakeClient();

    await SocialHandler.handlePublicChat(client as never, createPublicChatPacket('/lang:pt'));

    assert.equal(client.character.dialogueLanguage, 'en');
    assert.equal(getChatStatusTexts(client).some((text) => text.includes('DB_LOCALIZATION_RELOAD:')), false);
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
    assert.equal(decodeRoomThought(packet!.payload).text, 'Bunu odetecegiz!');
}

function testTurkishEnemyFallbackKeepsLineVariety(): void {
    const dataDir = path.resolve(__dirname, '../data');
    DialogueTranslationLoader.load(dataDir);

    const first = DialogueTranslationLoader.translateText(
        'I will crush you!',
        'tr',
        { fallbackToGeneric: true }
    );
    const second = DialogueTranslationLoader.translateText(
        'Attack now!',
        'tr',
        { fallbackToGeneric: true }
    );

    assert.equal(first, 'Sana izin vermeyecegiz!');
    assert.equal(second, 'Hucum edin!');
    assert.notEqual(first, second, 'unknown enemy fallback should not collapse every line to one taunt');
    assert.notEqual(first, 'Geber!');
    assert.notEqual(second, 'Saldirin!');
}

function testMeylourFallbackKeepsLineVarietyLikeScarab(): void {
    const dataDir = path.resolve(__dirname, '../data');
    DialogueTranslationLoader.load(dataDir);

    const first = DialogueTranslationLoader.translateText(
        'Meylour will burn everything!',
        'tr',
        { fallbackToGeneric: true }
    );
    const second = DialogueTranslationLoader.translateText(
        'Meylour will kill you!',
        'tr',
        { fallbackToGeneric: true }
    );

    assert.notEqual(first, 'Meylour icin!');
    assert.notEqual(second, 'Meylour icin!');
    assert.notEqual(first, second, 'unknown Meylour fallback should keep Scarab-style line variety');
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

function testCapstoneBossDialogueTranslatesEnemyAndPlayerLines(): void {
    const dataDir = path.resolve(__dirname, '../data');
    DialogueTranslationLoader.load(dataDir);

    const client = createFakeClient();
    client.character.dialogueLanguage = 'tr';
    client.token = 51006;
    client.currentLevel = 'AC_Mission6';
    client.levelInstanceId = '';
    client.playerSpawned = true;
    client.entities.set(670, {
        id: 670,
        name: 'GreatNephit',
        team: EntityTeam.ENEMY
    });

    GlobalState.sessionsByToken.set(client.token, client as never);
    try {
        SocialHandler.handleStartSkit(
            client as never,
            createStartSkitPacket(670, 'Ahhh, you finished off the dragon generals.')
        );
        SocialHandler.handleStartSkit(
            client as never,
            createStartSkitPacket(1, 'Prepare for another disappointment, Nephit.')
        );
    } finally {
        GlobalState.sessionsByToken.delete(client.token);
    }

    const thoughts = client.sentPackets
        .filter((entry) => entry.id === 0x76)
        .map((entry) => decodeRoomThought(entry.payload));

    assert.deepEqual(thoughts, [
        {
            entityId: 670,
            text: 'Ahhh, ejderha generallerini bitirmissin.'
        },
        {
            entityId: 1,
            text: 'Nephit, bir hayal kirikligina daha hazirlan.'
        }
    ]);
}

function testFelbridgeMeylourRoomDialogueUsesExactTranslations(): void {
    const dataDir = path.resolve(__dirname, '../data');
    DialogueTranslationLoader.load(dataDir);

    const client = createFakeClient();
    client.character.dialogueLanguage = 'tr';
    client.token = 51007;
    client.currentLevel = 'BT_Mission4';
    client.levelInstanceId = '';
    client.playerSpawned = true;
    client.entities.set(701, {
        id: 701,
        name: 'StewardOfFelbridge',
        team: EntityTeam.ENEMY
    });

    GlobalState.sessionsByToken.set(client.token, client as never);
    try {
        SocialHandler.handleStartSkit(
            client as never,
            createStartSkitPacket(701, 'Meylour is our only savior!:The Living Mountain preserve me!')
        );
        SocialHandler.handleStartSkit(
            client as never,
            createStartSkitPacket(701, 'Meylour demands his sacrifices, #tn#!')
        );
        SocialHandler.handleStartSkit(
            client as never,
            createStartSkitPacket(701, '<Goto Red 1>And I will continue to give Meylour more!')
        );
    } finally {
        GlobalState.sessionsByToken.delete(client.token);
    }

    const thoughts = client.sentPackets
        .filter((entry) => entry.id === 0x76)
        .map((entry) => decodeRoomThought(entry.payload));

    assert.deepEqual(thoughts, [
        {
            entityId: 701,
            text: 'Meylour tek kurtaricimiz!:Yasayan Dag beni korusun!'
        },
        {
            entityId: 701,
            text: 'Meylour kurbanlarini ister, #tn#!'
        },
        {
            entityId: 701,
            text: "<Goto Red 1>Ve Meylour'a daha fazlasini vermeye devam edecegim!"
        }
    ]);
}

function testFelbridgeMeylourLiveSkitSegmentsUseTranslations(): void {
    const dataDir = path.resolve(__dirname, '../data');
    DialogueTranslationLoader.load(dataDir);

    const client = createFakeClient();
    client.character.dialogueLanguage = 'tr';
    client.token = 51008;
    client.currentLevel = 'BT_Mission4';
    client.levelInstanceId = '';
    client.playerSpawned = true;
    client.entities.set(702, {
        id: 702,
        name: 'StewardOfFelbridge',
        team: EntityTeam.ENEMY
    });

    const liveSkitSegments: Array<[string, string]> = [
        ['Meylour is our only savior!', 'Meylour tek kurtaricimiz!'],
        ['The Living Mountain preserve me!', 'Yasayan Dag beni korusun!'],
        ['Meylour demands his sacrifices, LanguageTester!', 'Meylour kurbanlarini ister, LanguageTester!'],
        ['This temple is sacred Paladin.', 'Bu tapinak kutsaldir Paladin.'],
        ['Your doom is sealed, LanguageTester!', 'Sonun muhurlendi, LanguageTester!'],
        ['They belong to Meylour now!', "Artik Meylour'a aitler!"],
        ['Meylour grant me your strength!', 'Meylour, bana gucunu ver!'],
        ['You will die on the peak, LanguageTester...', 'Zirvede oleceksin, LanguageTester...']
    ];

    GlobalState.sessionsByToken.set(client.token, client as never);
    try {
        for (const [source] of liveSkitSegments) {
            SocialHandler.handleStartSkit(
                client as never,
                createStartSkitPacket(702, source)
            );
        }
    } finally {
        GlobalState.sessionsByToken.delete(client.token);
    }

    const thoughts = client.sentPackets
        .filter((entry) => entry.id === 0x76)
        .map((entry) => decodeRoomThought(entry.payload));

    assert.deepEqual(thoughts.map((thought) => thought.text), liveSkitSegments.map(([, expected]) => expected));
    assert.equal(
        thoughts.some((thought) => thought.text === 'Meylour icin!'),
        false,
        'live Felbridge skit segments should not fall through to the old Meylour placeholder'
    );
}

function testBridgeTownMissionsLiveSkitSegmentsUseTranslations(): void {
    const dataDir = path.resolve(__dirname, '../data');
    DialogueTranslationLoader.load(dataDir);

    const client = createFakeClient();
    client.character.dialogueLanguage = 'tr';
    client.token = 51009;
    client.currentLevel = 'BT_Mission1';
    client.levelInstanceId = '';
    client.playerSpawned = true;
    client.entities.set(703, {
        id: 703,
        name: 'BridgeTownMissionEnemy',
        team: EntityTeam.ENEMY
    });

    const liveSkitSegments: Array<[string, string]> = [
        ["LanguageTester, you should've stayed back across the sea.", 'LanguageTester, denizin ote yakasinda kalmaliydin.'],
        ['You always were a servile lapdog, LanguageTester.', 'Her zaman yalaka bir kopektin, LanguageTester.'],
        ["He's from the King!", 'Kral tarafindan gelmis!'],
        ['Come to take us back in chains!', 'Bizi zincire vurup geri goturmeye gelmis!'],
        ['I got one last trick for you, LanguageTester!', 'Senin icin son bir numaram var, LanguageTester!'],
        ['Wrath, avenge me!', 'Gazap, intikamimi al!'],
        ['Goblin magick lets us master these woods.', 'Goblin buyusu bu ormanlara hukmetmemizi sagliyor.'],
        ['Care to meet them?', 'Onlarla tanismak ister misin?'],
        ['We shall send you to the mountain\'s heart.', 'Seni dagin kalbine gonderecegiz.'],
        ['Hurt him! You fool, he is our leader!', 'Ona zarar mi vermek! Aptal, o bizim liderimiz!'],
        ['Rage of the stone, up!', 'Tasin ofkesi, ayaga kalk!'],
        ['To me, rocklings!', 'Bana gelin, kaya yaratiklari!']
    ];

    GlobalState.sessionsByToken.set(client.token, client as never);
    try {
        for (const [source] of liveSkitSegments) {
            SocialHandler.handleStartSkit(
                client as never,
                createStartSkitPacket(703, source)
            );
        }
    } finally {
        GlobalState.sessionsByToken.delete(client.token);
    }

    const thoughts = client.sentPackets
        .filter((entry) => entry.id === 0x76)
        .map((entry) => decodeRoomThought(entry.payload));

    assert.deepEqual(thoughts.map((thought) => thought.text), liveSkitSegments.map(([, expected]) => expected));
    assert.equal(
        thoughts.some((thought) => thought.text === 'Meylour icin!'),
        false,
        'BridgeTown mission skit segments should not fall through to old placeholder lines'
    );
}

function testBlackRoseMireLiveSkitSegmentsUseTranslations(): void {
    const dataDir = path.resolve(__dirname, '../data');
    DialogueTranslationLoader.load(dataDir);

    const client = createFakeClient();
    client.character.dialogueLanguage = 'tr';
    client.token = 51010;
    client.currentLevel = 'SRN_Mission4';
    client.levelInstanceId = '';
    client.playerSpawned = true;
    client.entities.set(704, {
        id: 704,
        name: 'BlackRoseMireEnemy',
        team: EntityTeam.ENEMY
    });

    const liveSkitSegments: Array<[string, string]> = [
        ['You humans will be slaves once again...', 'Siz insanlar yine kole olacaksiniz...'],
        ['She will make a nice snack for the herd.', 'Suru icin guzel bir atistirmalik olacak.'],
        ['Kill her !', 'Oldurun onu!'],
        ["She's here to steal the Legions wages!", 'Lejyonun maaslarini calmaya gelmis!'],
        ['You shall not disturb the Vizier further Paladin.', 'Veziri daha fazla rahatsiz etmeyeceksin Paladin.'],
        ['Protect the Seedlings!', 'Fideleri koruyun!'],
        ['Tuatara! To Arms!', 'Tuatara! Silah basina!'],
        ['The road\'s clear, now soldiers from Wolf\'s End can join me...', "Yol acildi, artik Kurtlarin Sonu'ndan askerler bana katilabilir..."]
    ];

    GlobalState.sessionsByToken.set(client.token, client as never);
    try {
        for (const [source] of liveSkitSegments) {
            SocialHandler.handleStartSkit(
                client as never,
                createStartSkitPacket(704, source)
            );
        }
    } finally {
        GlobalState.sessionsByToken.delete(client.token);
    }

    const thoughts = client.sentPackets
        .filter((entry) => entry.id === 0x76)
        .map((entry) => decodeRoomThought(entry.payload));

    assert.deepEqual(thoughts.map((thought) => thought.text), liveSkitSegments.map(([, expected]) => expected));
}

function testWolfsEndTimedSkitSegmentsUseTranslations(): void {
    const dataDir = path.resolve(__dirname, '../data');
    DialogueTranslationLoader.load(dataDir);

    const client = createFakeClient();
    client.character.dialogueLanguage = 'tr';
    client.token = 51011;
    client.currentLevel = 'TutorialDungeon';
    client.levelInstanceId = '';
    client.playerSpawned = true;

    GlobalState.sessionsByToken.set(client.token, client as never);
    try {
        SocialHandler.handleStartSkit(
            client as never,
            createStartSkitPacket(
                706,
                '0 Parrot <Scared>A treasure chest!+3:Too bad I dont have pockets.+13Open it with your weapon!'
            )
        );
    } finally {
        GlobalState.sessionsByToken.delete(client.token);
    }

    const packet = client.sentPackets.find((entry) => entry.id === 0x76);
    assert.ok(packet, "Wolf's End timed skit should be relayed as an NPC bubble");
    assert.deepEqual(decodeRoomThought(packet!.payload), {
        entityId: 706,
        text: 'Bir hazine sandigi!+3:Ne yazik ki ceplerim yok.+13Onu silahinla ac!'
    });
}

function isBlackRoseMireRoomDialogueSegment(value: string): boolean {
    if (!/[A-Za-z]{2,}/.test(value)) {
        return false;
    }
    if (/^(?:am_|a_|symbol|instance|Symbol|mc_|btn_|_)/.test(value)) {
        return false;
    }
    if (/^(?:default|neutral|enemy|Hard|Normal|Run|Bolster|Loop|Idle|Spawn|Windup|HitReact|BackToIdle|PoofInternal|HumanFireNova|Open|Closed|Close|Lowered|Raised|Up|Down|Left|Right|Start|Stop|Done|Door|Gate|Nothing)$/i.test(value)) {
        return false;
    }
    if (/^(?:Gold_|Bronze|Silver|ImperialChanneling|ImperialHealing|OasisTeleportEffectLarge|Untouchable)$/.test(value)) {
        return false;
    }
    if (/^(?:Camera|End|Free)$/i.test(value)) {
        return false;
    }
    if (/^(?:\d+\s+)?(?:Camera|Shake|End|SpawnCue|RemoveCue|QuickFirePower|FirePower|Revive|Collision(?:On|Off)?|SetLevelMoment|PlaySound|Sound|SetMusic|SetRoomActive|Teleport|AddMarker|RemoveMarker|Fade|Focus|Lock|Unlock|Disable|Enable|Show|Hide|Wait|SetEmote|Effect)\b/.test(value)) {
        return false;
    }

    return true;
}

function addBlackRoseMireRoomDialogueCandidate(raw: string, out: Set<string>): void {
    const value = unescapeActionScriptString(raw).trim();
    if (!value) {
        return;
    }

    for (const part of value.split(/=@|=|:/)) {
        const clean = part
            .replace(/^[@:]+/, '')
            .replace(/^\d+\s+[A-Za-z0-9_]+\s+/, '')
            .replace(/^(?:\s*<[^>]+>\s*)+/, '')
            .replace(/^\^t\s*/, '')
            .trim()
            .replace(/\s+/g, ' ');
        if (isBlackRoseMireRoomDialogueSegment(clean)) {
            out.add(clean);
        }
    }
}

function collectBlackRoseMireScriptFiles(root: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        const entryPath = path.join(root, entry.name);
        if (entry.isDirectory()) {
            collectBlackRoseMireScriptFiles(entryPath, out);
            continue;
        }
        if (!entry.name.endsWith('.as')) {
            continue;
        }

        const relative = path.relative(path.resolve(__dirname, '../../../build/npc-dialogue-level-scripts/scripts'), entryPath).split(path.sep).join('/');
        if (/^a_Room_(?:SRN.*|SRConn.*)\.as$/.test(relative)) {
            out.push(entryPath);
        }
    }

    return out;
}

function testBlackRoseMireRoomDialogueTranslationsCoverExtractedSource(): void {
    const dataDir = path.resolve(__dirname, '../data');
    const scriptRoot = path.resolve(__dirname, '../../../build/npc-dialogue-level-scripts/scripts');
    if (!fs.existsSync(scriptRoot)) {
        return;
    }

    const translations = JSON.parse(fs.readFileSync(path.join(dataDir, 'DialogueTranslations.tr.json'), 'utf8')) as {
        translations?: Record<string, string>;
    };
    const required = new Set<string>();

    for (const filePath of collectBlackRoseMireScriptFiles(scriptRoot)) {
        const source = fs.readFileSync(filePath, 'utf8');
        for (const match of source.matchAll(/\.(sayOn(?:Activate|Alert|Bloodied|Death|Interact|Spawn))\s*=\s*"((?:\\.|[^"\\])*)"/g)) {
            addBlackRoseMireRoomDialogueCandidate(match[2] ?? '', required);
        }
        for (const match of source.matchAll(/(?:cutScene\w+|Script_\w+)\s*=\s*\[((?:.|\n)*?)\];/g)) {
            for (const stringMatch of (match[1] ?? '').matchAll(/"((?:\\.|[^"\\])*)"/g)) {
                addBlackRoseMireRoomDialogueCandidate(stringMatch[1] ?? '', required);
            }
        }
        for (const match of source.matchAll(/\.Skit\("((?:\\.|[^"\\])*)"\)/g)) {
            addBlackRoseMireRoomDialogueCandidate(match[1] ?? '', required);
        }
    }

    const missing = [...required].filter((line) => !String(translations.translations?.[line] ?? '').trim()).sort();
    assert.ok(required.size > 300, 'Black Rose Mire room dialogue inventory should include all LevelsSRN scripts');
    assert.deepEqual(missing, [], 'Black Rose Mire room dialogue should have Turkish translations');
}

function testValhavenWelcomePartyLiveSkitSegmentsUseTranslations(): void {
    const dataDir = path.resolve(__dirname, '../data');
    DialogueTranslationLoader.load(dataDir);

    const client = createFakeClient();
    client.character.dialogueLanguage = 'tr';
    client.token = 51011;
    client.currentLevel = 'JC_Mission1';
    client.levelInstanceId = '';
    client.playerSpawned = true;
    client.entities.set(705, {
        id: 705,
        name: 'ImperialCommanderGrahl',
        team: EntityTeam.ENEMY
    });

    const liveSkitSegments: Array<[string, string]> = [
        ["Uh-oh, what's going on? Guards everywhere...", 'Eyvah, neler oluyor? Her yerde muhafiz var...'],
        ["It's an ambush!", 'Bu bir pusu!'],
        ['Try and fight your way through them!', 'Onlari yara yara gecmeye calis!'],
        ["I'll meet you at the Laughing Jester Inn!", "Gulen Soytari Hani'nda bulusalim!"],
        ['You go no further outlaw!', 'Buradan ileri gidemezsin, kanun kacagi!'],
        ['The Emperor has sentenced you to death.', 'Imparator seni olume mahkum etti.'],
        ['I am your executioner!', 'Celladin benim!'],
        ['Resistance is useless', 'Direnis ise yaramaz'],
        ["Take the usurper's head!", 'Gaspcinin kafasini alin!'],
        ['You dare defy the Emperor?', 'Imparatora meydan okumaya nasil cesaret edersin?'],
        ['The Emperor knew you were coming.', 'Imparator gelecegini biliyordu.'],
        ['And he wants you dead for some reason.', 'Ve nedense olmeni istiyor.'],
        ["Meet with our leader, Odryn. He'll know more.", 'Liderimiz Odryn ile bulus. O daha fazlasini bilir.']
    ];

    GlobalState.sessionsByToken.set(client.token, client as never);
    try {
        for (const [source] of liveSkitSegments) {
            SocialHandler.handleStartSkit(
                client as never,
                createStartSkitPacket(705, source)
            );
        }
    } finally {
        GlobalState.sessionsByToken.delete(client.token);
    }

    const thoughts = client.sentPackets
        .filter((entry) => entry.id === 0x76)
        .map((entry) => decodeRoomThought(entry.payload));

    assert.deepEqual(thoughts.map((thought) => thought.text), liveSkitSegments.map(([, expected]) => expected));
}

function testCapstoneRoomDialogueTranslationsCoverExtractedSource(): void {
    const dataDir = path.resolve(__dirname, '../data');
    const translations = JSON.parse(fs.readFileSync(path.join(dataDir, 'DialogueTranslations.tr.json'), 'utf8')) as {
        translations?: Record<string, string>;
    };

    const capstoneLines = [
        "There's a strange light coming from that tunnel...",
        'More of those blue crytals.',
        'Is this where they come from?',
        'These ghosts are different.',
        "Nephit's summoning spirits from everwhere now!",
        'Where am I?',
        'What is this place?',
        'Ghosts of all my former foes.',
        "Nephit's throwing everything at me.",
        "I've never heard of a place like this!",
        'I feel caught between two worlds.',
        "Hopefully there's some stable ground ahead.",
        'RAAAAAAWWWRRR!',
        'uugggugugu.....',
        'Ahhh, you finished off the dragon generals.',
        "I'd hoped you would kill each other.",
        'Prepare for another disappointment, Nephit.',
        'You know, I helped Baron Hocke create this Capstone.',
        'Then you know how dangerous it would be to disrupt it.',
        'Dangerous to you. Empowering for me.',
        'Once I drain its powers, I shall live again...',
        'And every ancient secret shall be revealed unto me!',
        'You should know by now, #tn#...',
        'This body is a mere placeholder',
        "Now let me show you Capstone's true potential!"
    ];

    const missing = capstoneLines.filter((line) => !String(translations.translations?.[line] ?? '').trim());
    assert.deepEqual(missing, [], 'Capstone dungeon dialogue should have Turkish translations');
}

function testFelbridgeMeylourRoomDialogueTranslationsCoverExtractedSource(): void {
    const dataDir = path.resolve(__dirname, '../data');
    const translations = JSON.parse(fs.readFileSync(path.join(dataDir, 'DialogueTranslations.tr.json'), 'utf8')) as {
        translations?: Record<string, string>;
    };

    const felbridgeMeylourLines = [
        "You cannot stop the Harvest Ritual!:You'll doom us all!",
        'You cannot stop the Harvest Ritual!',
        "You'll doom us all!",
        "@Looks like the Meylour's servants have gone wild.:@The Steward's house is being ruined.",
        "Looks like the Meylour's servants have gone wild.",
        "The Steward's house is being ruined.",
        'We shall carry you to the dire peak, sacrifice!',
        "Meylour's wrath will claim you!",
        'This temple is sacred #tc#.',
        "The Steward's ritual is complete...:Your doom is sealed, #tn#!",
        "The Steward's ritual is complete...",
        'Your doom is sealed, #tn#!',
        'Meylour will devour you all...',
        'For the Glory of Meylour, I give my life!',
        "He's|She's here for The Steward!:Cut him|her down!",
        "He's here for The Steward!",
        "She's here for The Steward!",
        'Cut him down!',
        'Cut her down!',
        'The Steward brought these.:They belong to Meylour now!',
        'The Steward brought these.',
        'They belong to Meylour now!',
        'These caves are holy ground, intruder.:Begone!',
        'These caves are holy ground, intruder.',
        'Begone!',
        'These offerings are for Meylour!:Begone, heretic!',
        'These offerings are for Meylour!',
        'Begone, heretic!',
        'Meylour The Living Mountain codemns thee!',
        'Meylour, I pray, devour my bones!',
        "::Felbridge didn't need your meddling!",
        "Felbridge didn't need your meddling!",
        "Meylour's Eternal Avalanche will crush you!",
        "You snivelling worm!:You dare to defile Meylour's temple?",
        'You snivelling worm!',
        "You dare to defile Meylour's temple?",
        'Meylour, my blood runs for thee!',
        'More sacrifices for the Living Mountain::Meylour grant me your strength!',
        'More sacrifices for the Living Mountain',
        'Meylour grant me your strength!',
        'Oh that I shall be reborn as rock, Mighty Meylour!',
        'Oh, you from Felbridge?:Come to the woods for some payback, have ye?',
        'Oh, you from Felbridge?',
        'Come to the woods for some payback, have ye?',
        'No wonder the people of Felbridge are so wary of strangers.',
        'So, #tn#. The Steward was right about you.',
        'Where is he? If you lot have hurt the Steward...',
        'Every Harvest Ritual we sacrifice to Meylour.',
        'Meylour demands blood. And this year he shall have yours!',
        'The Steward and his evil cult have sacrificed innocents...',
        'Time to put an end to the Steward and whoever is in league with him',
        'Meylour is our only savior!:The Living Mountain preserve me!',
        'Meylour is our only savior!',
        'The Living Mountain preserve me!',
        'Meylour demands his sacrifices, #tn#!',
        "You've sacrificed scores of people to your dark god.",
        '<Goto Red 1>And I will continue to give Meylour more!',
        'And I will continue to give Meylour more!',
        'Only The Living Mountain can protect us from the Sleeping Lands.',
        'We will never go back there!',
        'NEVER!',
        'You will die on the peak, #tn#...',
        'Your cult is finished, Steward.',
        "I need to let the Warden know he's in charge now."
    ];

    const missing = felbridgeMeylourLines.filter((line) => !String(translations.translations?.[line] ?? '').trim());
    assert.deepEqual(missing, [], 'Felbridge Meylour room dialogue should have exact Turkish translations');
}

function testBridgeTownMissionsRoomDialogueTranslationsCoverExtractedSource(): void {
    const dataDir = path.resolve(__dirname, '../data');
    const translations = JSON.parse(fs.readFileSync(path.join(dataDir, 'DialogueTranslations.tr.json'), 'utf8')) as {
        translations?: Record<string, string>;
    };

    const bridgeTownMissionLines = [
        'You cursed fool!',
        'We had a good thing going here...:You coulda joined us!',
        'We had a good thing going here...',
        'You coulda joined us!',
        'I remember you two. You were heroes once.',
        "#tn#, you should've stayed back across the sea.",
        'You always were a servile lapdog, #tn#.',
        'Let me remind you of your duty, scum.',
        'All these wretched deserters...',
        'I got one last trick for you, #tn#!',
        'Wrath, avenge me!:Urghhhhh...',
        'Wrath, avenge me!',
        'Urghhhhh...',
        'I heard you were dead, Svagg.',
        "Not me. I'm a survivor.",
        'You sold your soul for Goblin Magic.',
        'It was worth the price. Goblins used it, why not me?',
        'My followers respect power, Goblin or Human. Let us show you!',
        'Rawk!',
        'A Wargryph. Wow.',
        "Svagg's deserter tricks didn't save him though.",
        'I recognize you too, deserter!',
        '10 WaveBoss Not a deserter, just smarter then you.',
        'Not a deserter, just smarter then you.',
        '10 WaveBoss This land is ripe for the robbing!',
        'This land is ripe for the robbing!',
        "You're scum and a coward. I'll enjoy this!",
        'Imps, destroy this idiot!',
        'The forest is ours, bridge-scum.:That was the deal!',
        'The forest is ours, bridge-scum.',
        'That was the deal!',
        "These woods ain't for you no more, bridger-scum!",
        'Back in the homeland, I ate your kind for breakfast.',
        'You scum look familiar.',
        'I fought at the Battle of Querrel Hill.',
        'You deserted the King and turned bandit!',
        "If you'd been smart, you woulda too.",
        "Now it's too late!",
        "He's|She's from the King!:Come to take us back in chains!",
        "He's|She's from the King!",
        "He's from the King!",
        "She's from the King!",
        'Come to take us back in chains!',
        "Ellyrian scum! We won't go back!",
        'You shoulda died a hero in the war.',
        "Come to claim these woods for the King?:We won't bend knee again!",
        'Come to claim these woods for the King?',
        "We won't bend knee again!",
        'We should never have fought the goblins.:Their magic serves us now!',
        'We should never have fought the goblins.',
        'Their magic serves us now!',
        "Goblin magick lets us master these woods.:You'll die here without their power.",
        'Goblin magick lets us master these woods.',
        "You'll die here without their power.",
        'How did you get past the spider?',
        "Without the goblin's spells, you'll die here.:This forest is ours!",
        "Without the goblin's spells, you'll die here.",
        'This forest is ours!',
        "A goblin's skull can enchant 100 spiders.:Care to meet them?",
        "A goblin's skull can enchant 100 spiders.",
        'Care to meet them?',
        '@What have these bandits done?',
        'What have these bandits done?',
        '@Back in your hole, beast!',
        'Back in your hole, beast!',
        '@How can these bandits stand those things?',
        'How can these bandits stand those things?',
        "Svagg's imps, protect me!",
        'They said goblin magicks would protect us...',
        'You fought goblins, sure.:But not goblin magic under human command!',
        'You fought goblins, sure.',
        'But not goblin magic under human command!',
        'Death to your King!: And you too!',
        'Death to your King!',
        'And you too!',
        'Your flesh is not of ours.',
        "We shall send you to the mountain's heart.:There you shall join the others.",
        "We shall send you to the mountain's heart.",
        'There you shall join the others.',
        'Minions rise!',
        'The mountaintop will be your doom.',
        'Servants, heed my call!',
        'You should not be here.',
        'We told you to leave, stranger!',
        "He's|She's here for The Steward!",
        'Cut him|her down!',
        'Hurt him! You fool, he is our leader!',
        "Unless I'm wrong, the village is right above me.",
        'Rage of the stone, up!',
        'To me, rocklings!'
    ];

    const missing = bridgeTownMissionLines.filter((line) => !String(translations.translations?.[line] ?? '').trim());
    assert.deepEqual(missing, [], 'BridgeTown mission 1-3 room dialogue should have Turkish translations');
}

function isFelbridgeRoomDialogueSegment(value: string): boolean {
    if (!/[A-Za-z]{2,}/.test(value)) {
        return false;
    }
    if (/^(?:am_|a_|symbol|instance|Symbol|mc_|btn_)/.test(value)) {
        return false;
    }
    if (/^(?:default|neutral|enemy|Hard|Normal|Run|Bolster|Loop|Idle|Spawn|Windup|HitReact|BackToIdle|PoofInternal|HumanFireNova|Open|Closed|Close|Lowered|Raised|Up|Down|Left|Right|Start|Stop|Done|Door|Gate)$/i.test(value)) {
        return false;
    }
    if (/^(?:Gold_|Bronze|Silver|ImperialChanneling|ImperialHealing|OasisTeleportEffectLarge|Untouchable)$/.test(value)) {
        return false;
    }
    if (/^(?:Camera|End|Free)$/i.test(value)) {
        return false;
    }
    if (/^(?:\d+\s+)?(?:Camera|Shake|End|SpawnCue|RemoveCue|QuickFirePower|FirePower|Revive|Collision(?:On|Off)?|SetLevelMoment|PlaySound|Sound|SetMusic|SetRoomActive|Teleport|AddMarker|RemoveMarker|Fade|Focus|Lock|Unlock|Disable|Enable|Show|Hide|Wait)\b/.test(value)) {
        return false;
    }

    return true;
}

function addFelbridgeRoomDialogueCandidate(raw: string, out: Set<string>): void {
    const value = unescapeActionScriptString(raw).trim();
    if (!value) {
        return;
    }

    for (const part of value.split(/=@|=|:/)) {
        const clean = part
            .replace(/^[@:]+/, '')
            .replace(/^\d+\s+[A-Za-z0-9_]+\s+/, '')
            .replace(/^(?:\s*<[^>]+>\s*)+/, '')
            .replace(/^\^t\s*/, '')
            .trim()
            .replace(/\s+/g, ' ');
        if (isFelbridgeRoomDialogueSegment(clean)) {
            out.add(clean);
        }
    }
}

function collectFelbridgeScriptFiles(root: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        const entryPath = path.join(root, entry.name);
        if (entry.isDirectory()) {
            collectFelbridgeScriptFiles(entryPath, out);
            continue;
        }
        if (!entry.name.endsWith('.as')) {
            continue;
        }

        const relative = path.relative(path.resolve(__dirname, '../../../build/npc-dialogue-level-scripts/scripts'), entryPath).split(path.sep).join('/');
        if (/^(?:a_Room_(?:BT(?:\d+|Z_|M\d+R).*|CH(?:\d|mini|M\d+R|05R|08_|2_).*|CH2_.*)|LevelsB[TC]_fla\/.*)\.as$/.test(relative)) {
            out.push(entryPath);
        }
    }

    return out;
}

function testFelbridgeRoomDialogueTranslationsCoverExtractedSource(): void {
    const dataDir = path.resolve(__dirname, '../data');
    const scriptRoot = path.resolve(__dirname, '../../../build/npc-dialogue-level-scripts/scripts');
    if (!fs.existsSync(scriptRoot)) {
        return;
    }

    const translations = JSON.parse(fs.readFileSync(path.join(dataDir, 'DialogueTranslations.tr.json'), 'utf8')) as {
        translations?: Record<string, string>;
    };
    const required = new Set<string>();

    for (const filePath of collectFelbridgeScriptFiles(scriptRoot)) {
        const source = fs.readFileSync(filePath, 'utf8');
        for (const match of source.matchAll(/\.(sayOn(?:Activate|Alert|Bloodied|Death|Interact|Spawn))\s*=\s*"((?:\\.|[^"\\])*)"/g)) {
            addFelbridgeRoomDialogueCandidate(match[2] ?? '', required);
        }
        for (const match of source.matchAll(/(?:cutScene\w+|Script_\w+)\s*=\s*\[((?:.|\n)*?)\];/g)) {
            for (const stringMatch of (match[1] ?? '').matchAll(/"((?:\\.|[^"\\])*)"/g)) {
                addFelbridgeRoomDialogueCandidate(stringMatch[1] ?? '', required);
            }
        }
        for (const match of source.matchAll(/\.Skit\("((?:\\.|[^"\\])*)"\)/g)) {
            addFelbridgeRoomDialogueCandidate(match[1] ?? '', required);
        }
    }

    const missing = [...required].filter((line) => !String(translations.translations?.[line] ?? '').trim()).sort();
    assert.ok(required.size > 440, 'Felbridge room dialogue inventory should include BridgeTown and Cemetery Hill scripts');
    assert.deepEqual(missing, [], 'Felbridge room dialogue should have Turkish translations');
}

function collectCemeteryHillScriptFiles(root: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        const entryPath = path.join(root, entry.name);
        if (entry.isDirectory()) {
            collectCemeteryHillScriptFiles(entryPath, out);
            continue;
        }
        if (!entry.name.endsWith('.as')) {
            continue;
        }

        const relative = path.relative(path.resolve(__dirname, '../../../build/npc-dialogue-level-scripts/scripts'), entryPath).split(path.sep).join('/');
        if (/^(?:a_Room_(?:CH(?:\d|mini|M\d+R|05R|08_|2_).*|CH2_.*)|LevelsCH_fla\/.*)\.as$/.test(relative)) {
            out.push(entryPath);
        }
    }

    return out;
}

function testCemeteryHillRoomDialogueTranslationsCoverExtractedSource(): void {
    const dataDir = path.resolve(__dirname, '../data');
    const scriptRoot = path.resolve(__dirname, '../../../build/npc-dialogue-level-scripts/scripts');
    if (!fs.existsSync(scriptRoot)) {
        return;
    }

    const translations = JSON.parse(fs.readFileSync(path.join(dataDir, 'DialogueTranslations.tr.json'), 'utf8')) as {
        translations?: Record<string, string>;
    };
    const required = new Set<string>();

    for (const filePath of collectCemeteryHillScriptFiles(scriptRoot)) {
        const source = fs.readFileSync(filePath, 'utf8');
        for (const match of source.matchAll(/\.(sayOn(?:Activate|Alert|Bloodied|Death|Interact|Spawn))\s*=\s*"((?:\\.|[^"\\])*)"/g)) {
            addFelbridgeRoomDialogueCandidate(match[2] ?? '', required);
        }
        for (const match of source.matchAll(/(?:cutScene\w+|Script_\w+)\s*=\s*\[((?:.|\n)*?)\];/g)) {
            for (const stringMatch of (match[1] ?? '').matchAll(/"((?:\\.|[^"\\])*)"/g)) {
                addFelbridgeRoomDialogueCandidate(stringMatch[1] ?? '', required);
            }
        }
        for (const match of source.matchAll(/\.Skit\("((?:\\.|[^"\\])*)"\)/g)) {
            addFelbridgeRoomDialogueCandidate(match[1] ?? '', required);
        }
    }

    const missing = [...required].filter((line) => !String(translations.translations?.[line] ?? '').trim()).sort();
    assert.ok(required.size > 270, 'Cemetery Hill room dialogue inventory should include all LevelsCH scripts');
    assert.deepEqual(missing, [], 'Cemetery Hill room dialogue should have Turkish translations');
}

function testWolfsEndEnemyRoomDialogueTranslationsCoverExtractedSource(): void {
    const dataDir = path.resolve(__dirname, '../data');
    const translations = JSON.parse(fs.readFileSync(path.join(dataDir, 'DialogueTranslations.tr.json'), 'utf8')) as {
        translations?: Record<string, string>;
    };

    const wolfsEndEnemyLines = [
        'Mwahahaha!',
        'No fair!',
        '@Back to the deep with you, trog scum!',
        'These seas are ours!',
        'This ship is going down!',
        'Humans! What are humans doing here!?!',
        "Sink them! We can't be followed!",
        'CHARGE!',
        "The human from that boat!:He|she followed us!",
        'You killed our Kraken!',
        'He was only 120 years old!',
        'What did that Kraken ever do to you?',
        'The human from across the sea!',
        'You were a fool to follow us!',
        "You're gonna die in these caves, human!",
        'The Kraken shoulda killed you!',
        'Curse of Thrung upon ye!',
        'My soul goes to the Sleeping Lands...',
        'Who goes...oh!:The Kraken Slayer!',
        "We're doomed!",
        ':Have you come to serve Nephit too, human?',
        "Don't let him|her cross the bridge!",
        'Kill him|her and we can go home!',
        "We'll never see the Sleeping Lands again...",
        'Goblins! This is our final stand!',
        ':We\'re coming, boss',
        'Turn back, mortal.:Or join us.',
        'This war isn\'t over!',
        'We goblins never give up, human!',
        'Dead, rise to my defense!:The Ur-Sage demands it!:Kill him|her!',
        "Why do you fight so?:I conquered Death itself:You're nothing.",
        'No! This is for us!: We have to get back to the Sleeping Lands.',
        'Nephit is Goblin-kind\'s salvation!:He can open the passage!',
        'For Nephit! Our one true hope!',
        "Get out!: You'll ruin everything!",
        'Nephit, protect me!',
        "Nephit knows the path!: You can't stop him from leading us!",
        'Nephit will raise me to fight you again!',
        'The Karaken Slayer!: To Arms!',
        'Death is a small price to pay for knowledge.:So sayeth Nephit',
        "Master's wisdom is supreme.:Bow down to your fate.",
        'The goblins failed us.',
        'The Sleepers stir...',
        '"Help! Help!"...:A child cries out in the night.',
        'In the Sleeping Lands, dreams come true.',
        'Where all sleep, none may die.',
        'Lay down your sweet head...:That I might chop it off!',
        'Beware human...:You disturb Sythokahn\'s dream...',
        'All the treasure in the waking world...:Can\'t buy your way into the Sleeping Lands.',
        'Why do I torment myself with these fantasies?:Come forth my fellow dreamers.'
    ];

    const missing = wolfsEndEnemyLines.filter((line) => !String(translations.translations?.[line] ?? '').trim());
    assert.deepEqual(missing, [], "Wolf's End enemy room dialogue should have Turkish translations");
}

function isWolfsEndRoomDialogueSegment(value: string): boolean {
    if (!/[A-Za-z]{2,}/.test(value)) {
        return false;
    }
    if (/^(?:am_|a_|symbol|instance|Symbol|mc_|btn_|_|NPC_|FXP_|SND_|a_Sound|Gold_|Bronze|Silver|Untouchable)/.test(value)) {
        return false;
    }
    if (/^(?:default|neutral|enemy|Hard|Normal|Run|Bolster|Loop|Idle|Spawn|Windup|HitReact|BackToIdle|PoofInternal|HumanFireNova|Open|Closed|Close|Lowered|Raised|Up|Down|Left|Right|Start|Stop|Done|Door|Gate|Nothing|HELP!|Bah!|Gah!)$/i.test(value)) {
        return false;
    }
    if (/^(?:Camera|End|Free)$/i.test(value)) {
        return false;
    }
    if (/^(?:\d+\s+)?(?:Camera|Shake|End|SpawnCue|RemoveCue|QuickFirePower|FirePower|Revive|Collision(?:On|Off)?|SetLevelMoment|PlaySound|Sound|SetMusic|SetRoomActive|Teleport|AddMarker|RemoveMarker|Fade|Focus|Lock|Unlock|Disable|Enable|Show|Hide|Wait|SetEmote|Effect|Animate|Ambush|BossMusic|Music)\b/i.test(value)) {
        return false;
    }
    if (/^[A-Za-z0-9_]+(?:\s+[A-Za-z0-9_]+){0,2}$/.test(value) && !/[.!?,:'|#]/.test(value)) {
        return false;
    }

    return true;
}

function addWolfsEndRoomDialogueCandidate(raw: string, out: Set<string>): void {
    const value = unescapeActionScriptString(raw).trim();
    if (!value) {
        return;
    }

    for (const part of value.split(/=@|=|:|\+\d+/)) {
        const clean = part
            .replace(/^[@:]+/, '')
            .replace(/^\d+\s+[A-Za-z0-9_]+\s+/, '')
            .replace(/^(?:\s*<[^>]+>\s*)+/, '')
            .replace(/^\^t\s*/, '')
            .trim()
            .replace(/\s+/g, ' ');
        if (isWolfsEndRoomDialogueSegment(clean)) {
            out.add(clean);
        }
    }
}

function collectWolfsEndScriptFiles(root: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        const entryPath = path.join(root, entry.name);
        if (entry.isDirectory()) {
            collectWolfsEndScriptFiles(entryPath, out);
            continue;
        }
        if (!entry.name.endsWith('.as')) {
            continue;
        }

        const relative = path.relative(path.resolve(__dirname, '../../../build/npc-dialogue-level-scripts/scripts'), entryPath).split(path.sep).join('/');
        if (/^(?:a_Room_(?:TutorialBoat_.*|Tutorial_.*|NR.*|GoblinCamp.*|GoblinBeachHard_.*)|LevelsNR_fla\/.*|LevelsTut_fla\/.*)\.as$/.test(relative)) {
            out.push(entryPath);
        }
    }

    return out;
}

function testWolfsEndRoomDialogueTranslationsCoverExtractedSource(): void {
    const dataDir = path.resolve(__dirname, '../data');
    const scriptRoot = path.resolve(__dirname, '../../../build/npc-dialogue-level-scripts/scripts');
    if (!fs.existsSync(scriptRoot)) {
        return;
    }

    const translations = JSON.parse(fs.readFileSync(path.join(dataDir, 'DialogueTranslations.tr.json'), 'utf8')) as {
        translations?: Record<string, string>;
    };
    const required = new Set<string>();

    for (const filePath of collectWolfsEndScriptFiles(scriptRoot)) {
        const source = fs.readFileSync(filePath, 'utf8');
        for (const match of source.matchAll(/\.(sayOn(?:Activate|Alert|Bloodied|Death|Interact|Spawn))\s*=\s*"((?:\\.|[^"\\])*)"/g)) {
            addWolfsEndRoomDialogueCandidate(match[2] ?? '', required);
        }
        for (const match of source.matchAll(/(?:cutScene\w+|Script_\w+)\s*=\s*\[((?:.|\n)*?)\];/g)) {
            for (const stringMatch of (match[1] ?? '').matchAll(/"((?:\\.|[^"\\])*)"/g)) {
                addWolfsEndRoomDialogueCandidate(stringMatch[1] ?? '', required);
            }
        }
        for (const match of source.matchAll(/\.Skit\("((?:\\.|[^"\\])*)"\)/g)) {
            addWolfsEndRoomDialogueCandidate(match[1] ?? '', required);
        }
    }

    const missing = [...required].filter((line) => !String(translations.translations?.[line] ?? '').trim()).sort();
    assert.ok(required.size > 340, "Wolf's End room dialogue inventory should include all LevelsNR dungeon scripts");
    assert.deepEqual(missing, [], "Wolf's End room dialogue should have Turkish translations");
}

function isHomeRoomDialogueSegment(value: string): boolean {
    if (!/[A-Za-z]{2,}/.test(value)) {
        return false;
    }
    if (/^(?:am_|a_|symbol|instance|Symbol|mc_|btn_|_|NPC_|FXP_|SND_|a_Sound|Gold_|Bronze|Silver|Untouchable)/.test(value)) {
        return false;
    }
    if (/^(?:default|neutral|enemy|Hard|Normal|Run|Bolster|Loop|Idle|Spawn|Windup|HitReact|BackToIdle|PoofInternal|HumanFireNova|Open|Closed|Close|Lowered|Raised|Up|Down|Left|Right|Start|Stop|Done|Door|Gate|Nothing|Bah!|Gah!)$/i.test(value)) {
        return false;
    }
    if (/^(?:Camera|End|Free)$/i.test(value)) {
        return false;
    }
    if (/^(?:\d+\s+)?(?:Camera|Shake|End|SpawnCue|RemoveCue|QuickFirePower|FirePower|Revive|Collision(?:On|Off)?|SetLevelMoment|PlaySound|Sound|SetMusic|SetRoomActive|Teleport|AddMarker|RemoveMarker|Fade|Focus|Lock|Unlock|Disable|Enable|Show|Hide|Wait|SetEmote|Effect|Animate|Ambush|BossMusic|Music|RemoveCue)\b/i.test(value)) {
        return false;
    }
    if (/^[A-Za-z0-9_]+(?:\s+[A-Za-z0-9_]+){0,2}$/.test(value) && !/[.!?,:'|#]/.test(value)) {
        return false;
    }

    return true;
}

function addHomeRoomDialogueCandidate(raw: string, out: Set<string>): void {
    const value = unescapeActionScriptString(raw).trim();
    if (!value) {
        return;
    }

    for (const part of value.split(/=@|=|:|\+\d+/)) {
        const clean = part
            .replace(/^[@:]+/, '')
            .replace(/^\d+\s+[A-Za-z0-9_]+\s+/, '')
            .replace(/^(?:\s*<[^>]+>\s*)+/, '')
            .replace(/^\^t\s*/, '')
            .trim()
            .replace(/\s+/g, ' ');
        if (isHomeRoomDialogueSegment(clean)) {
            out.add(clean);
        }
    }
}

function collectHomeScriptFiles(root: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        const entryPath = path.join(root, entry.name);
        if (entry.isDirectory()) {
            collectHomeScriptFiles(entryPath, out);
            continue;
        }
        if (!entry.name.endsWith('.as')) {
            continue;
        }

        const relative = path.relative(path.resolve(__dirname, '../../../build/npc-dialogue-level-scripts/scripts'), entryPath).split(path.sep).join('/');
        if (/^(?:a_Room_(?:MainTutorial|GuildHallTutorial2|Main|Village|GuildHall|GuildHallInterior|Stables|Armory|Chambers|TrainingGround|Library)|LevelsHome_fla\/.*)\.as$/.test(relative)) {
            out.push(entryPath);
        }
    }

    return out;
}

function testHomeRoomDialogueTranslationsCoverExtractedSource(): void {
    const dataDir = path.resolve(__dirname, '../data');
    const scriptRoot = path.resolve(__dirname, '../../../build/npc-dialogue-level-scripts/scripts');
    if (!fs.existsSync(scriptRoot)) {
        return;
    }

    const translations = JSON.parse(fs.readFileSync(path.join(dataDir, 'DialogueTranslations.tr.json'), 'utf8')) as {
        translations?: Record<string, string>;
    };
    const required = new Set<string>(['I will not fall! To me, brothers!']);

    for (const filePath of collectHomeScriptFiles(scriptRoot)) {
        const source = fs.readFileSync(filePath, 'utf8');
        for (const match of source.matchAll(/\.(sayOn(?:Activate|Alert|Bloodied|Death|Interact|Spawn))\s*=\s*"((?:\\.|[^"\\])*)"/g)) {
            addHomeRoomDialogueCandidate(match[2] ?? '', required);
        }
        for (const match of source.matchAll(/(?:cutScene\w+|Script_\w+|cutscene|closingSkit|parrotLeave)\s*=\s*\[((?:.|\n)*?)\];/g)) {
            for (const stringMatch of (match[1] ?? '').matchAll(/"((?:\\.|[^"\\])*)"/g)) {
                addHomeRoomDialogueCandidate(stringMatch[1] ?? '', required);
            }
        }
        for (const match of source.matchAll(/\.Skit\("((?:\\.|[^"\\])*)"\)/g)) {
            addHomeRoomDialogueCandidate(match[1] ?? '', required);
        }
    }

    const missing = [...required].filter((line) => !String(translations.translations?.[line] ?? '').trim()).sort();
    assert.ok(required.size > 30, 'Home room dialogue inventory should include CraftTown and CraftTownTutorial scripts');
    assert.deepEqual(missing, [], 'Home room dialogue should have Turkish translations');
}

function testValhavenWelcomePartyRoomDialogueTranslationsCoverExtractedSource(): void {
    const dataDir = path.resolve(__dirname, '../data');
    const translations = JSON.parse(fs.readFileSync(path.join(dataDir, 'DialogueTranslations.tr.json'), 'utf8')) as {
        translations?: Record<string, string>;
    };

    const valhavenWelcomePartyLines = [
        "6 OrderGuy Uh-oh, what's going on? Guards everywhere...",
        "Uh-oh, what's going on? Guards everywhere...",
        "10 OrderGuy It's an ambush!",
        "It's an ambush!",
        '8 OrderGuy Try and fight your way through them!',
        'Try and fight your way through them!',
        "10 OrderGuy I'll meet you at the Laughing Jester Inn!",
        "I'll meet you at the Laughing Jester Inn!",
        '7 Boss <Melee> You go no further outlaw!',
        'You go no further outlaw!',
        '10 Boss The Emperor has sentenced you to death.',
        'The Emperor has sentenced you to death.',
        '11 Boss <Melee> I am your executioner!',
        'I am your executioner!',
        '4 OrderGuy The Emperor knew you were coming.',
        'The Emperor knew you were coming.',
        '8 OrderGuy And he wants you dead for some reason.',
        'And he wants you dead for some reason.',
        "10 OrderGuy Meet with our leader, Odryn. He'll know more.",
        "Meet with our leader, Odryn. He'll know more.",
        '<Melee> Resistance is useless',
        'Resistance is useless',
        "<ShieldBash> Take the usurper's head!",
        "Take the usurper's head!",
        '0 Boss <Melee> You dare defy the Emperor?',
        'You dare defy the Emperor?'
    ];

    const missing = valhavenWelcomePartyLines.filter((line) => !String(translations.translations?.[line] ?? '').trim());
    assert.deepEqual(missing, [], 'Valhaven Welcome Party room dialogue should have Turkish translations');
}

function unescapeActionScriptString(raw: string): string {
    return raw
        .replace(/\\'/g, "'")
        .replace(/\\"/g, '"')
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\\\/g, '\\');
}

function looksLikeValhavenRoomDialogue(value: string): boolean {
    if (!/[A-Za-z]{2,}/.test(value)) {
        return false;
    }
    if (/^(?:am_|a_|symbol)/.test(value)) {
        return false;
    }
    if (/^(?:default|neutral|enemy|Hard|Normal|Run|Bolster)$/.test(value)) {
        return false;
    }
    if (/^(?:Gold_|Bronze|Silver|ImperialChanneling|ImperialHealing|OasisTeleportEffectLarge|Untouchable)$/.test(value)) {
        return false;
    }
    if (/^(?:\d+\s+)?(?:Camera|Shake|End|SpawnCue|RemoveCue|QuickFirePower)\b/.test(value) && !/[.!?]|:|@/.test(value)) {
        return false;
    }

    return /[.!?]|:|@|#|\b(?:kill|die|death|Emperor|human|outlaw|usurper|Odryn|Seelie|Jester|fight|ambush|guards|burn|fire|head|resistance|savior|come|stop|dead|fool|attack|defend|slay|thief|you|I|we|they|he|she|The|And|No|What|Where|Why|How|Looks)\b/i.test(value);
}

function addValhavenRoomDialogueCandidate(raw: string, out: Set<string>): void {
    const value = unescapeActionScriptString(raw).trim();
    if (!looksLikeValhavenRoomDialogue(value)) {
        return;
    }

    for (const part of value.split(/=@|=|:/)) {
        const clean = part
            .replace(/^[@:]+/, '')
            .replace(/^\d+\s+[A-Za-z0-9_]+\s+/, '')
            .replace(/^(?:\s*<[^>]+>\s*)+/, '')
            .replace(/^\^t\s*/, '')
            .trim()
            .replace(/\s+/g, ' ');
        if (looksLikeValhavenRoomDialogue(clean)) {
            out.add(clean);
        }
    }
}

function testValhavenRoomDialogueTranslationsCoverExtractedSource(): void {
    const dataDir = path.resolve(__dirname, '../data');
    const scriptRoot = path.resolve(__dirname, '../../../build/npc-dialogue-level-scripts/scripts');
    if (!fs.existsSync(scriptRoot)) {
        return;
    }

    const translations = JSON.parse(fs.readFileSync(path.join(dataDir, 'DialogueTranslations.tr.json'), 'utf8')) as {
        translations?: Record<string, string>;
    };
    const required = new Set<string>();

    for (const file of fs.readdirSync(scriptRoot)) {
        if (!/^a_Room_JC(?:Mission\d+|Mini\d+)_.*\.as$/.test(file)) {
            continue;
        }

        const source = fs.readFileSync(path.join(scriptRoot, file), 'utf8');
        for (const match of source.matchAll(/\.(sayOn(?:Activate|Alert|Bloodied|Death|Interact|Spawn))\s*=\s*"((?:\\.|[^"\\])*)"/g)) {
            addValhavenRoomDialogueCandidate(match[2] ?? '', required);
        }
        for (const match of source.matchAll(/(?:cutScene\w+|Script_\w+)\s*=\s*\[((?:.|\n)*?)\];/g)) {
            for (const stringMatch of (match[1] ?? '').matchAll(/"((?:\\.|[^"\\])*)"/g)) {
                addValhavenRoomDialogueCandidate(stringMatch[1] ?? '', required);
            }
        }
        for (const match of source.matchAll(/\.Skit\("((?:\\.|[^"\\])*)"\)/g)) {
            addValhavenRoomDialogueCandidate(match[1] ?? '', required);
        }
    }

    const missing = [...required].filter((line) => !String(translations.translations?.[line] ?? '').trim()).sort();
    assert.ok(required.size > 300, 'Valhaven room dialogue inventory should include all dungeon scripts');
    assert.deepEqual(missing, [], 'Valhaven room dialogue should have Turkish translations');
}

function looksLikeShazariRoomDialogue(value: string): boolean {
    if (!/[A-Za-z]{2,}/.test(value)) {
        return false;
    }
    if (/^(?:am_|a_|symbol)/.test(value)) {
        return false;
    }
    if (/^(?:default|neutral|enemy|Hard|Normal|Run|Bolster)$/.test(value)) {
        return false;
    }
    if (/^(?:Gold_|Bronze|Silver|ImperialChanneling|ImperialHealing|OasisTeleportEffectLarge|Untouchable)$/.test(value)) {
        return false;
    }
    if (/^(?:\d+\s+)?(?:Camera|Shake|End|SpawnCue|RemoveCue|QuickFirePower)\b/.test(value) && !/[.!?]|:|@/.test(value)) {
        return false;
    }

    return /[.!?]|:|@|#|\b(?:kill|die|death|Emperor|human|mortal|Seelie|Magi|Shazari|dragon|Pit|Lord|sand|temple|scarab|arena|goblin|ogre|tomb|pyramid|burial|Leviathan|Titus|Rathbone|Kovah|fight|attack|defend|slay|you|I|we|they|he|she|The|And|No|What|Where|Why|How|come|stop|dead|fool|blood|bones|curse|war|oasis|water|pharaoh|construct|time|ancient|guard|guardian|wake|rise|perfection|work|impurity|cleanse|imperfection|destiny|rights|land|sands)\b/i.test(value);
}

function addShazariRoomDialogueCandidate(raw: string, out: Set<string>): void {
    const value = unescapeActionScriptString(raw).trim();
    if (!looksLikeShazariRoomDialogue(value)) {
        return;
    }

    for (const part of value.split(/=@|=|:/)) {
        const clean = part
            .replace(/^[@:]+/, '')
            .replace(/^\d+\s+[A-Za-z0-9_]+\s+/, '')
            .replace(/^(?:\s*<[^>]+>\s*)+/, '')
            .replace(/^\^t\s*/, '')
            .trim()
            .replace(/\s+/g, ' ');
        if (looksLikeShazariRoomDialogue(clean)) {
            out.add(clean);
        }
    }
}

function testShazariRoomDialogueTranslationsCoverExtractedSource(): void {
    const dataDir = path.resolve(__dirname, '../data');
    const scriptRoot = path.resolve(__dirname, '../../../build/npc-dialogue-level-scripts/scripts');
    if (!fs.existsSync(scriptRoot)) {
        return;
    }

    const translations = JSON.parse(fs.readFileSync(path.join(dataDir, 'DialogueTranslations.tr.json'), 'utf8')) as {
        translations?: Record<string, string>;
    };
    const required = new Set<string>();

    for (const file of fs.readdirSync(scriptRoot)) {
        if (!/^a_Room_SDMission.*\.as$/.test(file)) {
            continue;
        }

        const source = fs.readFileSync(path.join(scriptRoot, file), 'utf8');
        for (const match of source.matchAll(/\.(sayOn(?:Activate|Alert|Bloodied|Death|Interact|Spawn))\s*=\s*"((?:\\.|[^"\\])*)"/g)) {
            addShazariRoomDialogueCandidate(match[2] ?? '', required);
        }
        for (const match of source.matchAll(/(?:cutScene\w+|Script_\w+)\s*=\s*\[((?:.|\n)*?)\];/g)) {
            for (const stringMatch of (match[1] ?? '').matchAll(/"((?:\\.|[^"\\])*)"/g)) {
                addShazariRoomDialogueCandidate(stringMatch[1] ?? '', required);
            }
        }
        for (const match of source.matchAll(/\.Skit\("((?:\\.|[^"\\])*)"\)/g)) {
            addShazariRoomDialogueCandidate(match[1] ?? '', required);
        }
    }

    const missing = [...required].filter((line) => !String(translations.translations?.[line] ?? '').trim()).sort();
    assert.ok(required.size > 140, 'Shazari room dialogue inventory should include all dungeon scripts');
    assert.deepEqual(missing, [], 'Shazari room dialogue should have Turkish translations');
}

function looksLikeCastleHockeRoomDialogue(value: string): boolean {
    if (!/[A-Za-z]{2,}/.test(value)) {
        return false;
    }
    if (/^(?:am_|a_|symbol|instance|Symbol)/.test(value)) {
        return false;
    }
    if (/^(?:default|neutral|enemy|Hard|Normal|Run|Bolster|Loop|Idle|Spawn|Windup|HitReact|BackToIdle|PoofInternal|HumanFireNova)$/.test(value)) {
        return false;
    }
    if (/^(?:Gold_|Bronze|Silver|ImperialChanneling|ImperialHealing|OasisTeleportEffectLarge|Untouchable)$/.test(value)) {
        return false;
    }
    if (/^(?:\d+\s+)?(?:Camera|Shake|End|SpawnCue|RemoveCue|QuickFirePower|FirePower|Revive|Collision(?:On|Off)?|SetLevelMoment)\b/.test(value) && !/[.!?]|:|@/.test(value)) {
        return false;
    }

    return /[.!?]|:|@|#|\b(?:kill|die|death|Baron|Hocke|House|Castle|Capstone|dragon|dragons|Dragon|Legion|Legions|Sleeping Lands|Meylour|Nephit|Titus|ghost|spirits|Goblins|goblins|golem|knights|paladin|Dread|Emerald|Throne|Aether|Observatory|Ramparts|human|thieves|trespass|trespassing|intruder|enemy|enemies|command|obey|protect|slay|world|cause|Emperor|secrets|magic|dead|battle|army|your|you|I|we|they|he|she|The|And|No|What|Where|Why|How|For|All|By|Prepare|Dangerous|Once|This|That|Such|A|With|Now)\b/i.test(value);
}

function addCastleHockeRoomDialogueCandidate(raw: string, out: Set<string>): void {
    const value = unescapeActionScriptString(raw).trim();
    if (!looksLikeCastleHockeRoomDialogue(value)) {
        return;
    }

    for (const part of value.split(/=@|=|:/)) {
        const clean = part
            .replace(/^[@:]+/, '')
            .replace(/^\d+\s+[A-Za-z0-9_]+\s+/, '')
            .replace(/^(?:\s*<[^>]+>\s*)+/, '')
            .replace(/^\^t\s*/, '')
            .trim()
            .replace(/\s+/g, ' ');
        if (looksLikeCastleHockeRoomDialogue(clean)) {
            out.add(clean);
        }
    }
}

function collectCastleHockeScriptFiles(root: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        const entryPath = path.join(root, entry.name);
        if (entry.isDirectory()) {
            collectCastleHockeScriptFiles(entryPath, out);
            continue;
        }
        if (!entry.name.endsWith('.as')) {
            continue;
        }

        const relative = path.relative(path.resolve(__dirname, '../../../build/npc-dialogue-level-scripts/scripts'), entryPath).split(path.sep).join('/');
        if (/^(?:a_Room_(?:ACM\d|Dragon_R|Throne_R|Battle_R|Ramparts_R|Capstone_R).*|LevelsAC_fla\/.*)\.as$/.test(relative)) {
            out.push(entryPath);
        }
    }

    return out;
}

function testCastleHockeRoomDialogueTranslationsCoverExtractedSource(): void {
    const dataDir = path.resolve(__dirname, '../data');
    const scriptRoot = path.resolve(__dirname, '../../../build/npc-dialogue-level-scripts/scripts');
    if (!fs.existsSync(scriptRoot)) {
        return;
    }

    const translations = JSON.parse(fs.readFileSync(path.join(dataDir, 'DialogueTranslations.tr.json'), 'utf8')) as {
        translations?: Record<string, string>;
    };
    const required = new Set<string>();

    for (const filePath of collectCastleHockeScriptFiles(scriptRoot)) {
        const source = fs.readFileSync(filePath, 'utf8');
        for (const match of source.matchAll(/\.(sayOn(?:Activate|Alert|Bloodied|Death|Interact|Spawn))\s*=\s*"((?:\\.|[^"\\])*)"/g)) {
            addCastleHockeRoomDialogueCandidate(match[2] ?? '', required);
        }
        for (const match of source.matchAll(/(?:cutScene\w+|Script_\w+)\s*=\s*\[((?:.|\n)*?)\];/g)) {
            for (const stringMatch of (match[1] ?? '').matchAll(/"((?:\\.|[^"\\])*)"/g)) {
                addCastleHockeRoomDialogueCandidate(stringMatch[1] ?? '', required);
            }
        }
        for (const match of source.matchAll(/\.Skit\("((?:\\.|[^"\\])*)"\)/g)) {
            addCastleHockeRoomDialogueCandidate(match[1] ?? '', required);
        }
    }

    const missing = [...required].filter((line) => !String(translations.translations?.[line] ?? '').trim()).sort();
    assert.ok(required.size > 220, 'Castle Hocke room dialogue inventory should include all dungeon scripts');
    assert.deepEqual(missing, [], 'Castle Hocke room dialogue should have Turkish translations');
}

function looksLikeStormshardRoomDialogue(value: string): boolean {
    if (!/[A-Za-z]{2,}/.test(value)) {
        return false;
    }
    if (/^(?:am_|a_|symbol|instance|Symbol)/.test(value)) {
        return false;
    }
    if (/^(?:default|neutral|enemy|Hard|Normal|Run|Bolster|Loop|Idle|Spawn|Windup|HitReact|BackToIdle|PoofInternal|HumanFireNova)$/.test(value)) {
        return false;
    }
    if (/^(?:Gold_|Bronze|Silver|ImperialChanneling|ImperialHealing|OasisTeleportEffectLarge|Untouchable)$/.test(value)) {
        return false;
    }
    if (/^(?:\d+\s+)?(?:Camera|Shake|End|SpawnCue|RemoveCue|QuickFirePower|FirePower|Revive|Collision(?:On|Off)?|SetLevelMoment|PlaySound|Sound|SetMusic)\b/.test(value) && !/[.!?]|:|@/.test(value)) {
        return false;
    }

    return /[.!?]|:|@|#|\b(?:kill|die|death|Meylour|Mountain|Living Mountain|Stormshard|Storm|Uthor|forge|Forge|Armory|armory|gnole|gnoles|Gnole|Cyclops|cyclops|Ashen|Dryad|dryad|dragon|Dragon|Grail|Grahls|Magma|fire|ash|stone|rock|hulk|garden|voice|Silencing Blade|blade|weapon|weapons|sword|beast|beasts|human|humans|mortal|intruder|defiler|sacrifice|sacrifices|burn|flame|flames|embers|lava|heart|blood|veins|cave|bones|prey|master|Titan|titan|Mogul|Lord|Baron|Hocke|Titus|you|your|I|we|they|he|she|The|And|No|What|Where|Why|How|For|All|By|Prepare|Dangerous|Once|This|That|Such|A|With|Now|Come|Praise|Protect|Smite|Fight|Destroy|Defend|Attack)\b/i.test(value);
}

function addStormshardRoomDialogueCandidate(raw: string, out: Set<string>): void {
    const value = unescapeActionScriptString(raw).trim();
    if (!looksLikeStormshardRoomDialogue(value)) {
        return;
    }

    for (const part of value.split(/=@|=|:/)) {
        const clean = part
            .replace(/^[@:]+/, '')
            .replace(/^\d+\s+[A-Za-z0-9_]+\s+/, '')
            .replace(/^(?:\s*<[^>]+>\s*)+/, '')
            .replace(/^\^t\s*/, '')
            .trim()
            .replace(/\s+/g, ' ');
        if (looksLikeStormshardRoomDialogue(clean)) {
            out.add(clean);
        }
    }
}

function collectStormshardScriptFiles(root: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        const entryPath = path.join(root, entry.name);
        if (entry.isDirectory()) {
            collectStormshardScriptFiles(entryPath, out);
            continue;
        }
        if (!entry.name.endsWith('.as')) {
            continue;
        }

        const relative = path.relative(path.resolve(__dirname, '../../../build/npc-dialogue-level-scripts/scripts'), entryPath).split(path.sep).join('/');
        if (/^(?:a_Room_(?:SSM(?:\d+|_Armory|_Forge).*|OMM\d+_.*)|LevelsOMM_fla\/.*)\.as$/.test(relative)) {
            out.push(entryPath);
        }
    }

    return out;
}

function testStormshardRoomDialogueTranslationsCoverExtractedSource(): void {
    const dataDir = path.resolve(__dirname, '../data');
    const scriptRoot = path.resolve(__dirname, '../../../build/npc-dialogue-level-scripts/scripts');
    if (!fs.existsSync(scriptRoot)) {
        return;
    }

    const translations = JSON.parse(fs.readFileSync(path.join(dataDir, 'DialogueTranslations.tr.json'), 'utf8')) as {
        translations?: Record<string, string>;
    };
    const required = new Set<string>();

    for (const filePath of collectStormshardScriptFiles(scriptRoot)) {
        const source = fs.readFileSync(filePath, 'utf8');
        for (const match of source.matchAll(/\.(sayOn(?:Activate|Alert|Bloodied|Death|Interact|Spawn))\s*=\s*"((?:\\.|[^"\\])*)"/g)) {
            addStormshardRoomDialogueCandidate(match[2] ?? '', required);
        }
        for (const match of source.matchAll(/(?:cutScene\w+|Script_\w+)\s*=\s*\[((?:.|\n)*?)\];/g)) {
            for (const stringMatch of (match[1] ?? '').matchAll(/"((?:\\.|[^"\\])*)"/g)) {
                addStormshardRoomDialogueCandidate(stringMatch[1] ?? '', required);
            }
        }
        for (const match of source.matchAll(/\.Skit\("((?:\\.|[^"\\])*)"\)/g)) {
            addStormshardRoomDialogueCandidate(match[1] ?? '', required);
        }
    }

    const missing = [...required].filter((line) => !String(translations.translations?.[line] ?? '').trim()).sort();
    assert.ok(required.size > 420, 'Stormshard room dialogue inventory should include all dungeon scripts');
    assert.deepEqual(missing, [], 'Stormshard room dialogue should have Turkish translations');
}

function isEmeraldGladesRoomDialogueSegment(value: string): boolean {
    if (!/[A-Za-z]{2,}/.test(value)) {
        return false;
    }
    if (/^(?:am_|a_|symbol|instance|Symbol)/.test(value)) {
        return false;
    }
    if (/^(?:default|neutral|enemy|Hard|Normal|Run|Bolster|Loop|Idle|Spawn|Windup|HitReact|BackToIdle|PoofInternal|HumanFireNova)$/.test(value)) {
        return false;
    }
    if (/^(?:Camera|End|Free)$/i.test(value)) {
        return false;
    }
    if (/^(?:\d+\s+)?(?:Camera|Shake|End|SpawnCue|RemoveCue|QuickFirePower|FirePower|Revive|Collision(?:On|Off)?|SetLevelMoment|PlaySound|Sound|SetMusic|SetRoomActive|Teleport|AddMarker|RemoveMarker)\b/.test(value)) {
        return false;
    }

    return true;
}

function addEmeraldGladesRoomDialogueCandidate(raw: string, out: Set<string>): void {
    const value = unescapeActionScriptString(raw).trim();
    if (!value) {
        return;
    }

    for (const part of value.split(/=@|=|:/)) {
        const clean = part
            .replace(/^[@:]+/, '')
            .replace(/^\d+\s+[A-Za-z0-9_]+\s+/, '')
            .replace(/^(?:\s*<[^>]+>\s*)+/, '')
            .replace(/^\^t\s*/, '')
            .trim()
            .replace(/\s+/g, ' ');
        if (isEmeraldGladesRoomDialogueSegment(clean)) {
            out.add(clean);
        }
    }
}

function collectEmeraldGladesScriptFiles(root: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        const entryPath = path.join(root, entry.name);
        if (entry.isDirectory()) {
            collectEmeraldGladesScriptFiles(entryPath, out);
            continue;
        }
        if (!entry.name.endsWith('.as')) {
            continue;
        }

        const relative = path.relative(path.resolve(__dirname, '../../../build/npc-dialogue-level-scripts/scripts'), entryPath).split(path.sep).join('/');
        if (/^(?:a_Room_(?:EGZ_.*|Rotten_.*|Hopes_.*|Refuge_.*|M0[145]R.*)|LevelsEG_fla\/.*)\.as$/.test(relative)) {
            out.push(entryPath);
        }
    }

    return out;
}

function testEmeraldGladesRoomDialogueTranslationsCoverExtractedSource(): void {
    const dataDir = path.resolve(__dirname, '../data');
    const scriptRoot = path.resolve(__dirname, '../../../build/npc-dialogue-level-scripts/scripts');
    if (!fs.existsSync(scriptRoot)) {
        return;
    }

    const translations = JSON.parse(fs.readFileSync(path.join(dataDir, 'DialogueTranslations.tr.json'), 'utf8')) as {
        translations?: Record<string, string>;
    };
    const required = new Set<string>();

    for (const filePath of collectEmeraldGladesScriptFiles(scriptRoot)) {
        const source = fs.readFileSync(filePath, 'utf8');
        for (const match of source.matchAll(/\.(sayOn(?:Activate|Alert|Bloodied|Death|Interact|Spawn))\s*=\s*"((?:\\.|[^"\\])*)"/g)) {
            addEmeraldGladesRoomDialogueCandidate(match[2] ?? '', required);
        }
        for (const match of source.matchAll(/(?:cutScene\w+|Script_\w+)\s*=\s*\[((?:.|\n)*?)\];/g)) {
            for (const stringMatch of (match[1] ?? '').matchAll(/"((?:\\.|[^"\\])*)"/g)) {
                addEmeraldGladesRoomDialogueCandidate(stringMatch[1] ?? '', required);
            }
        }
        for (const match of source.matchAll(/\.Skit\("((?:\\.|[^"\\])*)"\)/g)) {
            addEmeraldGladesRoomDialogueCandidate(match[1] ?? '', required);
        }
    }

    const missing = [...required].filter((line) => !String(translations.translations?.[line] ?? '').trim()).sort();
    assert.ok(required.size > 90, 'Emerald Glades room dialogue inventory should include all dungeon scripts');
    assert.deepEqual(missing, [], 'Emerald Glades room dialogue should have Turkish translations');
}

async function main(): Promise<void> {
    await testLanguageCommandSwitchesToTurkishWithoutBroadcasting();
    await testLanguageCommandSwitchesBackToEnglish();
    await testPortugueseLanguageCommandAliasesSwitchToBrazilianPortuguese();
    await testPortuguesePortugalAliasIsNotAcceptedAsBrazilianPortuguese();
    testTurkishDialogueFilesCoverAllSourceDialogue();
    testTurkishRoomThoughtUsesTranslationTable();
    testTurkishRoomThoughtFallbackPreventsEnemyEnglish();
    testTurkishEnemyFallbackKeepsLineVariety();
    testMeylourFallbackKeepsLineVarietyLikeScarab();
    testSpecificDungeonRoomThoughtTranslation();
    testSplitDungeonRoomThoughtTranslation();
    testLevelHandlerRoomThoughtUsesRecipientLanguage();
    testCapstoneBossDialogueTranslatesEnemyAndPlayerLines();
    testFelbridgeMeylourRoomDialogueUsesExactTranslations();
    testFelbridgeMeylourLiveSkitSegmentsUseTranslations();
    testBridgeTownMissionsLiveSkitSegmentsUseTranslations();
    testBlackRoseMireLiveSkitSegmentsUseTranslations();
    testWolfsEndTimedSkitSegmentsUseTranslations();
    testValhavenWelcomePartyLiveSkitSegmentsUseTranslations();
    testCapstoneRoomDialogueTranslationsCoverExtractedSource();
    testFelbridgeMeylourRoomDialogueTranslationsCoverExtractedSource();
    testBridgeTownMissionsRoomDialogueTranslationsCoverExtractedSource();
    testBlackRoseMireRoomDialogueTranslationsCoverExtractedSource();
    testFelbridgeRoomDialogueTranslationsCoverExtractedSource();
    testCemeteryHillRoomDialogueTranslationsCoverExtractedSource();
    testWolfsEndEnemyRoomDialogueTranslationsCoverExtractedSource();
    testWolfsEndRoomDialogueTranslationsCoverExtractedSource();
    testHomeRoomDialogueTranslationsCoverExtractedSource();
    testValhavenWelcomePartyRoomDialogueTranslationsCoverExtractedSource();
    testValhavenRoomDialogueTranslationsCoverExtractedSource();
    testShazariRoomDialogueTranslationsCoverExtractedSource();
    testCastleHockeRoomDialogueTranslationsCoverExtractedSource();
    testStormshardRoomDialogueTranslationsCoverExtractedSource();
    testEmeraldGladesRoomDialogueTranslationsCoverExtractedSource();
    console.log('dialogue_language_regression: ok');
}

void main().catch((error) => {
    console.error('dialogue_language_regression: failed');
    console.error(error);
    process.exitCode = 1;
});
