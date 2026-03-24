import { strict as assert } from 'assert';
import { Character } from '../database/Database';
import { JsonAdapter } from '../database/JsonAdapter';
import { AbilityHandler } from '../handlers/AbilityHandler';
import { CharacterHandler } from '../handlers/CharacterHandler';
import { MissionHandler } from '../handlers/MissionHandler';

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

async function main(): Promise<void> {
    await testReloadCurrentCharacterFromSavePrefersFreshDiskState();
    await testReloadCurrentCharacterFromSaveKeepsUnsavedCharacterWhenMissingOnDisk();
    testAbilityRepairSyncsUnlockedActiveAbilityIntoLearnedAbilities();
    testCraftTownLoginRepairsCompletedKeepQuestProgress();
    testNewbieRoadLoginRepairsCompletedKeepQuestProgress();
    console.log('character_login_regression: ok');
}

void main().catch((error) => {
    console.error('character_login_regression: failed');
    console.error(error);
    process.exitCode = 1;
});
