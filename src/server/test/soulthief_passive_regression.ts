/**
 * Regression test for the Soulthief passive.
 *
 * The passive -- "every successful attack also strikes for 1% of the health the
 * target has when the blow lands" -- is applied server-side in
 * CombatHandler.handlePowerHit via getSoulthieftMaxHpBonus, because the target's
 * health is not a term the client's damage formula has.
 *
 * It read as doing nothing for three separate reasons, each fixed and each with
 * assertions below so it cannot come back:
 *
 *   1. The bonus was clamped against the attacker's own hit. That took the
 *      passive away in exactly the fight it exists for -- a full-health
 *      4,000,000 HP boss owes 40,000, far more than a rogue's swing, so the
 *      clamp handed back the plain hit instead. It also made the bonus
 *      crit-dependent, because the number it clamped against is crit-inflated.
 *
 *   2. Nothing delivered the bonus to the attacker. On a client-spawn dungeon
 *      level the attacker's own client runs the hit locally before the server
 *      ever sees the packet, and the server reconciles the difference through
 *      convergePartySharedHostileHealthToParty. That call was told the anchor had
 *      already applied the *rewritten* damage, so the correction came out as zero
 *      and the attacker's copy of the hostile -- the copy that draws the health
 *      bar and decides the kill -- never lost the extra health.
 *
 *   3. PvP targets skipped the rewrite entirely: the call site was gated on a
 *      non-player target.
 *
 * The delivery half is the one that makes the passive visible in play, so it is
 * tested against the real converge routine and the real packet it emits (a
 * negative 0x78, which is live damage since
 * patch-dungeonblitz-charregen-damage-channel.ts).
 *
 * The display twin is patch-dungeonblitz-soulthief-passive-display.ts, which
 * shows the same bonus in the floating damage numbers. It reads the pre-hit
 * health as `currHP + param1`; the rate here and there must agree.
 */
import * as fs from 'fs';
import * as path from 'path';
import { CombatHandler } from '../handlers/CombatHandler';
import { GameData } from '../core/GameData';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';
import { MasterClassID } from '../core/Enums';
import { BitReader } from '../network/protocol/bitReader';

const dataDir = path.resolve(__dirname, '..', 'data');
LevelConfig.load(dataDir);
GameData.load(dataDir);

const LEVEL = 'GoblinRiverDungeon';
const HOSTILE_ID = 5001;

function soulthiefSession(masterClass: number = MasterClassID.Soulthief): any {
    return { character: { MasterClass: masterClass } };
}

function hostile(overrides: Record<string, any> = {}): any {
    return {
        id: HOSTILE_ID,
        name: 'GoblinBoss1',
        team: 2,
        clientSpawned: true,
        level: 50,
        ...overrides
    };
}

const bonus = (target: any, baseDamage: number, session: any = soulthiefSession()): number =>
    (CombatHandler as any).getSoulthieftMaxHpBonus(session, target, baseDamage, LEVEL, null) as number;

/** A hostile at `hp` out of `maxHp`, which is what the passive now reads. */
const wounded = (maxHp: number, hp: number): any => hostile({ maxHp, hp, healthDelta: hp - maxHp });

/**
 * A PvP target. The pool comes from the session, not the entity, because a player's max HP is
 * gear-derived and the server keeps its own authoritative copy.
 */
function playerTarget(maxHp: number, level: number = 50, hp: number = maxHp): any {
    const entity = { id: 900, isPlayer: true, maxHp, hp };
    return {
        token: 2,
        clientEntID: 900,
        currentLevel: LEVEL,
        levelInstanceId: '',
        authoritativeMaxHp: maxHp,
        authoritativeCurrentHp: hp,
        character: { name: 'Victim', level },
        entities: new Map<number, any>([[900, entity]])
    };
}

const pvpBonus = (target: any, baseDamage: number, session: any = soulthiefSession()): number =>
    (CombatHandler as any).getSoulthieftMaxHpBonus(session, null, baseDamage, LEVEL, target) as number;

/**
 * Replays the reconciliation half of a power hit: the attacker's client already
 * applied `packetDamage` to its own copy, the server applied `serverDamage` to the
 * canonical, and converge has to make up the difference on the attacker's screen.
 *
 * Returns every HP-delta packet the attacker's session was sent.
 */
