import { strict as assert } from 'assert';
import { AdminRuntimeSettings } from '../core/AdminRuntimeSettings';
import { GlobalState } from '../core/GlobalState';
import { buildAdminSnapshot } from '../integrations/AdminControlApi';
import { EntityState, EntityTeam } from '../core/Entity';

function resetState(): void {
    AdminRuntimeSettings.reset();
    GlobalState.sessionsByToken.clear();
    GlobalState.clients.clear();
    GlobalState.levelEntities.clear();
    GlobalState.partyByMember.clear();
}

function testRuntimeSettingsValidationAndScaling(): void {
    const settings = AdminRuntimeSettings.update({
        oneHitEnabled: true,
        godModeEnabled: true,
        freezeEnemies: true,
        damageMultiplier: 3.5,
        playerSpeedMultiplier: 1.75,
        gearDropMultiplier: 4,
        materialDropMultiplier: 2,
        goldMultiplier: 2.25,
        xpMultiplier: 1.5
    });

    assert.equal(settings.oneHitEnabled, true);
    assert.equal(settings.playerSpeedMultiplier, 1.75);
    assert.equal(AdminRuntimeSettings.scaleDamage(10), 35);
    assert.equal(AdminRuntimeSettings.scaleGearChance(0.3), 1);
    assert.equal(AdminRuntimeSettings.scaleMaterialChance(0.2), 0.4);
    assert.equal(AdminRuntimeSettings.scaleGold(10), 23);
    assert.equal(AdminRuntimeSettings.scaleXp(10), 15);
    assert.throws(() => AdminRuntimeSettings.update({ playerSpeedMultiplier: 3 }), /between 0.25 and 2.5/);
}

function testLiveSnapshotGroupsPlayersAndRooms(): void {
    const sent: Array<{ id: number; payload: Buffer }> = [];
    const session = {
        token: 42,
        userId: 7,
        playerSpawned: true,
        character: { name: 'Neo', class: 'Mage' },
        currentLevel: 'JadeCity',
        levelInstanceId: '',
        currentRoomId: 9,
        authoritativeCurrentHp: 80,
        authoritativeMaxHp: 100,
        playSessionStartedAt: 1234,
        clientEntID: 101,
        entities: new Map(),
        movementAuthority: {},
        socket: { destroyed: false, readyState: 'open' },
        send(id: number, payload: Buffer): void { sent.push({ id, payload }); }
    };
    GlobalState.partyByMember.set('neo', 17);
    GlobalState.sessionsByToken.set(42, session as never);
    GlobalState.clients.add(session as never);
    GlobalState.levelEntities.set('JadeCity', new Map([
        [501, { id: 501, name: 'Goblin', isPlayer: false, team: EntityTeam.ENEMY, roomId: 9, hp: 50, entState: EntityState.ACTIVE }],
        [502, { id: 502, name: 'DeadGoblin', isPlayer: false, team: EntityTeam.ENEMY, roomId: 9, hp: 0, dead: true, entState: EntityState.DEAD }],
        [503, { id: 503, name: 'Villager', isPlayer: false, team: EntityTeam.NPC, roomId: 9, hp: 50, entState: EntityState.ACTIVE }]
    ]));

    const snapshot = buildAdminSnapshot();
    assert.equal(snapshot.onlinePlayers, 1);
    assert.equal(snapshot.players[0]?.name, 'Neo');
    assert.equal(snapshot.players[0]?.partyId, 17);
    assert.equal(snapshot.rooms[0]?.hostiles, 1);
    assert.equal(snapshot.rooms[0]?.players, 1);
}

resetState();
testRuntimeSettingsValidationAndScaling();
resetState();
testLiveSnapshotGroupsPlayersAndRooms();
resetState();
console.log('admin panel regression passed');
