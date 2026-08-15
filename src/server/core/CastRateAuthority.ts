import * as fs from 'fs';
import * as path from 'path';
import { resolveClientXmlDir } from '../utils/ClientXmlDir';

export interface CastRateState {
    /** Milliseconds of authored animation time the client has earned but not yet spent. */
    creditMs: number;
    creditUpdatedAtMs: number;
    violations: number;
    /** powerId -> earliest time its cooldown allows another cast. */
    cooldownReadyAtMs: Map<number, number>;
    /** powerId -> when hits for it stop being dropped, after a cast we refused. */
    blockedHitPowersUntilMs: Map<number, number>;
    /** Server-clock time at which the current Sentinel Form began, or 0 outside the form. */
    sentinelFormEnteredAtMs: number;
    /** Master-mana spent on Sentinel Form attacks since the form began. */
    sentinelFormEnergyUsed: number;
}

type PowerTiming = {
    /** Mean authored cast animation, which is what occupies the caster. */
    castMs: number;
    cooldownMs: number;
    /** Master-mana one cast spends, which meters Sentinel Form's exit cooldown. */
    manaCost: number;
};

/**
 * How fast a player is allowed to cast, measured on the server's clock.
 *
 * The client gates its own casting on two things, and both run off getTimer(): a power
 * cannot start while another is mid-animation (CombatState:1666), and it cannot start
 * before its own cooldown expires (`var_114[powerID] = mTimeThisTick + coolDownTime`).
 * Inflate Flash's timer -- a Cheat Engine speedhack is the usual way -- and both gates
 * open early, so the same rotation arrives two to ten times faster. The server relayed
 * every one of them and applied the damage that followed, which is the whole payoff of the
 * hack once the Speed Up screens stopped paying out.
 *
 * Both gates are rebuilt here, and they have to stay separate. Animation time is a global
 * budget: one caster, one animation at a time, so the authored durations of what you cast
 * cannot add up to more than the time that actually passed. Cooldowns are per power and
 * run in parallel -- three abilities on ten-second cooldowns can legitimately all fire
 * inside a second -- so charging a cooldown to a shared budget would refuse honest play.
 */
export class CastRateAuthority {
    /**
     * Fraction of the authored time a cast actually has to cost.
     *
     * ponytail: one blunt constant instead of modelling haste. AttackSpeed buffs go up to
     * +25% and Haste stacks on top, so honest play already runs faster than the XML says;
     * half leaves room for that and for a stalled connection dumping packets in a bunch.
     * The price is that a 2x speedhack sits right at the line and only clearly faster ones
     * get caught. If that stops being enough, track the caster's active AttackSpeed/Haste
     * buffs and tighten this toward 0.9.
     */
    private static readonly TOLERANCE = 0.5;
    /** Nothing is free: plenty of powers author no cast animation at all. */
    private static readonly MIN_CAST_COST_MS = 40;
    /**
     * Burst headroom, so a network stall that bunches packets is not read as speed. It
     * refills while idle, which is deliberate -- the opening second of a fight is
     * unconstrained, sustained casting is not.
     */
    private static readonly MAX_CREDIT_MS = 1000;
    /**
     * How long hits for a refused power keep being dropped. Refusing the cast alone does
     * not stop the damage -- 0x0A carries its own damage number and the server applies it
     * -- so the hits have to go with it. A player who never trips the limit never has a
     * power blocked, so the only trailing projectile this can swallow belongs to someone
     * already casting faster than the game allows.
     */
    private static readonly HIT_BLOCK_MS = 1000;

