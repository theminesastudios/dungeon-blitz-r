import { strict as assert } from 'assert';
import { Character } from '../database/Database';
import { JsonAdapter } from '../database/JsonAdapter';
import { TalentConfig } from '../core/TalentConfig';
import { Entity } from '../core/Entity';
import { TalentHandler } from '../handlers/TalentHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { BitReader } from '../network/protocol/bitReader';
import { WorldEnter } from '../utils/WorldEnter';

type SentPacket = {
    id: number;
    payload: Buffer;
};

type FakeClient = {
    authenticated: boolean;
    userId: number;
    character: Character;
    characters: Character[];
    currentLevel: string;
    playerSpawned: boolean;
    sentPackets: SentPacket[];
    talentResearchTimer: NodeJS.Timeout | null;
    sendBitBuffer(id: number, bb: BitBuffer): void;
};

function createCharacter(): Character {
    return {
        name: 'DiscTester',
        class: 'Paladin',
        gender: 'male',
        level: 12,
        gold: 100000,
        mammothIdols: 100,
        charms: [{ charmID: 91, count: 1 }],
        talentPoints: {},
        talentResearch: {
            classIndex: null,
            ReadyTime: 0
        },
        TalentTree: {
            '5': {
                nodes: [
                    { nodeID: 1, points: 2, filled: true },
                    { nodeID: 2, points: 1, filled: true }
                ]
            }
        },
        MasterClass: 5,
        magicForge: {
            stats_by_building: {
                '1': 1,
                '2': 1,
                '3': 2,
                '12': 1,
                '13': 1
            }
        },
        CurrentLevel: { name: 'CraftTown', x: 360, y: 1460 },
        PreviousLevel: { name: 'NewbieRoad', x: 1421, y: 826 }
    };
}

function createClient(): FakeClient {
    const sentPackets: SentPacket[] = [];
    const character = createCharacter();
    return {
        authenticated: true,
        userId: 6,
        character,
        characters: [character],
        currentLevel: 'CraftTown',
        playerSpawned: false,
        sentPackets,
        talentResearchTimer: null,
        sendBitBuffer(id: number, bb: BitBuffer): void {
            sentPackets.push({ id, payload: bb.toBuffer() });
        }
    };
}

function createTrainPacket(classIndex: number, isInstant: boolean): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod20(2, classIndex);
    bb.writeMethod15(isInstant);
    return bb.toBuffer();
}

function createActiveTalentPacket(entityId: number, masterClassId: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(entityId);
    bb.writeMethod6(masterClassId, 4);
    return bb.toBuffer();
}

function createAllocateTalentPacket(slots: Array<{ nodeID: number; points: number } | null>): Buffer {
    const bb = new BitBuffer(false);

    for (let index = 0; index < TalentConfig.NUM_TALENT_SLOTS; index += 1) {
        const slot = slots[index] ?? null;
        bb.writeMethod15(slot !== null);
        if (!slot) {
            continue;
        }

        bb.writeMethod6(slot.nodeID, 6);
        bb.writeMethod6(slot.points - 1, TalentConfig.getSlotBitWidth(index));
    }

    bb.writeMethod15(false);
    return bb.toBuffer();
}

