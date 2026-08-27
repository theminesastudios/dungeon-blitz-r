/**
 * Regression test for issue #753 — SandWorm kills on Ancient Unrest's normal route must
 * progress "It's Snot a Problem" even when the corpse never emits a later 0x0D destroy.
 */
import { strict as assert } from 'assert';
import * as path from 'path';
import { GlobalState } from '../core/GlobalState';
import { GameData } from '../core/GameData';
import { EntityState, EntityTeam } from '../core/Entity';
import { LevelConfig } from '../core/LevelConfig';
import { MissionLoader } from '../data/MissionLoader';
import { MissionID } from '../data/runtime';
import { CombatHandler } from '../handlers/CombatHandler';
import { LevelHandler } from '../handlers/LevelHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';

type SentPacket = { id: number; payload: Buffer };

const DUNGEON = 'SD_Mission5';
const ENTITY_ID = 75301;

function ensureDataLoaded(): void {
    const dataDir = path.resolve(__dirname, '../data');
    if (!LevelConfig.has(DUNGEON)) LevelConfig.load(dataDir);
    if (Object.keys(GameData.ENTTYPES).length === 0) GameData.load(dataDir);
    if (!MissionLoader.getMissionDef(MissionID.CollectWormGlands)) MissionLoader.load(dataDir);
}

function buildDeadStatePayload(entityId: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(entityId);
    bb.writeMethod45(0);
    bb.writeMethod45(0);
    bb.writeMethod45(0);
    bb.writeMethod6(EntityState.DEAD, 2);
    bb.writeMethod15(false); // left
    bb.writeMethod15(false); // running
    bb.writeMethod15(false); // jumping
    bb.writeMethod15(false); // dropping
    bb.writeMethod15(false); // backpedal
    bb.writeMethod15(false); // airborne
    return bb.toBuffer();
}

async function main(): Promise<void> {
    ensureDataLoaded();

    const character = {
        name: 'SandwormQuestRegression',
        level: 25,
        CurrentLevel: { name: DUNGEON, x: 100, y: 200 },
        missions: {
            [String(MissionID.CollectWormGlands)]: {
                state: 1,
                currCount: 0
            }
        }
    };
    const sentPackets: SentPacket[] = [];
    const client: any = {
        token: 753,
        userId: 0,
        playerSpawned: true,
        currentLevel: DUNGEON,
        levelInstanceId: 'issue-753',
        currentRoomId: 1,
        clientEntID: 9001,
        character,
        characters: [character],
        entities: new Map<number, any>(),
        knownEntityIds: new Set<number>(),
        entityIdAliases: new Map<number, number>(),
        triggeredLevelStates: new Set<string>(),
        startedRoomIds: new Set<number>(),
        sentPackets,
        send(id: number, payload: Buffer) {
            sentPackets.push({ id, payload: Buffer.from(payload) });
        },
        sendBitBuffer(id: number, bb: BitBuffer) {
            sentPackets.push({ id, payload: bb.toBuffer() });
        }
    };
    const scope = `${DUNGEON}#${client.levelInstanceId}`;
    const sandworm = {
        id: ENTITY_ID,
        name: 'SandWorm',
        isPlayer: false,
        team: EntityTeam.ENEMY,
        // EntityHandler.normalizeHybridClientSpawnHostileCanonical deliberately turns the
        // original clientSpawned flag off on the canonical copy and replaces it with this flag.
        // The issue only reproduces when the regression mirrors that production shape.
        clientSpawned: false,
        hybridCanonicalHostile: true,
        entState: EntityState.ACTIVE,
        dead: false,
        destroyed: false,
        // Reproduce the bug: the server's derived/partially tracked pool remains positive when
        // Flash reports the authored death transition.
        maxHp: 12_000,
        hp: 3_000,
        x: 500,
        y: 300,
        v: 0,
        roomId: 1
    };

    client.entities.set(ENTITY_ID, sandworm);
    GlobalState.sessionsByToken.set(client.token, client);
    GlobalState.levelEntities.set(scope, new Map([[ENTITY_ID, sandworm]]));

    // Normal-route worms end through the server's final-hit calculation without sending the
    // later 0x07 DEAD/0x0D destroy signal emitted by the treasure-room variants.
    sandworm.hp = 0;
    sandworm.dead = true;
    sandworm.entState = EntityState.DEAD;
    (CombatHandler as any).handleEnemyDefeatState(client, scope, ENTITY_ID, sandworm);
    await new Promise<void>((resolve) => setImmediate(resolve));

    const mission = character.missions[String(MissionID.CollectWormGlands)];
    assert.equal(mission.currCount, 1, 'a server-resolved normal-route SandWorm kill must add one gland');
    assert.equal(mission.state, 1, 'one of fifteen glands keeps the mission in progress');
    assert.ok(
        sentPackets.some((packet) => packet.id === 0x83),
        'the client must receive an immediate mission progress packet'
    );

    LevelHandler.handleEntityIncrementalUpdate(client, buildDeadStatePayload(ENTITY_ID));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(mission.currCount, 1, 'a later terminal packet must not count the same worm twice');

    const serverOwnedId = ENTITY_ID + 1;
    const serverOwnedEnemy = {
        ...sandworm,
        id: serverOwnedId,
        hp: 3_000,
        dead: false,
        destroyed: false,
        entState: EntityState.ACTIVE,
        questDefeatProcessed: false,
        clientSpawned: false,
        hybridCanonicalHostile: false
    };
    client.entities.set(serverOwnedId, serverOwnedEnemy);
    GlobalState.levelEntities.get(scope)?.set(serverOwnedId, serverOwnedEnemy);

    LevelHandler.handleEntityIncrementalUpdate(client, buildDeadStatePayload(serverOwnedId));
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(mission.currCount, 1, 'an untrusted server-owned death must not advance the gland mission');
    assert.equal(serverOwnedEnemy.hp, 3_000, 'a positive-HP server-owned enemy keeps the alive correction');
    assert.equal(serverOwnedEnemy.entState, EntityState.ACTIVE, 'the mission exception must not bypass server authority');

    console.log('sandworm_quest_dungeon_progress_regression: ok');
}

void main().catch((error) => {
    console.error(error);
    process.exit(1);
});
