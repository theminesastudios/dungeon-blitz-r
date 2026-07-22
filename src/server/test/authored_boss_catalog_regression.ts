/// <reference types="node" />

import { strict as assert } from 'assert';
import * as path from 'path';
import enemyElements from '../data/dungeon_enemy_elements.json';
import { DungeonCompletionConditions } from '../core/DungeonCompletionConditions';
import { DungeonCompletionSystem } from '../core/DungeonCompletionSystem';
import { EntityState, EntityTeam } from '../core/Entity';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';
import { getLevelScopeKey } from '../core/LevelScope';
import { markRoomBossEntity } from '../core/RoomBossState';
import { NpcLoader } from '../data/NpcLoader';

type EnemyManifest = Record<string, { enemyTypes?: Array<{ enemyType?: string }> }>;

// Bosses the level SWF spawns from script rather than authoring as a room enemy,
// so they never appear in dungeon_enemy_elements.json.
//
// SD_Mission1 (Unearthing the Past) is a special case worth spelling out: its
// rooms are a_Room_SDMission01..15, authored before the a_Room_SDMission<N>_<RR>
// convention the other Shazari missions use. The enemy extractor expects that
// convention, so it only matched room 01 and recorded a single RaptorHorned for
// the whole dungeon. LevelsSD.swf puts am_Guardian in a_Room_SDMission12 —
// mission 1's boss room — alongside Script_GuardianScene/Script_GuardianDefeated
// and the ac_RageGuardian class. RageGuardian is EntRank Boss at level 23
// (the mission's level) and is the only Shazari boss not already claimed by
// SD_Mission2..6, which take ScarabScorpion, OutlanderWyrm, OasisVizier,
// SandWormGreater and GolemLord respectively.
const SCRIPTED_PACKET_IDENTITIES: Record<string, string[]> = {
    AC_Mission6: ['NephitLargeEye'],
    AC_Mission6Hard: ['NephitLargeEyeHard'],
    GhostBossDungeon: ['GrayGhostLord', 'NRGhostBoss'],
    GhostBossDungeonHard: ['GrayGhostLordHard', 'NRGhostBoss'],
    SD_Mission1: ['RageGuardian'],
    SD_Mission1Hard: ['RageGuardianHard']
};

function authoredIdentities(levelName: string): string[] {
    const extracted = ((enemyElements as EnemyManifest)[levelName]?.enemyTypes ?? [])
        .map((entry) => String(entry.enemyType ?? '').trim())
        .filter(Boolean);
    const raw = NpcLoader.getRawNpcsForLevel(levelName)
        .flatMap((npc: any) => [npc?.name, npc?.characterName, npc?.character_name, npc?.displayName])
        .map((name) => String(name ?? '').replace(/^,+/, '').trim())
        .filter(Boolean);
    return Array.from(new Set([...extracted, ...raw, ...(SCRIPTED_PACKET_IDENTITIES[levelName] ?? [])]));
}

function testEveryBossGroupHasAnAuthoredPacketIdentity(): void {
    let bossLevelCount = 0;
    for (const levelName of DungeonCompletionConditions.getConfiguredLevelNames()) {
        const condition = DungeonCompletionConditions.get(levelName);
        if (condition?.mode !== 'bosses') {
            continue;
        }
        bossLevelCount += 1;
        const identities = authoredIdentities(levelName);
        for (const [groupIndex, group] of (condition.bossGroups ?? []).entries()) {
            const matching: string[] = identities.filter((identity: string) => {
                const entity: Record<string, unknown> = {
                    id: 1,
                    name: identity,
                    characterName: identity,
                    isRoomBoss: Boolean(condition.requireRoomBossMarker),
                    roomBossRoomId: condition.requireRoomBossMarker ? 1 : undefined,
                    roomBossName: condition.requireRoomBossMarker ? identity : undefined
                };
                return group.includes(DungeonCompletionConditions.getCanonicalBossName(levelName, entity));
            });
            assert.ok(
                matching.length > 0,
                `${levelName} boss group ${groupIndex + 1} has no authored packet identity (${group.join(', ')})`
            );
        }
    }
    assert.equal(bossLevelCount, 127, 'boss-mode catalog coverage changed without updating the authored audit');
}

function deadBoss(id: number, name: string): any {
    return {
        id,
        name,
        characterName: `,${name}`,
        roomId: 99,
        team: EntityTeam.ENEMY,
        entState: EntityState.DEAD,
        hp: 0,
        maxHp: 100,
        dead: true,
        destroyed: true,
        clientSpawned: true,
        clientDefeatVerified: true,
        playerDamageContributed: true
    };
}

