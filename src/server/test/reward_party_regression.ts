import { strict as assert } from 'assert';
import { GlobalState } from '../core/GlobalState';
import { getClientLevelScope } from '../core/LevelScope';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { BitReader } from '../network/protocol/bitReader';
import { Entity, EntityState } from '../core/Entity';
import { EntityHandler } from '../handlers/EntityHandler';
import { LevelHandler } from '../handlers/LevelHandler';
import { RewardHandler } from '../handlers/RewardHandler';
import { CombatHandler } from '../handlers/CombatHandler';

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
    goblinRiverBossIntroLockUntil?: number;
    goblinRiverBossIntroUnlockTimer?: NodeJS.Timeout | null;
    sentPackets: SentPacket[];
    send: (id: number, payload: Buffer) => void;
    sendBitBuffer: (id: number, payload: BitBuffer) => void;
};

function createFakeClient(token: number, name: string): FakeClient {
    const sentPackets: SentPacket[] = [];

    return {
        token,
        userId: token,
        currentLevel: 'TutorialDungeon',
        levelInstanceId: '',
        currentRoomId: 1,
        playerSpawned: true,
        clientEntID: token + 1000,
        character: {
            name,
            level: 10,
            class: 'Mage',
            xp: 0,
            gold: 0,
            materials: [],
            inventoryGears: []
        },
        characters: [],
        authoritativeMaxHp: 100,
        authoritativeCurrentHp: 100,
        processedRewardSources: new Set<string>(),
        pendingLoot: new Map<number, any>(),
        knownEntityIds: new Set<number>(),
        entities: new Map<number, any>(),
        goblinRiverBossIntroLockUntil: 0,
        goblinRiverBossIntroUnlockTimer: null,
        sentPackets,
        send(id: number, payload: Buffer) {
            sentPackets.push({ id, payload: Buffer.from(payload) });
        },
        sendBitBuffer(id: number, payload: BitBuffer) {
            sentPackets.push({ id, payload: payload.toBuffer() });
        }
    };
}

function buildGrantRewardPayload(sourceId: number, gold: number, worldX: number = 120, worldY: number = 220): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(0);
    bb.writeMethod4(sourceId);
    bb.writeMethod15(false);
    bb.writeMethod309(1);
    bb.writeMethod15(false);
    bb.writeMethod309(1);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    bb.writeMethod4(0);
    bb.writeMethod4(0);
    bb.writeMethod4(0);
    bb.writeMethod4(gold);
    bb.writeMethod24(worldX);
    bb.writeMethod24(worldY);
    bb.writeMethod15(false);
    return bb.toBuffer();
}

function buildPowerHitPayload(targetId: number, sourceId: number, damage: number, powerId: number): Buffer {
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

function buildEntityFullUpdatePayload(entity: {
    id: number;
    name: string;
    x: number;
    y: number;
    v?: number;
    team: number;
    isPlayer?: boolean;
    renderDepthOffset?: number;
    characterName?: string;
    dramaAnim?: string;
    sleepAnim?: string;
    summonerId?: number;
    powerId?: number;
    entState?: number;
    facingLeft?: boolean;
    running?: boolean;
    jumping?: boolean;
    dropping?: boolean;
    backpedal?: boolean;
}): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(entity.id);
    bb.writeMethod24(entity.x);
    bb.writeMethod24(entity.y);
    bb.writeMethod24(entity.v ?? 0);
    bb.writeMethod26(entity.name);
    bb.writeMethod6(entity.team, Entity.TEAM_BITS);
    bb.writeMethod15(Boolean(entity.isPlayer));
    bb.writeMethod706(entity.renderDepthOffset ?? 0);

    const characterName = String(entity.characterName ?? '');
    const dramaAnim = String(entity.dramaAnim ?? '');
    const sleepAnim = String(entity.sleepAnim ?? '');
    const hasCue = Boolean(characterName || dramaAnim || sleepAnim);
    bb.writeMethod15(hasCue);
    if (hasCue) {
        bb.writeMethod15(Boolean(characterName));
        if (characterName) {
            bb.writeMethod13(characterName);
        }
        bb.writeMethod15(Boolean(dramaAnim));
        if (dramaAnim) {
            bb.writeMethod13(dramaAnim);
        }
        bb.writeMethod15(Boolean(sleepAnim));
        if (sleepAnim) {
            bb.writeMethod13(sleepAnim);
        }
    }

    const summonerId = Number(entity.summonerId ?? 0);
    bb.writeMethod15(summonerId > 0);
    if (summonerId > 0) {
        bb.writeMethod4(summonerId);
    }

    const powerId = Number(entity.powerId ?? 0);
    bb.writeMethod15(powerId > 0);
    if (powerId > 0) {
        bb.writeMethod4(powerId);
    }

    bb.writeMethod6(entity.entState ?? EntityState.ACTIVE, Entity.STATE_BITS);
    bb.writeMethod15(Boolean(entity.facingLeft));
    bb.writeMethod15(Boolean(entity.running));
    bb.writeMethod15(Boolean(entity.jumping));
    bb.writeMethod15(Boolean(entity.dropping));
    bb.writeMethod15(Boolean(entity.backpedal));
    return bb.toBuffer();
}

