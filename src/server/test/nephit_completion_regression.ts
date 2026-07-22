import { strict as assert } from 'assert';
import * as path from 'path';
import { EntityState, EntityTeam } from '../core/Entity';
import { GameData } from '../core/GameData';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';
import { getClientLevelScope } from '../core/LevelScope';
import { MissionLoader } from '../data/MissionLoader';
import { MissionID } from '../data/runtime';
import { MissionHandler } from '../handlers/MissionHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';

type SentPacket = { id: number; payload: Buffer };

type FakeClient = {
    currentLevel: string;
    levelInstanceId: string;
    currentRoomId: number;
    token: number;
    userId: null;
    playerSpawned: boolean;
    clientEntID: number;
    character: any;
    characters: any[];
    sentPackets: SentPacket[];
    entities: Map<number, any>;
    pendingDungeonCompletionScope: string;
    pendingDungeonCompletionRequestedAt: number;
    pendingDungeonCompletionLastSkitAt: number;
    pendingDungeonCompletionNotBeforeAt: number;
    pendingDungeonCompletionSettleMs: number;
    pendingDungeonCompletionPayload: Buffer | null;
    pendingDungeonCompletionTimer: NodeJS.Timeout | null;
    pendingDungeonCompletionFlushActive: boolean;
    activeDungeonCutsceneScope: string;
    activeDungeonCutsceneRoomId: number;
    lastDungeonCutsceneStartScope: string;
    lastDungeonCutsceneStartAt: number;
    lastDungeonCutsceneEndScope: string;
    lastDungeonCutsceneEndAt: number;
    armPendingTransferGrace(): void;
    send(id: number, payload: Buffer): void;
    sendBitBuffer(id: number, bb: BitBuffer): void;
};

const TEST_SETTLE_MS = 12;

function ensureDataLoaded(): void {
    const dataDir = path.resolve(__dirname, '../data');
    if (!LevelConfig.has('GhostBossDungeon')) {
        LevelConfig.load(dataDir);
    }
    if (!MissionLoader.getMissionDef(MissionID.KillNephit)) {
        MissionLoader.load(dataDir);
    }
    if (Object.keys(GameData.ENTTYPES).length === 0) {
        GameData.load(dataDir);
    }
}

function createFakeClient(name: string, token: number, questTrackerState: number): FakeClient {
    const sentPackets: SentPacket[] = [];
    const character = {
        name,
        CurrentLevel: { name: 'GhostBossDungeon', x: 3200, y: 1400 },
        PreviousLevel: { name: 'NewbieRoad', x: 1210, y: 880 },
        missions: {
            [String(MissionID.KillNephit)]: {
                state: 1,
                currCount: 0
            }
        },
        questTrackerState,
        level: 12,
        xp: 0,
        gold: 0
    };

    return {
        currentLevel: 'GhostBossDungeon',
        levelInstanceId: `nephit-run-${token}`,
        currentRoomId: 12,
        token,
        userId: null,
        playerSpawned: true,
        clientEntID: token + 1000,
        character,
        characters: [character],
        sentPackets,
        entities: new Map(),
        pendingDungeonCompletionScope: '',
        pendingDungeonCompletionRequestedAt: 0,
        pendingDungeonCompletionLastSkitAt: 0,
        pendingDungeonCompletionNotBeforeAt: 0,
        pendingDungeonCompletionSettleMs: 0,
        pendingDungeonCompletionPayload: null,
        pendingDungeonCompletionTimer: null,
        pendingDungeonCompletionFlushActive: false,
        activeDungeonCutsceneScope: '',
        activeDungeonCutsceneRoomId: 0,
        lastDungeonCutsceneStartScope: '',
        lastDungeonCutsceneStartAt: 0,
        lastDungeonCutsceneEndScope: '',
        lastDungeonCutsceneEndAt: 0,
        armPendingTransferGrace() {
            return undefined;
        },
        send(id: number, payload: Buffer) {
            sentPackets.push({ id, payload: Buffer.from(payload) });
        },
        sendBitBuffer(id: number, bb: BitBuffer) {
            sentPackets.push({ id, payload: bb.toBuffer() });
        }
    };
}

function createNephitBoss(alias: string = 'GrayGhostLord'): any {
    return {
        id: 8801,
        name: alias,
        characterName: alias === 'GrayGhostLord' ? 'NRGhostBoss' : `,${alias}`,
        character_name: alias === 'GrayGhostLord' ? 'NRGhostBoss' : `,${alias}`,
        isPlayer: false,
        roomId: 12,
        team: EntityTeam.ENEMY,
        entState: EntityState.DEAD,
        hp: 0,
        maxHp: 1,
        dead: true,
        clientSpawned: true,
        clientDefeatVerified: true,
        playerDamageContributed: true
    };
}