function decodeCraftTownVisualData(packet: Buffer) {
    const br = new BitReader(packet);

    br.readMethod4();
    br.readMethod4();
    br.readMethod13();

    const hasOldCoord = br.readMethod20(1) === 1;
    if (hasOldCoord) {
        br.readMethod4();
        br.readMethod4();
    }

    br.readMethod13();
    br.readMethod4();
    br.readMethod13();
    br.readMethod20(6);
    br.readMethod20(6);
    br.readMethod13();
    br.readMethod13();
    br.readMethod13();
    br.readMethod20(1);

    const hasNewCoord = br.readMethod20(1) === 1;
    if (hasNewCoord) {
        br.readMethod45();
        br.readMethod45();
    }

    br.readMethod20(1);
    br.readMethod4();
    const masterClassId = br.readMethod20(4);
    const forgeRank = br.readMethod20(5);
    const keepRank = br.readMethod20(5);
    const towerRank = br.readMethod20(5);
    const tomeRank = br.readMethod20(5);
    const barnRank = br.readMethod20(5);
    const scaffoldingLevel = br.readMethod20(5);

    return {
        masterClassId,
        forgeRank,
        keepRank,
        towerRank,
        tomeRank,
        barnRank,
        scaffoldingLevel
    };
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

async function testRespecUsesPythonNodeMapping(): Promise<void> {
    const client = createClient();

    await withMockedCharacterSave(async () => {
        await TalentHandler.handleRespecTalentTree(client as never, Buffer.alloc(0));
    });

    const nodes = client.character.TalentTree?.['5']?.nodes ?? [];
    assert.equal(nodes.length, TalentConfig.NUM_TALENT_SLOTS);
    assert.equal(nodes[0].nodeID, 1);
    assert.equal(nodes[9].nodeID, 10);
    assert.equal(nodes[18].nodeID, 19);
    assert.equal(nodes[26].nodeID, 27);
    assert.equal(client.character.charms?.length ?? 0, 0);
    assert.equal(TalentConfig.getSlotBitWidth(0), 3);
    assert.equal(TalentConfig.getSlotBitWidth(1), 3);
    assert.equal(TalentConfig.getSlotBitWidth(2), 3);
    assert.equal(TalentConfig.getMaxPointsForSlotIndex(1), 2);
    assert.equal(TalentConfig.getMaxPointsForSlotIndex(2), 3);
}

async function testAllocateTalentTreePreservesHighNodeTypeIdsAndClampsByStorageSlot(): Promise<void> {
    const client = createClient();
    const slots: Array<{ nodeID: number; points: number } | null> = new Array(TalentConfig.NUM_TALENT_SLOTS).fill(null);
    slots[0] = { nodeID: 42, points: 5 };
    slots[1] = { nodeID: 41, points: 5 };
    slots[2] = { nodeID: 28, points: 3 };
    slots[3] = { nodeID: 7, points: 1 };

    await withMockedCharacterSave(async () => {
        await TalentHandler.handleAllocateTalentTreePoints(client as never, createAllocateTalentPacket(slots));
    });

    const nodes = client.character.TalentTree?.['5']?.nodes ?? [];
    assert.deepEqual(nodes[0], { nodeID: 42, points: 5, filled: true });
    assert.deepEqual(nodes[1], { nodeID: 41, points: 2, filled: true });
    assert.deepEqual(nodes[2], { nodeID: 28, points: 3, filled: true });
    assert.deepEqual(nodes[3], { nodeID: 7, points: 1, filled: true });
    assert.equal(nodes[4].filled, false);
}

async function testEmptyAllocateDoesNotClearSavedTalentTree(): Promise<void> {
    const client = createClient();
    const beforeNodes = JSON.stringify(client.character.TalentTree?.['5']?.nodes ?? []);
    const slots: Array<{ nodeID: number; points: number } | null> =
        new Array(TalentConfig.NUM_TALENT_SLOTS).fill(null);

    await withMockedCharacterSave(async () => {
        await TalentHandler.handleAllocateTalentTreePoints(client as never, createAllocateTalentPacket(slots));
    });

    assert.equal(
        JSON.stringify(client.character.TalentTree?.['5']?.nodes ?? []),
        beforeNodes,
        'empty client refresh packets should not wipe a previously saved discipline tree'
    );
}

async function testInstantResearchRequiresClaimLikePython(): Promise<void> {
    const client = createClient();
    const beforeStart = Math.floor(Date.now() / 1000);

    await withMockedCharacterSave(async () => {
        await TalentHandler.handleTrainTalentPoint(client as never, createTrainPacket(2, true));
    });

    const research = client.character.talentResearch as Record<string, unknown>;
    assert.equal(client.character.talentPoints?.['2'] ?? 0, 0, 'instant research should not auto-grant a point');
    assert.equal(Number(research.classIndex ?? -1), 2);
    assert.ok(Number(research.ReadyTime ?? 0) >= beforeStart);
    assert.equal(client.sentPackets.some((packet) => packet.id === 0xB5), true, 'instant idol purchase should refresh premium UI');
    assert.equal(client.sentPackets.some((packet) => packet.id === 0xD5), true, 'instant research should still notify completion');

    await withMockedCharacterSave(async () => {
        await TalentHandler.handleTalentClaim(client as never, Buffer.alloc(0));
    });

    assert.equal(client.character.talentPoints?.['2'], 1);
    assert.deepEqual(client.character.talentResearch, {
        classIndex: null,
        ReadyTime: 0
    });
}

async function testTimedResearchSchedulesCompletionNotify(): Promise<void> {
    const client = createClient();
    const originalSetTimeout = global.setTimeout;
    const originalDateNow = Date.now;
    let scheduledCallback: (() => void) | null = null;
    let scheduledDelayMs = -1;
    let fakeNowMs = originalDateNow();

    Date.now = () => fakeNowMs;
    (global as typeof globalThis & { setTimeout: typeof setTimeout }).setTimeout = ((callback: (...args: any[]) => void, delay?: number) => {
        scheduledCallback = () => callback();
        scheduledDelayMs = Number(delay ?? 0);
        return { unref() { return undefined; } } as unknown as NodeJS.Timeout;
    }) as typeof setTimeout;

    try {
        await withMockedCharacterSave(async () => {
            await TalentHandler.handleTrainTalentPoint(client as never, createTrainPacket(2, false));
        });

        const research = client.character.talentResearch as Record<string, unknown>;
        const readyTime = Number(research.ReadyTime ?? 0);
        assert.equal(Number(research.classIndex ?? -1), 2);
        assert.ok(scheduledDelayMs > 0, 'timed research should arm a completion timer');
        assert.ok(scheduledCallback, 'timed research should schedule a completion callback');

        fakeNowMs = (readyTime * 1000) + 1000;
        const runScheduledCallback = scheduledCallback as (() => void) | null;
        if (runScheduledCallback) {
            runScheduledCallback();
        }

        assert.equal(
            client.sentPackets.some((packet) => packet.id === 0xD5),
            true,
            'scheduled completion should notify the client when research finishes'
        );
    } finally {
        Date.now = originalDateNow;
        (global as typeof globalThis & { setTimeout: typeof setTimeout }).setTimeout = originalSetTimeout;
    }
}

function testEntityBuildsTalentsFromTalentTree(): void {
    const entity = Entity.fromCharacter(41, createCharacter(), {});
    assert.equal(entity.masterClass, 5);
    assert.deepEqual(entity.talents?.[0], { nodeID: 1, points: 2 });
    assert.deepEqual(entity.talents?.[1], { nodeID: 2, points: 1 });
}

function testEntityTalentSlotsKeepClientSlotPositions(): void {
    const character = createCharacter();
    character.TalentTree = {
        '5': {
            nodes: [
                { nodeID: 20, points: 2, filled: true },
                { nodeID: 0, points: 0, filled: false },
                { nodeID: 7, points: 1, filled: true }
            ]
        }
    };

    const entity = Entity.fromCharacter(41, character, {});
    assert.deepEqual(entity.talents?.[0], { nodeID: 20, points: 2 });
    assert.equal(entity.talents?.[1], null);
    assert.deepEqual(entity.talents?.[2], { nodeID: 7, points: 1 });
}

function testWorldEnterResolvesMasterClassFromTowerState(): void {
    const character = createCharacter();
    character.MasterClass = 0;
    character.magicForge = {
        stats_by_building: {
            '1': 1,
            '2': 1,
            '3': 2,
            '12': 1,
            '13': 1
        }
    };

    const packet = WorldEnter.buildEnterWorldPacket(
        77,
        0,
        '',
        false,
        0,
        0,
        'localhost',
        8080,
        'LevelsHome.swf',
        1,
        1,
        'CraftTown',
        '',
        '',
        true,
        true,
        10,
        20,
        character
    ).toBuffer();

    const decoded = decodeCraftTownVisualData(packet);
    assert.equal(decoded.masterClassId, 5);
    assert.equal(decoded.towerRank, 2);
    assert.equal(character.MasterClass, 5, 'resolved master class should be written back to the live character state');

    character.MasterClass = 0;
    WorldEnter.buildPlayerDataPacket(character, 77, 0, 0, 'CraftTown', 10, 20, true, false);
    assert.equal(character.MasterClass, 5, 'player data serialization should also resolve the active master class');
}

async function testSelectedDisciplinePersistsHomeTowerAfterRestart(): Promise<void> {
    const client = createClient();
    client.character.MasterClass = 0;
    client.character.magicForge = {
        stats_by_building: {
            '1': 1,
            '2': 1,
            '12': 1,
            '13': 1
        }
    };

    await withMockedCharacterSave(async () => {
        await TalentHandler.handleActiveTalentChangeRequest(client as never, createActiveTalentPacket(41, 5));
    });

    assert.equal(client.character.MasterClass, 5);
    assert.equal(
        client.character.magicForge?.stats_by_building?.['3'],
        1,
        'selecting Justicar should persist its rank-one home tower instead of leaving it client-only'
    );

    const packet = WorldEnter.buildEnterWorldPacket(
        77,
        0,
        '',
        false,
        0,
        0,
        'localhost',
        8080,
        'LevelsHome.swf',
        1,
        1,
        'CraftTown',
        '',
        '',
        true,
        true,
        10,
        20,
        client.character
    ).toBuffer();

    const decoded = decodeCraftTownVisualData(packet);
    assert.equal(decoded.masterClassId, 5);
    assert.equal(decoded.towerRank, 1, 'restart CraftTown packet should include the selected discipline tower');
}

function testCompletedDisciplineResearchSerializesAfterRestart(): void {
    const character = createCharacter();
    character.talentResearch = {
        classIndex: 2,
        ReadyTime: 0
    };

    const research = WorldEnter.getSerializableTalentResearch(character, Math.floor(Date.now() / 1000));
    assert.deepEqual(
        research,
        { classIndex: 2, readyTime: 0 },
        'completed discipline-point research should stay claimable after room change or restart'
    );
}

function testCompletedClassZeroResearchSerializesAfterRestart(): void {
    const character = createCharacter();
    character.talentResearch = {
        classIndex: 0,
        ReadyTime: 0
    };

    const research = WorldEnter.getSerializableTalentResearch(character, Math.floor(Date.now() / 1000));
    assert.deepEqual(
        research,
        { classIndex: 0, readyTime: 0 },
        'completed class-index-zero research should stay claimable after room change or restart'
    );
}

async function main(): Promise<void> {
    await testRespecUsesPythonNodeMapping();
    await testAllocateTalentTreePreservesHighNodeTypeIdsAndClampsByStorageSlot();
    await testEmptyAllocateDoesNotClearSavedTalentTree();
    await testInstantResearchRequiresClaimLikePython();
    await testTimedResearchSchedulesCompletionNotify();
    testEntityBuildsTalentsFromTalentTree();
    testEntityTalentSlotsKeepClientSlotPositions();
    testWorldEnterResolvesMasterClassFromTowerState();
    await testSelectedDisciplinePersistsHomeTowerAfterRestart();
    testCompletedDisciplineResearchSerializesAfterRestart();
    testCompletedClassZeroResearchSerializesAfterRestart();
    console.log('talent_disciplines_regression: ok');
}

void main().catch((error) => {
    console.error('talent_disciplines_regression: failed');
    console.error(error);
    process.exitCode = 1;
});
