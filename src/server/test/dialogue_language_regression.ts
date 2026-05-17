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
        "@Looks like the Meylour's servants have gone wild.:@The Steward's house is being ruined.",
        'We shall carry you to the dire peak, sacrifice!',
        "Meylour's wrath will claim you!",
        'This temple is sacred #tc#.',
        "The Steward's ritual is complete...:Your doom is sealed, #tn#!",
        'Meylour will devour you all...',
        'For the Glory of Meylour, I give my life!',
        "He's|She's here for The Steward!:Cut him|her down!",
        'The Steward brought these.:They belong to Meylour now!',
        'These caves are holy ground, intruder.:Begone!',
        'These offerings are for Meylour!:Begone, heretic!',
        'Meylour The Living Mountain codemns thee!',
        'Meylour, I pray, devour my bones!',
        "::Felbridge didn't need your meddling!",
        "Meylour's Eternal Avalanche will crush you!",
        "You snivelling worm!:You dare to defile Meylour's temple?",
        'Meylour, my blood runs for thee!',
        'More sacrifices for the Living Mountain::Meylour grant me your strength!',
        'Oh that I shall be reborn as rock, Mighty Meylour!',
        'Oh, you from Felbridge?:Come to the woods for some payback, have ye?',
        'No wonder the people of Felbridge are so wary of strangers.',
        'So, #tn#. The Steward was right about you.',
        'Where is he? If you lot have hurt the Steward...',
        'Every Harvest Ritual we sacrifice to Meylour.',
        'Meylour demands blood. And this year he shall have yours!',
        'The Steward and his evil cult have sacrificed innocents...',
        'Time to put an end to the Steward and whoever is in league with him',
        'Meylour is our only savior!:The Living Mountain preserve me!',
        'Meylour demands his sacrifices, #tn#!',
        "You've sacrificed scores of people to your dark god.",
        '<Goto Red 1>And I will continue to give Meylour more!',
        'And I will continue to give Meylour more!',
        'Only The Living Mountain can protect us from the Sleeping Lands.',
        'We will never go back there!',
        'NEVER!',
        'You will die on the peak, #tn#...',
        'Your cult is finished, Steward.'
    ];

    const missing = felbridgeMeylourLines.filter((line) => !String(translations.translations?.[line] ?? '').trim());
    assert.deepEqual(missing, [], 'Felbridge Meylour room dialogue should have exact Turkish translations');
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

async function main(): Promise<void> {
    await testLanguageCommandSwitchesToTurkishWithoutBroadcasting();
    await testLanguageCommandSwitchesBackToEnglish();
    testTurkishDialogueFilesCoverAllSourceDialogue();
    testTurkishRoomThoughtUsesTranslationTable();
    testTurkishRoomThoughtFallbackPreventsEnemyEnglish();
    testTurkishEnemyFallbackKeepsLineVariety();
    testSpecificDungeonRoomThoughtTranslation();
    testSplitDungeonRoomThoughtTranslation();
    testLevelHandlerRoomThoughtUsesRecipientLanguage();
    testCapstoneBossDialogueTranslatesEnemyAndPlayerLines();
    testFelbridgeMeylourRoomDialogueUsesExactTranslations();
    testCapstoneRoomDialogueTranslationsCoverExtractedSource();
    testFelbridgeMeylourRoomDialogueTranslationsCoverExtractedSource();
    testWolfsEndEnemyRoomDialogueTranslationsCoverExtractedSource();
    console.log('dialogue_language_regression: ok');
}

void main().catch((error) => {
    console.error('dialogue_language_regression: failed');
    console.error(error);
    process.exitCode = 1;
});
