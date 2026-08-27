import { EntityProps, EntityState, EntityTeam } from './Entity';
import { LevelConfig } from './LevelConfig';

/**
 * Hallow's Eve: the Green Knight's Challenge, put back where it used to stand.
 *
 * ## What was already in the files
 *
 * The event's dungeon ships whole and always has. `LevelsLD.swf` carries
 * `a_Level_LDArena1`: two rooms of catacomb, `am_Boss` bound to `ac_GreenKnight`,
 * three `ac_GreenKnightFalse` decoys, four `ac_TauntingSkull` switches, an
 * `ac_BoneFiend`, tower arms, three camera targets and an `a_Scene_BossRoom`
 * cutscene. `Gfx_Paladin_1.swf` carries the Green Knight's whole paperdoll down to
 * `a_Hat_HatGhostGreenKnight`. The EntTypes are there and say `Holiday Dungeon` in
 * their `DevStatus`. `level_config.json` already lists it at
 * `LevelsLD.swf/a_Level_LDArena1 50 50 true`, which is the "Dungeon Level: 50" the
 * screen shows, and Game.swz already names it **The Green Knight** on catacomb
 * music with `ZoneSet SwampRoadNorth` - this square, not another region.
 *
 * Exactly two things were missing: a DoorType and a door_map row. It had no way
 * in. Everything this file does is stand two figures beside the one that was added
 * and run the reward loop the dungeon was built around.
 *
 * ## The loop
 *
 * From the shipped prompt screen: *"Defeat the Green Knight to earn a key to open
 * a prize-filled coffer. The Green Knight can be defeated once every 12 hours."*
 * So the Knight pays a key, not loot - his EntType is `RewardClass HealthOnly`
 * with `ExpMult 0`, which is the game itself saying he drops nothing - and the
 * coffers in the square is what turns keys into prizes.
 *
 * ## Why the two figures are built in code
 *
 * Neither is level furniture. The door they flank is one this project added, their
 * dialogue is dispatched on their entity ids, and the gate the Watcher enforces
 * lives here beside them - the same reasoning that keeps Titus out of
 * `npcs/CraftTown.json`.
 *
 *   - **`entState: SLEEP`, like every other authored NPC.** A server-spawned
 *     entity gets no floor snap and an ACTIVE one runs physics; the Legends' Inn
 *     exit portal fell out of the world learning that. Sleep is also what keeps
 *     them interactable - `Entity.method_156` refuses an interact target in DRAMA,
 *     but not in sleep.
 *   - **A non-empty `characterName`.** `Game`'s interact path checks the entity's
 *     cue name before it will send `PKTTYPE_TALK_TO_NPC` at all. They borrow two
 *     cues `a_Room_SRN04` already defines and which carry no `sayOnInteract` of
 *     their own. Dialogue is dispatched on the *entity id*, never on the cue name.
 *   - **Standing on a measured floor line.** y=580 is `am_CollisionObject`'s cyan
 *     path through the left half of the room; the statues that used to stand there
 *     were stored at 579 and the room's own NPCIeld at 584.
 */

/**
 * Entity ids.
 *
 * Authored level ids in this project top out around 14.4M; the keep statues took
 * 26M, the Legends' Inn stage portals 27M and Titus 28M, so this block collides
 * with nothing.
 */
export const HALLOWS_EVE_WATCHER_ENTITY_ID = 29_000_001;
export const HALLOWS_EVE_COFFERS_ENTITY_ID = 29_000_002;

/** The EntTypes. Both shipped; `patch_swz_hallows_eve_ents.ts` only re-dresses them. */
export const HALLOWS_EVE_WATCHER_ENT = 'NPCHalloweenWatcher';
export const HALLOWS_EVE_COFFERS_ENT = 'HalloweenCoffers';

/**
 * The dungeon behind the portal, and the door that leads to it.
 *
 * `LDArena1` is the shipped Green Knight arena, not a level this project built.
 */
export const HALLOWS_EVE_LEVEL = 'LDArena1';
export const HALLOWS_EVE_DOOR_ID = 108;

/** The boss whose death pays the key. */
export const HALLOWS_EVE_BOSS_ENT = 'GreenKnight';

/** The towns the square is in. Both are drawn from the same `a_Room_SRN04`. */
export const HALLOWS_EVE_TOWNS = ['SwampRoadNorth', 'SwampRoadNorthHard'];

