import { strict as assert } from 'assert';
import fs from 'fs';
import path from 'path';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';
import { MissionLoader } from '../data/MissionLoader';
import { MissionID } from '../data/runtime';
import { MissionHandler } from '../handlers/MissionHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { BitReader } from '../network/protocol/bitReader';

type SentPacket = { id: number; payload: Buffer };

type FakeClient = {
    token: number;
    userId: null;
    playerSpawned: boolean;
    currentLevel: string;
    levelInstanceId: string;
    clientEntID: number;
    character: any;
    characters: any[];
    entities: Map<number, any>;
    sentPackets: SentPacket[];
    lastDoorId: number;
    lastDoorTargetLevel: string;
    transferGraceArmed: number;
    armPendingTransferGrace(): void;
    send(id: number, payload: Buffer): void;
    sendBitBuffer(id: number, bb: BitBuffer): void;
};

function ensureDataLoaded(): void {
    const dataDir = path.resolve(__dirname, '../data');
    if (!LevelConfig.has('TutorialDungeon')) {
        LevelConfig.load(dataDir);
    }
    if (!MissionLoader.getMissionDef(MissionID.RescueAnna)) {
        MissionLoader.load(dataDir);
    }
}

function createClient(currentLevel: string, token: number): FakeClient {
    const character = {
        name: `QuestIssue${token}`,
        level: 50,
        CurrentLevel: { name: currentLevel, x: 0, y: 0 },
        PreviousLevel: { name: 'BridgeTown', x: 100, y: 100 },
        missions: {},
        questTrackerState: 0
    };
    const sentPackets: SentPacket[] = [];
    return {
        token,
        userId: null,
        playerSpawned: true,
        currentLevel,
        levelInstanceId: `quest-issue-${token}`,
        clientEntID: token + 1000,
        character,
        characters: [character],
        entities: new Map(),
        sentPackets,
        lastDoorId: -1,
        lastDoorTargetLevel: '',
        transferGraceArmed: 0,
        armPendingTransferGrace(): void {
            this.transferGraceArmed++;
        },
        send(id: number, payload: Buffer): void {
            sentPackets.push({ id, payload: Buffer.from(payload) });
        },
        sendBitBuffer(id: number, bb: BitBuffer): void {
            sentPackets.push({ id, payload: bb.toBuffer() });
        }
    };
}

function decodeMissionAdded(packet: SentPacket): { missionId: number; active: number } {
    const br = new BitReader(packet.payload);
    return {
        missionId: br.readMethod4(),
        active: br.readMethod15() ? 1 : 0
    };
}

async function testCemeteryMiniMissionsSyncOnEntry(): Promise<void> {
    const characterHandlerSource = fs.readFileSync(
        path.resolve(__dirname, '../handlers/CharacterHandler.ts'),
        'utf8'
    );
    assert.match(
        characterHandlerSource,
        /syncMissionStateToClient\(client\);\s+MissionHandler\.syncFullClearDungeonEntryMissionToClient\(client\);/,
        'login must sync the auto-started Cemetery Hill tomb mission after Player Data'
    );

    const cases: Array<[string, MissionID]> = [
        ['CH_MiniMission1', MissionID.ClearMini1],
        ['CH_MiniMission2', MissionID.ClearMini2],
        ['CH_MiniMission3', MissionID.ClearMini3],
        ['CH_MiniMission4', MissionID.ClearMini4],
        ['CH_MiniMission5', MissionID.ClearMini5],
        ['CH_MiniMission6', MissionID.ClearMini6],
        ['CH_MiniMission7', MissionID.ClearMini7],
        ['CH_MiniMission8', MissionID.ClearMini8],
        ['CH_MiniMission9', MissionID.ClearMini9],
        ['CH_MiniMission1Hard', MissionID.ClearMini1Hard],
        ['CH_MiniMission2Hard', MissionID.ClearMini2Hard],
        ['CH_MiniMission3Hard', MissionID.ClearMini3Hard],
        ['CH_MiniMission4Hard', MissionID.ClearMini4Hard],
        ['CH_MiniMission5Hard', MissionID.ClearMini5Hard],
        ['CH_MiniMission6Hard', MissionID.ClearMini6Hard],
        ['CH_MiniMission7Hard', MissionID.ClearMini7Hard],
        ['CH_MiniMission8Hard', MissionID.ClearMini8Hard],
        ['CH_MiniMission9Hard', MissionID.ClearMini9Hard]
    ];

    for (let index = 0; index < cases.length; index++) {
        const [levelName, missionId] = cases[index];
        const client = createClient(levelName, 71000 + index);
        client.character.missions[String(MissionID.DeliverToSwamp)] = {
            state: 3,
            currCount: 1,
            claimed: 1,
            complete: 1
        };
        await MissionHandler.prepareFullClearDungeonEntry(client as never);
        assert.equal(
            client.character.missions[String(missionId)]?.state,
            1,
            `${levelName} entry did not auto-start its authored tomb mission`
        );
        client.sentPackets.length = 0;
        MissionHandler.syncFullClearDungeonEntryMissionToClient(client as never);
        assert.equal(client.sentPackets.length, 1, `${levelName} did not sync its active tomb mission`);
        assert.deepEqual(decodeMissionAdded(client.sentPackets[0]), { missionId, active: 1 });
    }
}

