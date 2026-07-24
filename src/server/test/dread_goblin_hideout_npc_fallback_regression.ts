import { strict as assert } from 'assert';
import * as path from 'path';
import { NpcLoader } from '../data/NpcLoader';

// Dread Goblin Hideout is TutorialDungeonHard, but it is NOT the normal Goblin
// Kidnappers layout at a higher difficulty: it is built from
// a_Level_GoblinBeachHard, a completely different room set. That is already why
// it has no NPCAnna and no Chains03 to rescue.
//
// The Hard -> base NPC fallback ignored that and seeded TutorialDungeon's
// authored actors into the Dread run. The boss entry is the damaging one:
// GoblinBoss1, id 3923550, at level position (22695, 2959). Those coordinates
// belong to a_Room_NRM02RGoblinCaveBoss; in the Dread layout room 09 starts at
// (20460, 1960) and its treasure chest sits at (22686, 2917), so the seeded boss
// materialised right on top of the chest — the motionless second Tag Ugo the
// player sees, never driven by AI, never damaged, holding every debuff it was
// ever hit with. Being an undefeated required boss, it also kept the run's
// objectives permanently pending.
const TAG_UGO_SEED_ID = 3923550;
const DREAD_LEVEL = 'TutorialDungeonHard';
const NORMAL_LEVEL = 'TutorialDungeon';

function testDreadGoblinHideoutInheritsNoNormalDungeonNpcs(): void {
    const raw = NpcLoader.getRawNpcsForLevel(DREAD_LEVEL);
    const filtered = NpcLoader.getNpcsForLevel(DREAD_LEVEL);

    assert.equal(
        raw.length,
        0,
        `${DREAD_LEVEL} inherited ${raw.length} NPCs from ${NORMAL_LEVEL}; its rooms are a different level entirely`,
    );
    assert.equal(filtered.length, 0, `${DREAD_LEVEL} inherited filtered NPCs from ${NORMAL_LEVEL}`);

    assert.equal(
        raw.some((npc: any) => Math.round(Number(npc?.id ?? 0)) === TAG_UGO_SEED_ID),
        false,
        'the normal dungeon Tag Ugo was seeded into the Dread run again',
    );
}

// The normal dungeon must keep its own actors, and the guard must not disable
// the fallback for every Hard level — the ones whose geometry really is shared
// still depend on it.
function testTheNormalDungeonAndOtherHardLevelsAreUnaffected(): void {
    const normal = NpcLoader.getRawNpcsForLevel(NORMAL_LEVEL);
    assert.ok(normal.length > 0, `${NORMAL_LEVEL} lost its authored NPCs`);
    assert.ok(
        normal.some((npc: any) => Math.round(Number(npc?.id ?? 0)) === TAG_UGO_SEED_ID),
        `${NORMAL_LEVEL} lost its authored Tag Ugo`,
    );

    // GoblinRiverDungeonHard shares its base level's rooms and is server-hostile,
    // so it must still inherit.
    assert.ok(
        NpcLoader.getRawNpcsForLevel('GoblinRiverDungeonHard').length > 0,
        'GoblinRiverDungeonHard stopped inheriting its base level NPCs',
    );
}

function main(): void {
    NpcLoader.load(path.resolve(__dirname, '../data'));
    testDreadGoblinHideoutInheritsNoNormalDungeonNpcs();
    testTheNormalDungeonAndOtherHardLevelsAreUnaffected();
    console.log('dread_goblin_hideout_npc_fallback_regression: ok');
}

main();
