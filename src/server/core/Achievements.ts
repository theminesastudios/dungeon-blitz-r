import { Client } from './Client';
import { RewardHandler } from '../handlers/RewardHandler';

/**
 * Archivist Neo's ledger. Achievements live entirely on the server: progress is
 * counted from events the server already sees, and the whole UI is Neo's speech
 * bubble, so nothing has to be added to the client's data archives.
 */

type Progress = { count: number; claimed: boolean };

export type AchievementDef = {
    id: string;
    goal: number;
    goldReward: number;
    /** offer -> what to do, progress -> {n} of {goal}, claim -> paid out, done -> already collected. */
    lines: { offer: string; progress: string; claim: string; done: string };
};

// The boat's deck sits around y 600 and its rigging tops out near y 0, so a
// player above this is up the mast rather than merely jumping on a crate.
// ponytail: one tuned constant, measured off a_Room_TutorialBoat's placements.
const BOAT_TOP_Y = 120;

export const ACHIEVEMENTS: readonly AchievementDef[] = [
    {
        id: 'kingoftheworld',
        goal: 1,
        goldReward: 5000,
        lines: {
            offer: 'The ship that carried you here still floats.%Climb its rigging, stand on the very top, and shout something worth writing down.%The archive pays for vanity. It always has.',
            progress: 'Still on the deck, I see. The top, archivist. The very top.',
            claim: 'They saw you up there, arms out, king of nothing at all.%Beautiful. Here is your gold -- the page is written.',
            done: 'Your climb is already in the ledger. One crown per lifetime.'
        }
    },
    {
        id: 'goblinslayer',
        goal: 250,
        goldReward: 25000,
        lines: {
            offer: 'Bring me two hundred and fifty goblin heads and I will pay you a price you will not hear anywhere else.%Do not carry them. I count them from here -- the ledger writes itself, and it never miscounts.',
            progress: 'The ledger says {n} of {goal} heads. Keep swinging, butcher.',
            claim: '{goal} heads. I counted twice, out of respect.%Take the gold. Do not tell me what you did with the rest of them.',
            done: 'That page is closed and paid. Bring me something new to count.'
        }
    }
];

/** Walk-up greeting state, kept off the Client type since it is pure runtime noise. */
const greeted = new WeakMap<Client, { at: number; inRange: boolean }>();
const GREET_RADIUS = 140;
const GREET_RELEASE_RADIUS = 260;
const GREET_COOLDOWN_MS = 15000;

export class Achievements {
    /**
     * True once per approach: the Home level plays NPC chat client-side and never
     * asks the server, so proximity is the only interaction signal that reaches us.
     */
    static shouldGreet(client: Client, distance: number, now: number = Date.now()): boolean {
        const state = greeted.get(client) ?? { at: 0, inRange: false };
        greeted.set(client, state);

        if (distance > GREET_RELEASE_RADIUS) {
            state.inRange = false;
            return false;
        }
        if (distance > GREET_RADIUS || state.inRange || (state.at > 0 && now - state.at < GREET_COOLDOWN_MS)) {
            return false;
        }
        state.inRange = true;
        state.at = now;
        return true;
    }

    private static getLedger(character: any): Record<string, Progress> {
        if (!character.achievements || typeof character.achievements !== 'object') {
            character.achievements = {};
        }
        return character.achievements;
    }

    private static getProgress(character: any, id: string): Progress {
        const ledger = Achievements.getLedger(character);
        const entry = ledger[id];
        if (!entry || typeof entry !== 'object') {
            ledger[id] = { count: 0, claimed: false };
        } else {
            entry.count = Math.max(0, Math.round(Number(entry.count) || 0));
            entry.claimed = Boolean(entry.claimed);
        }
        return ledger[id];
    }

    /** Adds to an achievement's counter. Returns true when the character changed. */
    static advance(character: any, id: string, amount: number = 1): boolean {
        const def = ACHIEVEMENTS.find((entry) => entry.id === id);
        if (!character || !def || amount <= 0) {
            return false;
        }

        const progress = Achievements.getProgress(character, id);
        if (progress.count >= def.goal) {
            return false;
        }
        progress.count = Math.min(def.goal, progress.count + amount);
        return true;
    }

    /** Every goblin killed anywhere counts, including the tutorial's Intro* variants. */
    static noteEnemyDefeat(character: any, defeatedNames: string[]): boolean {
        const isGoblin = defeatedNames.some((name) => /goblin/i.test(name));
        return isGoblin ? Achievements.advance(character, 'goblinslayer') : false;
    }

    /** The boat climb: only the tutorial boat, only above the rigging line. */
    static notePlayerPosition(character: any, levelName: string, y: number): boolean {
        if (levelName !== 'TutorialBoat' || !Number.isFinite(y) || y > BOAT_TOP_Y) {
            return false;
        }
        return Achievements.advance(character, 'kingoftheworld');
    }

    /**
     * What Neo says when talked to, and the payout when something is due.
     * Rewards are granted here because the bubble is the only place they can be
     * announced -- there is no achievement UI on the client.
     */
    static talk(client: Client): { text: string; didMutate: boolean } {
        const character: any = client.character;
        const lines: string[] = [];
        let didMutate = false;

        for (const def of ACHIEVEMENTS) {
            const progress = Achievements.getProgress(character, def.id);
            const text = def.lines;

            if (progress.claimed) {
                continue;
            }
            if (progress.count >= def.goal) {
                progress.claimed = true;
                didMutate = true;
                character.gold = Math.max(0, Math.round(Number(character.gold) || 0)) + def.goldReward;
                RewardHandler.sendGoldReward(client, def.goldReward, false);
                lines.push(Achievements.fill(text.claim, progress.count, def.goal));
                continue;
            }
            lines.push(Achievements.fill(progress.count > 0 ? text.progress : text.offer, progress.count, def.goal));
        }

        if (!lines.length) {
            // Everything paid out: fall back to the last achievement's closing line.
            const last = ACHIEVEMENTS[ACHIEVEMENTS.length - 1];
            lines.push(last.lines.done);
        }

        return { text: lines.join('%'), didMutate };
    }

    private static fill(text: string, count: number, goal: number): string {
        return text.replace(/\{n\}/g, String(count)).replace(/\{goal\}/g, String(goal));
    }
}