function addLevelEntity(client: FakeClient, entity: any): void {
    const scope = getClientLevelScope(client as never);
    let levelMap = GlobalState.levelEntities.get(scope);
    if (!levelMap) {
        levelMap = new Map<number, any>();
        GlobalState.levelEntities.set(scope, levelMap);
    }
    levelMap.set(Number(entity.id), entity);
}

function setContributors(levelScope: string, sourceId: number, contributors: string[]): void {
    const key = `${levelScope}:${sourceId}:0`;
    const contributionMap = new Map<string, number>();
    for (const contributor of contributors) {
        contributionMap.set(contributor.toLowerCase(), 100);
    }
    GlobalState.combatContributions.set(key, contributionMap);
}

function firstPendingLoot(client: FakeClient): any {
    return Array.from(client.pendingLoot.values())[0] ?? null;
}

function decodeLootdropPosition(payload: Buffer): { x: number; y: number } {
    const br = new BitReader(payload);
    br.readMethod4();
    const x = br.readMethod45();
    const y = br.readMethod45();
    return { x, y };
}

function clearTestState(): void {
    GlobalState.sessionsByToken.clear();
    GlobalState.partyByMember.clear();
    GlobalState.levelEntities.clear();
    GlobalState.combatContributions.clear();
    GlobalState.entityLifeNonces.clear();
    GlobalState.entityLastRewardNonces.clear();
}

async function testGoblinKidnappersBossIntroAliasLocksHostilesUntargetable(): Promise<void> {
    const alpha = createFakeClient(60, 'Alpha');
    alpha.currentLevel = 'GoblinKidnappers';
    alpha.currentRoomId = 4;
    GlobalState.sessionsByToken.set(alpha.token, alpha as never);

    const bossId = 9601;
    const minionId = 9602;
    const neutralId = 9603;
    addLevelEntity(alpha, {
        id: bossId,
        name: 'GoblinBoss2',
        isPlayer: false,
        team: 2,
        roomId: 4,
        x: 2800,
        y: 1510,
        untargetable: false,
        entState: 0
    });
    addLevelEntity(alpha, {
        id: minionId,
        name: 'GoblinEyeScout',
        isPlayer: false,
        team: 2,
        roomId: 4,
        x: 2713,
        y: 1510,
        untargetable: false,
        entState: 0
    });
    addLevelEntity(alpha, {
        id: neutralId,
        name: 'GoblinCutsceneProp',
        isPlayer: false,
        team: 3,
        roomId: 4,
        x: 2900,
        y: 1510,
        untargetable: false,
        entState: 0
    });
    alpha.entities.set(minionId, {
        id: minionId,
        name: 'GoblinEyeScout',
        isPlayer: false,
        team: 2,
        roomId: 4,
        x: 2713,
        y: 1510,
        untargetable: false,
        entState: 0
    });
    alpha.entities.set(neutralId, {
        id: neutralId,
        name: 'GoblinCutsceneProp',
        isPlayer: false,
        team: 3,
        roomId: 4,
        x: 2900,
        y: 1510,
        untargetable: false,
        entState: 0
    });

    LevelHandler.maybeStartGoblinRiverBossIntroLock(alpha as never, bossId, "You're the one that killed our Kraken!");

    assert.ok(
        Number(alpha.goblinRiverBossIntroLockUntil ?? 0) > Date.now(),
        'GoblinKidnappers alias should arm the goblin river boss intro lock'
    );
    assert.equal(
        GlobalState.levelEntities.get(getClientLevelScope(alpha as never))?.get(minionId)?.untargetable,
        true,
        'GoblinKidnappers alias should make room hostiles untargetable during boss intro'
    );
    assert.equal(
        alpha.entities.get(minionId)?.untargetable,
        true,
        'local hostile cache should also be marked untargetable during boss intro'
    );
    assert.equal(
        GlobalState.levelEntities.get(getClientLevelScope(alpha as never))?.get(minionId)?.entState,
        2,
        'GoblinKidnappers alias should switch room hostiles into drama state during boss intro'
    );
    assert.equal(
        GlobalState.levelEntities.get(getClientLevelScope(alpha as never))?.get(neutralId)?.untargetable,
        true,
        'GoblinKidnappers alias should also lock non-player neutral scene entities during boss intro'
    );
    assert.ok(
        alpha.sentPackets.some((packet) => packet.id === 0xA5),
        'GoblinKidnappers alias should start a room cutscene during boss intro lock'
    );
    assert.ok(
        alpha.sentPackets.some((packet) => packet.id === 0x07),
        'GoblinKidnappers alias should send drama-state updates so cutscene enemies do not expose normal hp bars'
    );
}

