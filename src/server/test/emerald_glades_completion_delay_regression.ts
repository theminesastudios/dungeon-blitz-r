import { strict as assert } from 'assert';
import * as path from 'path';
import { GlobalState } from '../core/GlobalState';
import { GameData } from '../core/GameData';
import { LevelConfig } from '../core/LevelConfig';
import { MissionLoader } from '../data/MissionLoader';
import { MissionID } from '../data/runtime';
import { MissionHandler } from '../handlers/MissionHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';

type SentPacket = {
    id: number;
    payload: Buffer;
};

type FakeClient = {
    token: number;
    userId: number | null;
    playerSpawned: boolean;
    currentLevel: string;
    levelInstanceId: string;
    currentRoomId: number;
    clientEntID: number;
    forcedDungeonCompletionScope: string;
    pendingDungeonCompletionScope?: string;
    pendingDungeonCompletionRequestedAt?: number;
    pendingDungeonCompletionLastSkitAt?: number;
    pendingDungeonCompletionNotBeforeAt?: number;
    pendingDungeonCompletionSettleMs?: number;
    pendingDungeonCompletionPayload?: Buffer | null;
    pendingDungeonCompletionForceSharedScope?: string;
    pendingDungeonCompletionTimer?: NodeJS.Timeout | null;
    pendingDungeonCompletionFlushActive?: boolean;
    pendingDungeonCompletionWaitForCutsceneEnd?: boolean;
    activeDungeonCutsceneScope?: string;
    activeDungeonCutsceneRoomId?: number;
    lastDungeonCutsceneStartScope?: string;
    lastDungeonCutsceneStartAt?: number;
    lastDungeonCutsceneEndScope?: string;
    lastDungeonCutsceneEndAt?: number;
    knownEntityIds: Set<number>;
    character: {
        name: string;
        level: number;
        xp: number;
        gold: number;
        CurrentLevel: { name: string; x: number; y: number };
        PreviousLevel: { name: string; x: number; y: number };
        missions: Record<string, { state: number; currCount?: number; claimed?: number; complete?: number }>;
        questTrackerState: number;
    };
    characters: any[];
    entities: Map<number, any>;
    dungeonRun: any;
    sentPackets: SentPacket[];
    send: (id: number, payload: Buffer) => void;
    sendBitBuffer: (id: number, bb: BitBuffer) => void;
};

type MissionCase = {
    level: string;
    missionId: MissionID;
    bossName: string;
};

const MISSION_CASES: MissionCase[] = [
    { level: 'EG_Mission1', missionId: MissionID.TheAshenDryad, bossName: 'AshenDryadHero' },
    { level: 'EG_Mission2', missionId: MissionID.OutOnALimb, bossName: 'AshenDryadHero' },
    { level: 'EG_Mission3', missionId: MissionID.RottenToTheRoots, bossName: 'AshenDryadWizard' },
    { level: 'EG_Mission4', missionId: MissionID.HopeSpringsEternal, bossName: 'AshenDryadWizard' },
    { level: 'EG_Mission1Hard', missionId: MissionID.TheAshenDryadHard, bossName: 'AshenDryadHeroHard' },
    { level: 'EG_Mission2Hard', missionId: MissionID.OutOnALimbHard, bossName: 'AshenDryadHeroHard' },
    { level: 'EG_Mission3Hard', missionId: MissionID.RottenToTheRootsHard, bossName: 'AshenDryadWizardHard' },
    { level: 'EG_Mission4Hard', missionId: MissionID.HopeSpringsEternalHard, bossName: 'AshenDryadWizardHard' }
];

function ensureDataLoaded(): void {
    const dataDir = path.resolve(__dirname, '../data');
    if (!LevelConfig.has('EG_Mission1') || !LevelConfig.has('EG_Mission4Hard')) {
        LevelConfig.load(dataDir);
    }
    if (!GameData.getEntType('AshenDryadHero') || !GameData.getEntType('AshenDryadWizardHard')) {
        GameData.load(dataDir);
    }
    if (
        !MissionLoader.getMissionDef(MissionID.TheAshenDryad) ||
        !MissionLoader.getMissionDef(MissionID.HopeSpringsEternalHard)
    ) {
        MissionLoader.load(dataDir);
    }
}

