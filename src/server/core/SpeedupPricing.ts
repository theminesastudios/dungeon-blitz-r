import { Client } from './Client';

/**
 * What a Speed Up costs, priced from the server's clock instead of the client's.
 *
 * Every Speed Up button in the game -- forge, building, ability tome, class tower, pet
 * training, egg hatchery -- runs its remaining time through the same client function
 * (Game.method_257):
 *
 *     remaining = endTime - mServerGameTime
 *     cost      = remaining <= 180 ? 0 : ceil(remaining / 1200)
 *
 * and sends that number to us. mServerGameTime is seeded once per world enter and then
 * free-runs off getTimer() (Game.method_1938), so a client whose Flash timer is running
 * fast -- a Cheat Engine speedhack is the usual way, and it accelerates every countdown on
 * screen along with the animations -- reaches "Free" in a fraction of the real time and
 * asks to be billed accordingly. A handler that spends the number in the packet hands over
 * a 24-hour forge for an idol, and no memory editing is needed beyond the value already on
 * screen.
 */
export class SpeedupPricing {
    static readonly SECONDS_PER_IDOL = 1200;
    static readonly FREE_THRESHOLD_SECONDS = 180;
    /**
     * The two clocks also drift apart honestly over a long session, and the client turns
     * the button Free before we would. Dropping those requests is issue #645: no packet
     * back, and the button stays dead until relog. 300s of skipped time is a quarter of
     * what one idol buys, so the whole window is worth less than a single idol.
     */
    static readonly CLOCK_GRACE_SECONDS = 120;

    static nowSeconds(): number {
        return Math.floor(Date.now() / 1000);
    }

    /** Our own price. 0 means free -- inside the window, or already finished. */
    static costFor(readyTime: unknown, now: number = SpeedupPricing.nowSeconds()): number {
        const ready = Math.max(0, Math.round(Number(readyTime) || 0));
        if (ready <= 0) {
            return 0;
        }

        const remainingSeconds = ready - now;
        if (remainingSeconds <= SpeedupPricing.FREE_THRESHOLD_SECONDS + SpeedupPricing.CLOCK_GRACE_SECONDS) {
            return 0;
        }

        return Math.ceil(remainingSeconds / SpeedupPricing.SECONDS_PER_IDOL);
    }

    /**
     * The price to bill: the one the player was shown when we can agree it is honest, ours
     * when we cannot. One idol of tolerance covers the drift -- a speedhacked countdown is
     * nowhere near that close -- so a lie costs the cheater's target at most one idol.
     */
    static reconcile(
        readyTime: unknown,
        declaredCost: unknown,
        now: number = SpeedupPricing.nowSeconds()
    ): number {
        const authoritativeCost = SpeedupPricing.costFor(readyTime, now);
        const declared = Math.max(0, Math.round(Number(declaredCost) || 0));
        if (authoritativeCost <= 0 || declared <= 0) {
            return authoritativeCost;
        }

        return Math.abs(authoritativeCost - declared) <= 1 ? declared : authoritativeCost;
    }

    /**
     * Un-stick a screen after a request we could not honour.
     *
     * Every one of these screens disables its Speed Up button the instant it is clicked and
     * re-enables it in exactly one place -- OnRefreshScreen -- so a request we drop leaves
     * the button dead for the rest of the session. 0xE3 carries no payload and refreshes
     * all five building screens at once (LinkUpdater.method_1499).
     */
    static refreshScreens(client: Client): void {
        client.send(0xE3, Buffer.alloc(0));
    }
}
