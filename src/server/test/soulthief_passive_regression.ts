/**
 * Regression test for the Soulthief passive.
 *
 * The passive -- "every successful attack also strikes for 1% of the target's
 * maximum Health" -- is applied server-side in CombatHandler.handlePowerHit via
 * getSoulthieftMaxHpBonus, because the target's health pool is not a term the
 * client's damage formula has.
 *
 * It was reported as doing nothing, and there were two separate reasons:
 *
 *   1. The bonus was clamped with Math.min(baseDamage, ...). That took the
 *      passive away in exactly the fight it exists for -- a 4,000,000 HP boss
 *      owes 40,000, which is more than a rogue's hit, so the clamp handed back
 *      the plain hit instead. It also made the bonus crit-dependent, because the
 *      number it clamped against is the crit-inflated damage.
 *
 *   2. Nothing delivered the bonus to the attacker. On a client-spawn dungeon
 *      level the attacker's own client runs the hit locally before the server
 *      ever sees the packet, and the server reconciles the difference through
 *      convergePartySharedHostileHealthToParty. That call was told the anchor had
 *      already applied the *rewritten* damage, so the correction came out as zero
 *      and the attacker's copy of the hostile -- the copy that draws the health
 *      bar and decides the kill -- never lost the extra health.
 *
 * Both halves are locked in here. The second half is the one that makes the
 * passive visible in play, so it is tested against the real converge routine and
 * the real packet it emits (a negative 0x78, which is live damage since
 * patch-dungeonblitz-charregen-damage-channel.ts).
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
    (CombatHandler as any).getSoulthieftMaxHpBonus(session, target, baseDamage, LEVEL) as number;

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
        'the rate is 1% of the target maximum health',
        () => (CombatHandler as any).SOULTHIEFT_MAX_HP_RATE === 0.01
    ],
    [
        'a 10,000 HP enemy owes 100',
        () => bonus(hostile({ maxHp: 10_000 }), 500) === 100
    ],
    [
        'a 100,000 HP enemy owes 1,000',
        () => bonus(hostile({ maxHp: 100_000 }), 500) === 1_000
    ],
    [
        'a 4,000,000 HP boss owes 40,000, not the attacker\'s own hit',
        () => bonus(hostile({ maxHp: 4_000_000 }), 5_000) === 40_000
    ],
    [
        'the bonus does not scale with the hit, so a crit does not inflate it',
        () => bonus(hostile({ maxHp: 4_000_000 }), 5_000) === bonus(hostile({ maxHp: 4_000_000 }), 15_000)
    ],
    [
        'the bonus reads maximum health, not current health',
        () => bonus(hostile({ maxHp: 100_000, hp: 1_000 }), 500) === bonus(hostile({ maxHp: 100_000, hp: 100_000 }), 500)
    ],
    [
        'a client-spawned hostile that never reported a pool still owes its share',
        () => bonus(hostile(), 5_000) ===
            Math.round(0.01 * Number((CombatHandler as any).getNpcHealthState(hostile(), LEVEL).maxHp))
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
        () => bonus(hostile({ maxHp: 100_000 }), 500, soulthiefSession(MasterClassID.Executioner)) === 0 &&
            bonus(hostile({ maxHp: 100_000 }), 500, soulthiefSession(MasterClassID.Shadowwalker)) === 0
    ],
    [
        'a player with no discipline gets nothing',
        () => bonus(hostile({ maxHp: 100_000 }), 500, soulthiefSession(MasterClassID.None)) === 0
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
            const packetDamage = 5_000;
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
