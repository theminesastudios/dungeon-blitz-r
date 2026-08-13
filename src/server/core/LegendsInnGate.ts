import { Client } from './Client';
import { EntityProps, EntityState, EntityTeam } from './Entity';

/**
 * Titus, and the warning the Legends' Inn portal is gated behind.
 *
 * The dungeon is nine stages of Dread Rogues that end on what Nephit left of
 * Telahair, and until now there was nothing between a player and the first step
 * but a portal hanging on a tree. Titus stands on the stone path under it. The
 * first time a character reaches for the portal he stops them, tells them what is
 * waiting, and stands aside; every visit after that the portal simply works.
 *
 * ## Where he stands
 *
 * On the arrival point the dungeon already uses. `door_spawn_map.json` lands a
 * player coming back out of Legends' Inn at Craft Town (-240, 1360), which is a
 * *measured* floor point on that path rather than a guess - it is where the game
 * itself puts a body. Titus stands a short step to the right of it so he is beside
 * the portal without standing on the spot returning players land on, and faces
 * left, towards it.
 *
 * ## Why he is built the way he is
 *
 *   - **`entState: SLEEP`, like every other authored NPC in the keep.** A
 *     server-spawned entity gets no floor snap and an ACTIVE one runs physics; the
 *     exit portal fell out of the world learning that. Sleep is also what keeps him
 *     interactable - `Entity.method_156` refuses an interact target in DRAMA, but
 *     not in sleep.
 *   - **A non-empty `characterName`.** `Game`'s interact path checks the entity's
 *     cue name before it will send `PKTTYPE_TALK_TO_NPC` at all, so an NPC with no
 *     cue cannot be clicked. He borrows `Special_XPBonus`, the keep cue Archivist
 *     Neo already answers to and which is therefore known to work in this level.
 *     Sharing it costs nothing: his dialogue is dispatched on his *entity id*
 *     (see `NpcHandler.handleTalkToNpc`), never on the cue name.
 */

/**
 * Titus's entity id.
 *
 * Authored level ids in this project top out around 14.4M; the keep statues took
 * 26M and the stage portals 27M, so this block collides with nothing.
 */
export const LEGENDS_INN_TITUS_ENTITY_ID = 28_000_001;

/** The EntType minted by patch_swz_legends_inn_titus.ts. */
export const LEGENDS_INN_TITUS_ENT = 'NPCLegendsInnTitus';

/** The level he stands in, and the door he is standing next to. */
export const LEGENDS_INN_TITUS_LEVEL = 'CraftTown';

/**
 * Where he stands, in `a_Level_Home` world pixels.
 *
 * Derived from `door_spawn_map.json`'s Craft Town door-101 arrival (-240, 1360) -
 * the floor of the stone path under the portal - stepped 180px to the right so he
 * is not standing on the point returning players land on.
 */
const TITUS_POSITION = { x: -60, y: 1360 };

/**
 * The keep cue he is clickable through. See the file comment: the client refuses
 * to open an interact on an entity with no cue name.
 */
const TITUS_CUE_NAME = 'Special_XPBonus';

/** Where the briefing is remembered on the character. */
const BRIEFED_FIELD = 'legendsInnBriefed';

/**
 * What Titus says when he stops someone at the portal.
 *
 * Delivered once, on the first reach for the door, and the door is refused while
 * he says it - which is the point: the player is told what Legends' Inn is before
 * they can be inside it.
 */
export const LEGENDS_INN_TITUS_WARNING =
    'Hold. If you feel ready to do this, then I wish you good luck - because Telahair is somewhere in there.';

/**
 * What he says when he is spoken to.
 *
 * Telahair's story, told by someone who was on the wrong end of it: he fought for
 * this country until the wounds outlasted the war, took Nephit's bargain to keep
 * the guardians off his people's border, and Nephit took the rest of him. His
 * guardians never left either - they spread out through the nine holds behind that
 * portal.
 */
