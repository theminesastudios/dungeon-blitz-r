import { strict as assert } from 'assert';
import * as path from 'path';
import { CharacterHandler } from '../handlers/CharacterHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { BitReader } from '../network/protocol/bitReader';
import { GlobalState } from '../core/GlobalState';
import { GameData } from '../core/GameData';
import { JsonAdapter } from '../database/JsonAdapter';

type SentPacket = {
    id: number;
    payload: Buffer;
};

type FakeClient = {
    userId: number;
    token: number;
    clientEntID: number;
    currentLevel: string;
    currentRoomId: number;
    levelInstanceId: string;
    playerSpawned: boolean;
    character: any;
    characters: any[];
    entities: Map<number, any>;
    knownEntityIds: Set<number>;
    socket: { destroyed: boolean; readyState: string };
    sentPackets: SentPacket[];
    send(id: number, payload: Buffer): void;
    sendBitBuffer(id: number, bb: BitBuffer): void;
};

function ensureGameDataLoaded(): void {
    if (!Array.isArray(GameData.DYES) || GameData.DYES.length === 0) {
        GameData.load(path.resolve(__dirname, '../data'));
    }
}

function createClient(token: number, level: string = 'CraftTown'): FakeClient {
    const sentPackets: SentPacket[] = [];
    const character = {
        name: `Neo${token}`,
        class: 'Paladin',
        gender: 'Male',
        level: 10,
        gold: 100000,
        mammothIdols: 500,
        shirtColor: 0,
        pantColor: 0,
        headSet: 'Head01',
        hairSet: 'Hair01',
        mouthSet: 'Mouth01',
        faceSet: 'Face01',
        hairColor: 0x111111,
        skinColor: 0xe0c0a0,
        equippedGears: [
            { gearID: 1177, tier: 2, runes: [0, 0, 0], colors: [0, 0] },
            { gearID: 1181, tier: 1, runes: [0, 0, 0], colors: [0, 0] },
            { gearID: 0, tier: 0, runes: [0, 0, 0], colors: [0, 0] },
            { gearID: 0, tier: 0, runes: [0, 0, 0], colors: [0, 0] },
            { gearID: 0, tier: 0, runes: [0, 0, 0], colors: [0, 0] },
            { gearID: 0, tier: 0, runes: [0, 0, 0], colors: [0, 0] }
        ],
        inventoryGears: [
            { gearID: 1177, tier: 2, runes: [0, 0, 0], colors: [0, 0] },
            { gearID: 1181, tier: 1, runes: [0, 0, 0], colors: [0, 0] }
        ]
    };

    return {
        userId: token,
        token,
        clientEntID: 400 + token,
        currentLevel: level,
        currentRoomId: 0,
        levelInstanceId: '',
        playerSpawned: true,
        character,
        characters: [character],
        entities: new Map([[400 + token, { id: 400 + token, isPlayer: true, equippedGears: character.equippedGears, shirtColor: 0, pantColor: 0 }]]),
        knownEntityIds: new Set<number>(),
        socket: { destroyed: false, readyState: 'open' },
        sentPackets,
        send(id: number, payload: Buffer): void {
            sentPackets.push({ id, payload: Buffer.from(payload) });
        },
        sendBitBuffer(id: number, bb: BitBuffer): void {
            sentPackets.push({ id, payload: bb.toBuffer() });
        }
    };
}

function buildApplyDyePacket(entityId: number, slot1: [number, number], shirtDyeId: number, pantDyeId: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(entityId);

    for (let slot = 1; slot <= 6; slot++) {
        if (slot === 1) {
            bb.writeMethod20(1, 1);
            bb.writeMethod20(8, slot1[0]);
            bb.writeMethod20(8, slot1[1]);
        } else {
            bb.writeMethod20(1, 0);
        }
    }

    bb.writeMethod20(1, 0);
    bb.writeMethod20(1, 1);
    bb.writeMethod20(8, shirtDyeId);
    bb.writeMethod20(1, 1);
    bb.writeMethod20(8, pantDyeId);
    return bb.toBuffer();
}

