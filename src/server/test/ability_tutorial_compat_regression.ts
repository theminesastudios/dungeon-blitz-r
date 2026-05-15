import { strict as assert } from 'assert';
import { Character } from '../database/Database';
import { JsonAdapter } from '../database/JsonAdapter';
import { AbilityHandler } from '../handlers/AbilityHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';

type SentPacket = {
    id: number;
    payload: Buffer;
};

type FakeClient = {
    userId: number;
    character: Character;
    characters: Character[];
    currentLevel: string;
    sentPackets: SentPacket[];
    sendBitBuffer(id: number, bb: BitBuffer): void;
};

function createCharacter(): Character {
    return {
        name: 'Neodevils',
        class: 'Mage',
        gender: 'male',
        level: 3,
        gold: 1784,
        mammothIdols: 0,
        questTrackerState: 100,
        learnedAbilities: [
            { abilityID: 10, rank: 1 },
            { abilityID: 14, rank: 1 },
            { abilityID: 17, rank: 1 }
        ],
        activeAbilities: [10, 14, 17],
        magicForge: {
            stats_by_building: {
                '1': 1
            }
        },
        SkillResearch: {},
        CurrentLevel: { name: 'CraftTown', x: 360, y: 1460 },
        PreviousLevel: { name: 'NewbieRoad', x: 1421, y: 826 }
    };
}

function createClient(): FakeClient {
    const sentPackets: SentPacket[] = [];
    const character = createCharacter();
    return {
        userId: 6,
        character,
        characters: [character],
        currentLevel: 'CraftTown',
        sentPackets,
        sendBitBuffer(id: number, bb: BitBuffer): void {
            sentPackets.push({ id, payload: bb.toBuffer() });
        }
    };
}

function createStartPacket(): Buffer {
    return Buffer.from('1420', 'hex');
}

function createNecromancerRankTwoStartPacket(): Buffer {
    return Buffer.from('d040', 'hex');
}

function createAbilityStartPacket(abilityId: number, rank: number, payWithIdols = false): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod20(7, abilityId);
    bb.writeMethod20(4, rank);
    bb.writeMethod15(payWithIdols);
    return bb.toBuffer();
}

function createSpeedupPacket(idolCost: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod9(idolCost);
    return bb.toBuffer();
}

async function withMockedCharacterSave<T>(fn: () => Promise<T>): Promise<T> {
    const originalSaveCharacterSnapshot = JsonAdapter.prototype.saveCharacterSnapshot;
    JsonAdapter.prototype.saveCharacterSnapshot = async function(userId: number, character: Character): Promise<Character[]> {
        assert.equal(userId, 6);
        return [character];
    };

    try {
        return await fn();
    } finally {
        JsonAdapter.prototype.saveCharacterSnapshot = originalSaveCharacterSnapshot;
    }
}

async function testDuplicateTutorialAbilityRequestCompletesWithoutGrantingExtraRank(): Promise<void> {
    const client = createClient();

    await withMockedCharacterSave(async () => {
        await AbilityHandler.handleStartAbilityResearch(client as never, createStartPacket());
    });

    assert.equal(client.sentPackets.some((packet) => packet.id === 0xBF), true);
    assert.equal((client.character.SkillResearch as Record<string, unknown>).abilityID, 10);
    assert.equal((client.character.SkillResearch as Record<string, unknown>).tutorialEcho, true);

    await withMockedCharacterSave(async () => {
        await AbilityHandler.handleClaimAbilityResearch(client as never);
    });

    assert.deepEqual(client.character.learnedAbilities, [
        { abilityID: 10, rank: 1 },
        { abilityID: 14, rank: 1 },
        { abilityID: 17, rank: 1 }
    ]);
    assert.deepEqual(client.character.SkillResearch, {});
}

async function testDefaultMasterAbilityCanStartRankTwoResearch(): Promise<void> {
    const client = createClient();
    client.character.level = 50;
    client.character.gold = 100000;
    client.character.MasterClass = 9;
    client.character.magicForge = {
        stats_by_building: {
            '1': 10,
            '2': 10,
            '8': 2,
            '12': 5,
            '13': 10
        }
    };
    client.character.learnedAbilities = [
        { abilityID: 10, rank: 1 },
        { abilityID: 14, rank: 1 },
        { abilityID: 17, rank: 1 },
        { abilityID: 18, rank: 1 },
        { abilityID: 98, rank: 10 },
        { abilityID: 100, rank: 10 },
        { abilityID: 103, rank: 10 }
    ];
    client.character.activeAbilities = [98, 100, 103];
    client.character.SkillResearch = {};

    await withMockedCharacterSave(async () => {
        await AbilityHandler.handleStartAbilityResearch(client as never, createNecromancerRankTwoStartPacket());
    });

    assert.deepEqual(
        client.character.learnedAbilities.find((ability: any) => ability.abilityID === 104),
        { abilityID: 104, rank: 1 },
        'server should persist the client-default Necromancer hotbar-4 ability before accepting rank two'
    );
    assert.equal((client.character.SkillResearch as Record<string, unknown>).abilityID, 104);
    assert.equal((client.character.SkillResearch as Record<string, unknown>).rank, 2);
}

