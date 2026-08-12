/// <reference types="node" />

import './helpers/disable_production_mongo';
import { strict as assert } from 'assert';
import { CombatHandler } from '../handlers/CombatHandler';
import { CommandHandler } from '../handlers/CommandHandler';
import { GlobalState } from '../core/GlobalState';
import { BitBuffer } from '../network/protocol/bitBuffer';

/*
 * Cheat Engine edits the client's own memory, which the server cannot prevent. What the
 * server can do is refuse to store the result.
 *
 * The client computes its own max HP -- base for the level times one plus the summed
 * percentage bonuses from gear, charms and talents -- and reports it in 0xFC and 0xBB.
 * The server has no independent stat model, so it has to accept the number for normal
 * play, but it used to accept it unbounded: writing maxHP = 10,000,000 in memory made
 * every server-side heal, regen and death check treat that player as immortal.
 */

const LEVEL_50_BASE_HP = 68_109; // CombatHandler.PLAYER_HITPOINTS[50]
const BONUS_MULTIPLE = 4;

function createClient(level: number): any {
    const sentPackets: Array<{ id: number }> = [];
    return {
        userId: 5150,
        token: 5150,
        clientEntID: 0,
        currentLevel: 'CraftTown',
        levelInstanceId: '',
        playerSpawned: true,
        character: { name: 'Cheater', class: 'Mage', level },
        entities: new Map(),
        authoritativeMaxHp: 0,
        authoritativeCurrentHp: 0,
        combatStatsDirty: false,
        allowDirtyCombatStatsRegen: false,
        lastCombatStatsSyncedAt: 0,
        lastCombatActivityAt: 0,
        pendingRespawnRequest: null,
        socket: { destroyed: false },
        sentPackets,
        send(id: number) { sentPackets.push({ id }); },
        sendBitBuffer(id: number) { sentPackets.push({ id }); }
    };
}

// `armorClass` null is the packet a client whose cached SWF predates
// patch-dungeonblitz-combat-stats-armor sends: the same fields, stopping one short.
function combatStatsPacket(maxHp: number, armorClass: number | null = null): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod9(100);   // meleeDamage
    bb.writeMethod9(100);   // magicDamage
    bb.writeMethod9(maxHp);
    bb.writeMethod20(4, 0);
    bb.writeMethod9(0);
    if (armorClass !== null) {
        bb.writeMethod9(armorClass);
    }
    return bb.toBuffer();
}

function hpIncreasePacket(delta: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod24(delta);
    return bb.toBuffer();
}

function testDeclaredMaxHpIsCapped(): void {
    const ceiling = LEVEL_50_BASE_HP * BONUS_MULTIPLE;

    const cheater = createClient(50);
    CommandHandler.handleSendCombatStats(cheater, combatStatsPacket(10_000_000));
    assert.equal(
        cheater.authoritativeMaxHp,
        ceiling,
        'a memory-edited max HP must be cut down to the level ceiling'
    );

    // A real maxed build stacking bonuses stays untouched.
    const legitimate = createClient(50);
    const realisticMaxHp = Math.round(LEVEL_50_BASE_HP * 1.8);
    CommandHandler.handleSendCombatStats(legitimate, combatStatsPacket(realisticMaxHp));
    assert.equal(
        legitimate.authoritativeMaxHp,
        realisticMaxHp,
        'a legitimate bonus stack must pass through untouched'
    );
}

// The increase notice adds to the running max, so an unbounded delta reaches the same
// pool one increment at a time.
function testHpIncreaseNoticeCannotClimbPastTheCap(): void {
    const client = createClient(50);
    client.authoritativeMaxHp = LEVEL_50_BASE_HP;

    for (let i = 0; i < 25; i += 1) {
        CommandHandler.handleHpIncreaseNotice(client, hpIncreasePacket(1_000_000));
    }

    assert.equal(
        client.authoritativeMaxHp,
        LEVEL_50_BASE_HP * BONUS_MULTIPLE,
        'repeated increase notices must not climb past the ceiling'
    );
}

// The ceiling scales with level, so a level 1 character cannot claim a level 50 pool.
function testCeilingScalesWithLevel(): void {
    const lowLevel = createClient(1);
    CommandHandler.handleSendCombatStats(lowLevel, combatStatsPacket(10_000_000));
    assert.ok(
        lowLevel.authoritativeMaxHp < LEVEL_50_BASE_HP,
        `a level 1 character must not reach a level 50 pool, got ${lowLevel.authoritativeMaxHp}`
    );
    assert.equal(lowLevel.authoritativeMaxHp, 7_400 * BONUS_MULTIPLE, 'level 1 base is 7400');
}

/*
 * Defense rides on the end of the same packet, and it is a declaration like everything else
 * in it -- the client computes it and Cheat Engine can edit it. It is bounded rather than
 * modelled; reproducing the client's gear/rune/mod stat pass to know the true figure is a
 * different job, and a ceiling is enough that a declared Defense in the millions cannot turn
 * the Sentinel passive's 0.1% into a one-shot.
 */
function testDeclaredArmorClassIsReadAndCapped(): void {
    const client = createClient(50);
    CommandHandler.handleSendCombatStats(client, combatStatsPacket(LEVEL_50_BASE_HP, 3200));
    assert.equal(client.authoritativeArmorClass, 3200, 'a real Defense must pass through untouched');

    CommandHandler.handleSendCombatStats(client, combatStatsPacket(LEVEL_50_BASE_HP, 50_000_000));
    assert.equal(client.authoritativeArmorClass, 100_000, 'a memory-edited Defense must be cut to the ceiling');
}

// The field is optional on purpose: browsers cache the SWF, so a client older than the server
// ends the packet one field early. The fields before it must still be read, not lost to a
// parse error.
function testCombatStatsPacketWithoutArmorStillParses(): void {
    const client = createClient(50);
    client.authoritativeArmorClass = 4242;
    CommandHandler.handleSendCombatStats(client, combatStatsPacket(LEVEL_50_BASE_HP));
    assert.equal(client.authoritativeMaxHp, LEVEL_50_BASE_HP, 'max HP must survive a short packet');
    assert.equal(client.authoritativeArmorClass, 4242, 'a short packet must not zero the last known Defense');
}

function main(): void {
    testDeclaredMaxHpIsCapped();
    testDeclaredArmorClassIsReadAndCapped();
    testCombatStatsPacketWithoutArmorStillParses();
    testHpIncreaseNoticeCannotClimbPastTheCap();
    testCeilingScalesWithLevel();
    assert.equal(typeof CombatHandler.clampDeclaredMaxHp, 'function');
    GlobalState.sessionsByToken.clear();
    console.log('client_declared_stat_authority_regression: ok');
}

main();
