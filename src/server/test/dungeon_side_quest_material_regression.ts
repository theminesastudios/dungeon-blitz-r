import { strict as assert } from 'assert';
import * as path from 'path';
import { EntityState, EntityTeam } from '../core/Entity';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';
import { getClientLevelScope } from '../core/LevelScope';
import { MissionLoader } from '../data/MissionLoader';
import { MissionID } from '../data/runtime';
import { CombatHandler } from '../handlers/CombatHandler';
import { MissionHandler } from '../handlers/MissionHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';

type FakeClient = {
    token: number;
    userId: number;
    playerSpawned: boolean;
    currentLevel: string;
    levelInstanceId: string;
    character: any;
    characters: any[];
    entities: Map<number, any>;
    sentPackets: Array<{ id: number; payload: Buffer }>;
    send(id: number, payload: Buffer): void;
    sendBitBuffer(id: number, bb: BitBuffer): void;
    scheduleCharacterSave(reason: string): void;
    saveReasons: string[];
};

function ensureDataLoaded(): void {
    const dataDir = path.resolve(__dirname, '../data');
    if (!LevelConfig.has('TutorialDungeon')) {
        LevelConfig.load(dataDir);
    }
    if (!MissionLoader.getMissionDef(MissionID.GetGoblinWands)) {
        MissionLoader.load(dataDir);
    }
}

function createClient(token: number, name: string, hasSideQuest: boolean): FakeClient {
    const missions = hasSideQuest
        ? {
            [String(MissionID.GetGoblinWands)]: {
                state: 1,
                currCount: 0
            }
        }
        : {};
    const character = {
        name,
        level: 10,
        CurrentLevel: { name: 'TutorialDungeon', x: 100, y: 100 },
        missions
    };
    const sentPackets: Array<{ id: number; payload: Buffer }> = [];
    const saveReasons: string[] = [];

    return {
        token,
        userId: token,
        playerSpawned: true,
        currentLevel: 'TutorialDungeon',
        levelInstanceId: 'side-quest-material-run',
        character,
        characters: [character],
        entities: new Map<number, any>(),
        sentPackets,
        send(id: number, payload: Buffer): void {
            sentPackets.push({ id, payload: Buffer.from(payload) });
        },
        sendBitBuffer(id: number, bb: BitBuffer): void {
            sentPackets.push({ id, payload: bb.toBuffer() });
        },
        scheduleCharacterSave(reason: string): void {
            saveReasons.push(reason);
        },
        saveReasons
    };
}

async function testDungeonDefeatAwardsEveryEligibleQuestHolder(): Promise<void> {
    ensureDataLoaded();
    const authority = createClient(91001, 'DungeonAuthority', false);
    const questHolder = createClient(91002, 'QuestHolder', true);
    const otherInstanceQuestHolder = createClient(91003, 'OtherInstance', true);
    otherInstanceQuestHolder.levelInstanceId = 'different-run';
    const defeatedShaman = {
        id: 92001,
        name: 'GoblinShamanHood',
        characterName: ',GoblinShamanHood',
        team: EntityTeam.ENEMY,
        entState: EntityState.DEAD,
        hp: 0,
        dead: true,
        destroyed: true
    };
    const levelScope = getClientLevelScope(authority as never);

    GlobalState.sessionsByToken.set(authority.token, authority as never);
    GlobalState.sessionsByToken.set(questHolder.token, questHolder as never);
    GlobalState.sessionsByToken.set(otherInstanceQuestHolder.token, otherInstanceQuestHolder as never);
    GlobalState.levelEntities.set(levelScope, new Map([[defeatedShaman.id, defeatedShaman]]));
    authority.entities.set(defeatedShaman.id, defeatedShaman);
    questHolder.entities.set(defeatedShaman.id, { ...defeatedShaman });
    try {
        assert.equal(
            MissionHandler.shouldWaitForEnemyKillStateMissionProgress(authority as never, defeatedShaman),
            true,
            'the dungeon authority should wait for a real defeat when another participant holds the side quest'
        );

        (CombatHandler as any).handleEnemyDefeatState(
            authority,
            levelScope,
            defeatedShaman.id,
            defeatedShaman,
            { fromDestroy: true }
        );
        await new Promise<void>((resolve) => setImmediate(resolve));

        (CombatHandler as any).handleEnemyDefeatState(
            authority,
            levelScope,
            defeatedShaman.id,
            defeatedShaman,
            { fromDestroy: true }
        );
        await new Promise<void>((resolve) => setImmediate(resolve));

        assert.equal(authority.character.missions[String(MissionID.GetGoblinWands)], undefined);
        assert.equal(
            questHolder.character.missions[String(MissionID.GetGoblinWands)].currCount,
            1,
            'the side-quest holder in the dungeon instance did not receive the quest material'
        );
        assert.equal(
            otherInstanceQuestHolder.character.missions[String(MissionID.GetGoblinWands)].currCount,
            0,
            'a player in another dungeon instance received quest progress'
        );
        assert.equal(questHolder.sentPackets.filter((packet) => packet.id === 0x83).length, 1);
        assert.deepEqual(questHolder.saveReasons, ['enemy kill mission progress']);
        assert.deepEqual(otherInstanceQuestHolder.saveReasons, []);
    } finally {
        GlobalState.levelEntities.delete(levelScope);
        GlobalState.sessionsByToken.delete(authority.token);
        GlobalState.sessionsByToken.delete(questHolder.token);
        GlobalState.sessionsByToken.delete(otherInstanceQuestHolder.token);
    }
}

