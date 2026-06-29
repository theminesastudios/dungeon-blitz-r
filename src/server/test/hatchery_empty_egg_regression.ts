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
    sentPackets: SentPacket[];
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
        sendBitBuffer(id: number, bb: BitBuffer) {
            sentPackets.push({ id, payload: bb.toBuffer() });
        }
    };
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

async function main(): Promise<void> {
    ensureDataLoaded();
    await testZeroPaddedEggsDoNotBlockDailyHatcherySeed();
    await testInvalidSavedEggIdsAreDroppedBeforePacketSerialization();
    console.log('hatchery_empty_egg_regression passed');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
}).then(() => {
    process.exit(0);
});
