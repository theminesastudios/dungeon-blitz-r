import { strict as assert } from 'assert';
import * as path from 'path';
import { Character } from '../database/Database';
import { JsonAdapter } from '../database/JsonAdapter';
import { MissionLoader } from '../data/MissionLoader';
import { MissionID } from '../data/runtime';
import { AbilityHandler } from '../handlers/AbilityHandler';
import { CharacterHandler } from '../handlers/CharacterHandler';
import { MissionHandler } from '../handlers/MissionHandler';
import { BitReader } from '../network/protocol/bitReader';

function createCharacter(name: string): Character {
    return {
        name,
        class: 'Mage',
        gender: 'female',
        level: 10,
        CurrentLevel: { name: 'CraftTown', x: 360, y: 1460 },
        PreviousLevel: { name: 'NewbieRoad', x: 1421, y: 826 },
        learnedAbilities: [
            { abilityID: 10, rank: 1 },
            { abilityID: 14, rank: 1 }
        ],
        activeAbilities: [10, 14]
    };
}

async function testReloadCurrentCharacterFromSavePrefersFreshDiskState(): Promise<void> {
    const staleCharacter = createCharacter('Neodevil');
    const freshCharacter = createCharacter('Neodevil');
    freshCharacter.learnedAbilities = [
        { abilityID: 10, rank: 1 },
        { abilityID: 14, rank: 1 },
        { abilityID: 17, rank: 1 }
    ];
    freshCharacter.activeAbilities = [10, 14, 17];

    const client = {
        userId: 6,
        character: staleCharacter,
        characters: [staleCharacter]
    };

    const originalLoadCharacters = JsonAdapter.prototype.loadCharacters;
    JsonAdapter.prototype.loadCharacters = async function(userId: number): Promise<Character[]> {
        assert.equal(userId, 6);
        return [freshCharacter];
    };

    try {
        await (CharacterHandler as any).reloadCurrentCharacterFromSave(client);
    } finally {
        JsonAdapter.prototype.loadCharacters = originalLoadCharacters;
    }

    assert.equal(client.character, freshCharacter);
    assert.equal(client.characters.length, 1);
    assert.equal(client.characters[0], freshCharacter);
    assert.deepEqual(client.character.learnedAbilities, [
        { abilityID: 10, rank: 1 },
        { abilityID: 14, rank: 1 },
        { abilityID: 17, rank: 1 }
    ]);
    assert.deepEqual(client.character.activeAbilities, [10, 14, 17]);
}

async function testReloadCurrentCharacterFromSaveKeepsUnsavedCharacterWhenMissingOnDisk(): Promise<void> {
    const character = createCharacter('Neodevil');
    const otherCharacter = createCharacter('Radiant');

    const client = {
        userId: 6,
        character,
        characters: []
    };

    const originalLoadCharacters = JsonAdapter.prototype.loadCharacters;
    JsonAdapter.prototype.loadCharacters = async function(): Promise<Character[]> {
        return [otherCharacter];
    };

    try {
        await (CharacterHandler as any).reloadCurrentCharacterFromSave(client);
    } finally {
        JsonAdapter.prototype.loadCharacters = originalLoadCharacters;
    }

    assert.equal(client.character, character);
    assert.equal(client.characters.length, 2);
    assert.equal(client.characters[0], otherCharacter);
    assert.equal(client.characters[1], character);
}

function testAbilityRepairSyncsUnlockedActiveAbilityIntoLearnedAbilities(): void {
    const character = createCharacter('Neodevil');
    character.learnedAbilities = [
        { abilityID: 10, rank: 1 },
        { abilityID: 14, rank: 1 }
    ];
    character.activeAbilities = [10, 14, 17];

    const repaired = AbilityHandler.repairCharacterAbilityState(character);

    assert.equal(repaired, true);
    assert.deepEqual(character.learnedAbilities, [
        { abilityID: 10, rank: 1 },
        { abilityID: 14, rank: 1 },
        { abilityID: 17, rank: 1 }
    ]);
}