function createAliveNephitBoss(alias: string = 'Nephit'): any {
    return {
        ...createNephitBoss(alias),
        entState: EntityState.ACTIVE,
        hp: 1000,
        maxHp: 1000,
        dead: false,
        clientDefeatVerified: false,
        playerDamageContributed: false
    };
}

function createBossDungeonClient(name: string, token: number, levelName: string): FakeClient {
    const missionDef = MissionLoader.findPrimaryMissionByDungeon(levelName);
    assert.ok(missionDef, `${levelName} should have a primary mission`);
    const missionId = Number(missionDef.MissionID ?? 0);
    assert.ok(missionId > 0, `${levelName} primary mission should have an id`);

    const client = createFakeClient(name, token, 0);
    client.currentLevel = levelName;
    client.levelInstanceId = `${levelName.toLowerCase()}-run-${token}`;
    client.character.CurrentLevel = { name: levelName, x: 3200, y: 1400 };
    client.character.missions = {
        [String(missionId)]: {
            state: 1,
            currCount: 0
        }
    };
    return client;
}

function createImperialChampionBoss(): any {
    return {
        id: 9901,
        name: 'ImperialChampion',
        characterName: ',ImperialChampion',
        character_name: ',ImperialChampion',
        isPlayer: false,
        roomId: 8,
        team: EntityTeam.ENEMY,
        entState: EntityState.DEAD,
        hp: 0,
        maxHp: 1,
        dead: true,
        clientSpawned: true,
        clientDefeatVerified: true,
        playerDamageContributed: true
    };
}

function seedNephitRun(client: FakeClient, boss: any): void {
    const scope = getClientLevelScope(client as never);
    GlobalState.sessionsByToken.set(client.token, client as never);
    client.entities.set(boss.id, boss);
    GlobalState.levelEntities.set(scope, new Map([
        [boss.id, boss],
        [
            8802,
            {
                id: 8802,
                name: 'SkeletonWarrior',
                isPlayer: false,
                roomId: 5,
                team: EntityTeam.ENEMY,
                entState: EntityState.ACTIVE,
                hp: 100,
                maxHp: 100,
                dead: false,
                clientSpawned: true
            }
        ]
    ]));
}

function seedSingleBossRun(client: FakeClient, boss: any): void {
    const scope = getClientLevelScope(client as never);
    GlobalState.sessionsByToken.set(client.token, client as never);
    client.entities.set(boss.id, boss);
    GlobalState.levelEntities.set(scope, new Map([[boss.id, boss]]));
}

function seedNephitRunWithClientOnlyBossProxy(client: FakeClient, boss: any): void {
    const scope = getClientLevelScope(client as never);
    GlobalState.sessionsByToken.set(client.token, client as never);
    client.entities.set(boss.id, boss);
    GlobalState.levelEntities.set(scope, new Map([
        [
            8802,
            {
                id: 8802,
                name: 'SkeletonWarrior',
                isPlayer: false,
                roomId: 5,
                team: EntityTeam.ENEMY,
                entState: EntityState.ACTIVE,
                hp: 100,
                maxHp: 100,
                dead: false,
                clientSpawned: true
            }
        ]
    ]));
}

function rankPacketCount(client: FakeClient): number {
    return client.sentPackets.filter((packet) => packet.id === 0x87).length;
}

function buildLevelCompletePacket(completionPercent: number = 100): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod9(completionPercent);
    bb.writeMethod9(0); // bonus score
    bb.writeMethod9(0); // gold reward
    bb.writeMethod9(0); // material reward
    bb.writeMethod9(0); // gear count
    bb.writeMethod9(0); // remaining kills
    bb.writeMethod9(1); // required kills
    bb.writeMethod9(0); // level width score
    return bb.toBuffer();
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPendingSettle(): Promise<void> {
    await sleep(TEST_SETTLE_MS + 25);
}