function createClient(testCase: MissionCase, index: number): FakeClient {
    const sentPackets: SentPacket[] = [];
    const character = {
        name: `EmeraldDelayTester${index}`,
        level: 50,
        xp: 0,
        gold: 0,
        CurrentLevel: { name: testCase.level, x: 0, y: 0 },
        PreviousLevel: { name: testCase.level.endsWith('Hard') ? 'EmeraldGladesHard' : 'EmeraldGlades', x: 18552, y: 4021 },
        missions: {
            [String(testCase.missionId)]: {
                state: 1,
                currCount: 0
            }
        },
        questTrackerState: 0
    };

    return {
        token: 18800 + index,
        userId: null,
        playerSpawned: true,
        currentLevel: testCase.level,
        levelInstanceId: `${testCase.level}-completion-delay-${index}`,
        currentRoomId: 1,
        clientEntID: 28800 + index,
        forcedDungeonCompletionScope: '',
        pendingDungeonCompletionScope: '',
        pendingDungeonCompletionRequestedAt: 0,
        pendingDungeonCompletionLastSkitAt: 0,
        pendingDungeonCompletionNotBeforeAt: 0,
        pendingDungeonCompletionSettleMs: 0,
        pendingDungeonCompletionPayload: null,
        pendingDungeonCompletionForceSharedScope: '',
        pendingDungeonCompletionTimer: null,
        pendingDungeonCompletionFlushActive: false,
        pendingDungeonCompletionWaitForCutsceneEnd: false,
        activeDungeonCutsceneScope: '',
        activeDungeonCutsceneRoomId: 0,
        lastDungeonCutsceneStartScope: '',
        lastDungeonCutsceneStartAt: 0,
        lastDungeonCutsceneEndScope: '',
        lastDungeonCutsceneEndAt: 0,
        knownEntityIds: new Set<number>(),
        character,
        characters: [character],
        entities: new Map<number, any>(),
        dungeonRun: null,
        sentPackets,
        send(id: number, payload: Buffer) {
            sentPackets.push({ id, payload: Buffer.from(payload) });
        },
        sendBitBuffer(id: number, bb: BitBuffer) {
            sentPackets.push({ id, payload: bb.toBuffer() });
        }
    };
}

function createDefeatedBoss(testCase: MissionCase, index: number): any {
    return {
        id: 8700 + index,
        name: testCase.bossName,
        isPlayer: false,
        team: 2,
        entRank: 'Boss',
        entState: 6,
        hp: 0,
        dead: true,
        clientSpawned: true,
        roomId: 1
    };
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
    ensureDataLoaded();

    const sessionsByToken = new Map(GlobalState.sessionsByToken);
    const levelEntities = new Map(GlobalState.levelEntities);
    const levelQuestProgress = new Map(GlobalState.levelQuestProgress);
    const clients: FakeClient[] = [];

    try {
        GlobalState.sessionsByToken.clear();
        GlobalState.levelEntities.clear();
        GlobalState.levelQuestProgress.clear();

        for (let index = 0; index < MISSION_CASES.length; index += 1) {
            const testCase = MISSION_CASES[index];
            const client = createClient(testCase, index);
            const boss = createDefeatedBoss(testCase, index);
            const levelScope = `${client.currentLevel}#${client.levelInstanceId}`;

            clients.push(client);
            boss.ownerToken = client.token;
            GlobalState.sessionsByToken.set(client.token, client as never);
            GlobalState.levelEntities.set(levelScope, new Map<number, any>([
                [boss.id, boss]
            ]));

            await MissionHandler.handleForcedDungeonBossCompletion(client as never, boss);

            assert.equal(
                Boolean(client.pendingDungeonCompletionWaitForCutsceneEnd),
                false,
                `${testCase.level} should not wait for the 15s missing post-death cutscene fallback`
            );
            assert.equal(
                Math.max(0, Number(client.pendingDungeonCompletionNotBeforeAt ?? 0) - Number(client.pendingDungeonCompletionRequestedAt ?? 0)),
                MissionHandler.DUNGEON_COMPLETION_SKIT_SETTLE_MS,
                `${testCase.level} should use the normal dungeon completion settle window`
            );
        }

        await sleep(MissionHandler.DUNGEON_COMPLETION_SKIT_SETTLE_MS + 200);

        for (let index = 0; index < MISSION_CASES.length; index += 1) {
            const testCase = MISSION_CASES[index];
            const client = clients[index];

            assert.equal(
                client.sentPackets.some((packet) => packet.id === 0x87),
                true,
                `${testCase.level} should send the dungeon completion stats packet after the settle window`
            );
            assert.equal(
                Number(client.character.missions[String(testCase.missionId)]?.state ?? 0),
                2,
                `${testCase.level} should move the matching mission to ready-to-turn-in`
            );
        }

        console.log('emerald_glades_completion_delay_regression: ok');
    } finally {
        for (const client of clients) {
            if (client.pendingDungeonCompletionTimer) {
                clearTimeout(client.pendingDungeonCompletionTimer);
            }
        }
        GlobalState.sessionsByToken = sessionsByToken;
        GlobalState.levelEntities = levelEntities;
        GlobalState.levelQuestProgress = levelQuestProgress;
    }
}

void main().catch((error) => {
    console.error(error);
    process.exit(1);
});