function primeFollowup(
    currentLevel: string,
    completedMissionId: MissionID,
    followupMissionId: MissionID,
    token: number
): FakeClient {
    const client = createClient(currentLevel, token);
    client.character.missions[String(MissionID.DeliverToSwamp)] = {
        state: 3,
        currCount: 1,
        claimed: 1,
        complete: 1
    };
    client.character.missions[String(completedMissionId)] = {
        state: 3,
        currCount: 1,
        claimed: 1,
        complete: 1
    };

    const primedMissionId = (MissionHandler as any).primeChainedDungeonFollowupMission(
        client,
        currentLevel,
        completedMissionId
    );
    assert.equal(primedMissionId, followupMissionId);
    assert.equal(client.character.missions[String(followupMissionId)]?.state, 1);
    const missionAdded = client.sentPackets.find((packet) => packet.id === 0x85);
    assert.ok(missionAdded, `follow-up ${followupMissionId} was not sent to the client`);
    assert.deepEqual(decodeMissionAdded(missionAdded!), { missionId: followupMissionId, active: 1 });
    return client;
}

function testDungeonFollowupAutoAcceptAndTeleport(): void {
    const originalTeleports = GlobalState.pendingTeleports;
    GlobalState.pendingTeleports = new Map();
    try {
        primeFollowup('CH_Mission6', MissionID.DiscoverSecret, MissionID.SealTheWisps, 72001);
        primeFollowup('CH_Mission6Hard', MissionID.DiscoverSecretHard, MissionID.SealTheWispsHard, 72002);

        const growingFlame = primeFollowup(
            'OMM_Mission9',
            MissionID.GrahlsRebellion,
            MissionID.DragonsQuarry,
            72003
        );
        assert.equal(
            MissionLoader.getMissionDef(MissionID.DragonsQuarry)?.MissionName,
            'DragonsQuarry',
            'The Growing Flame should unlock the authored deeper-mine follow-up'
        );
        assert.equal(growingFlame.character.missions[String(MissionID.DragonsQuarry)]?.state, 1);
        const missionTypes = JSON.parse(
            fs.readFileSync(path.resolve(__dirname, '../data/MissionTypes.json'), 'utf8')
        );
        assert.equal(
            missionTypes.find((mission: any) => Number(mission.MissionID) === MissionID.DragonsQuarry)?.ISayOnAccept,
            '^tI see a path deeper into the mine',
            'auto-accepting the deeper-mine follow-up must retain the authored final player thought'
        );

        const mouth = primeFollowup(
            'BT_Mission3',
            MissionID.MouthOfMeylour,
            MissionID.DerelictionOfDuty,
            72004
        );
        assert.equal(
            (MissionHandler as any).applyDungeonCompletionFollowupReturnOverride(
                mouth,
                MissionID.MouthOfMeylour
            ),
            true
        );
        assert.deepEqual(GlobalState.pendingTeleports.get(mouth.token), {
            targetLevel: 'BridgeTown',
            x: 9361,
            y: 482,
            hasCoord: true
        });
        assert.equal(mouth.lastDoorTargetLevel, 'BridgeTown');
        assert.equal(mouth.transferGraceArmed, 1);

        const dreadMouth = primeFollowup(
            'BT_Mission3Hard',
            MissionID.MouthOfMeylourHard,
            MissionID.DerelictionOfDutyHard,
            72005
        );
        assert.equal(
            (MissionHandler as any).applyDungeonCompletionFollowupReturnOverride(
                dreadMouth,
                MissionID.MouthOfMeylourHard
            ),
            true
        );
        assert.deepEqual(GlobalState.pendingTeleports.get(dreadMouth.token), {
            targetLevel: 'BridgeTownHard',
            x: 9361,
            y: 482,
            hasCoord: true
        });
    } finally {
        GlobalState.pendingTeleports = originalTeleports;
    }
}

function testBellaDialogueIncludesPlayerResponses(): void {
    const dialogues = JSON.parse(
        fs.readFileSync(path.resolve(__dirname, '../data/NpcDialogues.json'), 'utf8')
    );
    const bella = dialogues?.levels?.BridgeTown?.npctraveller;
    assert.ok(bella, 'Bella Sagesword dialogue data is missing');
    const scriptedText = String(bella.scriptedText ?? '');
    assert.match(scriptedText, /@I'm guessing no\?/);
    assert.match(scriptedText, /@Can I have a look\?/);
    assert.match(scriptedText, /@So, no\?/);
}

async function main(): Promise<void> {
    ensureDataLoaded();
    await testCemeteryMiniMissionsSyncOnEntry();
    testDungeonFollowupAutoAcceptAndTeleport();
    testBellaDialogueIncludesPlayerResponses();
    console.log('quest_issue_regression: ok');
}

void main().catch((error) => {
    console.error(error);
    process.exit(1);
});