/**
 * Where the coffers stands, in `a_Level_SwampRoadNorth` world pixels.
 *
 * Room-local 770 - the middle of the skull-grid wall, the square's second ruin,
 * which spans 600..942. **The ruin is the reward point**: the player walks up to
 * the stonework and opens it, rather than to a chest standing in front of it.
 *
 * That is very nearly where it started (3260), which is worth knowing - the ruin
 * was always the right spot and the chest art was the thing that was wrong.
 *
 * The Hollow Watcher used to stand at 2760, in front of the tower. He is gone: the
 * arch is set into that tower now, and a figure planted on the ruins was the one
 * thing in the square that answered a click on the stone with a speech bubble.
 * `buildWatcherEntity` and his lines are kept because the square may want a herald
 * again somewhere that is not on the artwork; nothing spawns him today.
 */
const COFFERS_POSITION = { x: 3210, y: 580 };

/**
 * The cues they are clickable through. See the file comment: the client refuses to
 * open an interact on an entity with no cue name, and both of these are cues
 * `a_Room_SRN04` already carries with an empty `sayOnInteract`.
 */
const WATCHER_CUE_NAME = 'SRN_Mayor01';
const COFFERS_CUE_NAME = 'Ield';

/** Where the briefing is remembered on the character. */
const BRIEFED_FIELD = 'hallowsEveBriefed';

/** How many coffer keys the character is holding. */
const KEYS_FIELD = 'hallowsEveKeys';

/** Unix seconds of the last Green Knight kill that paid a key. */
const LAST_KILL_FIELD = 'hallowsEveLastKnightAt';

/**
 * How long between keys.
 *
 * Twelve hours, because that is the number on the shipped prompt screen: *"The
 * Green Knight can be defeated once every 12 hours."* The dungeon can be walked as
 * often as anyone likes; it is the *key* that is on the clock, which is what the
 * original said too - impatient heroes were offered a paid summon rather than a
 * second free key.
 */
export const HALLOWS_EVE_KEY_COOLDOWN_SECONDS = 12 * 60 * 60;

/**
 * What the Watcher says when he stops someone at the portal.
 *
 * Delivered once, on the first reach for the door, and the door is refused while he
 * says it - which is the point: the player is told what is behind it before they
 * can be inside it.
 */
export const HALLOWS_EVE_WARNING =
    'Wait. The Green Knight is through there, and he is level fifty and in no mood. Beat him and you have earned a key.';

/** What he says when he is spoken to. */
const WATCHER_LINES: string[] = [
    'One night a year the arch opens and the Green Knight takes callers.',
    'He fights fair, more or less. The three standing with him do not fight at all.',
    'Strike the skulls. They are laughing at you for a reason.',
    'Beat him and you have a key. The coffers over there knows what to do with it.',
    'He will take one caller every twelve hours. After that he is only bored of you.',
    'The bone thing at the back is his, not yours. Leave it if you can.',
    'I have watched him lose. Not often, and not to anyone who went in alone.',
    'When the week turns the arch closes, and I go back to watching nothing.',
    'No, I do not know what is in the coffers. I have never had a key.',
    'Go on. He has been waiting a year.'
];

/**
 * The six `*SpecialHalloweenL` materials, all of which display as Candy Corn.
 *
 * There is one per kingdom because the event was built to run in every region at
 * once. Nothing drops them any more, so they are here as the consolation prize the
 * coffers pays once a character owns every hat and pet in it.
 */
export const HALLOWS_EVE_MATERIAL_IDS = [121, 122, 123, 124, 125, 126];

/** Candy corn from the Mythic shelf - the Green Knight's own `Kingdom`. */
export const HALLOWS_EVE_CONSOLATION_MATERIAL_ID = 123;

/** Gold paid alongside the consolation corn, once the coffers has nothing left. */
export const HALLOWS_EVE_CONSOLATION_GOLD = 250_000;

/** The class helms, by `mMasterClass`. GearIDs 1159..1161. */
export const HALLOWS_EVE_HELM_GEAR_IDS: Record<string, number> = {
    paladin: 1159,
    mage: 1160,
    rogue: 1161
};

/** PetIDs 57..60: the Jack-O lanterns, the `HalloweenNormal` set. */
export const HALLOWS_EVE_JACK_O_PET_IDS = [57, 58, 59, 60];

/** PetIDs 61..64: the gargoyles, the `HalloweenHard` set. */
export const HALLOWS_EVE_GARGOYLE_PET_IDS = [61, 62, 63, 64];