function assertMarkerRequired(levelName: string, decoyName: string, realBossName: string, ordinal: number): void {
    const scope = getLevelScopeKey(levelName, `authored-marker-${ordinal}`);
    const decoy = deadBoss(10_000 + ordinal * 10, decoyName);
    GlobalState.levelEntities.set(scope, new Map([[decoy.id, decoy]]));
    DungeonCompletionSystem.noteEntityDefeated(scope, decoy, 1000);
    assert.equal(
        DungeonCompletionSystem.evaluate(scope, 1001).objectivesMet,
        false,
        `${levelName}: a pre-boss decoy satisfied final-boss completion`
    );

    const realBoss = deadBoss(decoy.id + 1, realBossName);
    GlobalState.levelEntities.get(scope)!.set(realBoss.id, realBoss);
    markRoomBossEntity(scope, realBoss.id, realBoss.roomId, realBossName);
    DungeonCompletionSystem.noteEntityDefeated(scope, realBoss, 1002);
    assert.equal(
        DungeonCompletionSystem.evaluate(scope, 1003).objectivesMet,
        true,
        `${levelName}: the marked authored final boss was not accepted`
    );

    DungeonCompletionSystem.reset(scope);
    GlobalState.levelEntities.delete(scope);
}

function assertMarkedAliasCompletes(levelName: string, aliasName: string, canonicalName: string, ordinal: number): void {
    const scope = getLevelScopeKey(levelName, `authored-alias-${ordinal}`);
    const aliasBoss = deadBoss(20_000 + ordinal * 10, aliasName);
    GlobalState.levelEntities.set(scope, new Map([[aliasBoss.id, aliasBoss]]));
    markRoomBossEntity(scope, aliasBoss.id, aliasBoss.roomId, aliasName);
    DungeonCompletionSystem.noteEntityDefeated(scope, aliasBoss, 1000);
    assert.equal(
        DungeonCompletionSystem.evaluate(scope, 1001).objectivesMet,
        true,
        `${levelName}: marked authored alias ${aliasName} did not satisfy ${canonicalName}`
    );

    DungeonCompletionSystem.reset(scope);
    GlobalState.levelEntities.delete(scope);
}

function assertVerifiedClientBossBypassesMissingMarker(levelName: string, bossName: string, ordinal: number): void {
    const scope = getLevelScopeKey(levelName, `verified-client-boss-${ordinal}`);
    const unverified = deadBoss(30_000 + ordinal * 10, bossName);
    unverified.clientSpawned = true;
    unverified.playerDamageContributed = false;
    unverified.clientDefeatVerified = false;
    GlobalState.levelEntities.set(scope, new Map([[unverified.id, unverified]]));
    DungeonCompletionSystem.noteEntityDefeated(scope, unverified, 1000);
    assert.equal(
        DungeonCompletionSystem.evaluate(scope, 1001).objectivesMet,
        false,
        `${levelName}: unverified unmarked client boss bypassed the marker guard`
    );

    const verified = deadBoss(unverified.id + 1, bossName);
    verified.clientSpawned = true;
    verified.playerDamageContributed = true;
    GlobalState.levelEntities.get(scope)!.set(verified.id, verified);
    DungeonCompletionSystem.noteEntityDefeated(scope, verified, 1002);
    assert.equal(
        DungeonCompletionSystem.evaluate(scope, 1003).objectivesMet,
        true,
        `${levelName}: verified unmarked client boss did not bypass the missing marker`
    );

    DungeonCompletionSystem.reset(scope);
    GlobalState.levelEntities.delete(scope);
}

function assertVerifiedAliasStillNeedsMarker(levelName: string, aliasName: string, ordinal: number): void {
    const scope = getLevelScopeKey(levelName, `verified-alias-marker-${ordinal}`);
    const verified = deadBoss(35_000 + ordinal * 10, aliasName);
    verified.clientSpawned = true;
    verified.playerDamageContributed = true;
    GlobalState.levelEntities.set(scope, new Map([[verified.id, verified]]));
    DungeonCompletionSystem.noteEntityDefeated(scope, verified, 1000);
    assert.equal(
        DungeonCompletionSystem.evaluate(scope, 1001).objectivesMet,
        false,
        `${levelName}: verified unmarked alias ${aliasName} bypassed the final-boss marker guard`
    );

    DungeonCompletionSystem.reset(scope);
    GlobalState.levelEntities.delete(scope);
}

function assertPacketOnlyBossCompletes(levelName: string, bossName: string, ordinal: number): void {
    const scope = getLevelScopeKey(levelName, `packet-only-boss-${ordinal}`);
    const boss = deadBoss(40_000 + ordinal * 10, bossName);
    DungeonCompletionSystem.noteEntityDefeated(scope, boss, 1000);
    const condition = DungeonCompletionConditions.get(levelName);
    if (condition?.cutscene?.requiredAfterObjectives) {
        assert.equal(
            DungeonCompletionSystem.evaluate(scope, 1001).reason,
            'cutscene_gate_pending',
            `${levelName}: packet-only boss defeat bypassed its authored ending skit`
        );
        DungeonCompletionSystem.noteCutsceneStart(scope, 99, 1002);
        DungeonCompletionSystem.noteCutsceneEnd(scope, 99, 1003);
    }
    assert.equal(
        DungeonCompletionSystem.evaluate(scope, 1004).ready,
        true,
        `${levelName}: packet-only boss defeat did not complete without a scoped entity map`
    );

    DungeonCompletionSystem.reset(scope);
}

