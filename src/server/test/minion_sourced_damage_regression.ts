// Issue #668 follow-up: a summoned minion is the combat source for Plague Battalion's poison
// and for a ranged minion's projectile. Both were reported as "animation plays, nothing lands",
// which is what a server-side drop of the minion-sourced packet looks like from the client.
import { strict as assert } from 'assert';
import * as path from 'path';
import { GlobalState } from '../core/GlobalState';
import { GameData } from '../core/GameData';
import { LevelConfig } from '../core/LevelConfig';
import { Entity, EntityState, EntityTeam } from '../core/Entity';
import { EntityHandler } from '../handlers/EntityHandler';
import { CombatHandler } from '../handlers/CombatHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { getLevelScopeKey } from '../core/LevelScope';

const LEVEL = 'JC_Mission3';
const INSTANCE = 'minion-damage-regression';
const ROOM_ID = 2;
const MINION_ID = 530001;
const HOSTILE_ID = 540001;

function ensureDataLoaded(): void {
    const dataDir = path.resolve(__dirname, '../data');
    if (!LevelConfig.has(LEVEL)) {
        LevelConfig.load(dataDir);
    }
    if (Object.keys(GameData.ENTTYPES).length === 0) {
        GameData.load(dataDir);
    }
}

function createFakeClient(name: string, token: number): any {
    const sentPackets: { id: number; payload: Buffer }[] = [];
    return {
        token,
        character: {
            name,
            level: 50,
            class: 'rogue',
            MasterClass: 0,
            CurrentLevel: { name: LEVEL, x: 1000, y: 1000 }
        },
        currentLevel: LEVEL,
        levelInstanceId: INSTANCE,
        syncAnchorStartedAt: token,
        currentRoomId: ROOM_ID,
        playerSpawned: true,
        clientEntID: token + 1000,
        userId: token,
        authoritativeMaxHp: 5000,
        authoritativeCurrentHp: 5000,
        processedRewardSources: new Set<string>(),
        pendingLoot: new Map<number, any>(),
        knownEntityIds: new Set<number>([token + 1000]),
        entityIdAliases: new Map<number, number>(),
        sharedEntityRemoteUpdateDeferredIds: new Set<number>(),
        entities: new Map<number, any>(),
        sentPackets,
        send(id: number, payload: Buffer) {
            sentPackets.push({ id, payload: Buffer.from(payload) });
        },
        sendBitBuffer(id: number, bb: BitBuffer) {
            sentPackets.push({ id, payload: bb.toBuffer() });
        }
    };
}

function attachPlayer(client: any): void {
    const scope = getLevelScopeKey(client.currentLevel, client.levelInstanceId);
    const player = {
        ...Entity.fromCharacter(client.clientEntID, client.character as any, {
            x: 1000,
            y: 1000,
            team: EntityTeam.PLAYER,
            entState: EntityState.ACTIVE,
            roomId: client.currentRoomId
        }),
        ownerToken: client.token,
        ownerUserId: client.userId,
        hp: client.authoritativeCurrentHp,
        maxHp: client.authoritativeMaxHp
    };
    client.entities.set(client.clientEntID, player);
    client.knownEntityIds.add(client.clientEntID);

    let levelMap = GlobalState.levelEntities.get(scope);
    if (!levelMap) {
        levelMap = new Map<number, any>();
        GlobalState.levelEntities.set(scope, levelMap);
    }
    levelMap.set(client.clientEntID, player);
}

function buildEntityFullUpdate(
    entityId: number,
    name: string,
    team: number,
    summonerId: number
): Buffer {
    const payload = (EntityHandler as any).buildEntityFullUpdatePayload({
        id: entityId,
        name,
        isPlayer: false,
        x: 2000,
        y: 1200,
        v: 0,
        team,
        renderDepthOffset: 0,
        characterName: '',
        dramaAnim: '',
        sleepAnim: '',
        summonerId,
        powerId: 0,
        entState: EntityState.ACTIVE,
        facingLeft: false,
        running: false,
        jumping: false,
        dropping: false,
        backpedal: false,
        roomId: ROOM_ID
    });
    return Buffer.concat([payload, Buffer.from([0])]);
}

function buildPowerHitPayload(targetId: number, sourceId: number, damage: number, powerId: number = 77): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(targetId);
    bb.writeMethod4(sourceId);
    bb.writeMethod24(damage);
    bb.writeMethod4(powerId);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    return bb.toBuffer();
}

function buildBuffTickDotPayload(targetId: number, sourceId: number, damage: number, powerId: number = 77): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod9(targetId);
    bb.writeMethod9(sourceId);
    bb.writeMethod9(powerId);
    bb.writeMethod45(damage);
    bb.writeMethod6(0, 5);
    return bb.toBuffer();
}

async function main(): Promise<void> {
    ensureDataLoaded();

    const necro = createFakeClient('PlagueNecro', 78001);
    attachPlayer(necro);
    GlobalState.sessionsByToken.set(necro.token, necro as never);
    const scope = getLevelScopeKey(necro.currentLevel, necro.levelInstanceId);

    // The horde: a player-team minion summoned by this client, exactly how the client
    // reports Call the Horde's undead. Registered directly rather than through the wire
    // format -- the summoner block is not what this test is about.
    const minion = {
        id: MINION_ID,
        name: 'UndeadMinion',
        isPlayer: false,
        team: EntityTeam.PLAYER,
        summonerId: necro.clientEntID,
        ownerToken: necro.token,
        ownerUserId: necro.userId,
        clientSpawned: true,
        x: 1800,
        y: 1200,
        roomId: ROOM_ID,
        hp: 500,
        maxHp: 500,
        entState: EntityState.ACTIVE
    };
    necro.entities.set(MINION_ID, minion);
    necro.knownEntityIds.add(MINION_ID);
    GlobalState.levelEntities.get(scope)?.set(MINION_ID, minion);

    EntityHandler.handleEntityFullUpdate(
        necro as never,
        buildEntityFullUpdate(HOSTILE_ID, 'DefectorMage', EntityTeam.ENEMY, 0)
    );
    const hostile = GlobalState.levelEntities.get(scope)?.get(HOSTILE_ID);
    assert.ok(hostile, 'hostile should be registered in the level scope');
    hostile.maxHp = 10000;
    hostile.hp = 10000;
    necro.entities.set(HOSTILE_ID, { ...necro.entities.get(HOSTILE_ID), hp: 10000, maxHp: 10000 });

    // Plague Battalion: the minion swings, the poison rides its hit.
    await CombatHandler.handlePowerHit(necro as never, buildPowerHitPayload(HOSTILE_ID, MINION_ID, 1500));
    const afterHit = Math.round(Number(hostile.hp ?? 0));
    assert.equal(afterHit, 8500, `minion-sourced power hit must damage the hostile (hp=${afterHit})`);

    // The poison stack itself, sourced from the minion rather than the player.
    await CombatHandler.handleBuffTickDot(necro as never, buildBuffTickDotPayload(HOSTILE_ID, MINION_ID, 500));
    const afterDot = Math.round(Number(hostile.hp ?? 0));
    assert.equal(afterDot, 8000, `minion-sourced poison tick must damage the hostile (hp=${afterDot})`);

    console.log('minion sourced damage regression passed');
}

void main().catch((error) => {
    console.error(error);
    process.exit(1);
});