async function testNephitAliasCompletesAfterPostBossSkitQuiet(): Promise<void> {
    const client = createFakeClient('NephitRunner', 83001, 0);
    const boss = createNephitBoss('Nephit');
    seedNephitRun(client, boss);
    const scope = getClientLevelScope(client as never);

    assert.equal(rankPacketCount(client), 0, 'rank screen must not appear before boss defeat');

    await MissionHandler.handleForcedDungeonBossCompletion(client as never, boss);

    assert.equal(
        client.pendingDungeonCompletionScope,
        scope,
        'boss objectives should queue a recoverable completion before the shared cutscene gate'
    );
    assert.equal(rankPacketCount(client), 0, 'rank screen must not appear before post-boss skit settles');

    await MissionHandler.handleSetLevelComplete(client as never, buildLevelCompletePacket());
    assert.equal(
        rankPacketCount(client),
        0,
        'a client completion packet must not bypass Nephit\'s authoritative cutscene-end gate'
    );

    MissionHandler.noteDungeonCutsceneStart(client as never, 12);
    MissionHandler.noteDungeonSkitActivity(client as never);
    await waitForPendingSettle();

    assert.equal(rankPacketCount(client), 0, 'rank screen must wait for the post-boss cutscene close');
    MissionHandler.noteDungeonCutsceneEnd(client as never, 12);
    await waitForPendingSettle();

    assert.equal(rankPacketCount(client), 1, 'normal dungeon rank/statistics packet should be sent after the cutscene ends');
    assert.equal(Number(client.character.questTrackerState ?? 0), 100, 'completion should update tracker to 100 after validation');
    assert.ok(
        Number(client.character.missions[String(MissionID.KillNephit)]?.state ?? 0) >= 2,
        'Nephit dungeon mission should be persisted as completed or ready to turn in'
    );

    await MissionHandler.handleForcedDungeonBossCompletion(client as never, boss);
    MissionHandler.noteDungeonSkitActivity(client as never);
    await waitForPendingSettle();

    assert.equal(rankPacketCount(client), 1, 'rank/statistics packet should be sent exactly once per run');
}

async function testMissingNephitCutsceneUsesBoundedFallback(): Promise<void> {
    const client = createFakeClient('NephitFallbackRunner', 83007, 0);
    const boss = createNephitBoss('Nephit');
    seedNephitRun(client, boss);
    const scope = getClientLevelScope(client as never);

    await MissionHandler.handleForcedDungeonBossCompletion(client as never, boss);
    assert.equal(client.pendingDungeonCompletionScope, scope, 'missing-cutscene run did not arm completion');
    assert.equal(rankPacketCount(client), 0, 'fallback completed before the ending-skit grace expired');

    if (client.pendingDungeonCompletionTimer) {
        clearTimeout(client.pendingDungeonCompletionTimer);
        client.pendingDungeonCompletionTimer = null;
    }
    const state = GlobalState.dungeonCompletions.get(scope);
    assert(state, 'missing-cutscene run has no shared completion state');
    state.objectivesMetAt = Date.now() - MissionHandler.DUNGEON_COMPLETION_CUTSCENE_START_GRACE_MS - 1;
    client.pendingDungeonCompletionNotBeforeAt = Date.now() - 1;
    client.pendingDungeonCompletionLastSkitAt = Date.now() - 1;
    client.pendingDungeonCompletionSettleMs = 0;

    await (MissionHandler as any).flushPendingDungeonCompletion(client);

    assert.equal(rankPacketCount(client), 1, 'missing ending skit did not release through the bounded fallback');
    assert.equal(state.cutsceneFallbackReason, 'missing-start-timeout');
    assert.equal(Number(client.character.questTrackerState ?? 0), 100);
}

async function testStuckNephitCutsceneUsesHardSafetyFallback(): Promise<void> {
    const client = createFakeClient('NephitStuckCutsceneRunner', 83008, 0);
    const boss = createNephitBoss('Nephit');
    seedNephitRun(client, boss);
    const scope = getClientLevelScope(client as never);

    await MissionHandler.handleForcedDungeonBossCompletion(client as never, boss);
    MissionHandler.noteDungeonCutsceneStart(client as never, 12);
    if (client.pendingDungeonCompletionTimer) {
        clearTimeout(client.pendingDungeonCompletionTimer);
        client.pendingDungeonCompletionTimer = null;
    }
    client.pendingDungeonCompletionRequestedAt = Date.now() -
        MissionHandler.DUNGEON_COMPLETION_CINEMATIC_MAX_WAIT_MS - 1;
    client.pendingDungeonCompletionNotBeforeAt = Date.now() - 1;
    client.pendingDungeonCompletionLastSkitAt = Date.now() - 1;
    client.pendingDungeonCompletionSettleMs = 0;

    await (MissionHandler as any).flushPendingDungeonCompletion(client);

    assert.equal(rankPacketCount(client), 1, 'permanently open ending cinematic stranded completion');
    assert.equal(
        GlobalState.dungeonCompletions.get(scope)?.cutsceneFallbackReason,
        'active-timeout'
    );
}

