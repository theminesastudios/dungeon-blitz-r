/**
 * Regression test for issue #698 — "Side quest counting inside dungeons:
 * sometimes counts, sometimes doesn't".
 *
 * A side-quest kill inside a dungeon is credited when the server accepts the
 * death and routes it through MissionHandler.handleEnemyDefeatMissionProgress.
 * For party-shared client hostiles (the default for most dungeons) the destroy
 * (0x0D) path is the safety net that has to commit the kill whenever the
 * kill-state (0x07) never reached the server or was rejected (e.g. the killing
 * client was not the combat-authority holder).
 *
 * That destroy path used to reject any destroy whose canonical HP was still
 * positive. For a client-spawned mob the server never saw take damage, the
 * "canonical HP" is only the estimated max HP derived from EntTypes — it is
 * not evidence the mob is alive. Rejecting the destroy on it answered a
 * legitimate kill with an alive-correction and dropped the side-quest credit
 * (and the shared dungeon progress) for that kill.
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
import { BitReader } from '../network/protocol/bitReader';

type SentPacket = { id: number; payload: Buffer };

type FakeClient = {
    token: number;
    userId: number;
    playerSpawned: boolean;
    currentLevel: string;
    levelInstanceId: string;
    currentRoomId: number;
    clientEntID: number;
    character: any;
    characters: any[];
    entities: Map<number, any>;
    knownEntityIds: Set<number>;
    entityIdAliases: Map<number, number>;
    sentPackets: SentPacket[];
    dungeonRun: any;
    send: (id: number, payload: Buffer) => void;
    sendBitBuffer: (id: number, bb: BitBuffer) => void;
};

const DUNGEON = 'SRN_Mission2'; // Mystery of Yornak — the dungeon named in issue #694

function ensureDataLoaded(): void {
    const dataDir = path.resolve(__dirname, '../data');
    if (!LevelConfig.has(DUNGEON)) {
        LevelConfig.load(dataDir);
    }
    if (Object.keys(GameData.ENTTYPES).length === 0) {
        GameData.load(dataDir);
    }
    if (!MissionLoader.getMissionDef(MissionID.GetGoblinNoserings)) {
        MissionLoader.load(dataDir);
    }
}

function createClient(instanceId: string, token: number): FakeClient {
    const character = {
        name: `SideQuest${token}`,
        level: 50,
        CurrentLevel: { name: DUNGEON, x: 100, y: 200 },
        missions: {
            [String(MissionID.GetGoblinNoserings)]: {
                state: 1, // MISSION_IN_PROGRESS
                currCount: 0
            }
        }
    };
    const sentPackets: SentPacket[] = [];
    return {
        token,
        userId: token,
        playerSpawned: true,
        currentLevel: DUNGEON,
        levelInstanceId: instanceId,
        currentRoomId: 1,
        clientEntID: token + 1000,
        character,
        characters: [character],
        entities: new Map<number, any>(),
        knownEntityIds: new Set<number>(),
        entityIdAliases: new Map<number, number>(),
        sentPackets,
        dungeonRun: null,
        send(id: number, payload: Buffer) {
            sentPackets.push({ id, payload: Buffer.from(payload) });
        },
        sendBitBuffer(id: number, bb: BitBuffer) {
            sentPackets.push({ id, payload: bb.toBuffer() });
        }
    };
}

function registerSession(client: FakeClient): string {
    GlobalState.sessionsByToken.set(client.token, client as never);
    const scope = `${DUNGEON}#${client.levelInstanceId}`;
    const levelMap = new Map<number, any>();
    GlobalState.levelEntities.set(scope, levelMap);
    return scope;
}

function spawnClientSpawnedHostile(client: FakeClient, scope: string, entityId: number, name: string): any {
    const hostile = {
        id: entityId,
        name,
        isPlayer: false,
        team: EntityTeam.ENEMY,
        clientSpawned: true,
        entState: EntityState.ACTIVE,
        dead: false,
        x: 500,
        y: 300,
        facingLeft: false,
        roomId: 1
    };
    client.entities.set(entityId, { ...hostile });
    GlobalState.levelEntities.get(scope)?.set(entityId, hostile);
    return hostile;
}

function buildDestroyPayload(entityId: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(entityId);
    bb.writeMethod15(true);
    return bb.toBuffer();
}

function parseStatePacket(packet: SentPacket): { entityId: number; state: number } {
    const br = new BitReader(packet.payload);
    return {
        entityId: br.readMethod4(),
        state: br.readMethod6(2)
    };
}

function getMissionCount(client: FakeClient): number {
    return Number(client.character.missions[String(MissionID.GetGoblinNoserings)]?.currCount ?? 0);
}

function assertNoAliveCorrection(client: FakeClient, entityId: number): void {
    for (const packet of client.sentPackets) {
        if (packet.id === 0x78) {
            assert.fail(`destroy was answered with a heal (0x78): ${packet.payload.toString('hex')}`);
        }
        if (packet.id === 0x07) {
            const parsed = parseStatePacket(packet);
            if (parsed.entityId === entityId && parsed.state === EntityState.ACTIVE) {
                assert.fail('destroy was answered with an alive state correction (0x07 ACTIVE)');
            }
        }
    }
}

function testAcceptDecision(): void {
    const accept = (CombatHandler as any).shouldAcceptPartySharedHostileDestroy as (
        entity: any,
        canonicalHp: number,
        serverTracksHostileHp: boolean,
        verifiedRequiredBossDestroy: boolean
    ) => boolean;

    // A client-spawned hostile the server never saw take damage has no trustworthy
    // HP snapshot: the estimated max HP must not be treated as proof it is alive.
    assert.equal(
        accept({ dead: false, entState: EntityState.ACTIVE }, 240, false, false),
        true,
        'untracked hostile destroy must be accepted so the kill can be credited'
    );

    // A hostile whose HP the server does track and still believes alive must keep
    // getting the alive-correction (anti-cheat preserved).
    assert.equal(
        accept({ dead: false, entState: EntityState.ACTIVE }, 240, true, false),
        false,
        'tracked-but-alive hostile destroy must still be rejected'
    );

    // A kill-state already accepted the death (dead flag set) but left the stale
    // positive HP in place: the destroy must go through.
    assert.equal(
        accept({ dead: true, entState: EntityState.DEAD }, 240, true, false),
        true,
        'destroy for an already-accepted kill must not be rejected over stale HP'
    );

    assert.equal(accept({ dead: false }, 0, true, false), true, 'zero HP never rejects');
    assert.equal(accept({ dead: false }, 240, true, true), true, 'verified boss destroy always accepted');
}

async function testUntrackedHostileDestroyCreditsSideQuest(): Promise<void> {
    const client = createClient('side-quest-run-1', 99001);
    const scope = registerSession(client);
    const entityId = 7001;
    spawnClientSpawnedHostile(client, scope, entityId, 'GoblinBrute');

    // The server has never applied damage to this mob, so it carries no explicit
    // maxHp/hp. Its estimated max HP is positive (GoblinBrute is a known EntType),
    // which is exactly the state that used to get the destroy rejected.
    const hostile = GlobalState.levelEntities.get(scope)?.get(entityId);
    assert.equal(Number(hostile?.maxHp ?? 0), 0, 'hostile should be HP-untracked for this scenario');

    await CombatHandler.handleEntityDestroy(client as never, buildDestroyPayload(entityId));

    assertNoAliveCorrection(client, entityId);
    assert.equal(getMissionCount(client), 1, 'destroy of an untracked hostile must credit the side-quest kill');
    assert.ok(
        client.sentPackets.some((packet) => packet.id === 0x83),
        'a mission progress packet (0x83) must have been sent'
    );
}

async function testTrackedAliveHostileDestroyStillRejected(): Promise<void> {
    const client = createClient('side-quest-run-2', 99002);
    const scope = registerSession(client);
    const entityId = 7002;
    const hostile = spawnClientSpawnedHostile(client, scope, entityId, 'GoblinBrute');

    // The server engaged HP tracking for this mob (explicit maxHp/hp) and believes
    // it is still alive — the alive-correction must keep rejecting this destroy.
    hostile.maxHp = 240;
    hostile.hp = 240;
    client.entities.get(entityId)!.maxHp = 240;
    client.entities.get(entityId)!.hp = 240;

    await CombatHandler.handleEntityDestroy(client as never, buildDestroyPayload(entityId));

    assert.equal(getMissionCount(client), 0, 'a destroy the server can prove false must not credit a kill');
}

async function main(): Promise<void> {
    ensureDataLoaded();
    testAcceptDecision();
    await testUntrackedHostileDestroyCreditsSideQuest();
    await testTrackedAliveHostileDestroyStillRejected();
    console.log('side_quest_dungeon_counting_regression: ok');
}

void main().catch((error) => {
    console.error(error);
    process.exit(1);
});
