import { strict as assert } from 'assert';
import { Character } from '../database/Database';
import { JsonAdapter } from '../database/JsonAdapter';
import { LevelHandler } from '../handlers/LevelHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';

type FakeClient = {
    userId: number;
    character: Character;
    characters: Character[];
    currentLevel: string;
    levelInstanceId: string;
};

function createCharacter(): Character {
    return {
        name: 'Neodevil',
        class: 'Paladin',
        gender: 'male',
        level: 10,
        questTrackerState: 92,
        CurrentLevel: { name: 'CraftTown', x: 360, y: 1460 },
        PreviousLevel: { name: 'NewbieRoad', x: 1421, y: 826 }
    };
}

function createClient(): FakeClient {
    const character = createCharacter();
    return {
        userId: 6,
        character,
        characters: [character],
        currentLevel: 'CraftTown',
        levelInstanceId: ''
    };
}

function createQuestProgressPacket(progress: number): Buffer {
    const bb = new BitBuffer();
    bb.writeMethod4(progress);
    return bb.toBuffer();
}

async function testQuestProgressUpdatePersistsCharacterSnapshot(): Promise<void> {
    const client = createClient();
    let saveCalls = 0;

    const originalSaveCharacterSnapshot = JsonAdapter.prototype.saveCharacterSnapshot;
    JsonAdapter.prototype.saveCharacterSnapshot = async function(userId: number, character: Character): Promise<Character[]> {
        saveCalls += 1;
        assert.equal(userId, 6);
        assert.equal(character.questTrackerState, 100);
        return [character];
    };

    try {
        await LevelHandler.handleQuestProgressUpdate(client as never, createQuestProgressPacket(100));
    } finally {
        JsonAdapter.prototype.saveCharacterSnapshot = originalSaveCharacterSnapshot;
    }

    assert.equal(client.character.questTrackerState, 100);
    assert.equal(saveCalls, 1);
}

async function testQuestProgressUpdateDoesNotRegressCompletedCraftTownTutorial(): Promise<void> {
    const client = createClient();
    client.character.missions = {
        '5': {
            state: 3,
            currCount: 1,
            claimed: 1,
            complete: 1
        }
    };
    client.character.questTrackerState = 100;

    let saveCalls = 0;
    const originalSaveCharacterSnapshot = JsonAdapter.prototype.saveCharacterSnapshot;
    JsonAdapter.prototype.saveCharacterSnapshot = async function(userId: number, character: Character): Promise<Character[]> {
        saveCalls += 1;
        assert.equal(userId, 6);
        assert.equal(character.questTrackerState, 100);
        return [character];
    };

    try {
        await LevelHandler.handleQuestProgressUpdate(client as never, createQuestProgressPacket(92));
    } finally {
        JsonAdapter.prototype.saveCharacterSnapshot = originalSaveCharacterSnapshot;
    }

    assert.equal(client.character.questTrackerState, 100);
    assert.equal(saveCalls, 0);
}

async function main(): Promise<void> {
    await testQuestProgressUpdatePersistsCharacterSnapshot();
    await testQuestProgressUpdateDoesNotRegressCompletedCraftTownTutorial();
    console.log('quest_progress_persistence_regression: ok');
}

void main().catch((error) => {
    console.error('quest_progress_persistence_regression: failed');
    console.error(error);
    process.exitCode = 1;
});
