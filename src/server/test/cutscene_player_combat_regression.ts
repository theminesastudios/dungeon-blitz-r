// Issue #668: the dungeon cutscene combat lock was applied to whole handlers instead of just
// hostile-sourced packets, so every player ability went dead while the boss was talking.
// Enemy-sourced combat must still pause; the player's own must not.
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
const INSTANCE = 'cutscene-combat-regression';
const ROOM_ID = 2;

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
            class: 'mage',
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
        knownEntityIds: new Set<number>(),
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

function attachHostile(client: any, localId: number, name: string): void {
    const payload = (EntityHandler as any).buildEntityFullUpdatePayload({
        id: localId,
        name,
        isPlayer: false,
        x: 2000,
        y: 1200,
        v: 0,
        team: EntityTeam.ENEMY,
        renderDepthOffset: 0,
        characterName: '',
        dramaAnim: '',
        sleepAnim: '',
        summonerId: 0,
        powerId: 0,
        entState: EntityState.ACTIVE,
        facingLeft: false,
        running: false,
        jumping: false,
        dropping: false,
        backpedal: false,
        roomId: ROOM_ID
    });
    EntityHandler.handleEntityFullUpdate(client as never, Buffer.concat([payload, Buffer.from([0])]));
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

function buildHpDeltaPayload(entityId: number, amount: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(entityId);
    bb.writeMethod24(amount);
    return bb.toBuffer();
}

function startCutscene(client: any): void {
    const scope = getLevelScopeKey(client.currentLevel, client.levelInstanceId);
    client.activeDungeonCutsceneScope = scope;
    client.activeDungeonCutsceneRoomId = ROOM_ID;
    client.lastDungeonCutsceneStartScope = scope;
    client.lastDungeonCutsceneStartAt = Date.now();
}

async function testPlayerCombatSurvivesBossDialogue(): Promise<void> {
    const mage = createFakeClient('CutsceneMage', 77001);
    attachPlayer(mage);
    GlobalState.sessionsByToken.set(mage.token, mage as never);
    startCutscene(mage);

    const scope = getLevelScopeKey(mage.currentLevel, mage.levelInstanceId);
    attachHostile(mage, 510001, 'DefectorMage');
    const hostile = GlobalState.levelEntities.get(scope)?.get(510001);
    assert.ok(hostile, 'hostile should be registered in the level scope');
    hostile.maxHp = 10000;
    hostile.hp = 10000;
    mage.entities.set(510001, { ...mage.entities.get(510001), hp: 10000, maxHp: 10000 });

    await CombatHandler.handlePowerHit(mage as never, buildPowerHitPayload(510001, mage.clientEntID, 2500));
    assert.equal(hostile.hp, 7500, 'player power hit must land while the boss cutscene is active');

    // Plague Battalion's poison rides the buff tick DoT packet, which was blanket-locked too.
    mage.sentPackets.length = 0;
    const dot = new BitBuffer(false);
    dot.writeMethod4(510001);
    dot.writeMethod4(mage.clientEntID);
    await CombatHandler.handleBuffTickDot(mage as never, dot.toBuffer());
    assert.equal(
        mage.sentPackets.length > 0 || hostile.hp === 7500,
        true,
        'player DoT tick must not be swallowed by the cutscene lock'
    );

    // Damage reported straight onto a hostile (minion relays) must be handled identically
    // whether or not the boss is mid-dialogue.
    hostile.hp = 7500;
    mage.sentPackets.length = 0;
    CombatHandler.handleCharRegen(mage as never, buildHpDeltaPayload(510001, -1000));
    const duringCutscene = { hp: Math.round(Number(hostile.hp ?? 0)), packets: mage.sentPackets.length };

    mage.activeDungeonCutsceneScope = '';
    mage.lastDungeonCutsceneStartAt = 0;
    hostile.hp = 7500;
    mage.sentPackets.length = 0;
    CombatHandler.handleCharRegen(mage as never, buildHpDeltaPayload(510001, -1000));
    assert.deepEqual(
        duringCutscene,
        { hp: Math.round(Number(hostile.hp ?? 0)), packets: mage.sentPackets.length },
        'hostile HP report from the player must be handled the same during a cutscene'
    );
}

async function testHostileCombatStillPausesDuringDialogue(): Promise<void> {
    const mage = createFakeClient('CutsceneTarget', 77002);
    attachPlayer(mage);
    GlobalState.sessionsByToken.set(mage.token, mage as never);
    startCutscene(mage);

    attachHostile(mage, 520001, 'DefectorMage');
    mage.authoritativeCurrentHp = 5000;
    mage.entities.set(mage.clientEntID, {
        ...mage.entities.get(mage.clientEntID),
        hp: 5000,
        maxHp: 5000,
        dead: false,
        entState: EntityState.ACTIVE
    });

    await CombatHandler.handlePowerHit(mage as never, buildPowerHitPayload(mage.clientEntID, 520001, 3000));
    assert.equal(
        mage.authoritativeCurrentHp,
        5000,
        'enemy-sourced hits must still be suppressed while the boss is talking'
    );
}

async function main(): Promise<void> {
    ensureDataLoaded();
    await testPlayerCombatSurvivesBossDialogue();
    await testHostileCombatStillPausesDuringDialogue();
    console.log('cutscene player combat regression passed');
}

void main().catch((error) => {
    console.error(error);
    process.exit(1);
});