function reconcileOnAttackerScreen(
    maxHp: number,
    packetDamage: number,
    serverDamage: number
): Array<{ packetId: number; delta: number }> {
    const sent: Array<{ packetId: number; delta: number }> = [];
    const attacker: any = {
        token: 1,
        userId: 1,
        currentLevel: LEVEL,
        levelInstanceId: '',
        playerSpawned: true,
        clientEntID: 900,
        character: { name: 'Rogue', MasterClass: MasterClassID.Soulthief },
        entities: new Map<number, any>(),
        knownEntityIds: new Set<number>(),
        send(packetId: number, payload: Buffer) {
            // buildHpDeltaPayload is bit packed: entity id, then a signed delta.
            const br = new BitReader(payload);
            br.readMethod4();
            sent.push({ packetId, delta: br.readMethod45() });
        }
    };

    const canonical = hostile({ maxHp, hp: Math.max(0, maxHp - serverDamage) });
    attacker.entities.set(HOSTILE_ID, { ...canonical });

    const previousScope = GlobalState.sessionsByLevelScope.get(LEVEL);
    GlobalState.sessionsByLevelScope.set(LEVEL, new Set([attacker]));
    try {
        (CombatHandler as any).convergePartySharedHostileHealthToParty(
            attacker,
            LEVEL,
            canonical,
            new Map([[attacker.token, { localId: HOSTILE_ID, previousHp: maxHp, previousMaxHp: maxHp }]]),
            -packetDamage,
            -serverDamage
        );
    } finally {
        if (previousScope) {
            GlobalState.sessionsByLevelScope.set(LEVEL, previousScope);
        } else {
            GlobalState.sessionsByLevelScope.delete(LEVEL);
        }
    }

    return sent;
}

