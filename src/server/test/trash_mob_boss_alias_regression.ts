/// <reference types="node" />

import { strict as assert } from 'assert';
import * as path from 'path';
import entTypesCatalog from '../data/EntTypes.json';
import { DungeonCompletionConditions } from '../core/DungeonCompletionConditions';
import { DungeonCompletionSystem } from '../core/DungeonCompletionSystem';
import { EntityState, EntityTeam } from '../core/Entity';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';
import { getLevelScopeKey } from '../core/LevelScope';

// Unearthing the Past showed its rank plate at 7% progress with the boss still
// alive. SD_Mission1 had RaptorHorned configured as its boss, aliasing
// RaptorHorned2/RaptorHornedGreater/RaptorHornedGreater2 onto it — but every one
// of those is an ordinary desert raptor (EntRank Minion/Lieutenant, 0.2-1 HP
// multiplier). Killing the first trash raptor satisfied the boss objective, and
// SD_Mission1 has no cutscene gate to hold the summary back, so the run
// completed on the spot.
//
// The real boss is RageGuardian ("Amenrahtep", EntRank Boss, level 23), spawned
// from script in a_Room_SDMission12.

type EntType = { EntName?: string; EntRank?: string; HitPoints?: string };

const TRASH_RANKS = new Set(['Minion', 'Lieutenant']);

function entTypesByName(): Map<string, EntType> {
    // EntTypes.json nests as { EntTypes: { <group>: EntType[] } }.
    const groups = (entTypesCatalog as { EntTypes: Record<string, unknown> }).EntTypes;
    const inner = Object.values(groups).find(Array.isArray) as EntType[] | undefined;
    assert.ok(inner?.length, 'could not read the EntTypes catalog');
    return new Map(
        (inner ?? [])
            .filter((entry) => entry && String(entry.EntName ?? '').trim())
            .map((entry) => [String(entry.EntName), entry])
    );
}

// The class of bug, not just the one instance: no dungeon may treat a Minion or
// Lieutenant as its boss, whether as the canonical name or via an alias.
function verifyNoTrashMobIsConfiguredAsABoss(): void {
    const byName = entTypesByName();
    const offenders: string[] = [];

    for (const levelName of DungeonCompletionConditions.getConfiguredLevelNames()) {
        const condition = DungeonCompletionConditions.get(levelName);
        if (condition?.mode !== 'bosses') {
            continue;
        }

        // CraftTownTutorial's scripted mini-boss is a Lieutenant by design.
        if (levelName === 'CraftTownTutorial') {
            continue;
        }

        const configured = new Set([
            ...(condition.bossGroups ?? []).flat(),
            ...Object.keys(condition.bossAliases ?? {})
        ]);

        for (const name of configured) {
            // "*Marker" entities are script-driven boss proxies, and their
            // EntTypes rank is nominal rather than real: NephitSpireMarker is
            // listed as EntRank Minion with HitPoints 1, yet a live Capstone
            // trace shows it fighting with 134560 HP and being the only kill the
            // client reports (28 times, while the server rejected it). The
            // codebase already treats markers as boss identities — NephitDragon-
            // Marker, DragonTempleMarker, BrigandChampMarker, PhantomKnight-
            // Marker. They are singletons, never ordinary trash, so the rank
            // check below cannot say anything useful about them.
            if (/Marker(Hard)?$/.test(name)) {
                continue;
            }

            const entType = byName.get(name);
            // Display-name aliases ("Amenrahtep") have no EntType entry.
            if (!entType) {
                continue;
            }
            const rank = String(entType.EntRank ?? '');
            if (TRASH_RANKS.has(rank)) {
                offenders.push(
                    `${levelName}: ${name} is EntRank ${rank} (hp ${entType.HitPoints}), ` +
                    `so killing ordinary trash completes the dungeon`
                );
            }
        }
    }

    assert.deepEqual(offenders, [], `trash mobs configured as bosses:\n  ${offenders.join('\n  ')}`);
}

function createRaptor(id: number, name: string): any {
    return {
        id,
        name,
        EntName: name,
        characterName: `,${name}`,
        isPlayer: false,
        clientSpawned: false,
        team: EntityTeam.ENEMY,
        roomId: 3,
        hp: 0,
        maxHp: 100,
        dead: true,
        destroyed: true,
        entState: EntityState.DEAD
    };
}

// The reported failure, reproduced end to end.
function verifyKillingRaptorsDoesNotCompleteUnearthingThePast(): void {
    for (const levelName of ['SD_Mission1', 'SD_Mission1Hard']) {
        const scope = getLevelScopeKey(levelName, `raptor-${levelName}`);
        const suffix = levelName.endsWith('Hard') ? 'Hard' : '';
        const raptors = [
            `RaptorHorned${suffix}`,
            `RaptorHorned2${suffix}`,
            `RaptorHornedGreater${suffix}`,
            `RaptorHornedGreater2${suffix}`
        ].map((name, index) => createRaptor(70_000 + index, name));

        GlobalState.levelEntities.set(scope, new Map(raptors.map((raptor) => [raptor.id, raptor])));
        raptors.forEach((raptor) => DungeonCompletionSystem.noteEntityDefeated(scope, raptor));

        const evaluation = DungeonCompletionSystem.evaluate(scope);
        assert.equal(
            evaluation.objectivesMet,
            false,
            `${levelName}: clearing ordinary desert raptors completed the dungeon, so the ` +
            `rank screen appears while the boss is still alive`
        );

        DungeonCompletionSystem.reset(scope);
        GlobalState.levelEntities.delete(scope);
    }
}

// ...and the real boss must still finish it.
function verifyTheGuardianStillCompletesUnearthingThePast(): void {
    for (const [levelName, bossName] of [
        ['SD_Mission1', 'RageGuardian'],
        ['SD_Mission1Hard', 'RageGuardianHard']
    ] as const) {
        const scope = getLevelScopeKey(levelName, `guardian-${levelName}`);
        const boss = createRaptor(71_000, bossName);

        GlobalState.levelEntities.set(scope, new Map([[boss.id, boss]]));
        DungeonCompletionSystem.noteEntityDefeated(scope, boss);

        assert.equal(
            DungeonCompletionSystem.evaluate(scope).objectivesMet,
            true,
            `${levelName}: defeating ${bossName} no longer completes the dungeon`
        );

        DungeonCompletionSystem.reset(scope);
        GlobalState.levelEntities.delete(scope);
    }
}

// The boss is script-spawned and reports its display name in some packets.
function verifyTheGuardianDisplayNameResolves(): void {
    for (const [levelName, bossName] of [
        ['SD_Mission1', 'RageGuardian'],
        ['SD_Mission1Hard', 'RageGuardianHard']
    ] as const) {
        assert.equal(
            DungeonCompletionConditions.getCanonicalBossName(levelName, {
                id: 1,
                name: 'Amenrahtep',
                characterName: ',Amenrahtep'
            }),
            bossName,
            `${levelName}: the boss's display name no longer resolves to ${bossName}`
        );
    }
}

function main(): void {
    LevelConfig.load(path.resolve(__dirname, '../data'));
    verifyNoTrashMobIsConfiguredAsABoss();
    verifyKillingRaptorsDoesNotCompleteUnearthingThePast();
    verifyTheGuardianStillCompletesUnearthingThePast();
    verifyTheGuardianDisplayNameResolves();
    console.log('trash_mob_boss_alias_regression: ok');
}

main();
