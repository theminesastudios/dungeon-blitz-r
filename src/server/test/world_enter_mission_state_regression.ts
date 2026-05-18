import { strict as assert } from 'assert';
import * as path from 'path';
import { MissionLoader } from '../data/MissionLoader';
import { MissionID } from '../data/runtime';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { BitReader } from '../network/protocol/bitReader';
import { WorldEnter } from '../utils/WorldEnter';

function ensureDataLoaded(): void {
    const dataDir = path.resolve(__dirname, '../data');
    if (!MissionLoader.getMissionDef(MissionID.DefendTheShip)) {
        MissionLoader.load(dataDir);
    }
}

function encodeMissionState(missionId: number, missionState: Record<string, number>): Buffer {
    const bb = new BitBuffer(false);
    const missionDef = MissionLoader.getMissionDef(missionId);
    (WorldEnter as any).writeMissionState(bb, missionDef, missionState);
    return bb.toBuffer();
}

function testReadyToTurnInEncodesAsNotClaimed(): void {
    const br = new BitReader(
        encodeMissionState(MissionID.DefendTheShip, {
            state: 2,
            currCount: 1,
            Tier: 5,
            highscore: 209,
            Time: 123456
        })
    );

    assert.equal(br.readMethod15(), true, 'mission entry should be present');
    assert.equal(br.readMethod15(), true, 'ready-to-turn-in story mission should still be encoded as ready');
    assert.equal(
        br.readMethod15(),
        false,
        'ready-to-turn-in story mission must not be serialized as already claimed'
    );
    assert.equal(br.readMethod6(4), 5, 'ready-to-turn-in dungeon mission should still serialize saved stars');
    assert.equal(br.readMethod4(), 209, 'ready-to-turn-in dungeon mission should still serialize saved high score');
    assert.equal(br.readMethod4(), 123456, 'ready-to-turn-in dungeon mission should still serialize completion time');
}

function testClaimedEncodesAsClaimed(): void {
    const br = new BitReader(
        encodeMissionState(MissionID.DefendTheShip, {
            state: 3,
            currCount: 1,
            Tier: 5,
            highscore: 209,
            Time: 123456,
            claimed: 1,
            complete: 1
        })
    );

    assert.equal(br.readMethod15(), true, 'mission entry should be present');
    assert.equal(br.readMethod15(), true, 'claimed story mission still uses the ready/complete branch');
    assert.equal(br.readMethod15(), true, 'claimed story mission should serialize the claimed bit');
}

function testUnlockedDungeonMissionIsNotSerializedBeforeNpcAcceptance(): void {
    const character: any = {
        missions: {
            [String(MissionID.DeliverToSwamp)]: {
                state: 3,
                currCount: 1,
                claimed: 1,
                complete: 1
            },
            [String(MissionID.AbandonedArmory)]: {
                state: 3,
                currCount: 1,
                claimed: 1,
                complete: 1
            }
        }
    };

    const serializable = (WorldEnter as any).buildSerializableMissionsState(character);

    assert.equal(
        serializable[String(MissionID.ForgottenForge)],
        undefined,
        'unaccepted dungeon missions must not be sent as active before the NPC assigns them'
    );
}

function testAcceptedDungeonMissionIsSerialized(): void {
    const character: any = {
        missions: {
            [String(MissionID.DeliverToSwamp)]: {
                state: 3,
                currCount: 1,
                claimed: 1,
                complete: 1
            },
            [String(MissionID.ForgottenForge)]: {
                state: 1,
                currCount: 0
            }
        }
    };

    const serializable = (WorldEnter as any).buildSerializableMissionsState(character);

    assert.equal(
        Number(serializable[String(MissionID.ForgottenForge)]?.state ?? 0),
        1,
        'accepted dungeon missions should still be sent as active'
    );
}

function testDungeonOffersAcrossZonesRequireNpcAcceptance(): void {
    const character: any = {
        missions: {
            [String(MissionID.DeliverToSwamp)]: {
                state: 3,
                currCount: 1,
                claimed: 1,
                complete: 1
            },
            [String(MissionID.Capstone)]: {
                state: 3,
                currCount: 1,
                claimed: 1,
                complete: 1
            },
            [String(MissionID.IntoTheDepths)]: {
                state: 2,
                currCount: 0
            }
        }
    };

    const serializable = (WorldEnter as any).buildSerializableMissionsState(character);

    assert.equal(
        serializable[String(MissionID.SlayMindlessQueen)],
        undefined,
        "Mindless Queen's Glade should stay unaccepted so Odem can show the offer marker"
    );
    assert.equal(
        serializable[String(MissionID.ForgottenForge)],
        undefined,
        'Forgotten Forge should stay unaccepted so Stormshard NPC icons remain offer markers'
    );
    assert.equal(
        serializable[String(MissionID.EmeraldThrone)],
        undefined,
        'The Emerald Throne should stay unaccepted so Castle NPC icons remain offer markers'
    );
    assert.equal(
        serializable[String(MissionID.TempleOfShadows)],
        undefined,
        'Unearthing the Past should stay unaccepted until Siggin assigns the mission'
    );
}

function main(): void {
    ensureDataLoaded();
    testReadyToTurnInEncodesAsNotClaimed();
    testClaimedEncodesAsClaimed();
    testUnlockedDungeonMissionIsNotSerializedBeforeNpcAcceptance();
    testAcceptedDungeonMissionIsSerialized();
    testDungeonOffersAcrossZonesRequireNpcAcceptance();
    console.log('world_enter_mission_state_regression: ok');
}

try {
    main();
} catch (error) {
    console.error('world_enter_mission_state_regression: failed');
    console.error(error);
    process.exitCode = 1;
}