async function testGoblinKidnappersTakUgoIntroAlsoLocksRoomHostiles(): Promise<void> {
    const alpha = createFakeClient(61, 'Alpha');
    alpha.currentLevel = 'GoblinKidnappers';
    alpha.currentRoomId = 4;
    GlobalState.sessionsByToken.set(alpha.token, alpha as never);

    const bossId = 9611;
    const minionId = 9612;
    const offRoomId = 9613;
    addLevelEntity(alpha, {
        id: bossId,
        name: 'GoblinBoss1',
        isPlayer: false,
        team: 2,
        roomId: 4,
        x: 24816,
        y: 1877,
        untargetable: false,
        entState: 0
    });
    addLevelEntity(alpha, {
        id: minionId,
        name: 'GoblinEyeScout',
        isPlayer: false,
        team: 2,
        roomId: 4,
        x: 24720,
        y: 1877,
        untargetable: false,
        entState: 0
    });
    addLevelEntity(alpha, {
        id: offRoomId,
        name: 'GoblinShamanHood',
        isPlayer: false,
        team: 2,
        roomId: 5,
        x: 26000,
        y: 1877,
        untargetable: false,
        entState: 0
    });

    LevelHandler.maybeStartGoblinRiverBossIntroLock(alpha as never, bossId, "You're the one that killed our Kraken!");

    assert.equal(
        GlobalState.levelEntities.get(getClientLevelScope(alpha as never))?.get(bossId)?.untargetable,
        true,
        'Tak-Ugo intro should also make the boss untargetable during the cutscene'
    );
    assert.equal(
        GlobalState.levelEntities.get(getClientLevelScope(alpha as never))?.get(minionId)?.untargetable,
        true,
        'Tak-Ugo intro should also lock nearby cutscene hostiles'
    );
    assert.equal(
        GlobalState.levelEntities.get(getClientLevelScope(alpha as never))?.get(minionId)?.entState,
        2,
        'Tak-Ugo intro should also switch nearby cutscene hostiles into drama state'
    );
    assert.equal(
        GlobalState.levelEntities.get(getClientLevelScope(alpha as never))?.get(offRoomId)?.untargetable,
        false,
        'Tak-Ugo intro should not lock enemies outside the cutscene room'
    );
}

async function testUntargetableGoblinKidnappersCutsceneEnemiesIgnoreDamage(): Promise<void> {
    const alpha = createFakeClient(62, 'Alpha');
    alpha.currentLevel = 'GoblinKidnappers';
    alpha.currentRoomId = 4;
    GlobalState.sessionsByToken.set(alpha.token, alpha as never);

    const bossId = 9621;
    addLevelEntity(alpha, {
        id: bossId,
        name: 'GoblinBoss1',
        isPlayer: false,
        team: 2,
        roomId: 4,
        hp: 150,
        x: 24816,
        y: 1877,
        untargetable: true,
        dead: false,
        entState: 2
    });

    await CombatHandler.handlePowerHit(
        alpha as never,
        buildPowerHitPayload(bossId, alpha.clientEntID, 50, 77)
    );

    const boss = GlobalState.levelEntities.get(getClientLevelScope(alpha as never))?.get(bossId);
    assert.equal(
        boss?.hp,
        150,
        'untargetable Goblin Kidnappers cutscene enemies should not lose hp'
    );
    assert.equal(
        boss?.dead,
        false,
        'untargetable Goblin Kidnappers cutscene enemies should not be killed by incoming hits'
    );
    assert.equal(
        alpha.sentPackets.some((packet) => packet.id === 0x0A),
        false,
        'server should not relay hit packets against untargetable Goblin Kidnappers cutscene enemies'
    );
}