async function testQuestTrackerTwentySixStillCompletesAfterBossSkit(): Promise<void> {
    const client = createFakeClient('NephitTrackerRunner', 83002, 26);
    const boss = createNephitBoss('Nephit');
    seedNephitRun(client, boss);

    await MissionHandler.handleForcedDungeonBossCompletion(client as never, boss);

    assert.equal(Number(client.character.questTrackerState ?? 0), 26, 'tracker should remain partial before completion flush');
    assert.equal(rankPacketCount(client), 0);

    MissionHandler.noteDungeonCutsceneStart(client as never, 12);
    MissionHandler.noteDungeonSkitActivity(client as never);
    await waitForPendingSettle();
    assert.equal(rankPacketCount(client), 0, 'boss objective should not complete before the ending cutscene closes');

    MissionHandler.noteDungeonCutsceneEnd(client as never, 12);
    await waitForPendingSettle();

    assert.equal(rankPacketCount(client), 1, 'boss objective should complete even when tracker was stuck at 26 percent');
    assert.equal(Number(client.character.questTrackerState ?? 0), 100);
}

async function testPostCutsceneCompletesWhenDefeatedBossProxyOnlyExistsClientSide(): Promise<void> {
    const client = createFakeClient('NephitProxyRunner', 83004, 37);
    const boss = createNephitBoss('Nephit');
    seedNephitRunWithClientOnlyBossProxy(client, boss);

    await MissionHandler.handleForcedDungeonBossCompletion(client as never, boss);
    MissionHandler.noteDungeonCutsceneStart(client as never, 12);
    MissionHandler.noteDungeonCutsceneEnd(client as never, 12);
    await waitForPendingSettle();

    assert.equal(rankPacketCount(client), 1, 'post-cutscene completion should recover defeated Nephit proxy from client cache');
    assert.equal(Number(client.character.questTrackerState ?? 0), 100);
    assert.ok(
        Number(client.character.missions[String(MissionID.KillNephit)]?.state ?? 0) >= 2,
        'recovered Nephit proxy completion should persist mission state'
    );
}

async function testNonNephitBossDungeonStillOpensRankScreen(): Promise<void> {
    const client = createBossDungeonClient('ImperialRunner', 83005, 'JC_Mission1');
    const boss = createImperialChampionBoss();
    seedSingleBossRun(client, boss);

    await MissionHandler.handleForcedDungeonBossCompletion(client as never, boss);
    MissionHandler.noteDungeonCutsceneStart(client as never, 12);
    MissionHandler.noteDungeonCutsceneEnd(client as never, 12);
    await waitForPendingSettle();

    assert.equal(rankPacketCount(client), 1, 'non-Nephit boss dungeon should still send the rank/statistics packet');
}

async function testEarlyCutsceneDoesNotCompleteBeforeBossDeath(): Promise<void> {
    const client = createFakeClient('EarlySceneRunner', 83003, 26);
    const boss = createAliveNephitBoss('Nephit');
    seedNephitRun(client, boss);

    MissionHandler.noteDungeonCutsceneStart(client as never, 3);
    MissionHandler.noteDungeonSkitActivity(client as never);
    MissionHandler.noteDungeonCutsceneEnd(client as never, 3);
    await waitForPendingSettle();

    assert.equal(rankPacketCount(client), 0, 'early non-boss cutscene must not trigger completion');
    assert.equal(Number(client.character.questTrackerState ?? 0), 26);
}

function createDreadLordBoss(): any {
    return {
        id: 9902,
        name: 'DreadLord',
        characterName: ',DreadLord',
        character_name: ',DreadLord',
        isPlayer: false,
        roomId: 8,
        team: EntityTeam.ENEMY,
        entState: EntityState.DEAD,
        hp: 0,
        maxHp: 1,
        dead: true,
        clientSpawned: true,
        clientDefeatVerified: true,
        playerDamageContributed: true
    };
}

