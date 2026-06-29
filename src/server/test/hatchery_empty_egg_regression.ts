import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { PetConfig } from '../core/PetConfig';
import { PetHandler } from '../handlers/PetHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { BitReader } from '../network/protocol/bitReader';

type SentPacket = { id: number; payload: Buffer };

type FakeClient = {
    userId: null;
    character: any;
    characters: any[];
    clientEntID?: number;
    currentLevel?: string;
    playerSpawned?: boolean;
    mountTransferGraceUntil?: number;
    entities?: Map<number, any>;
    sentPackets: SentPacket[];
    send(id: number, payload: Buffer): void;
    sendBitBuffer(id: number, bb: BitBuffer): void;
};

function ensureDataLoaded(): void {
    if (PetConfig.EGG_TYPES.length === 0 || PetConfig.PET_TYPES.length === 0) {
        const sourceDataDir = path.resolve(__dirname, '../data');
        const compiledDataDir = path.resolve(__dirname, '../../data');
        PetConfig.load(fs.existsSync(path.join(sourceDataDir, 'egg_types.json')) ? sourceDataDir : compiledDataDir);
    }
}

function createFakeClient(character: any): FakeClient {
    const sentPackets: SentPacket[] = [];
    return {
        userId: null,
        character,
        characters: [character],
        sentPackets,
        send(id: number, payload: Buffer) {
            sentPackets.push({ id, payload });
        },
        sendBitBuffer(id: number, bb: BitBuffer) {
            sentPackets.push({ id, payload: bb.toBuffer() });
        }
    };
}

function buildPetEquipPacket(slots: Array<{ typeID: number; uniqueID: number }>): Buffer {
    const bb = new BitBuffer(false);
    const padded = slots.slice(0, 4);
    while (padded.length < 4) {
        padded.push({ typeID: 0, uniqueID: 0 });
    }

    for (const slot of padded) {
        bb.writeMethod6(slot.typeID, 7);
        bb.writeMethod9(slot.uniqueID);
    }

    return bb.toBuffer();
}

function decodeHatcheryPacket(payload: Buffer): { slotCount: number; eggs: number[]; resetTime: number } {
    const br = new BitReader(payload);
    const slotCount = br.readMethod6(6);
    const eggs: number[] = [];
    for (let i = 0; i < slotCount; i++) {
        eggs.push(br.readMethod6(6));
    }
    return {
        slotCount,
        eggs,
        resetTime: br.readMethod4()
    };
}

async function testZeroPaddedEggsDoNotBlockDailyHatcherySeed(): Promise<void> {
    const futureReset = Math.floor(Date.now() / 1000) + 3600;
    const client = createFakeClient({
        name: 'EggTutorial',
        OwnedEggsID: [0, 0, 0, 0, 0, 0, 0, 0],
        EggResetTime: futureReset,
        EggNotifySent: true
    });

    await PetHandler.handleRequestHatcheryEggs(client as never, Buffer.alloc(0));

    assert.equal(client.sentPackets.length, 1);
    assert.equal(client.sentPackets[0].id, 0xE5);

    const decoded = decodeHatcheryPacket(client.sentPackets[0].payload);
    const visibleEggs = decoded.eggs.filter((eggId) => eggId > 0);
    assert.equal(decoded.slotCount, PetConfig.MAX_EGG_SLOTS);
    assert.equal(visibleEggs.length, 3, 'empty saved hatchery should receive the starter daily egg set');
    assert.deepEqual(client.character.OwnedEggsID, visibleEggs);
    assert.ok(client.character.EggResetTime > futureReset, 'forced reseed should advance the hatchery reset time');
    assert.equal(client.character.EggNotifySent, false);
}

async function testInvalidSavedEggIdsAreDroppedBeforePacketSerialization(): Promise<void> {
    const client = createFakeClient({
        name: 'EggCleanup',
        OwnedEggsID: [0, 4, 999, -1, 12],
        EggResetTime: Math.floor(Date.now() / 1000) + 3600,
        EggNotifySent: true
    });

    await PetHandler.handleRequestHatcheryEggs(client as never, Buffer.alloc(0));

    const decoded = decodeHatcheryPacket(client.sentPackets[0].payload);
    assert.deepEqual(decoded.eggs.slice(0, 2), [4, 12]);
    assert.deepEqual(decoded.eggs.slice(2), [0, 0, 0, 0, 0, 0]);
    assert.deepEqual(client.character.OwnedEggsID, [4, 12]);
}

async function testExpiredActiveEggSendsReadyPacketOnce(): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const client = createFakeClient({
        name: 'EggReady',
        OwnedEggsID: [4],
        EggResetTime: now + 3600,
        EggHachery: {
            EggID: 4,
            ReadyTime: now - 1,
            slotIndex: 0
        },
        activeEggCount: 1
    });

    const didSync = await PetHandler.syncCompletedEggHatch(client as never, now);

    assert.equal(didSync, true);
    assert.equal(client.sentPackets.length, 1);
    assert.equal(client.sentPackets[0].id, 0xE7);
    assert.equal(new BitReader(client.sentPackets[0].payload).readMethod6(6), 4);
    assert.equal(client.character.EggHachery.ReadyTime, 0);

    const didSyncAgain = await PetHandler.syncCompletedEggHatch(client as never, now);
    assert.equal(didSyncAgain, false);
    assert.equal(client.sentPackets.length, 1, 'ready packet should not repeat after ReadyTime is already 0');
}