async function testGoblinKidnappersCutsceneLockBlocksOtherRoomClientsToo(): Promise<void> {
    const alpha = createFakeClient(63, 'Alpha');
    const beta = createFakeClient(64, 'Beta');
    alpha.currentLevel = 'GoblinKidnappers';
    beta.currentLevel = 'GoblinKidnappers';
    alpha.currentRoomId = 4;
    beta.currentRoomId = 4;
    GlobalState.sessionsByToken.set(alpha.token, alpha as never);
    GlobalState.sessionsByToken.set(beta.token, beta as never);

    const bossId = 9631;
    addLevelEntity(alpha, {
        id: bossId,
        name: 'GoblinBoss1',
        isPlayer: false,
        team: 2,
        roomId: 4,
        hp: 150,
        x: 24816,
        y: 1877,
        untargetable: false,
        dead: false,
        entState: 0
    });

    LevelHandler.maybeStartGoblinRiverBossIntroLock(alpha as never, bossId, "You're the one that killed our Kraken!");

    await CombatHandler.handlePowerHit(
        beta as never,
        buildPowerHitPayload(bossId, beta.clientEntID, 50, 77)
    );

    const boss = GlobalState.levelEntities.get(getClientLevelScope(alpha as never))?.get(bossId);
    assert.equal(
        boss?.hp,
        150,
        'Goblin Kidnappers cutscene lock should block hit packets from other clients in the same room'
    );
    assert.equal(
        beta.sentPackets.some((packet) => packet.id === 0x0A),
        false,
        'Goblin Kidnappers cutscene lock should stop other room clients from relaying hit packets'
    );
}

async function testGoblinKidnappersClientSpawnedHostilesStayUntargetableDuringCutscene(): Promise<void> {
    const alpha = createFakeClient(65, 'Alpha');
    const beta = createFakeClient(66, 'Beta');
    alpha.currentLevel = 'GoblinKidnappers';
    beta.currentLevel = 'GoblinKidnappers';
    alpha.currentRoomId = 4;
    beta.currentRoomId = 4;
    GlobalState.sessionsByToken.set(alpha.token, alpha as never);
    GlobalState.sessionsByToken.set(beta.token, beta as never);

    const bossId = 9641;
    const minionId = 9642;
    addLevelEntity(alpha, {
        id: bossId,
        name: 'GoblinBoss1',
        isPlayer: false,
        team: 2,
        roomId: 4,
        x: 24816,
        y: 1877,
        untargetable: false,
        entState: 0
    });

    LevelHandler.maybeStartGoblinRiverBossIntroLock(alpha as never, bossId, "You're the one that killed our Kraken!");

    EntityHandler.handleEntityFullUpdate(alpha as never, buildEntityFullUpdatePayload({
        id: minionId,
        name: 'GoblinEyeScout',
        x: 24720,
        y: 1877,
        team: 2,
        entState: EntityState.ACTIVE
    }));

    const stored = GlobalState.levelEntities.get(getClientLevelScope(alpha as never))?.get(minionId);
    assert.equal(
        stored?.untargetable,
        true,
        'client-spawned Goblin Kidnappers cutscene hostiles should be canonicalized as untargetable'
    );
    assert.equal(
        stored?.entState,
        EntityState.DRAMA,
        'client-spawned Goblin Kidnappers cutscene hostiles should be canonicalized into drama state'
    );

    beta.sentPackets.length = 0;
    EntityHandler.ensureEntityKnown(beta as never, beta.currentLevel, minionId);
    assert.deepEqual(
        beta.sentPackets.map((packet) => packet.id),
        [0x0F, 0xAE, 0x07],
        'late-seen cutscene hostiles should spawn with untargetable and drama updates for viewers'
    );
}

