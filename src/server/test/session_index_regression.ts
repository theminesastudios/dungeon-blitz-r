import { strict as assert } from 'assert';
import { GlobalState } from '../core/GlobalState';

function session(token: number, name: string, level: string, instance: string, roomId: number): any {
    return {
        token,
        character: { name, CurrentLevel: { name: level, x: 0, y: 0 } },
        currentLevel: level,
        levelInstanceId: instance,
        currentRoomId: roomId,
        playerSpawned: true,
        socket: { destroyed: false, readyState: 'open' }
    };
}

function main(): void {
    GlobalState.sessionsByToken.clear();
    GlobalState.partyByMember.clear();
    GlobalState.sessionsByCharacterName.clear();

    const first = session(101, 'First', 'AC_Mission1', 'run-a', 4);
    const second = session(102, 'Second', 'AC_Mission1', 'run-a', 4);
    GlobalState.partyByMember.set('first', 88);
    GlobalState.partyByMember.set('second', 88);
    GlobalState.sessionsByCharacterName.set('first', first);
    GlobalState.sessionsByCharacterName.set('second', second);
    GlobalState.sessionsByToken.set(first.token, first);
    GlobalState.sessionsByToken.set(second.token, second);

    assert.deepEqual(new Set(GlobalState.getSessionsInLevelScope('AC_Mission1#run-a')), new Set([first, second]));
    assert.deepEqual(new Set(GlobalState.getSessionsInParty(88)), new Set([first, second]));
    assert.deepEqual(new Set(GlobalState.getSessionsInRoom('AC_Mission1#run-a', 4)), new Set([first, second]));

    second.levelInstanceId = 'run-b';
    second.currentRoomId = 9;
    GlobalState.refreshSessionIndexes(second);
    assert.deepEqual(new Set(GlobalState.getSessionsInLevelScope('AC_Mission1#run-a')), new Set([first]));
    assert.deepEqual(new Set(GlobalState.getSessionsInLevelScope('AC_Mission1#run-b')), new Set([second]));
    assert.deepEqual(new Set(GlobalState.getSessionsInRoom('AC_Mission1#run-b', 9)), new Set([second]));

    GlobalState.partyByMember.delete('second');
    GlobalState.refreshSessionIndexesByCharacterName('second');
    assert.deepEqual(new Set(GlobalState.getSessionsInParty(88)), new Set([first]));

    GlobalState.sessionsByToken.delete(first.token);
    assert.equal(GlobalState.getSessionsInLevelScope('AC_Mission1#run-a').size, 0);
    assert.equal(GlobalState.getSessionsInParty(88).size, 0);
    assert.equal(GlobalState.getSessionsInRoom('AC_Mission1#run-a', 4).size, 0);

    GlobalState.sessionsByToken.delete(second.token);
    console.log('session_index_regression: ok');
}

main();
