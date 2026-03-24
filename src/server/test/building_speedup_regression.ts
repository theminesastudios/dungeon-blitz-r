import { strict as assert } from 'assert';
import { Character } from '../database/Database';
import { JsonAdapter } from '../database/JsonAdapter';
import { BuildingHandler } from '../handlers/BuildingHandler';
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
    playerSpawned: boolean;
    sentPackets: SentPacket[];
    sendBitBuffer(id: number, bb: BitBuffer): void;
};

function createCharacter(): Character {
    return {
        name: 'Neodevil',
        class: 'Paladin',
        gender: 'male',
        level: 10,
        MasterClass: 4,
        mammothIdols: 12,
        magicForge: {
            stats_by_building: {
                '1': 0,
                '2': 5,
                '3': 2,
                '12': 0,
                '13': 4
            }
        },
        buildingUpgrade: {
            buildingID: 1,
            rank: 1,
            ReadyTime: Math.floor(Date.now() / 1000) + 60
        },
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
        playerSpawned: true,
        sentPackets,
        sendBitBuffer(id: number, bb: BitBuffer): void {
            sentPackets.push({ id, payload: bb.toBuffer() });
        }
    };
}

function createSpeedupPacket(idolCost: number): Buffer {
    const bb = new BitBuffer();
    bb.writeMethod9(idolCost);
    return bb.toBuffer();
}

function createUpgradePacket(buildingId: number, targetRank: number, usedIdols: boolean): Buffer {
    const bb = new BitBuffer();
    bb.writeMethod20(5, buildingId);
    bb.writeMethod20(5, targetRank);
    bb.writeMethod15(usedIdols);
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

async function testBuildingSpeedupCompletesUpgradeAndReassertsCraftTownState(): Promise<void> {
    const client = createClient();

    await withMockedCharacterSave(async () => {
        await BuildingHandler.handleBuildingSpeedUpRequest(client as never, createSpeedupPacket(3));
    });

    assert.equal(client.character.mammothIdols, 9);
    assert.equal(client.character.magicForge?.stats_by_building?.['1'], 1);
    assert.deepEqual(client.character.buildingUpgrade, { buildingID: 0, rank: 0, ReadyTime: 0 });
    assert.equal(client.sentPackets.some((packet) => packet.id === 0xB5), true, 'speedup should refresh idol UI');
    assert.equal(client.sentPackets.some((packet) => packet.id === 0xD8), true, 'speedup should complete the upgrade');
    assert.equal(
        client.sentPackets.filter((packet) => packet.id === 0xDA).length,
        5,
        'speedup should immediately reassert CraftTown building state'
    );
}

async function testDuplicateBuiltTomeUpgradeRequestIsIgnoredAndReassertsHomeState(): Promise<void> {
    const client = createClient();
    client.character.magicForge = {
        stats_by_building: {
            '1': 1,
            '2': 5,
            '3': 2,
            '12': 0,
            '13': 4
        }
    };
    client.character.buildingUpgrade = { buildingID: 0, rank: 0, ReadyTime: 0 };

    await withMockedCharacterSave(async () => {
        await BuildingHandler.handleBuildingUpgrade(client as never, createUpgradePacket(1, 1, false));
    });

    assert.deepEqual(client.character.buildingUpgrade, { buildingID: 0, rank: 0, ReadyTime: 0 });
    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0xD8),
        true,
        'duplicate built Tome request should emit a completion packet so stale client UI can close'
    );
    assert.equal(
        client.sentPackets.filter((packet) => packet.id === 0xDA).length,
        5,
        'duplicate built Tome request should reassert existing CraftTown building state'
    );
}

async function testDuplicateSpeedupRequestReplaysCompletionForBuiltTome(): Promise<void> {
    const client = createClient();
    client.character.magicForge = {
        stats_by_building: {
            '1': 1,
            '2': 5,
            '3': 2,
            '12': 0,
            '13': 4
        }
    };
    client.character.buildingUpgrade = { buildingID: 0, rank: 0, ReadyTime: 0 };

    await withMockedCharacterSave(async () => {
        await BuildingHandler.handleBuildingSpeedUpRequest(client as never, createSpeedupPacket(0));
    });

    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0xD8),
        true,
        'duplicate speedup request should replay completion for the already-built Tome'
    );
    assert.equal(
        client.sentPackets.filter((packet) => packet.id === 0xDA).length,
        5,
        'duplicate speedup request should reassert CraftTown building state'
    );
}

function testCraftTownSpawnRefreshSendsImmediateBuildingReassert(): void {
    const client = createClient();
    const observedDelays: number[] = [];
    const originalSetTimeout = global.setTimeout;

    (global as typeof globalThis & {
        setTimeout: typeof setTimeout;
    }).setTimeout = ((callback: (...args: any[]) => void, delay?: number) => {
        observedDelays.push(Number(delay ?? 0));
        return { unref() { return undefined; } } as unknown as NodeJS.Timeout;
    }) as typeof setTimeout;

    try {
        BuildingHandler.refreshCraftTownBuildingsOnSpawn(client as never);
    } finally {
        (global as typeof globalThis & {
            setTimeout: typeof setTimeout;
        }).setTimeout = originalSetTimeout;
    }

    assert.equal(
        client.sentPackets.filter((packet) => packet.id === 0xDA).length,
        5,
        'CraftTown spawn should immediately resend home building state'
    );
    assert.deepEqual(observedDelays, [1200, 2800]);
}

async function main(): Promise<void> {
    await testBuildingSpeedupCompletesUpgradeAndReassertsCraftTownState();
    await testDuplicateBuiltTomeUpgradeRequestIsIgnoredAndReassertsHomeState();
    await testDuplicateSpeedupRequestReplaysCompletionForBuiltTome();
    testCraftTownSpawnRefreshSendsImmediateBuildingReassert();
    console.log('building_speedup_regression: ok');
}

void main().catch((error) => {
    console.error('building_speedup_regression: failed');
    console.error(error);
    process.exitCode = 1;
});