function testPaperDollPacketNormalizesLegacyLowercaseGender(): void {
    const character = createCharacter('GenderNormalize');
    character.gender = 'male';
    character.headSet = 'Head03';
    character.hairSet = 'MDo03';
    character.mouthSet = 'MM06';
    character.faceSet = 'MF03';
    character.hairColor = 0x515151;
    character.skinColor = 0xffc3b2;
    character.shirtColor = 0x101010;
    character.pantColor = 0x202020;
    character.equippedGears = [];

    const bb = (CharacterHandler as any).buildPaperDollPacket(character);
    const br = new BitReader(bb.toBuffer());

    assert.equal(br.readMethod13(), 'GenderNormalize');
    assert.equal(br.readMethod13(), 'Mage');
    assert.equal(br.readMethod13(), 'Male');
}

function testCraftTownLoginRepairsCompletedKeepQuestProgress(): void {
    const character = createCharacter('Neodevil');
    character.questTrackerState = 92;
    character.missions = {
        '5': {
            state: 3,
            currCount: 1,
            claimed: 1,
            complete: 1
        }
    };

    const repair = MissionHandler.repairEarlyStoryOnLogin(character, 'CraftTown');

    assert.equal(repair.didMutate, true);
    assert.equal(character.questTrackerState, 100);
}

function testCraftTownLoginMarksClearedKeepQuestReadyToTurnIn(): void {
    const character = createCharacter('FleerpuhRepair');
    character.CurrentLevel = { name: 'CraftTown', x: 918, y: 1440 };
    character.PreviousLevel = { name: 'WolfsEnd', x: 1210, y: 880 };
    character.questTrackerState = 100;
    character.missions = {
        '1': {
            state: 3,
            currCount: 1,
            claimed: 1,
            complete: 1
        },
        '2': {
            state: 3,
            claimed: 1,
            complete: 1
        },
        '3': {
            state: 3,
            currCount: 1,
            claimed: 1,
            complete: 1
        },
        '4': {
            state: 3,
            currCount: 1,
            claimed: 1,
            complete: 1
        },
        '5': {
            state: 1,
            currCount: 0
        }
    };

    const repair = MissionHandler.repairEarlyStoryOnLogin(character, 'CraftTown');

    assert.equal(repair.didMutate, true);
    assert.equal(Number(character.missions?.['5']?.state ?? 0), 2);
    assert.equal(Number(character.missions?.['5']?.currCount ?? 0), 1);
    assert.equal(Number(character.magicForge?.stats_by_building?.['12'] ?? 0), 5);
}

function testNewbieRoadLoginRepairsCompletedKeepQuestProgress(): void {
    const character = createCharacter('Prutacold');
    character.CurrentLevel = { name: 'NewbieRoad', x: 12340, y: 2299 };
    character.PreviousLevel = { name: 'CraftTown', x: 0, y: 0 };
    character.questTrackerState = 4;
    character.missions = {
        '5': {
            state: 3,
            currCount: 1,
            claimed: 1,
            complete: 1
        }
    };

    const repair = MissionHandler.repairEarlyStoryOnLogin(character, 'NewbieRoad');

    assert.equal(repair.didMutate, true);
    assert.equal(character.questTrackerState, 100);
}

function testStoryRepairRestoresLostAtSeaTurnInWhenMissionIsMissing(): void {
    const character = createCharacter('LostAtSeaRepair');
    character.CurrentLevel = { name: 'CraftTown', x: 360, y: 1460 };
    character.PreviousLevel = { name: 'NewbieRoad', x: 1421, y: 826 };
    character.questTrackerState = 100;
    character.missions = {};

    const repair = MissionHandler.repairEarlyStoryOnLogin(character, 'CraftTown');

    assert.equal(repair.didMutate, true);
    assert.equal(repair.addedMissionId, 1);
    assert.deepEqual(character.missions?.['1'], {
        state: 2,
        currCount: 1
    });
}

function testStoryRepairUpgradesLostAtSeaTurnInInsideTutorialBoat(): void {
    const character = createCharacter('LostAtSeaBoatRepair');
    character.CurrentLevel = { name: 'TutorialBoat', x: 0, y: 0 };
    character.PreviousLevel = { name: 'NewbieRoad', x: 1421, y: 826 };
    character.questTrackerState = 100;
    character.missions = {
        '1': {
            state: 1,
            currCount: 0
        }
    };

    const repair = MissionHandler.repairEarlyStoryOnLogin(character, 'TutorialBoat');

    assert.equal(repair.didMutate, true);
    assert.equal(Number(character.missions?.['1']?.state ?? 0), 2);
    assert.equal(Number(character.missions?.['1']?.currCount ?? 0), 1);
}

