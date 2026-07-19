import { strict as assert } from 'assert';
import path from 'path';
import { EntityState, EntityTeam } from '../core/Entity';
import { GameData } from '../core/GameData';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';
import { getClientLevelScope } from '../core/LevelScope';
import { LevelHandler } from '../handlers/LevelHandler';
import { RewardHandler } from '../handlers/RewardHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';

type SentPacket = { id: number; payload: Buffer };

function client(token: number, name: string, scopeInstance: string): any {
    const sentPackets: SentPacket[] = [];
    const events: string[] = [];
    const character = {
        name,
        CurrentLevel: { name: 'JC_Mini1Hard', x: 100, y: 100 },
        PreviousLevel: { name: 'Castle', x: 0, y: 0 },
        missions: {},
        questTrackerState: 0,
        level: 20,
        xp: 0,
        gold: 0
    };
    return {
        token,
        userId: null,
        character,
        characters: [character],
        currentLevel: 'JC_Mini1Hard',
        levelInstanceId: scopeInstance,
        currentRoomId: 4,
        playerSpawned: true,
        clientEntID: token + 1000,
        entities: new Map<number, any>(),
        knownEntityIds: new Set<number>(),
        pendingLoot: new Map<number, any>(),
        processedRewardSources: new Set<string>(),
        authoritativeMaxHp: 1000,
        socket: { destroyed: false, readyState: 'open', write: () => true },
        sentPackets,
        events,
        send(id: number, payload: Buffer) {
            sentPackets.push({ id, payload: Buffer.from(payload) });
            events.push(`packet:${id}`);
        },
        sendBitBuffer(id: number, bb: BitBuffer) { sentPackets.push({ id, payload: bb.toBuffer() }); },
        scheduleCharacterSave() { events.push('save'); }
    };
}

async function main(): Promise<void> {
    const dataDir = path.resolve(__dirname, '..', 'data');
    LevelConfig.load(dataDir);
    GameData.load(dataDir);
    GlobalState.sessionsByToken.clear();
    GlobalState.partyByMember.clear();
    GlobalState.sessionsByCharacterName.clear();

    const first = client(5101, 'LatencyOne', 'latency-run');
    const second = client(5102, 'LatencyTwo', 'latency-run');
    GlobalState.partyByMember.set('latencyone', 6001);
    GlobalState.partyByMember.set('latencytwo', 6001);
    GlobalState.sessionsByCharacterName.set('latencyone', first);
    GlobalState.sessionsByCharacterName.set('latencytwo', second);
    GlobalState.sessionsByToken.set(first.token, first);
    GlobalState.sessionsByToken.set(second.token, second);
    const levelScope = getClientLevelScope(first);

    for (let index = 0; index < 250; index++) {
        const unrelated = client(7000 + index, `Unrelated${index}`, `other-${index}`);
        unrelated.currentLevel = 'NewbieRoad';
        unrelated.levelInstanceId = '';
        GlobalState.sessionsByToken.set(unrelated.token, unrelated);
        Object.defineProperty(unrelated, 'entities', {
            get() { throw new Error('unrelated online session was scanned'); }
        });
    }

    const recipients = (RewardHandler as any).resolveServerEnemyRewardViewers(first, levelScope);
    assert.deepEqual(new Set(recipients), new Set([first, second]));

    const enemy = {
        id: 99001,
        name: 'GoblinDagger',
        isPlayer: false,
        clientSpawned: false,
        team: EntityTeam.ENEMY,
        roomId: 4,
        x: 100,
        y: 100,
        hp: 0,
        maxHp: 500,
        dead: true,
        destroyed: true,
        entState: EntityState.DEAD,
        lifeNonce: 1,
        deathFinalizedAt: Date.now(),
        finalDeathReason: 'latency_regression',
        lootDropNonce: `${levelScope}:99001:1`
    };
    GlobalState.levelEntities.set(levelScope, new Map([[enemy.id, enemy]]));
    RewardHandler.grantServerEnemyRewardToEligibleViewers(first, enemy, {
        levelScope,
        sourceEnemyCanonicalId: enemy.id,
        lootDropNonce: enemy.lootDropNonce,
        caller: 'latency_regression_authoritative_death'
    });
    assert(first.sentPackets.some((packet: SentPacket) => packet.id === 0x32), 'authority client did not receive loot synchronously');
    assert(second.sentPackets.some((packet: SentPacket) => packet.id === 0x32), 'party client did not receive loot synchronously');
    assert(first.events.indexOf('packet:50') >= 0);
    assert(first.events.indexOf('save') < 0 || first.events.indexOf('packet:50') < first.events.indexOf('save'));

    const originalRefresh = LevelHandler.refreshSharedDungeonQuestProgress;
    let refreshCalls = 0;
    (LevelHandler as any).refreshSharedDungeonQuestProgress = () => { refreshCalls += 1; return 50; };
    try {
        for (let index = 0; index < 100; index++) {
            LevelHandler.scheduleSharedDungeonQuestProgressRefresh(levelScope, { reason: 'dedupe_test' });
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
        assert.equal(refreshCalls, 1, 'progress refresh requests were not deduplicated');
        const metrics = LevelHandler.getSharedDungeonProgressRefreshMetrics(levelScope);
        assert(metrics.deduplicated >= 99);
        assert.equal(metrics.executed, 1);
    } finally {
        (LevelHandler as any).refreshSharedDungeonQuestProgress = originalRefresh;
    }

    GlobalState.levelEntities.delete(levelScope);
    GlobalState.sessionsByToken.clear();
    GlobalState.partyByMember.clear();
    GlobalState.sessionsByCharacterName.clear();
    console.log('latency_optimization_regression: ok');
}

void main();