async function testNonDungeonDefeatRemainsLocalToReportingClient(): Promise<void> {
    ensureDataLoaded();
    const reporter = createClient(93001, 'WorldReporter', false);
    const nearbyQuestHolder = createClient(93002, 'NearbyQuestHolder', true);
    reporter.currentLevel = 'NewbieRoad';
    reporter.levelInstanceId = '';
    reporter.character.CurrentLevel.name = 'NewbieRoad';
    nearbyQuestHolder.currentLevel = 'NewbieRoad';
    nearbyQuestHolder.levelInstanceId = '';
    nearbyQuestHolder.character.CurrentLevel.name = 'NewbieRoad';
    const defeatedShaman = {
        name: 'GoblinShamanHood',
        characterName: ',GoblinShamanHood',
        team: EntityTeam.ENEMY,
        entState: EntityState.DEAD,
        hp: 0,
        dead: true,
        destroyed: true
    };

    GlobalState.sessionsByToken.set(reporter.token, reporter as never);
    GlobalState.sessionsByToken.set(nearbyQuestHolder.token, nearbyQuestHolder as never);
    try {
        assert.equal(
            MissionHandler.shouldWaitForEnemyKillStateMissionProgress(reporter as never, defeatedShaman),
            false,
            'a nearby overworld player must not make the reporter wait for quest progress'
        );
        await MissionHandler.handleEnemyDefeatMissionProgressForScope(
            reporter as never,
            getClientLevelScope(reporter as never),
            defeatedShaman
        );
        assert.equal(
            nearbyQuestHolder.character.missions[String(MissionID.GetGoblinWands)].currCount,
            0,
            'overworld quest progress leaked to another player'
        );
    } finally {
        GlobalState.sessionsByToken.delete(reporter.token);
        GlobalState.sessionsByToken.delete(nearbyQuestHolder.token);
    }
}

async function testAuthoredDungeonSideQuestVariants(): Promise<void> {
    ensureDataLoaded();
    const cases: Array<[MissionID, string]> = [
        [MissionID.GetLizardBanners, 'GreatLizardBanner'],
        [MissionID.GetLizardBanners, 'GreatLizardBanner2'],
        [MissionID.GetLizardBannersHard, 'GreatLizardBannerHard'],
        [MissionID.GetLizardBannersHard, 'GreatLizardBanner2Hard'],
        [MissionID.GetLizardGreatHelm, 'GreatLizardHeavy'],
        [MissionID.GetLizardGreatHelm, 'GreatLizardHeavy2'],
        [MissionID.GetLizardGreatHelmHard, 'GreatLizardHeavyHard'],
        [MissionID.GetLizardGreatHelmHard, 'GreatLizardHeavy2Hard'],
        [MissionID.SpiritProblem, 'CastleLizardBanner2'],
        [MissionID.SpiritProblem, 'CastleLizardMaster'],
        [MissionID.SpiritProblemHard, 'CastleLizardBanner2Hard'],
        [MissionID.SpiritProblemHard, 'CastleLizardMasterHard'],
        [MissionID.GatherDreadMasks, 'DreadPaladin'],
        [MissionID.GatherDreadMasks, 'DreadChampion3'],
        [MissionID.GatherDreadMasksHard, 'DreadPaladinHard'],
        [MissionID.GatherDreadMasksHard, 'DreadLordHard']
    ];

    for (let index = 0; index < cases.length; index++) {
        const [missionId, enemyName] = cases[index];
        const client = createClient(94_000 + index, `Variant${index}`, false);
        if (missionId === MissionID.GatherDreadMasks) {
            client.currentLevel = 'Castle';
            client.character.CurrentLevel.name = 'Castle';
        } else if (missionId === MissionID.GatherDreadMasksHard) {
            client.currentLevel = 'CastleHard';
            client.character.CurrentLevel.name = 'CastleHard';
        }
        client.character.missions[String(missionId)] = { state: 1, currCount: 0 };
        const enemy = {
            id: 95_000 + index,
            EntName: enemyName,
            characterName: `,${enemyName}`,
            team: EntityTeam.ENEMY,
            entState: EntityState.DEAD,
            hp: 0,
            dead: true,
            destroyed: true
        };
        GlobalState.sessionsByToken.set(client.token, client as never);
        try {
            await MissionHandler.handleEnemyDefeatMissionProgressForScope(
                client as never,
                getClientLevelScope(client as never),
                enemy
            );
            assert.equal(
                client.character.missions[String(missionId)].currCount,
                1,
                `${enemyName} did not count for side quest ${missionId}`
            );
        } finally {
            GlobalState.sessionsByToken.delete(client.token);
        }
    }
}

Promise.resolve()
    .then(testDungeonDefeatAwardsEveryEligibleQuestHolder)
    .then(testNonDungeonDefeatRemainsLocalToReportingClient)
    .then(testAuthoredDungeonSideQuestVariants)
    .then(() => {
        console.log('Dungeon side-quest material regression tests passed.');
    })
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