function testStoryRepairDoesNotAutoCompleteGoblinRiverOutsideDungeon(): void {
    MissionLoader.load(path.resolve(__dirname, '..', 'data'));

    const character = createCharacter('GoblinRiverRepair');
    character.CurrentLevel = { name: 'NewbieRoad', x: 11083, y: 539 };
    character.PreviousLevel = { name: 'CraftTown', x: 1083, y: 1448 };
    character.questTrackerState = 100;
    character.missions = {
        '1': {
            state: 3,
            currCount: 1,
            claimed: 1,
            complete: 1
        },
        '2': {
            state: 3,
            claimed: 1,
            complete: 1
        },
        '271': {
            state: 1,
            currCount: 0
        }
    };

    const repair = MissionHandler.repairEarlyStoryOnLogin(character, 'NewbieRoad');

    assert.equal(repair.didMutate, false);
    assert.equal(Number(character.missions?.['271']?.state ?? 0), 1);
    assert.equal(Number(character.missions?.['271']?.currCount ?? 0), 0);
}

function testStoryRepairDoesNotAutoClaimKeepQuestOutsideDungeon(): void {
    MissionLoader.load(path.resolve(__dirname, '..', 'data'));

    const character = createCharacter('KeepRepairGuard');
    character.CurrentLevel = { name: 'NewbieRoad', x: 11083, y: 539 };
    character.PreviousLevel = { name: 'CraftTown', x: 1083, y: 1448 };
    character.questTrackerState = 100;
    character.missions = {
        '1': {
            state: 3,
            currCount: 1,
            claimed: 1,
            complete: 1
        },
        '2': {
            state: 3,
            claimed: 1,
            complete: 1
        },
        '3': {
            state: 3,
            currCount: 1,
            claimed: 1,
            complete: 1
        },
        '4': {
            state: 3,
            claimed: 1,
            complete: 1
        },
        '5': {
            state: 1,
            currCount: 0
        }
    };

    const repair = MissionHandler.repairEarlyStoryOnLogin(character, 'NewbieRoad');

    assert.equal(Number(character.missions?.['5']?.state ?? 0), 1);
    assert.equal(Number(character.missions?.['5']?.currCount ?? 0), 0);
}

function testStoryRepairDoesNotAutoCompleteOtherSwampDungeonMission(): void {
    MissionLoader.load(path.resolve(__dirname, '..', 'data'));

    const character = createCharacter('SwampRepairGuard');
    character.CurrentLevel = { name: 'SwampRoadNorth', x: 8331, y: 579 };
    character.PreviousLevel = { name: 'NewbieRoad', x: 20298, y: 639 };
    character.questTrackerState = 100;
    character.missions = {
        [String(MissionID.DefendTheShip)]: {
            state: 3,
            currCount: 1,
            claimed: 1,
            complete: 1
        },
        [String(MissionID.MeetTheTown)]: {
            state: 3,
            claimed: 1,
            complete: 1
        },
        [String(MissionID.StopCastout)]: {
            state: 3,
            currCount: 1,
            claimed: 1,
            complete: 1
        },
        [String(MissionID.SlayYornak)]: {
            state: 1,
            currCount: 0
        }
    };

    const repair = MissionHandler.repairEarlyStoryOnLogin(character, 'SwampRoadNorth');

    assert.equal(repair.didMutate, false);
    assert.equal(
        Number(character.missions?.[String(MissionID.SlayYornak)]?.state ?? 0),
        1,
        'login repair should not auto-complete another Black Rose Mire dungeon just because questTrackerState is 100'
    );
    assert.equal(
        Number(character.missions?.[String(MissionID.SlayYornak)]?.currCount ?? 0),
        0,
        'login repair should leave the unrelated swamp dungeon mission untouched'
    );
}

