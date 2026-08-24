import type { Client } from './Client';

/**
 * A per-player damage meter, broken down by what was being hit.
 *
 * The server is the only side that can answer "how much am I actually doing", because it is
 * the side that owns the final number: the client computes a hit, sends it, and the server
 * then rewrites it with the class passives and any admin scaling before applying it. A meter
 * built from the client's own floaters would report the number before those rewrites -- which
 * is exactly the mismatch that made the Soulthief passive look broken in the first place.
 *
 * Hits are kept in a rolling window rather than summed forever, so the readout answers "how am
 * I doing right now" instead of drifting toward a session average that nothing can move.
 */

const WINDOW_MS = 60_000;

/** A hard cap so a long fight cannot grow the buffer without bound between prunes. */
const MAX_SAMPLES_PER_PLAYER = 4_000;

interface DamageSample {
    atMs: number;
    /** EntType name for a hostile, or the empty string when it could not be resolved. */
    target: string;
    /** The damage the server actually applied, passives included. */
    total: number;
    /** How much of `total` came from the Soulthief passive. */
    bonus: number;
}

interface TargetBreakdown {
    target: string;
    total: number;
    bonus: number;
    hits: number;
}

export interface DamageReport {
    windowMs: number;
    elapsedMs: number;
    total: number;
    bonus: number;
    hits: number;
    perSecond: number;
    perMinute: number;
    byTarget: TargetBreakdown[];
}

export class DamageMeter {
    private static readonly samplesByToken = new Map<number, DamageSample[]>();

    static note(
        session: Client | null | undefined,
        targetName: string,
        total: number,
        bonus: number = 0
    ): void {
        const token = Math.max(0, Math.round(Number(session?.token ?? 0)));
        const damage = Math.max(0, Math.round(Number(total) || 0));
        if (token <= 0 || damage <= 0) {
            return;
        }

        const samples = DamageMeter.samplesByToken.get(token) ?? [];
        samples.push({
            atMs: Date.now(),
            target: String(targetName ?? '').trim(),
            total: damage,
            bonus: Math.max(0, Math.min(damage, Math.round(Number(bonus) || 0)))
        });
        DamageMeter.prune(samples);
        DamageMeter.samplesByToken.set(token, samples);
    }

    static report(session: Client | null | undefined, windowMs: number = WINDOW_MS): DamageReport {
        const token = Math.max(0, Math.round(Number(session?.token ?? 0)));
        const samples = DamageMeter.samplesByToken.get(token) ?? [];
        DamageMeter.prune(samples, windowMs);

        const now = Date.now();
        const empty: DamageReport = {
            windowMs,
            elapsedMs: 0,
            total: 0,
            bonus: 0,
            hits: 0,
            perSecond: 0,
            perMinute: 0,
            byTarget: []
        };
        if (samples.length === 0) {
            return empty;
        }

        // Measure against the fight, not the window. A player who has been swinging for four
        // seconds has done four seconds of damage; dividing by a fixed sixty would report a
        // fifteenth of their real rate and read as a bug.
        const elapsedMs = Math.max(1, now - samples[0].atMs);
        const byTarget = new Map<string, TargetBreakdown>();
        let total = 0;
        let bonus = 0;
        for (const sample of samples) {
            total += sample.total;
            bonus += sample.bonus;
            const key = sample.target || 'Bilinmeyen';
            const entry = byTarget.get(key) ?? { target: key, total: 0, bonus: 0, hits: 0 };
            entry.total += sample.total;
            entry.bonus += sample.bonus;
            entry.hits += 1;
            byTarget.set(key, entry);
        }

        const seconds = elapsedMs / 1000;
        return {
            windowMs,
            elapsedMs,
            total,
            bonus,
            hits: samples.length,
            perSecond: Math.round(total / seconds),
            perMinute: Math.round((total / seconds) * 60),
            byTarget: [...byTarget.values()].sort((a, b) => b.total - a.total)
        };
    }

    static reset(session: Client | null | undefined): void {
        const token = Math.max(0, Math.round(Number(session?.token ?? 0)));
        if (token > 0) {
            DamageMeter.samplesByToken.delete(token);
        }
    }

    static forget(token: number): void {
        DamageMeter.samplesByToken.delete(Math.max(0, Math.round(Number(token) || 0)));
    }

    private static prune(samples: DamageSample[], windowMs: number = WINDOW_MS): void {
        const cutoff = Date.now() - windowMs;
        let drop = 0;
        while (drop < samples.length && samples[drop].atMs < cutoff) {
            drop += 1;
        }
        if (drop > 0) {
            samples.splice(0, drop);
        }
        if (samples.length > MAX_SAMPLES_PER_PLAYER) {
            samples.splice(0, samples.length - MAX_SAMPLES_PER_PLAYER);
        }
    }
}