/**
 * The two questions the square asks, and how they are asked.
 *
 * `UI_Seasonal.swf` ships the real panels - `a_ScreenHalloweenDungeonPrompt` with
 * its `am_Enter` button, `a_ScreenHalloweenCoffers` with a forty-cell
 * `am_CofferGroup` - and `DungeonBlitz.swf` refers to none of those names, so no
 * code in this client build can open either window. Adding one would mean emitting
 * new AVM2 classes into a 5MB obfuscated ABC, which is not a thing to ship blind.
 *
 * What the client *does* have is a fully server-driven prompt: `a_DialogBox`,
 * opened by packet 0x58 with `(token, context, message)` and answered on 0x59 with
 * `(token, context, yes/no)`. The friend-invite and guild-invite flows already run
 * on it. So both Hallow's Eve questions are asked through that instead: a real
 * window with real Yes/No buttons, and the text of each is the text off the
 * original screens.
 *
 * Tokens are allocated from a block of their own so an answer can never be
 * mistaken for a party invite - SocialHandler's friend prompts take 2,000,000 and
 * guild invites use live entity ids, both well clear of this.
 */
const PROMPT_TOKEN_BASE = 3_000_000;
const PROMPT_TOKEN_SPAN = 1_000_000;

/**
 * The opaque context string the dialog echoes back with the answer.
 *
 * `a_DialogBox` treats it as a passthrough - it is the inviter's name in the party
 * flow - so it costs nothing and makes a stray answer obvious in a packet log.
 */
export const HALLOWS_EVE_PROMPT_CONTEXT = 'HallowsEve';

/** How long an unanswered prompt stays claimable before it is swept. */
const PROMPT_TTL_MS = 5 * 60 * 1000;

/** How long a Yes on the challenge keeps the arch open for that character. */
const ENTRY_GRANT_TTL_MS = 60 * 1000;

export type HallowsEvePromptKind = 'challenge' | 'coffers';

interface PendingPrompt {
    kind: HallowsEvePromptKind;
    /** Character the prompt was raised for, so another character cannot answer it. */
    characterName: string;
    /** The level the player was standing in, for the challenge prompt's door answer. */
    fromLevel: string;
    expiresAt: number;
}

export type HallowsEvePrize =
    | { kind: 'gear'; gearId: number; label: string }
    | { kind: 'pet'; petTypeId: number; label: string }
    | { kind: 'consolation'; materialId: number; gold: number; label: string };