/** Chief Tourzahl: client-owned, so the server's cached HP is stale on death. */
function createChiefTourzahlBoss(hp: number): any {
    return {
        id: 7701,
        name: 'GoblinBoss2',
        characterName: ',GoblinBoss2',
        character_name: ',GoblinBoss2',
        displayName: 'Chief Tourzahl',
        isPlayer: false,
        roomId: 11,
        team: EntityTeam.ENEMY,
        entState: EntityState.DEAD,
        hp,
        maxHp: 5000,
        dead: true,
        destroyed: true,
        clientSpawned: true
        // Deliberately no clientDefeatVerified/playerDamageContributed: the Flash
        // client owns this boss, so the final damage delta never reaches the server.
    };
}

/**
 * GoblinRiverDungeon leaves Chief Tourzahl on the Flash client, so his defeat only
 * ever arrives as a client-reported destroy with a stale server HP snapshot. Unless
 * he is declared a client-authority boss the death is thrown away as unverified and
 * the run can never complete.
 */
function testChiefTourzahlDefeatIsAcceptedAsClientAuthority(): void {
    for (const [levelName, bossName] of [
        ['GoblinRiverDungeon', 'GoblinBoss2'],
        ['GoblinRiverDungeonHard', 'GoblinBoss2Hard']
    ] as [string, string][]) {
        for (const hp of [900, 1, 0]) {
            const boss = { ...createChiefTourzahlBoss(hp), name: bossName, characterName: `,${bossName}` };
            assert.equal(
                MissionHandler.shouldIgnoreUnverifiedDungeonBossDefeat(levelName, boss, ''),
                false,
                `${levelName}: ${bossName} defeat at hp=${hp} must not be discarded as unverified`
            );
        }
    }
}

/**
 * The cutscene close is the authoritative "dialogue done, cinematic gone" signal,
 * so the rank/statistics plate must follow it with no further settle delay.
 */
async function testChiefTourzahlPlateFollowsCutsceneWithoutDelay(): Promise<void> {
    const client = createBossDungeonClient('RiverRunner', 83007, 'GoblinRiverDungeon');
    const boss = createChiefTourzahlBoss(0);
    seedSingleBossRun(client, boss);
    const missionId = Number(MissionLoader.findPrimaryMissionByDungeon('GoblinRiverDungeon')?.MissionID ?? 0);

    await MissionHandler.handleForcedDungeonBossCompletion(client as never, boss);
    assert.equal(rankPacketCount(client), 0, 'plate must not appear before the defeat cutscene');

    MissionHandler.noteDungeonCutsceneStart(client as never, 11);
    MissionHandler.noteDungeonSkitActivity(client as never);
    await waitForPendingSettle();
    assert.equal(rankPacketCount(client), 0, 'plate must stay hidden while the defeat dialogue plays');

    // No awaits here: the plate has to be dispatched by the cutscene close itself.
    MissionHandler.noteDungeonCutsceneEnd(client as never, 11);
    assert.equal(
        rankPacketCount(client),
        1,
        'rank/statistics plate must be sent immediately on cutscene close, with no extra settle delay'
    );
    assert.equal(Number(client.character.questTrackerState ?? 0), 100);
    assert.ok(
        missionId > 0 && Number(client.character.missions[String(missionId)]?.state ?? 0) >= 2,
        'the Goblin River mission should be completed alongside the plate'
    );
}

/**
 * AC_Mission2 has no authoritative cutscene gate, so the completion is armed the
 * moment the boss dies. If the victory cinematic then opens, the plate must wait
 * for its close rather than being dropped: dropping it stranded the run with no
 * plate and no quest credit whenever the cinematic ended up being the last thing
 * to reschedule it.
 */
async function testPlateWaitsForCinematicCloseInsteadOfBeingDropped(): Promise<void> {
    const client = createBossDungeonClient('DreadLordRunner', 83006, 'AC_Mission2');
    const boss = createDreadLordBoss();
    seedSingleBossRun(client, boss);
    const scope = getClientLevelScope(client as never);
    const missionId = Number(MissionLoader.findPrimaryMissionByDungeon('AC_Mission2')?.MissionID ?? 0);

    await MissionHandler.handleForcedDungeonBossCompletion(client as never, boss);
    assert.equal(
        client.pendingDungeonCompletionScope,
        scope,
        'a gate-less boss dungeon should arm the completion on boss death'
    );

    // Victory cinematic opens before the armed completion flushes.
    MissionHandler.noteDungeonCutsceneStart(client as never, 8);
    MissionHandler.noteDungeonSkitActivity(client as never);
    await waitForPendingSettle();

    assert.equal(rankPacketCount(client), 0, 'completion plate must stay hidden while the cinematic is open');
    assert.equal(
        client.pendingDungeonCompletionScope,
        scope,
        'the armed completion must survive the cinematic instead of being discarded'
    );

    MissionHandler.noteDungeonCutsceneEnd(client as never, 8);
    await waitForPendingSettle();

    assert.equal(rankPacketCount(client), 1, 'plate should appear once the cinematic closed and dialogue went quiet');
    assert.equal(Number(client.character.questTrackerState ?? 0), 100);
    assert.ok(
        missionId > 0 && Number(client.character.missions[String(missionId)]?.state ?? 0) >= 2,
        'the dungeon mission should be completed alongside the plate'
    );
}