async function testPartyContributorRewardsEntireParty(): Promise<void> {
    const alpha = createFakeClient(1, 'Alpha');
    const beta = createFakeClient(2, 'Beta');
    const gamma = createFakeClient(3, 'Gamma');

    GlobalState.sessionsByToken.set(alpha.token, alpha as never);
    GlobalState.sessionsByToken.set(beta.token, beta as never);
    GlobalState.sessionsByToken.set(gamma.token, gamma as never);
    GlobalState.partyByMember.set('alpha', 77);
    GlobalState.partyByMember.set('beta', 77);

    const sourceId = 9001;
    addLevelEntity(alpha, {
        id: sourceId,
        name: 'IntroGoblin',
        isPlayer: false,
        team: 2,
        x: 120,
        y: 220
    });
    setContributors(getClientLevelScope(alpha as never), sourceId, ['alpha']);

    await RewardHandler.handleGrantReward(gamma as never, buildGrantRewardPayload(sourceId, 25));

    assert.equal(alpha.pendingLoot.size, 1, 'contributor should receive reward');
    assert.equal(beta.pendingLoot.size, 1, 'party member should receive reward');
    assert.equal(gamma.pendingLoot.size, 0, 'non-party bystander should not receive reward');
    assert.equal(firstPendingLoot(alpha)?.gold, 25);
    assert.equal(firstPendingLoot(beta)?.gold, 25);
}

async function testSoloContributorDoesNotRewardBystander(): Promise<void> {
    const alpha = createFakeClient(10, 'Alpha');
    const beta = createFakeClient(11, 'Beta');

    GlobalState.sessionsByToken.set(alpha.token, alpha as never);
    GlobalState.sessionsByToken.set(beta.token, beta as never);

    const sourceId = 9002;
    addLevelEntity(alpha, {
        id: sourceId,
        name: 'IntroGoblin',
        isPlayer: false,
        team: 2,
        x: 50,
        y: 75
    });
    setContributors(getClientLevelScope(alpha as never), sourceId, ['alpha']);

    await RewardHandler.handleGrantReward(beta as never, buildGrantRewardPayload(sourceId, 30));

    assert.equal(alpha.pendingLoot.size, 1, 'solo contributor should receive reward');
    assert.equal(beta.pendingLoot.size, 0, 'solo bystander should not receive reward');
    assert.equal(firstPendingLoot(alpha)?.gold, 30);
}

async function testPetContributionResolvesToOwner(): Promise<void> {
    const alpha = createFakeClient(20, 'Alpha');
    GlobalState.sessionsByToken.set(alpha.token, alpha as never);

    const petId = 9101;
    const targetId = 9102;
    const levelScope = getClientLevelScope(alpha as never);

    addLevelEntity(alpha, {
        id: petId,
        name: 'ActivePetWolf',
        isPlayer: false,
        team: 1,
        summonerId: alpha.clientEntID,
        ownerToken: alpha.token,
        x: 15,
        y: 15
    });
    addLevelEntity(alpha, {
        id: targetId,
        name: 'IntroGoblin',
        isPlayer: false,
        team: 2,
        hp: 100,
        x: 20,
        y: 20
    });

    await CombatHandler.handlePowerHit(alpha as never, buildPowerHitPayload(targetId, petId, 12, 77));

    const snapshot = CombatHandler.getContributionSnapshot(levelScope, targetId);
    assert.deepEqual(snapshot.contributors, ['alpha'], 'pet damage should count for its owner');
}

async function testChainsLootDropsOnPlayerPath(): Promise<void> {
    const alpha = createFakeClient(30, 'Alpha');
    GlobalState.sessionsByToken.set(alpha.token, alpha as never);

    alpha.entities.set(alpha.clientEntID, {
        id: alpha.clientEntID,
        name: 'MagePaperDoll',
        isPlayer: true,
        team: 1,
        x: 1500,
        y: 1942
    });

    const sourceId = 9301;
    addLevelEntity(alpha, {
        id: sourceId,
        name: 'Chains02',
        isPlayer: false,
        team: 2,
        x: 1327,
        y: 1880
    });
    setContributors(getClientLevelScope(alpha as never), sourceId, ['alpha']);

    await RewardHandler.handleGrantReward(alpha as never, buildGrantRewardPayload(sourceId, 25, 2713, 1510));

    const lootPacket = alpha.sentPackets.find((packet) => packet.id === 0x32);
    assert.ok(lootPacket, 'chains kill should emit a lootdrop packet');
    const lootPosition = decodeLootdropPosition(lootPacket!.payload);
    assert.equal(lootPosition.x, 1327, 'chains loot should keep source x position');
    assert.equal(lootPosition.y, 1942, 'chains loot should stay on player path y position');
}

