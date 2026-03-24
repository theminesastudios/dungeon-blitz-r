import { strict as assert } from 'assert';
import * as path from 'path';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';
import { MissionHandler } from '../handlers/MissionHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';

type SentPacket = {
    id: number;
    payload: Buffer;
};

type FakeClient = {
    currentLevel: string;
    levelInstanceId: string;
    userId: number | null;
    character: {
        name: string;
        CurrentLevel: { name: string; x: number; y: number };
        PreviousLevel: { name: string; x: number; y: number };
        missions: Record<string, { state: number; currCount?: number }>;
        questTrackerState: number;
    };
    sentPackets: SentPacket[];
    sendBitBuffer: (id: number, bb: BitBuffer) => void;
};

function ensureLevelConfigLoaded(): void {
    if (!LevelConfig.has('CraftTownTutorial')) {
        LevelConfig.load(path.resolve(__dirname, '../data'));
    }
}

function createFakeClient(): FakeClient {
    const sentPackets: SentPacket[] = [];

    return {
        currentLevel: 'CraftTownTutorial',
        levelInstanceId: 'keep-run',
        userId: null,
        character: {
            name: 'KeepRunner',
            CurrentLevel: { name: 'CraftTown', x: 918, y: 1440 },
            PreviousLevel: { name: 'WolfsEnd', x: 1210, y: 880 },
            missions: {
                '5': {
                    state: 1,
                    currCount: 0
                }
            },
            questTrackerState: 0
        },
        sentPackets,
        sendBitBuffer(id: number, bb: BitBuffer) {
            sentPackets.push({ id, payload: bb.toBuffer() });
        }
    };
}

function createLevelCompletePacket(): Buffer {
    const bb = new BitBuffer();
    bb.writeMethod9(100);
    bb.writeMethod9(0);
    bb.writeMethod9(0);
    bb.writeMethod9(0);
    bb.writeMethod9(0);
    bb.writeMethod9(0);
    bb.writeMethod9(1);
    bb.writeMethod9(3);
    return bb.toBuffer();
}

async function testCraftTownTutorialCompletionPreservesReturnCoordinatesUntilExitTransfer(): Promise<void> {
    const client = createFakeClient();

    GlobalState.levelEntities.set(
        'CraftTownTutorial#keep-run',
        new Map<number, any>([
            [
                7401,
                {
                    id: 7401,
                    name: 'IntroGoblinShamanHood',
                    isPlayer: false,
                    x: 49,
                    y: 1459,
                    team: 2,
                    entState: 6,
                    hp: 0,
                    dead: true
                }
            ]
        ])
    );

    await MissionHandler.handleSetLevelComplete(client as never, createLevelCompletePacket());

    assert.equal(client.sentPackets.some((packet) => packet.id === 0x87), true);
    assert.deepEqual(client.character.CurrentLevel, { name: 'CraftTown', x: 918, y: 1440 });
    assert.deepEqual(client.character.PreviousLevel, { name: 'WolfsEnd', x: 1210, y: 880 });
}

async function main(): Promise<void> {
    ensureLevelConfigLoaded();

    const levelEntities = new Map(GlobalState.levelEntities);
    GlobalState.levelEntities.clear();

    try {
        await testCraftTownTutorialCompletionPreservesReturnCoordinatesUntilExitTransfer();
    } finally {
        GlobalState.levelEntities = levelEntities;
    }

    console.log('craft_town_tutorial_completion_regression: ok');
}

void main().catch((error) => {
    console.error('craft_town_tutorial_completion_regression: failed');
    console.error(error);
    process.exitCode = 1;
});