async function testAnyActiveDisciplineSkillCanInferMissingSavedRank(): Promise<void> {
    const client = createClient();
    client.character.level = 50;
    client.character.gold = 100000;
    client.character.MasterClass = 9;
    client.character.magicForge = {
        stats_by_building: {
            '1': 10,
            '2': 10,
            '8': 2,
            '12': 5,
            '13': 10
        }
    };
    client.character.learnedAbilities = [
        { abilityID: 10, rank: 1 },
        { abilityID: 14, rank: 1 },
        { abilityID: 17, rank: 1 },
        { abilityID: 18, rank: 1 },
        { abilityID: 98, rank: 10 },
        { abilityID: 100, rank: 10 },
        { abilityID: 103, rank: 10 },
        { abilityID: 104, rank: 10 }
    ];
    client.character.activeAbilities = [98, 100, 103];
    client.character.SkillResearch = {};

    await withMockedCharacterSave(async () => {
        await AbilityHandler.handleStartAbilityResearch(client as never, createAbilityStartPacket(105, 2));
    });

    assert.deepEqual(
        client.character.learnedAbilities.find((ability: any) => ability.abilityID === 105),
        { abilityID: 105, rank: 1 },
        'server should infer the previous saved rank for any ability in the selected discipline'
    );
    assert.equal((client.character.SkillResearch as Record<string, unknown>).abilityID, 105);
    assert.equal((client.character.SkillResearch as Record<string, unknown>).rank, 2);
}

async function testShadowWalkerDisciplineSkillsCanStartRankTwoResearch(): Promise<void> {
    for (const abilityId of [74, 75, 76]) {
        const client = createClient();
        client.character.class = 'Rogue';
        client.character.level = 50;
        client.character.gold = 100000;
        client.character.MasterClass = 2;
        client.character.learnedAbilities = [
            { abilityID: 3, rank: 1 },
            { abilityID: 5, rank: 1 },
            { abilityID: 68, rank: 10 },
            { abilityID: 70, rank: 10 },
            { abilityID: 72, rank: 10 }
        ];
        client.character.activeAbilities = [68, 70, 72];
        client.character.SkillResearch = {};

        await withMockedCharacterSave(async () => {
            await AbilityHandler.handleStartAbilityResearch(client as never, createAbilityStartPacket(abilityId, 2));
        });

        assert.deepEqual(
            client.character.learnedAbilities.find((ability: any) => ability.abilityID === abilityId),
            { abilityID: abilityId, rank: 1 },
            `server should infer ShadowWalker ability ${abilityId} rank one before accepting rank two`
        );
        assert.equal((client.character.SkillResearch as Record<string, unknown>).abilityID, abilityId);
        assert.equal((client.character.SkillResearch as Record<string, unknown>).rank, 2);
    }
}

async function testAbilitySpeedupAppliesCompletedRank(): Promise<void> {
    const client = createClient();
    client.character.class = 'Rogue';
    client.character.level = 50;
    client.character.gold = 100000;
    client.character.mammothIdols = 100;
    client.character.MasterClass = 2;
    client.character.learnedAbilities = [
        { abilityID: 3, rank: 1 },
        { abilityID: 5, rank: 1 },
        { abilityID: 68, rank: 10 },
        { abilityID: 70, rank: 10 },
        { abilityID: 72, rank: 10 }
    ];
    client.character.activeAbilities = [68, 70, 72];
    client.character.SkillResearch = {};

    await withMockedCharacterSave(async () => {
        await AbilityHandler.handleStartAbilityResearch(client as never, createAbilityStartPacket(75, 2));
        await AbilityHandler.handleSpeedupAbilityResearch(client as never, createSpeedupPacket(10));
    });

    assert.deepEqual(
        client.character.learnedAbilities.find((ability: any) => ability.abilityID === 75),
        { abilityID: 75, rank: 2 },
        'speeding up a completed ability research should persist the upgraded rank immediately'
    );
    assert.deepEqual(client.character.SkillResearch, {});
    assert.equal(client.character.mammothIdols, 90);
    assert.equal(client.sentPackets.some((packet) => packet.id === 0xBF), true);
}

async function main(): Promise<void> {
    await testDuplicateTutorialAbilityRequestCompletesWithoutGrantingExtraRank();
    await testDefaultMasterAbilityCanStartRankTwoResearch();
    await testAnyActiveDisciplineSkillCanInferMissingSavedRank();
    await testShadowWalkerDisciplineSkillsCanStartRankTwoResearch();
    await testAbilitySpeedupAppliesCompletedRank();
    console.log('ability_tutorial_compat_regression: ok');
}

void main().catch((error) => {
    console.error('ability_tutorial_compat_regression: failed');
    console.error(error);
    process.exitCode = 1;
});