async function testGoblinRiverFlyingLootDropsOnPlayerPath(): Promise<void> {
    const alpha = createFakeClient(40, 'Alpha');
    alpha.currentLevel = 'GoblinRiverDungeon';
    GlobalState.sessionsByToken.set(alpha.token, alpha as never);

    alpha.entities.set(alpha.clientEntID, {
        id: alpha.clientEntID,
        name: 'MagePaperDoll',
        isPlayer: true,
        team: 1,
        x: 2800,
        y: 1510
    });

    const sourceId = 9401;
    addLevelEntity(alpha, {
        id: sourceId,
        name: 'PsychophageBaby',
        isPlayer: false,
        team: 2,
        x: 2713,
        y: 1441,
        Flying: 'true'
    });
    setContributors(getClientLevelScope(alpha as never), sourceId, ['alpha']);

    await RewardHandler.handleGrantReward(alpha as never, buildGrantRewardPayload(sourceId, 25, 2713, 1510));

    const lootPacket = alpha.sentPackets.find((packet) => packet.id === 0x32);
    assert.ok(lootPacket, 'goblin river flying kill should emit a lootdrop packet');
    const lootPosition = decodeLootdropPosition(lootPacket!.payload);
    assert.equal(lootPosition.x, 2713, 'psychophage loot should keep the reward world x position');
    assert.equal(lootPosition.y, 1510, 'psychophage loot should use goblin reward world ground y position');
}

async function testGoblinKidnappersAirborneLootDropsOnPlayerPathWithoutFlyingFlag(): Promise<void> {
    const alpha = createFakeClient(50, 'Alpha');
    alpha.currentLevel = 'GoblinKidnappers';
    GlobalState.sessionsByToken.set(alpha.token, alpha as never);

    alpha.entities.set(alpha.clientEntID, {
        id: alpha.clientEntID,
        name: 'MagePaperDoll',
        isPlayer: true,
        team: 1,
        x: 2800,
        y: 1510
    });

    const sourceId = 9501;
    addLevelEntity(alpha, {
        id: sourceId,
        name: 'GoblinEyeScout',
        isPlayer: false,
        team: 2,
        x: 2713,
        y: 1441
    });
    setContributors(getClientLevelScope(alpha as never), sourceId, ['alpha']);

    await RewardHandler.handleGrantReward(alpha as never, buildGrantRewardPayload(sourceId, 25, 2713, 1300));

    const lootPacket = alpha.sentPackets.find((packet) => packet.id === 0x32);
    assert.ok(lootPacket, 'airborne goblin kidnappers kill should emit a lootdrop packet');
    const lootPosition = decodeLootdropPosition(lootPacket!.payload);
    assert.equal(lootPosition.x, 2713, 'airborne goblin kidnappers loot should keep reward world x position');
    assert.equal(lootPosition.y, 1510, 'airborne goblin kidnappers loot should use goblin reward world ground y position without needing a Flying flag');
}

async function testGroundEnemyLootKeepsRewardWorldPosition(): Promise<void> {
    const alpha = createFakeClient(60, 'Alpha');
    alpha.currentLevel = 'GoblinRiverDungeonHard';
    GlobalState.sessionsByToken.set(alpha.token, alpha as never);

    alpha.entities.set(alpha.clientEntID, {
        id: alpha.clientEntID,
        name: 'MagePaperDoll',
        isPlayer: true,
        team: 1,
        x: 2800,
        y: 1510
    });

    const sourceId = 9601;
    addLevelEntity(alpha, {
        id: sourceId,
        name: 'GoblinWarrior',
        isPlayer: false,
        team: 2,
        x: 2713,
        y: 1514
    });
    setContributors(getClientLevelScope(alpha as never), sourceId, ['alpha']);

    await RewardHandler.handleGrantReward(alpha as never, buildGrantRewardPayload(sourceId, 25, 2650, 1492));

    const lootPacket = alpha.sentPackets.find((packet) => packet.id === 0x32);
    assert.ok(lootPacket, 'ground enemy kill should emit a lootdrop packet');
    const lootPosition = decodeLootdropPosition(lootPacket!.payload);
    assert.equal(lootPosition.x, 2650, 'ground enemy loot should keep reward world x position');
    assert.equal(lootPosition.y, 1492, 'ground enemy loot should keep reward world y position');
}