function testMissionSyncDoesNotReplayQuestPopupsOnLogin(): void {
    const character = createCharacter('QuestSync');
    character.questTrackerState = 100;
    character.missions = {
        '1': {
            state: 3,
            currCount: 1,
            claimed: 1,
            complete: 1,
            Tier: 5,
            highscore: 209,
            Time: 123456
        },
        '2': {
            state: 1,
            currCount: 0
        },
        '4': {
            state: 2,
            currCount: 0
        }
    };

    const sentPackets: Array<{ id: number; payload: Buffer }> = [];
    const client = {
        character,
        sendBitBuffer(id: number, bb: { toBuffer(): Buffer }): void {
            sentPackets.push({ id, payload: bb.toBuffer() });
        }
    };

    MissionHandler.syncMissionStateToClient(client as never);

    assert.deepEqual(
        sentPackets.map((packet) => packet.id),
        [0xB7],
        'mission sync should only refresh quest progress and must not replay mission popups during room/login sync'
    );
}

function testBootstrappedStoryMissionSendsGoblinAssaultAssignment(): void {
    const character = createCharacter('FreshQuest');
    character.missions = {
        '1': {
            state: 1,
            currCount: 0
        }
    };

    const sentPackets: Array<{ id: number; payload: Buffer }> = [];
    const client = {
        character,
        sendBitBuffer(id: number, bb: { toBuffer(): Buffer }): void {
            sentPackets.push({ id, payload: bb.toBuffer() });
        }
    };

    (CharacterHandler as any).sendBootstrappedStoryMission(client, 1);

    const missionAdded = sentPackets.find((packet) => packet.id === 0x85);
    assert.ok(missionAdded, 'bootstrapped story mission should send a mission-added packet');
    const reader = new BitReader(missionAdded.payload);
    assert.equal(reader.readMethod4(), 1, 'the bootstrapped mission should be Goblin Assault');
    assert.equal(reader.readMethod15(), true, 'Goblin Assault should start in progress');
}

function testMissingBootstrappedMissionDoesNotReplayGoblinAssaultAssignment(): void {
    const character = createCharacter('FreshQuestNoReplay');
    character.missions = {
        '1': {
            state: 1,
            currCount: 0
        }
    };

    const sentPackets: Array<{ id: number; payload: Buffer }> = [];
    const client = {
        character,
        sendBitBuffer(id: number, bb: { toBuffer(): Buffer }): void {
            sentPackets.push({ id, payload: bb.toBuffer() });
        }
    };

    (CharacterHandler as any).sendBootstrappedStoryMission(client, 0);

    assert.equal(sentPackets.length, 0, 'no mission should be replayed when nothing was bootstrapped');
}

async function main(): Promise<void> {
    await testReloadCurrentCharacterFromSavePrefersFreshDiskState();
    await testReloadCurrentCharacterFromSaveKeepsUnsavedCharacterWhenMissingOnDisk();
    testAbilityRepairSyncsUnlockedActiveAbilityIntoLearnedAbilities();
    testPaperDollPacketNormalizesLegacyLowercaseGender();
    testCraftTownLoginRepairsCompletedKeepQuestProgress();
    testCraftTownLoginMarksClearedKeepQuestReadyToTurnIn();
    testNewbieRoadLoginRepairsCompletedKeepQuestProgress();
    testStoryRepairRestoresLostAtSeaTurnInWhenMissionIsMissing();
    testStoryRepairUpgradesLostAtSeaTurnInInsideTutorialBoat();
    testMissionSyncDoesNotReplayQuestPopupsOnLogin();
    testBootstrappedStoryMissionSendsGoblinAssaultAssignment();
    testMissingBootstrappedMissionDoesNotReplayGoblinAssaultAssignment();
    testStoryRepairDoesNotAutoCompleteGoblinRiverOutsideDungeon();
    testStoryRepairDoesNotAutoClaimKeepQuestOutsideDungeon();
    testStoryRepairDoesNotAutoCompleteOtherSwampDungeonMission();
    console.log('character_login_regression: ok');
}

void main().catch((error) => {
    console.error('character_login_regression: failed');
    console.error(error);
    process.exitCode = 1;
});
