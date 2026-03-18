import { strict as assert } from 'assert';
import { GlobalState } from '../core/GlobalState';
import { getClientLevelScope } from '../core/LevelScope';
import { BitBuffer } from '../network/protocol/bitBuffer';
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
        sentPackets,
        send(id: number, payload: Buffer) {
            sentPackets.push({ id, payload: Buffer.from(payload) });
        },
        sendBitBuffer(id: number, payload: BitBuffer) {
            sentPackets.push({ id, payload: payload.toBuffer() });
        }
    };
}

function buildGrantRewardPayload(sourceId: number, gold: number): Buffer {
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
    bb.writeMethod24(120);
    bb.writeMethod24(220);
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

        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.levelEntities.clear();
        GlobalState.combatContributions.clear();
        GlobalState.entityLifeNonces.clear();
        GlobalState.entityLastRewardNonces.clear();

        await testSoloContributorDoesNotRewardBystander();

        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.levelEntities.clear();
        GlobalState.combatContributions.clear();
        GlobalState.entityLifeNonces.clear();
        GlobalState.entityLastRewardNonces.clear();

        await testPetContributionResolvesToOwner();
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