    /**
     * Sentinel Form is the one power whose final lockout depends on how long it stayed active.
     *
     * The form has no Duration -- it runs until the mana bar cannot pay for the next swing --
     * and its per-swing cost is now low enough that a form routinely outlasts the 30s cooldown
     * it started. So the client re-stamps that cooldown when the form ENDS
     * (CombatState.sentinelFormExitCooldown, added by
     * patch-dungeonblitz-sentinel-form-exit-cooldown.js), and a client that simply skips that
     * re-stamp gets an unlimited-uptime tank stance. Mirrored here for the same reason every
     * other cooldown is: the client's copy is a convenience, not the authority.
     *
     * The cooldown after leaving is not a fixed 30 seconds -- it is the energy the form actually
     * spent, scaled so that draining the whole mana bar costs the full 30 seconds. Every swing in
     * the form (SFMelee, SFMeleeCombo, SFRanged) spends its authored ManaCost from the master-mana
     * bar, and each such cast accumulates here; on exit the total is converted at
     * SENTINEL_FORM_ENERGY_TO_MS, so a form that burned 50 of its 100 energy waits 15 seconds and
     * one that tapped out with a nearly full bar waits the floor. A near-instant exit spends ~0
     * energy, so the SENTINEL_FORM_EXIT_FLOOR_MS floor keeps the form from being re-entered with no
     * cooldown at all. Both ways out of the form cast EndSentinelForm and both are relayed as 0x09
     * -- the hotbar cancel through CombatState.method_51, the mana-ran-out exit through method_46
     * -- so one hook on that power id covers cancelling early, running dry, and dying in form.
     */
    private static readonly SENTINEL_FORM_EXIT_LOCKOUT_MS = 30000;
    /**
     * Cooldown milliseconds per point of master-mana spent in the form. The mana bar holds 100
     * points, so draining it dry -- the way the form normally ends -- costs the authored 30-second
     * cooldown, and a partial burn costs proportionally less. Mirrors ENERGY_TO_MS in
     * patch-dungeonblitz-sentinel-form-exit-cooldown.js; the two must agree or the server and the
     * honest client enforce different lockouts.
     */
    private static readonly SENTINEL_FORM_ENERGY_TO_MS = 300;
    /**
     * Floor for the energy refund, mirroring CombatState.sentinelFormExitCooldown: without it
     * a client that taps the form and leaves on the same frame refunds to ~0 and re-enters freely,
     * which is the spam the floor exists to stop. Applied before TOLERANCE, so the tolerant server
     * floor is half this -- an honest client waiting the full client-side floor is never refused.
     */
    private static readonly SENTINEL_FORM_EXIT_FLOOR_MS = 10000;

    private static timingsByPowerId: Map<number, PowerTiming> | null = null;
    /** Every rank of the form. Stamped together -- see noteSentinelFormExit. */
    private static sentinelFormPowerIds = new Set<number>();
    /** Every melee, combo, and ranged attack substituted while Sentinel Form is active. */
    private static sentinelFormAttackPowerIds = new Set<number>();
    /** The cancel power, whose cast is what starts the lockout. */
    private static endSentinelFormPowerIds = new Set<number>();

    static createState(): CastRateState {
        return {
            creditMs: CastRateAuthority.MAX_CREDIT_MS,
            creditUpdatedAtMs: 0,
            violations: 0,
            cooldownReadyAtMs: new Map(),
            blockedHitPowersUntilMs: new Map(),
            sentinelFormEnteredAtMs: 0,
            sentinelFormEnergyUsed: 0
        };
    }

    static nowMs(): number {
        return Date.now();
    }