const TITUS_LINES: string[] = [
    'Nine holds behind that portal, and Telahair at the end of the last one.',
    'He was our first man into every battle. Twenty winters of it.',
    'The wounds outlasted the war. That is what Nephit was waiting for.',
    'The bargain was that his guardians would never cross our border. Nephit kept it. He simply moved them in here instead.',
    'There was a spell under the ink. Telahair never read that far.',
    'He does not know our faces any more. Do not waste breath on your name.',
    'Better fighters than you have gone through there. I stopped counting.',
    'If you mean to end it, end it. Do not go in to look.',
    'What comes back out of that portal is never quite what went in.',
    'I would go with you. These legs will not carry me that far any more.'
];

function normalizeName(value: unknown): string {
    return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export class LegendsInnGate {
    /** True for the entity id Titus occupies. */
    static isTitus(entityId: unknown): boolean {
        return Math.round(Number(entityId ?? 0)) === LEGENDS_INN_TITUS_ENTITY_ID;
    }

    /** Whether this character has already been stopped once. */
    static isBriefed(character: unknown): boolean {
        return Boolean((character as Record<string, unknown> | null)?.[BRIEFED_FIELD]);
    }

    /**
     * Records the briefing. Returns true the first time, which is the call that
     * both refuses the door and makes Titus speak.
     */
    static markBriefed(character: unknown): boolean {
        const record = character as Record<string, unknown> | null;
        if (!record || record[BRIEFED_FIELD]) {
            return false;
        }
        record[BRIEFED_FIELD] = true;
        return true;
    }

    /**
     * Whether a door leading into Legends' Inn should be refused for now.
     *
     * Only the way *in* is gated, and only from outside the dungeon - the stage
     * portals inside it have their own rule, and a player who is already in there
     * has plainly had the conversation.
     */
    static shouldStopAtPortal(client: Client, targetLevel: string | null | undefined): boolean {
        // Imported lazily: LegendsInn is loaded by the LevelConfig-time bootstrap.
        const { LegendsInn } = require('./LegendsInn') as typeof import('./LegendsInn');
        return (
            Boolean(targetLevel) &&
            LegendsInn.isStageLevel(targetLevel) &&
            !LegendsInn.isStageLevel(client?.currentLevel) &&
            !LegendsInnGate.isBriefed(client?.character)
        );
    }

    /** One of his lines, chosen at random the way every other NPC's is. */
    static getLine(): string {
        return TITUS_LINES[Math.floor(Math.random() * TITUS_LINES.length)];
    }

    /**
     * Titus as an entity.
     *
     * Modelled on the keep's own authored NPCs rather than invented: team NPC,
     * asleep, targetable so he can be clicked, and carrying a cue name so the
     * client will offer the interact at all.
     */
    static buildEntity(): EntityProps & Record<string, unknown> {
        return {
            id: LEGENDS_INN_TITUS_ENTITY_ID,
            name: LEGENDS_INN_TITUS_ENT,
            isPlayer: false,
            x: TITUS_POSITION.x,
            y: TITUS_POSITION.y,
            spawnX: TITUS_POSITION.x,
            spawnY: TITUS_POSITION.y,
            spawnEntState: EntityState.SLEEP,
            v: 0,
            team: EntityTeam.NPC,
            renderDepthOffset: 0,
            characterName: TITUS_CUE_NAME,
            dramaAnim: '',
            sleepAnim: '',
            summonerId: 0,
            powerId: 0,
            entState: EntityState.SLEEP,
            // Facing the portal, which hangs on the tree to his left.
            facingLeft: true,
            running: false,
            jumping: false,
            dropping: false,
            backpedal: false,
            untargetable: false,
            healthDelta: 0,
            buffs: [],
            roomId: -1,
            // Server-owned: neither a client spawn nor a session's own entity, so the
            // ownership sweeps that follow players between scopes leave him be.
            clientSpawned: false,
            legendsInnTitus: true
        };
    }

    /** True if an entity record is Titus, however it was reached. */
    static isTitusEntity(entity: unknown): boolean {
        const record = entity as Record<string, unknown> | null;
        return (
            Boolean(record?.legendsInnTitus) ||
            normalizeName(record?.name) === normalizeName(LEGENDS_INN_TITUS_ENT)
        );
    }
}