function normalizeName(value: unknown): string {
    return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function buildProp(
    id: number,
    name: string,
    cueName: string,
    position: { x: number; y: number },
    facingLeft: boolean
): EntityProps & Record<string, unknown> {
    return {
        id,
        name,
        isPlayer: false,
        x: position.x,
        y: position.y,
        spawnX: position.x,
        spawnY: position.y,
        spawnEntState: EntityState.SLEEP,
        v: 0,
        team: EntityTeam.NPC,
        renderDepthOffset: 0,
        characterName: cueName,
        dramaAnim: '',
        sleepAnim: '',
        summonerId: 0,
        powerId: 0,
        entState: EntityState.SLEEP,
        facingLeft,
        running: false,
        jumping: false,
        dropping: false,
        backpedal: false,
        untargetable: false,
        healthDelta: 0,
        buffs: [],
        roomId: -1,
        // Server-owned: neither a client spawn nor a session's own entity, so the
        // ownership sweeps that follow players between scopes leave them be.
        clientSpawned: false,
        hallowsEveProp: true
    };
}

/** "3 hours", "45 minutes" - how long until the Green Knight takes another caller. */
export function describeHallowsEveDelay(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    if (hours >= 1) {
        return `${hours} hour${hours === 1 ? '' : 's'}`;
    }
    const minutes = Math.max(1, Math.round(seconds / 60));
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

export class HallowsEve {
    /** Prompts raised and not yet answered, by token. */
    private static pendingPrompts: Map<number, PendingPrompt> = new Map();

    /** Characters who answered Yes and have not walked through yet, by expiry. */
    private static entryGrants: Map<string, number> = new Map();

    /** True for the two entity ids the square occupies. */
    static isWatcher(entityId: unknown): boolean {
        return Math.round(Number(entityId ?? 0)) === HALLOWS_EVE_WATCHER_ENTITY_ID;
    }

    static isCoffers(entityId: unknown): boolean {
        return Math.round(Number(entityId ?? 0)) === HALLOWS_EVE_COFFERS_ENTITY_ID;
    }

    /** Whether this level is one of the two towns the square stands in. */
    static isTown(levelName: string | null | undefined): boolean {
        const normalized = LevelConfig.normalizeLevelName(levelName) || String(levelName ?? '').trim();
        return HALLOWS_EVE_TOWNS.includes(normalized);
    }

    /** Whether this level is the Green Knight's arena. */
    static isDungeon(levelName: string | null | undefined): boolean {
        const normalized = LevelConfig.normalizeLevelName(levelName) || String(levelName ?? '').trim();
        return normalized === HALLOWS_EVE_LEVEL;
    }

    /**
     * Whether a reach for the arch should raise the challenge window instead of
     * opening.
     *
     * Asked every time, the way the original panel was - the prompt is not a
     * one-off briefing, it is where the player is told whether a key is due. A Yes
     * leaves an entry grant behind, and this spends it, so the transfer that
     * follows a Yes goes straight through rather than raising a second window.
     *
     * Only the way in is gated, and only from outside: a player already inside the
     * arena has plainly answered it.
     */
    static shouldStopAtPortal(
        characterName: unknown,
        currentLevel: string | null | undefined,
        targetLevel: string | null | undefined
    ): boolean {
        if (!HallowsEve.isDungeon(targetLevel) || HallowsEve.isDungeon(currentLevel)) {
            return false;
        }
        return !HallowsEve.consumeEntryGrant(characterName);
    }

    /** One of his lines, chosen at random the way every other NPC's is. */
    static getWatcherLine(): string {
        return WATCHER_LINES[Math.floor(Math.random() * WATCHER_LINES.length)];
    }

    /**
     * The Hollow Watcher, for a square that wants one again.
     *
     * Nothing calls this: he stood in front of the tower the arch is now set into,
     * and standing on the ruins made them answer a click with his speech bubble.
     * The caller supplies the position, so bringing him back is a matter of picking
     * a spot that is not on the artwork - room-local 1300 and up is open ground.
     */
    static buildWatcherEntity(
        position: { x: number; y: number } = { x: 3740, y: 580 }
    ): EntityProps & Record<string, unknown> {
        // Facing left, back towards the arch he is keeping watch over.
        return buildProp(
            HALLOWS_EVE_WATCHER_ENTITY_ID,
            HALLOWS_EVE_WATCHER_ENT,
            WATCHER_CUE_NAME,
            position,
            true
        );
    }

    static buildCoffersEntity(): EntityProps & Record<string, unknown> {
        // Facing left, back towards the arch the keys come out of.
        return buildProp(
            HALLOWS_EVE_COFFERS_ENTITY_ID,
            HALLOWS_EVE_COFFERS_ENT,
            COFFERS_CUE_NAME,
            COFFERS_POSITION,
            true
        );
    }

    /** True if an entity record is one of the square's props, however it was reached. */
    static isProp(entity: unknown): boolean {
        const record = entity as Record<string, unknown> | null;
        return (
            Boolean(record?.hallowsEveProp) ||
            normalizeName(record?.name) === normalizeName(HALLOWS_EVE_WATCHER_ENT) ||
            normalizeName(record?.name) === normalizeName(HALLOWS_EVE_COFFERS_ENT)
        );
    }

    // -----------------------------------------------------------------------
    // Prompts
    // -----------------------------------------------------------------------

    private static sweepExpiredPrompts(now = Date.now()): void {
        for (const [token, prompt] of HallowsEve.pendingPrompts.entries()) {
            if (prompt.expiresAt <= now) {
                HallowsEve.pendingPrompts.delete(token);
            }
        }
    }

    /**
     * Registers a prompt and returns the token to raise it under.
     *
     * A character may only have one outstanding prompt of each kind: reaching for
     * the door twice replaces the question rather than stacking two windows whose
     * answers would both be honoured.
     */
    static openPrompt(
        kind: HallowsEvePromptKind,
        characterName: unknown,
        fromLevel: unknown,
        now = Date.now()
    ): number {
        HallowsEve.sweepExpiredPrompts(now);
        const name = String(characterName ?? '');
        for (const [token, prompt] of HallowsEve.pendingPrompts.entries()) {
            if (prompt.kind === kind && prompt.characterName === name) {
                HallowsEve.pendingPrompts.delete(token);
            }
        }

        let token = 0;
        do {
            token = PROMPT_TOKEN_BASE + Math.floor(Math.random() * PROMPT_TOKEN_SPAN);
        } while (HallowsEve.pendingPrompts.has(token));

        HallowsEve.pendingPrompts.set(token, {
            kind,
            characterName: name,
            fromLevel: String(fromLevel ?? ''),
            expiresAt: now + PROMPT_TTL_MS
        });
        return token;
    }

    /**
     * Lets one character through the arch, once, for the next minute.
     *
     * A Yes on the challenge answers the *door*, and answering a door makes the
     * client ask for the transfer that door leads to - which would walk straight
     * back into the gate and raise a second window. So a Yes leaves a grant behind
     * and the transfer spends it. Short-lived on purpose: it covers one level load
     * and nothing else, so it can never become a standing pass.
     */
    static grantEntry(characterName: unknown, now = Date.now()): void {
        HallowsEve.entryGrants.set(String(characterName ?? ''), now + ENTRY_GRANT_TTL_MS);
    }

    /** Spends a grant if there is a live one. */
    static consumeEntryGrant(characterName: unknown, now = Date.now()): boolean {
        const name = String(characterName ?? '');
        const until = HallowsEve.entryGrants.get(name) ?? 0;
        HallowsEve.entryGrants.delete(name);
        return until > now;
    }

    /** Whether a token belongs to this feature at all, before anything is looked up. */
    static ownsPromptToken(token: unknown): boolean {
        const value = Math.round(Number(token ?? 0));
        return value >= PROMPT_TOKEN_BASE && value < PROMPT_TOKEN_BASE + PROMPT_TOKEN_SPAN;
    }

    /**
     * Claims a prompt. Returns null when the token is not ours, has expired, or
     * belongs to a different character - so an answer is always spent exactly once.
     */
    static claimPrompt(token: unknown, characterName: unknown, now = Date.now()): PendingPrompt | null {
        HallowsEve.sweepExpiredPrompts(now);
        const value = Math.round(Number(token ?? 0));
        const prompt = HallowsEve.pendingPrompts.get(value);
        if (!prompt || prompt.characterName !== String(characterName ?? '')) {
            return null;
        }
        HallowsEve.pendingPrompts.delete(value);
        return prompt;
    }

    /**
     * The Green Knight's Challenge, worded off the shipped prompt screen.
     *
     * The original panel had two states - a clock and a locked door while the
     * twelve hours ran, and "The Green Knight has returned!" once they were up -
     * and the difference mattered because it told the player whether the run was
     * worth a key. Both states still enter the dungeon: the original's own text
     * says impatient heroes could go straight back in, and only the reward was ever
     * on the clock.
     */
    static buildChallengeText(character: any): string {
        const wait = HallowsEve.secondsUntilNextKey(character);
        const keys = HallowsEve.getKeys(character);
        const held = keys > 0 ? ` You are holding ${keys} key${keys === 1 ? '' : 's'}.` : '';
        if (wait > 0) {
            return (
                'THE GREEN KNIGHT\'S CHALLENGE\n\n' +
                'Defeat the Green Knight to earn a key to open a prize-filled coffer. ' +
                'The Green Knight can be defeated once every 12 hours.\n\n' +
                `He will grant another key in ${describeHallowsEveDelay(wait)}. ` +
                `Enter anyway?${held}`
            );
        }
        return (
            'THE GREEN KNIGHT\'S CHALLENGE\n\n' +
            'Defeat the Green Knight to earn a key to open a prize-filled coffer. ' +
            'The Green Knight can be defeated once every 12 hours.\n\n' +
            `The Green Knight has returned! Enter the dungeon?${held}`
        );
    }

    /** What the coffers asks. Refuses to ask at all when there is no key to spend. */
    static buildCoffersText(character: any): string | null {
        const keys = HallowsEve.getKeys(character);
        if (keys <= 0) {
            return null;
        }
        const prize = HallowsEve.nextPrize(character);
        return (
            `The coffers is locked, and you are holding ${keys} key${keys === 1 ? '' : 's'}.\n\n` +
            `Spend one to open it? There is ${prize.label} inside.`
        );
    }

    /** What the coffers says when there is nothing to spend. */
    static buildNoKeyLine(character: any): string {
        const wait = HallowsEve.secondsUntilNextKey(character);
        return wait > 0
            ? `Locked, and you have no key. The Green Knight will grant another in ${describeHallowsEveDelay(wait)}.`
            : 'Locked. Beat the Green Knight through that arch and come back with a key.';
    }

    // -----------------------------------------------------------------------
    // Keys
    // -----------------------------------------------------------------------

    static getKeys(character: any): number {
        return Math.max(0, Math.round(Number(character?.[KEYS_FIELD] ?? 0)) || 0);
    }

    /** Seconds until this character can earn another key; 0 when one is due. */
    static secondsUntilNextKey(character: any, nowSeconds = Math.floor(Date.now() / 1000)): number {
        const last = Math.max(0, Math.round(Number(character?.[LAST_KILL_FIELD] ?? 0)) || 0);
        if (last <= 0) {
            return 0;
        }
        return Math.max(0, last + HALLOWS_EVE_KEY_COOLDOWN_SECONDS - nowSeconds);
    }

    /**
     * Pays a key for a Green Knight clear, if one is due.
     *
     * Returns false when the character is still inside the twelve hours, which is
     * not a failure - the run still happened, it simply did not earn a second key.
     * Clearing the arena is never blocked; only the key is on the clock.
     */
    static awardKey(character: any, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
        if (!character || HallowsEve.secondsUntilNextKey(character, nowSeconds) > 0) {
            return false;
        }
        character[KEYS_FIELD] = HallowsEve.getKeys(character) + 1;
        character[LAST_KILL_FIELD] = nowSeconds;
        return true;
    }

    /** Spends one key. Returns false when there is none, and takes nothing. */
    static spendKey(character: any): boolean {
        const held = HallowsEve.getKeys(character);
        if (held <= 0) {
            return false;
        }
        character[KEYS_FIELD] = held - 1;
        return true;
    }

    /** Whether the character already owns a pet of this type. */
    static ownsPet(character: any, petTypeId: number): boolean {
        const pets = Array.isArray(character?.pets) ? character.pets : [];
        return pets.some((pet: any) => Math.round(Number(pet?.typeID ?? pet?.petID ?? 0)) === petTypeId);
    }

    /** Whether the character already has this gear in the bag or on the body. */
    static ownsGear(character: any, gearId: number): boolean {
        const owned = [
            ...(Array.isArray(character?.inventoryGears) ? character.inventoryGears : []),
            ...(Array.isArray(character?.equippedGears) ? character.equippedGears : [])
        ];
        return owned.some((gear: any) => Math.round(Number(gear?.gearID ?? gear?.GearID ?? 0)) === gearId);
    }

    /**
     * What the next key out of the coffers is worth.
     *
     * The shipped coffers screen is a forty-cell prize grid, and no code in this
     * client build opens it, so there is no wheel to spin and no way to show one
     * spinning. What is left is the part that matters: a key is always worth
     * something the character does not already have. The order is the hat the
     * event is remembered for, then the four jack-o-lanterns, then the four
     * gargoyles; a character holding all nine gets corn and gold instead, so a key
     * is never wasted.
     *
     * Nothing is deducted here - the caller spends and grants together, so a grant
     * that cannot be delivered never costs a key.
     */
    static nextPrize(character: any): HallowsEvePrize {
        const masterClass = String(character?.mMasterClass ?? character?.class ?? '').trim().toLowerCase();
        const helmGearId = HALLOWS_EVE_HELM_GEAR_IDS[masterClass] ?? 0;
        if (helmGearId > 0 && !HallowsEve.ownsGear(character, helmGearId)) {
            return { kind: 'gear', gearId: helmGearId, label: 'a pumpkin helm' };
        }

        const shelves: Array<{ ids: number[]; label: string }> = [
            { ids: HALLOWS_EVE_JACK_O_PET_IDS, label: 'a jack-o-lantern' },
            { ids: HALLOWS_EVE_GARGOYLE_PET_IDS, label: 'a gargoyle' }
        ];
        for (const shelf of shelves) {
            // Ordered, not rolled: the four in each set differ only in which find
            // bonus they carry, so handing them out in order means a player who
            // keeps coming back ends up with the set rather than four of one.
            const missing = shelf.ids.find((petTypeId) => !HallowsEve.ownsPet(character, petTypeId));
            if (missing !== undefined) {
                return { kind: 'pet', petTypeId: missing, label: shelf.label };
            }
        }

        return {
            kind: 'consolation',
            materialId: HALLOWS_EVE_CONSOLATION_MATERIAL_ID,
            gold: HALLOWS_EVE_CONSOLATION_GOLD,
            label: 'candy corn and gold'
        };
    }
}