    /**
     * CastTime is a comma list of combo steps, and what a cast costs on average is the mean
     * of them. Cleave is "400,100,100,100,100": the fast steps are only reachable after the
     * slow opener, so charging the 100 would leave room for three times the melee anyone
     * can actually swing, while charging the 400 would refuse the combo itself. 800ms of
     * animation buys five casts, so a cast is worth 160.
     */
    private static loadTimings(): Map<number, PowerTiming> {
        if (CastRateAuthority.timingsByPowerId) {
            return CastRateAuthority.timingsByPowerId;
        }

        const timings = new Map<number, PowerTiming>();
        CastRateAuthority.timingsByPowerId = timings;

        const xmlDir = resolveClientXmlDir(['PlayerPowerTypes.xml']);
        if (!xmlDir) {
            console.warn('[CastRateAuthority] PlayerPowerTypes.xml not found; cast rate limiting is disabled.');
            return timings;
        }

        try {
            const xml = fs.readFileSync(path.join(xmlDir, 'PlayerPowerTypes.xml'), 'utf8');
            for (const block of xml.match(/<Power PowerName="[^"]*">[\s\S]*?<\/Power>/g) ?? []) {
                const powerId = Math.round(Number(block.match(/<PowerID>([^<]*)<\/PowerID>/)?.[1] ?? 0));
                if (!Number.isFinite(powerId) || powerId <= 0) {
                    continue;
                }

                // Resolved from the authored data rather than hardcoded: the ids are whatever
                // PlayerPowerTypes says they are, and a wrong constant here would hang the
                // lockout on some unrelated power.
                const powerName = String(block.match(/<Power PowerName="([^"]*)">/)?.[1] ?? '');
                if (/^EndSentinelForm\d*$/.test(powerName)) {
                    CastRateAuthority.endSentinelFormPowerIds.add(powerId);
                } else if (/^SentinelForm\d*$/.test(powerName)) {
                    CastRateAuthority.sentinelFormPowerIds.add(powerId);
                }
                const basePowerName = String(block.match(/<BasePowerName>([^<]*)<\/BasePowerName>/)?.[1] ?? '');
                if (/^SF(?:Melee(?:Combo)?|Ranged)$/.test(basePowerName)) {
                    CastRateAuthority.sentinelFormAttackPowerIds.add(powerId);
                }

                const castTimes = String(block.match(/<CastTime>([^<]*)<\/CastTime>/)?.[1] ?? '')
                    .split(',')
                    .map((value) => Number(value))
                    .filter((value) => Number.isFinite(value) && value >= 0);
                const cooldown = Number(block.match(/<CoolDownTime>([^<]*)<\/CoolDownTime>/)?.[1] ?? 0);
                // ManaCost authors "a,b" as two scalars in a couple of places; the spent amount is
                // the first one, which is also what PowerType.manaCost ends up holding.
                const manaCost = Number(String(block.match(/<ManaCost>([^<]*)<\/ManaCost>/)?.[1] ?? '').split(',')[0] ?? 0);

                timings.set(powerId, {
                    castMs: castTimes.length > 0
                        ? castTimes.reduce((total, value) => total + value, 0) / castTimes.length
                        : 0,
                    cooldownMs: Number.isFinite(cooldown) ? Math.max(0, cooldown) : 0,
                    manaCost: Number.isFinite(manaCost) ? Math.max(0, manaCost) : 0
                });
            }
            console.log(`[CastRateAuthority] Loaded cast timings for ${timings.size} powers.`);
        } catch (err) {
            console.warn('[CastRateAuthority] Could not read PlayerPowerTypes.xml; cast rate limiting is disabled.', err);
        }

        return timings;
    }

    /**
     * True when everything is allowed, as it was before this existed: the power data never
     * loaded, or someone turned it off.
     *
     * This is a heuristic pointed at live players, so it gets a kill switch that does not
     * need a code change to reach -- `DB_DISABLE_CAST_RATE_LIMIT=1` plus the
     * `pm2 restart dungeon-mp --update-env` a deploy runs anyway.
     */
    static isDisabled(): boolean {
        if (String(process.env.DB_DISABLE_CAST_RATE_LIMIT ?? '').trim() === '1') {
            return true;
        }
        return CastRateAuthority.loadTimings().size === 0;
    }

    /**
     * Charge one cast. False means it arrived faster than the game allows and must not be
     * relayed.
     */
    static chargeCast(
        client: { castRate: CastRateState; userId?: number | null; character?: { name?: string } | null; currentLevel?: string },
        powerId: number,
        nowMs: number = CastRateAuthority.nowMs()
    ): boolean {
        if (CastRateAuthority.isDisabled()) {
            return true;
        }

        const state = client.castRate ?? CastRateAuthority.createState();
        client.castRate = state;

        const id = Math.round(Number(powerId) || 0);
        const now = Math.max(0, Math.round(Number(nowMs) || 0));
        const timing = CastRateAuthority.loadTimings().get(id) ?? { castMs: 0, cooldownMs: 0 };

        const elapsedMs = state.creditUpdatedAtMs > 0 ? Math.max(0, now - state.creditUpdatedAtMs) : 0;
        state.creditMs = Math.min(CastRateAuthority.MAX_CREDIT_MS, state.creditMs + elapsedMs);
        state.creditUpdatedAtMs = now;

        const cost = Math.max(
            CastRateAuthority.MIN_CAST_COST_MS,
            Math.round(timing.castMs * CastRateAuthority.TOLERANCE)
        );
        const cooldownReadyAt = Number(state.cooldownReadyAtMs.get(id) ?? 0);

        if (state.creditMs < cost) {
            return CastRateAuthority.refuse(client, state, id, now, `animation cost=${cost}ms credit=${Math.round(state.creditMs)}ms`);
        }
        if (cooldownReadyAt > now) {
            return CastRateAuthority.refuse(client, state, id, now, `cooldown ${cooldownReadyAt - now}ms early`);
        }

        state.creditMs -= cost;
        if (timing.cooldownMs > 0) {
            state.cooldownReadyAtMs.set(id, now + Math.round(timing.cooldownMs * CastRateAuthority.TOLERANCE));
        }
        CastRateAuthority.noteSentinelFormTransition(state, id, now);
        state.violations = Math.max(0, state.violations - 1);
        return true;
    }

