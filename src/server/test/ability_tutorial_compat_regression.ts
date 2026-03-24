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

async function main(): Promise<void> {
    await testDuplicateTutorialAbilityRequestCompletesWithoutGrantingExtraRank();
    console.log('ability_tutorial_compat_regression: ok');
}

void main().catch((error) => {
    console.error('ability_tutorial_compat_regression: failed');
    console.error(error);
    process.exitCode = 1;
});
