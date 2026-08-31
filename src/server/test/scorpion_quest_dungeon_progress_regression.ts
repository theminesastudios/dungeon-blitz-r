/**
 * Regression test for issue #760 — Scorpion kills in the three authored Shazari dungeon
 * routes must progress "An Ironic Hunt" even when no later terminal/destroy packet arrives.
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
import { BitBuffer } from '../network/protocol/bitBuffer';

type SentPacket = { id: number; payload: Buffer };

const DUNGEONS = ['SD_Mission2', 'SD_Mission4', 'SD_Mission5'] as const;

function ensureDataLoaded(): void {
    const dataDir = path.resolve(__dirname, '../data');
    if (!LevelConfig.has(DUNGEONS[0])) LevelConfig.load(dataDir);
    if (Object.keys(GameData.ENTTYPES).length === 0) GameData.load(dataDir);
    if (!MissionLoader.getMissionDef(MissionID.GatherScorpionStingers)) MissionLoader.load(dataDir);
}

async function assertScorpionProgress(dungeon: string, index: number): Promise<void> {
    const character = {
        name: `ScorpionQuestRegression${index}`,
        level: 25,
        CurrentLevel: { name: dungeon, x: 100, y: 200 },
        missions: {
            [String(MissionID.GatherScorpionStingers)]: {
                state: 1,
                currCount: 0
            }
        }
    };
    const sentPackets: SentPacket[] = [];
    const client: any = {
        token: 7600 + index,
        userId: 0,
        playerSpawned: true,
        currentLevel: dungeon,
        levelInstanceId: `issue-760-${index}`,
        currentRoomId: 1,
        clientEntID: 9100 + index,
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
    const scope = `${dungeon}#${client.levelInstanceId}`;
    const entityId = 76000 + index;
    const scorpion = {
        id: entityId,
        name: 'ScarabPredator',
        isPlayer: false,
        team: EntityTeam.ENEMY,
        clientSpawned: false,
        hybridCanonicalHostile: true,
        entState: EntityState.DEAD,
        dead: true,
        destroyed: false,
        maxHp: 12_000,
        hp: 0,
        x: 500,
        y: 300,
        v: 0,
        roomId: 1
    };

    client.entities.set(entityId, scorpion);
    GlobalState.sessionsByToken.set(client.token, client);
    GlobalState.levelEntities.set(scope, new Map([[entityId, scorpion]]));

    (CombatHandler as any).handleEnemyDefeatState(client, scope, entityId, scorpion);
    await new Promise<void>((resolve) => setImmediate(resolve));

    const mission = character.missions[String(MissionID.GatherScorpionStingers)];
    assert.equal(mission.currCount, 1, `${dungeon} must count a server-resolved Scorpion kill`);
    assert.equal(mission.state, 1, 'one stinger keeps the mission in progress');
    assert.ok(
        sentPackets.some((packet) => packet.id === 0x83),
        `${dungeon} must send immediate mission progress to the client`
    );
}

async function main(): Promise<void> {
    ensureDataLoaded();

    for (let index = 0; index < DUNGEONS.length; index += 1) {
        await assertScorpionProgress(DUNGEONS[index], index);
    }

    console.log('scorpion_quest_dungeon_progress_regression: ok');
}

void main().catch((error) => {
    console.error(error);
    process.exit(1);
});
