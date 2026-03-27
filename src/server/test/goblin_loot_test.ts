import { strict as assert } from 'assert';
import { GlobalState } from '../core/GlobalState';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { RewardHandler } from '../handlers/RewardHandler';
import { GameData } from '../core/GameData';
import * as path from 'path';

GameData.load(path.join(__dirname, '../data'));

type SentPacket = {
    id: number;
    payload: Buffer;
};

type FakeClient = {
    token: number;
    userId: number | null;
    currentLevel: string;
    levelInstanceId: string;
    currentRoomId: number;
    playerSpawned: boolean;
    clientEntID: number;
    character: any;
    characters: any[];
    authoritativeMaxHp: number;
    authoritativeCurrentHp: number;
    processedRewardSources: Set<string>;
    pendingLoot: Map<number, any>;
    knownEntityIds: Set<number>;
    entities: Map<number, any>;
    sentPackets: SentPacket[];
    send: (id: number, payload: Buffer) => void;
    sendBitBuffer: (id: number, payload: BitBuffer) => void;
};

function createFakeClient(token: number, name: string, levelName: string): FakeClient {
    const sentPackets: SentPacket[] = [];

    const client: FakeClient = {
        token,
        userId: token,
        currentLevel: levelName,
        levelInstanceId: '',
        currentRoomId: 1,
        playerSpawned: true,
        clientEntID: token + 1000,
        character: {
            name,
            level: 3,
            class: 'Rogue',
            xp: 0,
            gold: 0,
            materials: [],
            inventoryGears: []
        },
        characters: [],
        authoritativeMaxHp: 100,
        authoritativeCurrentHp: 100,
        processedRewardSources: new Set<string>(),
        pendingLoot: new Map(),
        knownEntityIds: new Set<number>(),
        entities: new Map<number, any>(),
        sentPackets,
        send(id: number, payload: Buffer) {
            sentPackets.push({ id, payload: Buffer.from(payload) });
        },
        sendBitBuffer(id: number, payload: BitBuffer) {
            sentPackets.push({ id, payload: payload.toBuffer() });
        }
    };
    return client;
}

function buildGrantRewardPayload(sourceId: number, gold: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod9(0); // receiverId
    bb.writeMethod9(sourceId);
    bb.writeMethod15(false); // dropItem
    bb.writeMethod309(1); // itemMultiplier
    bb.writeMethod15(false); // dropGear
    bb.writeMethod309(1); // gearMultiplier
    bb.writeMethod15(false); // dropMaterial
    bb.writeMethod15(false); // dropTrove
    bb.writeMethod9(0); // exp (0 to trigger server calculation)
    bb.writeMethod9(0); // petExp
    bb.writeMethod9(0); // hpGain
    bb.writeMethod9(gold);
    bb.writeMethod45(120); // worldX
    bb.writeMethod45(220); // worldY
    bb.writeMethod15(false); // combo
    return bb.toBuffer();
}

async function runTests(): Promise<void> {
    console.log('Starting Goblin Loot Regression Tests...');
    const originalRandom = Math.random;
    Math.random = () => 0.01; // Force low rolls for loot drops
    try {
        GlobalState.sessionsByToken.clear();
        GlobalState.levelEntities.clear();
        GlobalState.combatContributions.clear();

        // 1. Tutorial Small Enemy (Should drop gold/hp/mat but NOT gear)
        const client1 = createFakeClient(123, 'TestHero', 'TutorialDungeon');
        GlobalState.sessionsByToken.set(123, client1 as any);
        GlobalState.levelEntities.set('TutorialDungeon', new Map([[555, { id: 555, name: 'IntroGoblinClub', x: 100, y: 100 }]]));
        GlobalState.combatContributions.set(`TutorialDungeon:555:0`, new Map([['testhero', 100]]));

        await RewardHandler.handleGrantReward(client1 as any, buildGrantRewardPayload(555, 0));
        assert.ok(client1.pendingLoot.size > 0, 'Tutorial small enemy SHOULD drop some loot (gold/hp/mat)');
        for (const loot of client1.pendingLoot.values()) {
            assert.ok(!loot.gear, 'Tutorial small enemy should NOT drop gear');
        }
        console.log('Test 1: Tutorial Small Enemy -> Drops non-gear loot (PASS)');

        // 2. Tutorial Large Enemy (Should drop EVERYTHING including gear)
        const client2 = createFakeClient(124, 'TestHero2', 'TutorialDungeon');
        GlobalState.sessionsByToken.set(124, client2 as any);
        GlobalState.levelEntities.set('TutorialDungeon', new Map([[666, { id: 666, name: 'IntroGoblinBrute', x: 100, y: 100 }]]));
        GlobalState.combatContributions.set(`TutorialDungeon:666:0`, new Map([['testhero2', 100]]));

        await RewardHandler.handleGrantReward(client2 as any, buildGrantRewardPayload(666, 0));
        assert.ok(client2.pendingLoot.size > 0, 'Tutorial large enemy SHOULD drop loot');
        let foundGear = false;
        for (const loot of client2.pendingLoot.values()) {
            if (loot.gear) foundGear = true;
        }
        assert.ok(foundGear, 'Tutorial large enemy SHOULD drop gear with low random roll');
        console.log('Test 2: Tutorial Large Enemy -> Drops all loot including gear (PASS)');

        // 3. Non-Tutorial Small Enemy (NewbieRoad) (Should drop EVERYTHING including gear)
        const client3 = createFakeClient(125, 'TestHero3', 'NewbieRoad');
        GlobalState.sessionsByToken.set(125, client3 as any);
        GlobalState.levelEntities.set('NewbieRoad', new Map([[777, { id: 777, name: 'IntroGoblinClub', x: 100, y: 100 }]]));
        GlobalState.combatContributions.set(`NewbieRoad:777:0`, new Map([['testhero3', 100]]));

        await RewardHandler.handleGrantReward(client3 as any, buildGrantRewardPayload(777, 0));
        assert.ok(client3.pendingLoot.size > 0, 'Non-tutorial small enemy SHOULD drop loot');
        
        let foundGear3 = false;
        for (const loot of client3.pendingLoot.values()) {
            if (loot.gear) foundGear3 = true;
        }
        assert.ok(foundGear3, 'Non-tutorial small enemy SHOULD drop gear');
        console.log('Test 3: Non-Tutorial Small Enemy (NewbieRoad) -> Drops all loot including gear (PASS)');

        console.log('\nAll goblin loot tests passed successfully! ✅');
    } catch (err) {
        console.error('\nLoot tests failed:', err);
        Math.random = originalRandom;
        process.exit(1);
    } finally {
        Math.random = originalRandom;
    }
}

runTests();