async function main(): Promise<void> {
    ensureDataLoaded();

    const originalSettleMs = MissionHandler.DUNGEON_COMPLETION_SKIT_SETTLE_MS;
    const originalMaxDeferMs = MissionHandler.DUNGEON_COMPLETION_MAX_DEFER_MS;
    const originalCutsceneStartGraceMs = MissionHandler.DUNGEON_COMPLETION_CUTSCENE_START_GRACE_MS;
    const levelEntities = new Map(GlobalState.levelEntities);
    const levelQuestProgress = new Map(GlobalState.levelQuestProgress);
    const sessionsByToken = new Map(GlobalState.sessionsByToken);
    const dungeonCompletions = new Map(GlobalState.dungeonCompletions);

    try {
        (MissionHandler as any).DUNGEON_COMPLETION_SKIT_SETTLE_MS = TEST_SETTLE_MS;
        (MissionHandler as any).DUNGEON_COMPLETION_MAX_DEFER_MS = TEST_SETTLE_MS * 2;
        (MissionHandler as any).DUNGEON_COMPLETION_CUTSCENE_START_GRACE_MS = TEST_SETTLE_MS * 2;

        GlobalState.levelEntities.clear();
        GlobalState.levelQuestProgress.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.dungeonCompletions.clear();
        await testNephitAliasCompletesAfterPostBossSkitQuiet();

        GlobalState.levelEntities.clear();
        GlobalState.levelQuestProgress.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.dungeonCompletions.clear();
        await testMissingNephitCutsceneUsesBoundedFallback();

        GlobalState.levelEntities.clear();
        GlobalState.levelQuestProgress.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.dungeonCompletions.clear();
        await testStuckNephitCutsceneUsesHardSafetyFallback();

        GlobalState.levelEntities.clear();
        GlobalState.levelQuestProgress.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.dungeonCompletions.clear();
        await testQuestTrackerTwentySixStillCompletesAfterBossSkit();

        GlobalState.levelEntities.clear();
        GlobalState.levelQuestProgress.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.dungeonCompletions.clear();
        await testPostCutsceneCompletesWhenDefeatedBossProxyOnlyExistsClientSide();

        GlobalState.levelEntities.clear();
        GlobalState.levelQuestProgress.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.dungeonCompletions.clear();
        await testNonNephitBossDungeonStillOpensRankScreen();

        GlobalState.levelEntities.clear();
        GlobalState.levelQuestProgress.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.dungeonCompletions.clear();
        await testEarlyCutsceneDoesNotCompleteBeforeBossDeath();

        GlobalState.levelEntities.clear();
        GlobalState.levelQuestProgress.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.dungeonCompletions.clear();
        await testPlateWaitsForCinematicCloseInsteadOfBeingDropped();

        GlobalState.levelEntities.clear();
        GlobalState.levelQuestProgress.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.dungeonCompletions.clear();
        testChiefTourzahlDefeatIsAcceptedAsClientAuthority();
        await testChiefTourzahlPlateFollowsCutsceneWithoutDelay();
    } finally {
        (MissionHandler as any).DUNGEON_COMPLETION_SKIT_SETTLE_MS = originalSettleMs;
        (MissionHandler as any).DUNGEON_COMPLETION_MAX_DEFER_MS = originalMaxDeferMs;
        (MissionHandler as any).DUNGEON_COMPLETION_CUTSCENE_START_GRACE_MS = originalCutsceneStartGraceMs;
        GlobalState.levelEntities = levelEntities;
        GlobalState.levelQuestProgress = levelQuestProgress;
        GlobalState.dungeonCompletions = dungeonCompletions;
        GlobalState.sessionsByToken.clear();
        for (const [token, session] of sessionsByToken) {
            GlobalState.sessionsByToken.set(token, session);
        }
    }

    console.log('nephit_completion_regression: ok');
}

void main().catch((error) => {
    console.error('nephit_completion_regression: failed');
    console.error(error);
    process.exitCode = 1;
});