    /**
     * Leaving Sentinel Form replaces the cast-time stamp with a usage-proportional cooldown.
     *
     * Every rank is stamped, not just the one that was cast: var_114 is keyed per power id and
     * SentinelForm1..10 are ten separate powers, but the server has no cheap way to know which
     * rank this character owns. A player only ever holds one of them, so stamping all ten costs
     * nothing and cannot be dodged by a client that lies about its rank.
     *
     * The exit cooldown is charged by energy spent in the form, not by the time that passed: the
     * form has no Duration and only drains the mana bar when a swing actually lands, so wall-clock
     * time over-charges a Sentinel who spends most of the form idle. Each swing's authored ManaCost
     * is added to the running total while the form is up; on exit the total is converted at
     * SENTINEL_FORM_ENERGY_TO_MS. A brief use therefore waits the ten-second floor client-side
     * (five seconds in this deliberately tolerant authority); a longer use waits its energy share
     * of the 30-second budget. An exit without a matching observed entry -- the client skipped the
     * re-stamp entirely -- receives the full lockout.
     */
    private static noteSentinelFormTransition(state: CastRateState, powerId: number, nowMs: number): void {
        if (CastRateAuthority.sentinelFormPowerIds.has(powerId)) {
            state.sentinelFormEnteredAtMs = nowMs;
            state.sentinelFormEnergyUsed = 0;
            return;
        }
        if (CastRateAuthority.sentinelFormAttackPowerIds.has(powerId) && state.sentinelFormEnteredAtMs > 0) {
            const timing = CastRateAuthority.loadTimings().get(powerId);
            if (timing && timing.manaCost > 0) {
                state.sentinelFormEnergyUsed = (state.sentinelFormEnergyUsed ?? 0) + timing.manaCost;
            }
            return;
        }
        if (!CastRateAuthority.endSentinelFormPowerIds.has(powerId)) {
            return;
        }

        const energyUsed = state.sentinelFormEnergyUsed ?? 0;
        const usedMs = state.sentinelFormEnteredAtMs > 0
            ? Math.max(
                CastRateAuthority.SENTINEL_FORM_EXIT_FLOOR_MS,
                Math.min(
                    CastRateAuthority.SENTINEL_FORM_EXIT_LOCKOUT_MS,
                    Math.round(energyUsed * CastRateAuthority.SENTINEL_FORM_ENERGY_TO_MS)
                )
            )
            : CastRateAuthority.SENTINEL_FORM_EXIT_LOCKOUT_MS;
        state.sentinelFormEnteredAtMs = 0;
        state.sentinelFormEnergyUsed = 0;

        // Same tolerance as every other cooldown here: this is a cheat check, not a second copy
        // of the simulation, and an honest client on a stalled connection must not be refused.
        const readyAt = nowMs + Math.round(
            usedMs * CastRateAuthority.TOLERANCE
        );
        for (const formPowerId of CastRateAuthority.sentinelFormPowerIds) {
            state.cooldownReadyAtMs.set(formPowerId, readyAt);
        }
    }

    private static refuse(
        client: { userId?: number | null; character?: { name?: string } | null; currentLevel?: string },
        state: CastRateState,
        powerId: number,
        nowMs: number,
        detail: string
    ): boolean {
        state.violations += 1;
        state.blockedHitPowersUntilMs.set(powerId, nowMs + CastRateAuthority.HIT_BLOCK_MS);
        console.warn(
            `[CastRateAuthority] refused cast userId=${client.userId ?? 0} ` +
            `character=${String(client.character?.name ?? 'unknown').replace(/\s+/g, '_')} ` +
            `level=${client.currentLevel || '(unknown)'} power=${powerId} ${detail} ` +
            `violations=${state.violations}`
        );
        return false;
    }

    /** True while hits for this power belong to a cast we already refused. */
    static isHitBlocked(
        client: { castRate: CastRateState },
        powerId: number,
        nowMs: number = CastRateAuthority.nowMs()
    ): boolean {
        const blocked = client.castRate?.blockedHitPowersUntilMs;
        if (!blocked || blocked.size === 0) {
            return false;
        }

        const id = Math.round(Number(powerId) || 0);
        const until = Number(blocked.get(id) ?? 0);
        if (until <= 0) {
            return false;
        }
        if (nowMs >= until) {
            blocked.delete(id);
            return false;
        }

        return true;
    }
}