async function testCollectReadyEggSendsClientPetInventoryPacket(): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const client = createFakeClient({
        name: 'EggCollect',
        pets: [],
        OwnedEggsID: [5],
        EggResetTime: now + 3600,
        EggHachery: {
            EggID: 5,
            ReadyTime: 0,
            slotIndex: 0
        },
        activeEggCount: 1
    });

    await PetHandler.handleCollectHatchedEgg(client as never, Buffer.alloc(0));

    assert.equal(client.character.pets.length, 1, 'collect should persist the hatched pet');
    assert.deepEqual(client.character.OwnedEggsID, [], 'collect should remove the hatched egg');
    assert.equal(client.character.EggHachery.EggID, 0, 'collect should reset the active egg state');

    const petPacket = client.sentPackets.find((packet) => packet.id === 0x37);
    if (!petPacket) {
        assert.fail('collect should send the client new-pet inventory packet');
    }

    const petReader = new BitReader(petPacket.payload);
    assert.equal(petReader.readMethod6(7), client.character.pets[0].typeID);
    assert.equal(petReader.readMethod4(), client.character.pets[0].special_id);
    assert.equal(petReader.readMethod6(6), 1);
    assert.equal(petReader.readMethod15(), false);
    assert.equal(client.sentPackets.some((packet) => packet.id === 0x30), false, 'collect should not send the equipment update packet');
    assert.equal(client.sentPackets.some((packet) => packet.id === 0xE5), true, 'collect should refresh hatchery contents');
}

async function testEquipPetsUpdatesSelectedPetSlots(): Promise<void> {
    const client = createFakeClient({
        name: 'PetEquip',
        pets: [
            { typeID: 11, special_id: 101, level: 3, xp: 0 },
            { typeID: 12, special_id: 102, level: 2, xp: 0 },
            { typeID: 13, special_id: 103, level: 1, xp: 0 }
        ],
        activePet: { typeID: 11, special_id: 101 },
        restingPets: []
    });

    await PetHandler.handleEquipPets(
        client as never,
        buildPetEquipPacket([
            { typeID: 12, uniqueID: 102 },
            { typeID: 13, uniqueID: 103 }
        ])
    );

    assert.deepEqual(client.character.activePet, { typeID: 12, special_id: 102 });
    assert.deepEqual(client.character.restingPets, [
        { typeID: 13, special_id: 103 },
        { typeID: 0, special_id: 0 },
        { typeID: 0, special_id: 0 }
    ]);
}

async function testMountEquipPacketUpdatesSelectedMount(): Promise<void> {
    const client = createFakeClient({
        name: 'MountEquip',
        mounts: [1, 7],
        equippedMount: 1
    });
    client.clientEntID = 42;
    client.entities = new Map([[42, { id: 42, equippedMount: 1 }]]);
    client.playerSpawned = false;
    client.currentLevel = '';
    client.mountTransferGraceUntil = 0;

    await PetHandler.handleMountEquipPacket(
        client as never,
        PetHandler.buildMountEquipPacket(42, 7)
    );

    assert.equal(client.character.equippedMount, 7);
    assert.equal(client.entities.get(42).equippedMount, 7);
}

function testTransferCompanionStateWinsAfterReload(): void {
    const loadedFromDisk = {
        name: 'ReloadedCompanion',
        mounts: [1, 7],
        equippedMount: 1,
        pets: [
            { typeID: 11, special_id: 101, level: 3, xp: 0 },
            { typeID: 12, special_id: 102, level: 2, xp: 0 }
        ],
        activePet: { typeID: 11, special_id: 101 },
        restingPets: []
    };
    const pendingTransferState = {
        equippedMount: 7,
        activePet: { typeID: 12, special_id: 102 },
        restingPets: [{ typeID: 11, special_id: 101 }]
    };

    const changed = PetHandler.syncEquippedCompanionState(loadedFromDisk, pendingTransferState);

    assert.equal(changed, true);
    assert.equal(loadedFromDisk.equippedMount, 7);
    assert.deepEqual(loadedFromDisk.activePet, { typeID: 12, special_id: 102 });
    assert.deepEqual(loadedFromDisk.restingPets, [{ typeID: 11, special_id: 101 }]);
}

async function main(): Promise<void> {
    ensureDataLoaded();
    await testZeroPaddedEggsDoNotBlockDailyHatcherySeed();
    await testInvalidSavedEggIdsAreDroppedBeforePacketSerialization();
    await testExpiredActiveEggSendsReadyPacketOnce();
    await testCollectReadyEggSendsClientPetInventoryPacket();
    await testEquipPetsUpdatesSelectedPetSlots();
    await testMountEquipPacketUpdatesSelectedMount();
    testTransferCompanionStateWinsAfterReload();
    console.log('hatchery_empty_egg_regression passed');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
}).then(() => {
    process.exit(0);
});