const assertions: Array<[string, () => boolean]> = [
    [
        'the rate is 1% of the health the target has when the hit lands',
        () => (CombatHandler as any).SOULTHIEFT_CURRENT_HP_RATE === 0.01
    ],
    [
        // The passive now reads the health the target still has when the blow connects, so it
        // starts high on a full bar and tapers as the target is worn down.
        'a full-health 100,000 HP target owes 1,000',
        () => bonus(wounded(100_000, 100_000), 5_000) === 1_000
    ],
    [
        'the same target at half health owes half as much',
        () => bonus(wounded(100_000, 50_000), 5_000) === 500
    ],
    [
        'the same target at a tenth of its health owes a tenth',
        () => bonus(wounded(100_000, 10_000), 5_000) === 100
    ],
    [
        'the bonus falls monotonically as the target is worn down',
        () => {
            const steps = [100_000, 80_000, 60_000, 40_000, 20_000, 5_000]
                .map((hp) => bonus(wounded(100_000, hp), 5_000));
            return steps.every((value, i) => i === 0 || value < steps[i - 1]);
        }
    ],
    [
        // The anti-tank identity survives the change: a 4,000,000 HP boss opens at 40,000.
        'a full-health 4,000,000 HP boss owes 40,000',
        () => bonus(wounded(4_000_000, 4_000_000), 5_000) === 40_000
    ],
    [
        'a nearly dead target owes almost nothing, so the passive cannot execute',
        () => bonus(wounded(4_000_000, 500), 5_000) === 5
    ],
    [
        'the bonus is uncapped: it does not track the hit that carried it',
        () => bonus(wounded(4_000_000, 4_000_000), 5_000) === bonus(wounded(4_000_000, 4_000_000), 40_000)
    ],
    [
        'a crit does not modify the bonus',
        () => bonus(wounded(100_000, 70_000), 20_000) === bonus(wounded(100_000, 70_000), 30_000)
    ],
    [
        'the bonus scales linearly with the health remaining',
        () => bonus(wounded(400_000, 200_000), 5_000) === 2 * bonus(wounded(400_000, 100_000), 5_000)
    ],
    [
        'a hostile the server has never seen take damage is read at full health',
        () => bonus(hostile(), 5_000) ===
            Math.round(0.01 * Number((CombatHandler as any).getNpcHealthState(hostile(), LEVEL).maxHp))
    ],
    [
        // Elite and boss EntTypes differ from a minion only by HitPoints, so an untouched
        // hostile's pool -- and with it the opening bonus -- grows with rank with no
        // rank-specific code.
        'an elite and a boss open strictly higher than a minion of the same level',
        () => {
            const minion = bonus(hostile({ name: 'GoblinBase' }), 5_000);
            const elite = bonus(hostile({ name: 'GoblinMiniBoss' }), 5_000);
            const boss = bonus(hostile({ name: 'GoblinBoss1' }), 5_000);
            return minion > 0 && elite > minion && boss > elite;
        }
    ],

    // --- PvP: a player target used to skip every server-side damage rewrite ---
    [
        'a full-health 100,000 HP player target owes 1,000',
        () => pvpBonus(playerTarget(100_000), 5_000) === 1_000
    ],
    [
        'a wounded player owes proportionally less',
        () => pvpBonus(playerTarget(100_000, 50, 40_000), 5_000) === 400
    ],
    [
        'the player health comes from the session, not from a passed entity',
        () => pvpBonus(playerTarget(250_000), 5_000) === 2_500
    ],
    [
        'a crit does not modify the bonus against a player either',
        () => pvpBonus(playerTarget(100_000), 20_000) === pvpBonus(playerTarget(100_000), 30_000)
    ],
    [
        'a non-Soulthief gets nothing in PvP',
        () => pvpBonus(playerTarget(100_000), 5_000, soulthiefSession(MasterClassID.Executioner)) === 0
    ],

    [
        'a missed swing (zero damage) owes nothing',
        () => bonus(hostile({ maxHp: 100_000 }), 0) === 0
    ],
    [
        'a target with no resolvable health pool owes nothing',
        () => bonus({ id: HOSTILE_ID, name: 'NotAnEntType', team: 2 }, 5_000) === 0
    ],
    [
        'the other two rogue disciplines get nothing',
        () => bonus(hostile({ maxHp: 100_000 }), 20_000, soulthiefSession(MasterClassID.Executioner)) === 0 &&
            bonus(hostile({ maxHp: 100_000 }), 20_000, soulthiefSession(MasterClassID.Shadowwalker)) === 0
    ],
    [
        'a player with no discipline gets nothing',
        () => bonus(hostile({ maxHp: 100_000 }), 20_000, soulthiefSession(MasterClassID.None)) === 0
    ],

    // --- delivery: the half that made the passive read as "not working" ---
    [
        'the attacker is sent the bonus their own client did not apply',
        () => {
            const packets = reconcileOnAttackerScreen(100_000, 5_000, 6_000);
            return packets.length === 1 && packets[0].delta === -1_000;
        }
    ],
    [
        'the delivered correction is exactly the server-side bonus, not the whole hit',
        () => {
            const maxHp = 4_000_000;
            const packetDamage = 40_000;
            const passive = bonus(hostile({ maxHp }), packetDamage);
            const packets = reconcileOnAttackerScreen(maxHp, packetDamage, packetDamage + passive);
            return packets.length === 1 && packets[0].delta === -passive;
        }
    ],
    [
        // The two assertions above prove converge does the right thing once it is told the
        // truth. This one pins the caller, which is where the bug actually was: handlePowerHit
        // has to hand it the anchor's own packet damage and the relayed damage separately.
        // Source-level because reaching handlePowerHit needs a whole live socket session.
        'handlePowerHit gives converge the anchor packet damage, not the relayed damage',
        () => {
            const source = fs.readFileSync(
                path.resolve(__dirname, '..', 'handlers', 'CombatHandler.ts'),
                'utf8'
            );
            const call = source.match(
                /convergePartySharedHostileHealthToParty\(\s*sourceSession \?\? client,[\s\S]*?partySharedHostileHealthRelay\.snapshots,\s*(-[^,]+),\s*(-[^\s)]+)\s*\)/
            );
            return Boolean(call) &&
                call![1].includes('packetDamage') &&
                call![2].includes('displayRelayDamage');
        }
    ],
    [
        'a hit the server did not rewrite still sends the attacker nothing',
        () => reconcileOnAttackerScreen(100_000, 5_000, 5_000).length === 0
    ]
];

let failed = 0;
for (const [name, check] of assertions) {
    let ok = false;
    try {
        ok = check();
    } catch (err) {
        console.error(`  ${name}: threw`, err);
    }
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (!ok) {
        failed++;
    }
}

console.log(failed === 0
    ? `\nSoulthief passive: ${assertions.length} assertions passed.`
    : `\nSoulthief passive: ${failed} of ${assertions.length} assertions FAILED.`);
process.exit(failed === 0 ? 0 : 1);