async function testMissingAirborneSourceStillSnapsLootToPlayerPath(): Promise<void> {
    const alpha = createFakeClient(70, 'Alpha');
    alpha.currentLevel = 'GoblinRiverDungeon';
    GlobalState.sessionsByToken.set(alpha.token, alpha as never);

    alpha.entities.set(alpha.clientEntID, {
        id: alpha.clientEntID,
        name: 'MagePaperDoll',
        isPlayer: true,
        team: 1,
        x: 2800,
        y: 1510
    });

    const sourceId = 9701;
    setContributors(getClientLevelScope(alpha as never), sourceId, ['alpha']);

    await RewardHandler.handleGrantReward(alpha as never, buildGrantRewardPayload(sourceId, 25, 2713, 1300));

    const lootPacket = alpha.sentPackets.find((packet) => packet.id === 0x32);
    assert.ok(lootPacket, 'missing airborne source kill should emit a lootdrop packet');
    const lootPosition = decodeLootdropPosition(lootPacket!.payload);
    assert.equal(lootPosition.x, 2713, 'missing airborne source loot should keep reward world x position');
    assert.equal(lootPosition.y, 1300, 'missing airborne source loot should keep reward world ground y position when no source entity is available');
}

async function main(): Promise<void> {
    const sessionsByToken = new Map(GlobalState.sessionsByToken);
    const partyByMember = new Map(GlobalState.partyByMember);
    const levelEntities = new Map(GlobalState.levelEntities);
    const combatContributions = new Map(GlobalState.combatContributions);
    const entityLifeNonces = new Map(GlobalState.entityLifeNonces);
    const entityLastRewardNonces = new Map(GlobalState.entityLastRewardNonces);

    GlobalState.sessionsByToken.clear();
    GlobalState.partyByMember.clear();
    GlobalState.levelEntities.clear();
    GlobalState.combatContributions.clear();
    GlobalState.entityLifeNonces.clear();
    GlobalState.entityLastRewardNonces.clear();

    try {
        await testPartyContributorRewardsEntireParty();

        clearTestState();

        await testSoloContributorDoesNotRewardBystander();

        clearTestState();

        await testPetContributionResolvesToOwner();

        clearTestState();

        await testChainsLootDropsOnPlayerPath();

        clearTestState();

        await testGoblinRiverFlyingLootDropsOnPlayerPath();

        clearTestState();

        await testGoblinKidnappersAirborneLootDropsOnPlayerPathWithoutFlyingFlag();

        clearTestState();

        await testGoblinKidnappersBossIntroAliasLocksHostilesUntargetable();

        clearTestState();

        await testGoblinKidnappersTakUgoIntroAlsoLocksRoomHostiles();

        clearTestState();

        await testUntargetableGoblinKidnappersCutsceneEnemiesIgnoreDamage();

        clearTestState();

        await testGoblinKidnappersCutsceneLockBlocksOtherRoomClientsToo();

        clearTestState();

        await testGoblinKidnappersClientSpawnedHostilesStayUntargetableDuringCutscene();

        clearTestState();

        await testGroundEnemyLootKeepsRewardWorldPosition();

        clearTestState();

        await testMissingAirborneSourceStillSnapsLootToPlayerPath();
    } finally {
        GlobalState.sessionsByToken = sessionsByToken;
        GlobalState.partyByMember = partyByMember;
        GlobalState.levelEntities = levelEntities;
        GlobalState.combatContributions = combatContributions;
        GlobalState.entityLifeNonces = entityLifeNonces;
        GlobalState.entityLastRewardNonces = entityLastRewardNonces;
    }

    console.log('reward_party_regression: ok');
}

void main().catch((error) => {
    console.error('reward_party_regression: failed');
    console.error(error);
    process.exitCode = 1;
});