function assertPacketOnlyBossDoesNotComplete(levelName: string, entityName: string, ordinal: number): void {
    const scope = getLevelScopeKey(levelName, `packet-only-non-boss-${ordinal}`);
    const entity = deadBoss(50_000 + ordinal * 10, entityName);
    DungeonCompletionSystem.noteEntityDefeated(scope, entity, 1000);
    assert.equal(
        DungeonCompletionSystem.evaluate(scope, 1001).ready,
        false,
        `${levelName}: packet-only non-boss ${entityName} satisfied completion`
    );

    DungeonCompletionSystem.reset(scope);
}

function testScriptedIdentityAndEarlyEndingGuardrails(): void {
    assert.equal(
        DungeonCompletionConditions.getCanonicalBossName('GhostBossDungeon', {
            name: 'GrayGhostLord',
            characterName: 'NRGhostBoss'
        }),
        'GrayGhostLord',
        'Ghost Boss Dungeon must recognize its actual packet identity'
    );
    assert.equal(
        DungeonCompletionConditions.getCanonicalBossName('GhostBossDungeonHard', {
            name: 'GrayGhostLordHard',
            characterName: 'NRGhostBoss'
        }),
        'GrayGhostLordHard'
    );

    assertMarkerRequired('JC_Mission11', 'BrigandChamp', 'BrigandChamp', 1);
    assertMarkerRequired('JC_Mission11Hard', 'BrigandChampHard', 'BrigandChampHard', 2);
    assertMarkerRequired('SD_Mission4', 'OasisVizierGreen', 'OasisVizier', 3);
    assertMarkerRequired('SD_Mission4Hard', 'OasisVizierGreenHard', 'OasisVizierHard', 4);
    assertMarkedAliasCompletes('JC_Mission11', 'BrigandChampMarker', 'BrigandChamp', 5);
    assertMarkedAliasCompletes('JC_Mission11Hard', 'BrigandChampMarkerHard', 'BrigandChampHard', 6);
    assertMarkedAliasCompletes('SD_Mission4', 'OasisVizierGreen', 'OasisVizier', 7);
    assertMarkedAliasCompletes('SD_Mission4Hard', 'OasisVizierGreenHard', 'OasisVizierHard', 8);
    assertVerifiedClientBossBypassesMissingMarker('SD_Mission4', 'OasisVizier', 9);
    assertVerifiedClientBossBypassesMissingMarker('SD_Mission4Hard', 'OasisVizierHard', 10);
    assertVerifiedAliasStillNeedsMarker('SD_Mission4', 'OasisVizierGreen', 11);
    assertVerifiedAliasStillNeedsMarker('SD_Mission4Hard', 'OasisVizierGreenHard', 12);
    // These four used to assert that killing a desert raptor completes Unearthing
    // the Past — they encoded the bug that made the rank plate appear at 7% with
    // the boss still alive. RaptorHorned and RaptorHorned2 are EntRank Minion;
    // the dungeon's boss is RageGuardian ("Amenrahtep"). trash_mob_boss_alias_
    // regression now asserts the raptors specifically do NOT complete it.
    assertPacketOnlyBossCompletes('SD_Mission1', 'RageGuardian', 13);
    assertPacketOnlyBossCompletes('SD_Mission1Hard', 'RageGuardianHard', 14);
    assertPacketOnlyBossCompletes('SD_Mission1', 'Amenrahtep', 15);
    assertPacketOnlyBossCompletes('SD_Mission1Hard', 'Amenrahtep', 16);
    assertPacketOnlyBossCompletes('JC_Mission5', 'NephitDragonMarker', 17);
    assertPacketOnlyBossCompletes('JC_Mission5Hard', 'NephitDragonMarkerHard', 18);
    assertPacketOnlyBossCompletes('JC_Mission5Hard', 'NephitDragonMarker', 19);
    assertPacketOnlyBossDoesNotComplete('JC_Mission5', 'NephitDragonPortal', 20);
    assertPacketOnlyBossDoesNotComplete('JC_Mission5Hard', 'NephitDragonPortalHard', 21);
}

function main(): void {
    const dataDir = path.resolve(__dirname, '../data');
    LevelConfig.load(dataDir);
    NpcLoader.load(dataDir);
    testEveryBossGroupHasAnAuthoredPacketIdentity();
    testScriptedIdentityAndEarlyEndingGuardrails();
    console.log('Authored boss catalog regression passed (127 boss-mode dungeons).');
}

main();