function parseDyeSyncPacket(payload: Buffer): { entityId: number; slot1Colors: [number, number]; shirtColor: number; pantColor: number } {
    const br = new BitReader(payload);
    const entityId = br.readMethod4();
    let slot1Colors: [number, number] = [0, 0];

    for (let slot = 1; slot <= 6; slot++) {
        const hasPair = br.readMethod6(1);
        if (!hasPair) {
            continue;
        }

        const c1 = br.readMethod6(8);
        const c2 = br.readMethod6(8);
        if (slot === 1) {
            slot1Colors = [c1, c2];
        }
    }

    const shirtColor = br.readMethod6(1) ? br.readMethod6(24) : 0;
    const pantColor = br.readMethod6(1) ? br.readMethod6(24) : 0;
    return { entityId, slot1Colors, shirtColor, pantColor };
}

async function testApplyDyeUpdatesAppearanceAndPersists(): Promise<void> {
    ensureGameDataLoaded();

    const client = createClient(1);
    const observer = createClient(2);
    observer.currentLevel = client.currentLevel;

    const levelMap = new Map<number, any>([
        [client.clientEntID, client.entities.get(client.clientEntID)],
        [observer.clientEntID, observer.entities.get(observer.clientEntID)]
    ]);

    const originalSaveCharacterSnapshot = JsonAdapter.prototype.saveCharacterSnapshot;
    const originalSessionsByToken = GlobalState.sessionsByToken;
    const originalLevelEntities = GlobalState.levelEntities;

    let savedCharacter: any = null;
    JsonAdapter.prototype.saveCharacterSnapshot = async function(_userId: number, character: any): Promise<any[]> {
        savedCharacter = character;
        return [character];
    };

    GlobalState.sessionsByToken = new Map([
        [client.token, client as never],
        [observer.token, observer as never]
    ]);
    GlobalState.levelEntities = new Map([[client.currentLevel, levelMap]]);

    const shirtDyeId = GameData.getDyeId('WizardWoolWhite');
    const pantDyeId = GameData.getDyeId('BroodMotherBlack');
    assert.ok(shirtDyeId > 0);
    assert.ok(pantDyeId > 0);

    try {
        await CharacterHandler.handleApplyDyes(
            client as never,
            buildApplyDyePacket(client.clientEntID, [12, 34], shirtDyeId, pantDyeId)
        );
    } finally {
        JsonAdapter.prototype.saveCharacterSnapshot = originalSaveCharacterSnapshot;
        GlobalState.sessionsByToken = originalSessionsByToken;
        GlobalState.levelEntities = originalLevelEntities;
    }

    assert.ok(savedCharacter, 'dye apply should persist the updated character');
    assert.deepEqual(client.character.equippedGears[0].colors, [12, 34], 'equipped gear colors should update');
    assert.deepEqual(client.character.inventoryGears[0].colors, [12, 34], 'inventory gear colors should mirror equipped gear colors');
    assert.equal(client.character.gold, 97690, 'dye apply should charge gold based on changed gear dye channels');
    assert.equal(client.sentPackets.some((packet) => packet.id === 0xB4), true, 'dye apply should send a gold loss packet');
    assert.equal(client.sentPackets.some((packet) => packet.id === 0x1A), true, 'dye apply should refresh the local paper-doll HUD');

    const dyeSync = client.sentPackets.find((packet) => packet.id === 0x111);
    assert.ok(dyeSync, 'dye apply should send a 0x111 dye sync packet to the player');
    const parsedSync = parseDyeSyncPacket(dyeSync!.payload);
    assert.equal(parsedSync.entityId, client.clientEntID);
    assert.deepEqual(parsedSync.slot1Colors, [12, 34]);
    assert.equal(parsedSync.shirtColor, GameData.getDyeColor(shirtDyeId));
    assert.equal(parsedSync.pantColor, GameData.getDyeColor(pantDyeId));

    assert.equal(observer.sentPackets.some((packet) => packet.id === 0x111), true, 'same-level observers should receive dye sync');

    const localEntity = client.entities.get(client.clientEntID);
    assert.deepEqual(localEntity?.equippedGears?.[0]?.colors, [12, 34], 'live entity gear colors should update');
    assert.equal(localEntity?.shirtColor, GameData.getDyeColor(shirtDyeId), 'live entity shirt color should update');
    assert.equal(localEntity?.pantColor, GameData.getDyeColor(pantDyeId), 'live entity pant color should update');
}

async function main(): Promise<void> {
    await testApplyDyeUpdatesAppearanceAndPersists();
    console.log('apply_dye_regression: ok');
}

void main().catch((error) => {
    console.error('apply_dye_regression: failed');
    console.error(error);
    process.exitCode = 1;
});
