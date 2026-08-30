import { EntityProps, EntityState, EntityTeam } from './Entity';
import { LevelConfig } from './LevelConfig';
import { BitBuffer } from '../network/protocol/bitBuffer';

/**
 * The little of a session this file needs.
 *
 * Structural rather than the real `Client` so that raising a window stays a core
 * concern: `LevelHandler` and `NpcHandler` both open these prompts, and routing
 * either of them through the other would close an import loop.
 */
interface PromptTarget {
    character?: any;
    currentLevel?: string | null;
    sendBitBuffer(packetId: number, bb: BitBuffer): void;
}

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
export const HALLOWS_EVE_HERALD_ENTITY_ID = 29_000_003;
export const HALLOWS_EVE_CHALLENGE_ENTITY_ID = 29_000_004;

/** The EntTypes. The first two shipped; the Herald is minted alongside them. */
export const HALLOWS_EVE_WATCHER_ENT = 'NPCHalloweenWatcher';
export const HALLOWS_EVE_COFFERS_ENT = 'HalloweenCoffers';
export const HALLOWS_EVE_HERALD_ENT = 'NPCHalloweenHerald';
/** The shipped portal EntType - empty art, used as a click box on the arch. */
export const HALLOWS_EVE_PORTAL_ENT = 'HalloweenPortal';

/**
 * The dungeon behind the portal, and the door that leads to it.
 *
 * `LDArena1` is the shipped Green Knight arena, not a level this project built.
 */
export const HALLOWS_EVE_LEVEL = 'LDArena1';
export const HALLOWS_EVE_DOOR_ID = 108;

/**
 * The coffer's lockbox id, minted by `patch_swz_hallows_eve_coffer.ts`.
 *
 * Its own id rather than the Treasure Trove's, because `class_131.OpenLockbox`
 * decrements the stack of whatever id it is given - a coffer sharing id 1 would
 * eat troves the player had bought. Ids are sent in two bits, so 0..3 is the
 * whole range there will ever be.
 */
export const HALLOWS_EVE_COFFER_LOCKBOX_ID = 2;

/**
 * What "Summon Knight Now" costs, in Mammoth Idols.
 *
 * Twenty, because that is the number drawn on the panel's own price tag
 * (`am_IdolGroup`), which is authored art and cannot be driven from here. Change one
 * and the other is a lie.
 */
export const HALLOWS_EVE_SUMMON_COST_IDOLS = 20;

/** The boss whose death pays the key. */
export const HALLOWS_EVE_BOSS_ENT = 'GreenKnight';

/** The towns the square is in. Both are drawn from the same `a_Room_SRN04`. */
export const HALLOWS_EVE_TOWN_NORMAL = 'SwampRoadNorth';
export const HALLOWS_EVE_TOWN_HARD = 'SwampRoadNorthHard';
export const HALLOWS_EVE_TOWNS = [HALLOWS_EVE_TOWN_NORMAL, HALLOWS_EVE_TOWN_HARD];

/**
 * The coffers - on the skulls, not on the stonework.
 *
 * The first pass hung a 300x160 interact box on the floor against the second
 * ruin, so every click anywhere on the lower wall opened a speech bubble. That
 * was the complaint, and it is still the rule: **plain stone must not talk.**
 *
 * What is wanted instead is the skull grid itself - the panel of carved skulls
 * between the two lanterns, which is what a coffer *is* in this square. So the
 * box is lifted off the floor onto that panel: room-local x 800 is the centre of
 * the grid and room-local -140 is the ruin's base ledge, i.e. world (3240, 520).
 * From there `Height` carries it up over the grid rather than down over the
 * walkable rock.
 *
 * It only stays up there because the EntType is `Flying`: a server-spawned entity
 * gets no floor snap, and without the flag it would drop to the ground - which is
 * how the Legends' Inn portal once fell out of the world.
 */
const COFFERS_POSITION = { x: 3240, y: 520 };

/**
 * Where the Herald stands, in `a_Level_SwampRoadNorth` world pixels.
 *
 * Room-local 552, on the floor line, at the foot of the second ruin - **and the
 * spot is chosen to hide something.**
 *
 * The scene carries a broken iron fence, and one of its posts hangs about 50px
 * below the stonework it belongs to, ending in a point over open grass. It is
 * baked into character 39 along with both ruins, the hill and every other fence
 * in the square, so it cannot be deleted, moved or masked away - a clip window is
 * a rectangle you see *through*, not a hole you can punch. The only way to be rid
 * of it is to put something in front of it.
 *
 * A hooded figure a head and a half taller than the post covers it exactly, and
 * he wants to be near the coffers anyway. So the glitch is the anchor: move him
 * and it comes back.
 */
const HERALD_POSITION = { x: 2992, y: 580 };

/**
 * The cues they are clickable through. See the file comment: the client refuses to
 * open an interact on an entity with no cue name, and both of these are cues
 * `a_Room_SRN04` already carries with an empty `sayOnInteract`.
 */
const WATCHER_CUE_NAME = 'SRN_Mayor01';

/** What the Herald is clickable through - a cue the room already carries. */
const HERALD_CUE_SOURCE = 'Ield';

/**
 * **The client renames every cue in a Hard level, and this is what broke the square.**
 *
 * `Level.method_1130`, which walks a room's cues and builds `level.var_1046` - the
 * name -> cue dictionary a *server-spawned* entity is bound through - does this
 * first:
 *
 *     if (this.alterParamsString == "Hard")
 *         cue.characterName = cue.characterName + "Hard";
 *
 * So in Dread Black Rose Mire the dictionary holds `IeldHard`,
 * `Special_ClassTowerHard`, `SRN_Mayor01Hard`; the unsuffixed names are simply not
 * in it. An entity sent with `Ield` there resolves to `undefined`, `entity.cue`
 * stays null, and `Entity.method_355()` - `team == NEUTRAL && cue && cue.characterName`
 * - refuses it as an interact target. The body is still drawn and still stands
 * there; it just cannot be clicked, and it grows no name plate, because the plate
 * is `cue.displayName`.
 *
 * That is why `data/npcs/SwampRoadNorthHard.json` carries `IeldHard` while the level
 * SWF defines only `Ield` - the suffix is synthesised on the client, not authored.
 * The square's three props were built with the plain names whichever town they
 * stood in, so **in the Dread town none of them, the Herald included, has ever been
 * clickable**, which is exactly what a whole session of testing there kept showing.
 *
 * `Blackrose Mire` (the normal town) is unaffected: `alterParamsString` is empty and
 * the plain names are the right ones.
 */
function cueFor(levelName: string | null | undefined, cueName: string): string {
    const normalized = LevelConfig.normalizeLevelName(levelName) || String(levelName ?? '').trim();
    return normalized === HALLOWS_EVE_TOWN_HARD ? `${cueName}Hard` : cueName;
}

/**
 * **This string is the coffer screen.**
 *
 * `Game.method_668` branches on the clicked entity's `characterName`, and the
 * `Special_TreasureTrove` arm opens `screenLockBox` - the client's real
 * lockbox-opening panel, with its Open button, key counter, sparkle fountain and
 * reward reveal. It is the only path in this build that lets the server open a
 * screen without touching a byte of `DungeonBlitz.swf`.
 *
 * So the coffers is not "an NPC that says something about a coffer" any more. It
 * is a lockbox, the skull grid is the box, and clicking it opens the panel.
 * `HALLOWS_EVE_COFFER_LOCKBOX_ID` is what it costs to open.
 *
 * The gate on the client side is `mLockboxData.method_662()` - the player must
 * own at least one lockbox - and `OpenLockbox` additionally wants a key. Both are
 * paid by `grantCoffer` on a Green Knight clear.
 */
const COFFERS_CUE_NAME = 'Special_TreasureTrove';

/**
 * **This string is the challenge screen.**
 *
 * The other spare arm of `Game.method_668`'s `characterName` chain:
 * `Special_ClassTower` opens `screenClassTowers`, and
 * `patch-hallows-eve-challenge-screen.ts` has repointed that class at
 * `a_ScreenHalloweenDungeonPrompt` - the event's own panel, with its clock, its
 * chained door and its Enter button.
 *
 * The Class Tower was the one feature left in the chain this server does not use.
 * There is no third spare arm; the remaining six are the barn, the forge, the
 * dyer, the look-change, the sigil store and the ability tome.
 */

/** The cue each prop answers to, and the villager cue it borrows while diagnosing. */
const CHALLENGE_CUE_NAME = 'Special_ClassTower';

/**
 * Where the challenge figure stands: **beside the arch, on the floor.**
 *
 * ## Why it moved off the rift
 *
 * It used to be an invisible box floating at (2744, 420), on the arch's centre
 * line, and the note here claimed that lifting it "clear of the door's
 * rectangle". That was simply wrong, and it is worth writing down because it cost
 * three rounds. `a_Door_108` carries a 200x400 click rectangle **standing on the
 * floor line**, so it spans y 180..580 - and the box at y 420, 260 tall, spanned
 * y 160..420. It was not clear of the door's rectangle; it was **entirely inside
 * it**, on the same centre x. Every reach for the arch had two targets stacked on
 * one another and no reason to prefer the invisible one.
 *
 * ## Where it is now
 *
 * The door owns x 2644..2844. This stands at 2580 on the floor line, on the open
 * grass the player walks in from: 80px wide, so it ends at 2620 and leaves 24px of
 * daylight before the door's rectangle begins. The Herald keeps the far side at
 * 2992. So the arch is a door and this is a person, and a click can only mean one
 * of them.
 *
 * y is 580, the measured floor line - `NPCHalloweenWatcher` is not `Flying` and a
 * server-spawned entity gets no floor snap, so the number has to be right.
 */
const CHALLENGE_POSITION = { x: 2580, y: 580 };

/**
 * The Herald's cue: the coffers' own, because he is standing where it stood and
 * doing what it did.
 *
 * `Ield` is the one cue name in this room already proven to carry an interact for
 * a prop this feature spawns - the coffers answered a click through it. Dialogue
 * is dispatched on the entity id, never on the cue name, so sharing it with the
 * room's own `NPCIeld` costs nothing. See the file comment.
 */
/**
 * **The Herald is the coffers now.**
 *
 * He used to answer to `Ield` and merely talk about the skull grid, while an
 * invisible box on the grid itself carried `Special_TreasureTrove` and opened the
 * screen. That gave the square two mouths saying the same sentence - the Herald and
 * a piece of ruin - and put the reward on masonry rather than on a person.
 *
 * Giving him the cue collapses the two: clicking him opens the coffer screen
 * directly, client-side, and the grid is no longer an entity at all. With no coffer
 * to open the client says so itself ("Maybe that old man knows how to open this...")
 * - which, standing in front of him, finally reads correctly.
 *
 * In the Dread town the suffixed name matches no arm of the interact chain, so the
 * click falls through to the server and he talks instead. See `cueFor`.
 */
const HERALD_CUE_NAME = COFFERS_CUE_NAME;

/** Where the briefing is remembered on the character. */
const BRIEFED_FIELD = 'hallowsEveBriefed';

/** How many coffer keys the character is holding. */
const KEYS_FIELD = 'hallowsEveKeys';

/** Unix seconds of the last Green Knight kill that paid a key. */
const LAST_KILL_FIELD = 'hallowsEveLastKnightAt';

/** When this character first walked into the arena. Absent means they never have. */
const FIRST_ENTRY_FIELD = 'hallowsEveFirstEntryAt';

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
 * What the Herald says when he has nothing to unlock.
 *
 * He is the square's one figure, so he carries the whole briefing between them:
 * where the arch goes, what is through it, what a key is worth and how often one
 * is due. The coffers' old "locked, and you have no key" line is still used when
 * the answer turns on the clock - see `buildNoKeyLine` - and these are what he
 * says the rest of the time.
 */
const HERALD_LINES: string[] = [
    'One night a year the arch opens, and the Green Knight takes callers. Tonight is that night.',
    'Beat him and you have a key. Bring it back to me and we will see what the coffers is keeping.',
    'He fights fair, more or less. The three standing with him do not fight at all.',
    'Strike the skulls in there. They are laughing at you for a reason.',
    'One key every twelve hours. After that he is only bored of you.',
    'The bone thing at the back of the arena is his, not yours. Leave it if you can.',
    'I have watched him lose. Not often, and not to anyone who went in alone.',
    'Climb the stones if you like. They have held longer than anyone here has.',
    'When the week turns the arch closes, and I go back to heralding nothing.',
    'No, I do not know what is in the coffers. I have never had a key.'
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

    /**
     * Characters who have earned a key and not yet been offered the coffers.
     *
     * The event's own screen opens *"cutscene biter bitmez"* - the moment the Green
     * Knight's last line finishes - and that is a different instant from the one
     * the key is paid at. The key is awarded when the arena is cleared, which is
     * the boss dying; the defeat cinematic runs after it. So the clear leaves a
     * mark here and `LevelHandler.sendRoomCutSceneEnd` spends it on the next
     * cutscene end inside the arena.
     *
     * A mark rather than a persisted field on purpose: it belongs to one run, and
     * a player who logs out mid-cinematic should meet the Herald in the square
     * rather than a window that opens itself a day later.
     */
    private static coffersOwed: Set<string> = new Set();

    /**
     * Characters currently inside the arena, so their next arrival in the square
     * can be told apart from any other way into it.
     *
     * The challenge screen is asked for *"zindandan çıktığımız zaman"* - on the way
     * out, not on the way in - and the way out is an ordinary level transfer with
     * nothing about it that says where it came from. A transfer burns three
     * sessions and two tokens (see the door-transfer notes), so this is keyed by
     * character name, which is the one thing that survives all three.
     */
    private static insideArena: Set<string> = new Set();

    /** True for the two entity ids the square occupies. */
    static isWatcher(entityId: unknown): boolean {
        return Math.round(Number(entityId ?? 0)) === HALLOWS_EVE_WATCHER_ENTITY_ID;
    }

    static isCoffers(entityId: unknown): boolean {
        return Math.round(Number(entityId ?? 0)) === HALLOWS_EVE_COFFERS_ENTITY_ID;
    }

    static isHerald(entityId: unknown): boolean {
        return Math.round(Number(entityId ?? 0)) === HALLOWS_EVE_HERALD_ENTITY_ID;
    }

    /**
     * The invisible click box on the arch.
     *
     * Only reached in the Dread town, where `Special_ClassTowerHard` matches no arm
     * of the interact chain and the click falls through to the server as an ordinary
     * NPC talk. In the normal town the client opens the panel itself and sends
     * nothing.
     */
    static isChallengeMarker(entityId: unknown): boolean {
        return Math.round(Number(entityId ?? 0)) === HALLOWS_EVE_CHALLENGE_ENTITY_ID;
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
        /**
         * **The arch is shut. The panel is the only way in.**
         *
         * Walking into the rift used to work, which made the whole challenge screen
         * optional: a player could read nothing, pay nothing and be in the arena.
         * Now the door refuses, and the only thing that opens it is the entry grant
         * the Summon button leaves behind (`grantEntry`, spent by the transfer that
         * follows). That is what makes the price mean anything.
         *
         * Only the way *in* is gated, and only from the square: a transfer that is
         * already carrying a grant passes, and nothing here touches the way out.
         */
        const from = LevelConfig.normalizeLevelName(currentLevel) || String(currentLevel ?? '').trim();
        const to = LevelConfig.normalizeLevelName(targetLevel) || String(targetLevel ?? '').trim();
        if (to !== HALLOWS_EVE_LEVEL || !HALLOWS_EVE_TOWNS.includes(from)) {
            return false;
        }
        // A live grant is the Summon button's doing; spend it and let them through.
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
        position: { x: number; y: number } = { x: 3740, y: 580 },
        levelName?: string | null
    ): EntityProps & Record<string, unknown> {
        // Facing left, back towards the arch he is keeping watch over.
        return buildProp(
            HALLOWS_EVE_WATCHER_ENTITY_ID,
            HALLOWS_EVE_WATCHER_ENT,
            cueFor(levelName, WATCHER_CUE_NAME),
            position,
            true
        );
    }

    /** One of the Herald's lines, chosen at random the way every other NPC's is. */
    static getHeraldLine(): string {
        return HERALD_LINES[Math.floor(Math.random() * HERALD_LINES.length)];
    }

    /**
     * The Herald, standing in the middle of the square.
     *
     * Facing left, towards the arch he is heralding. He is the only figure the
     * square spawns: the Watcher is kept in code but stands nowhere (see
     * `buildWatcherEntity`), and the coffers is gone entirely because an invisible
     * interact box on the ruins is what made the stonework talk.
     */
    static buildHeraldEntity(levelName?: string | null): EntityProps & Record<string, unknown> {
        return buildProp(
            HALLOWS_EVE_HERALD_ENTITY_ID,
            HALLOWS_EVE_HERALD_ENT,
            cueFor(levelName, HERALD_CUE_NAME),
            HERALD_POSITION,
            true
        );
    }

    /**
     * The figure beside the arch that opens the Green Knight's Challenge panel.
     *
     * **It is drawn now, and that is the point.** It used to be `HalloweenPortal`,
     * whose GfxType is `a__EmptyAnimation` - a click box that draws nothing. Two
     * things were wrong with that. It sat inside the door's own click rectangle
     * (see `CHALLENGE_POSITION`), and even standing somewhere clear it would have
     * been an invisible square that a player has no way of knowing to click.
     *
     * The panel cannot be raised any other way. `Game.method_668` opens it off the
     * clicked entity's cue, entirely inside the client - no packet is sent, so the
     * server cannot put it up on a door, on a transfer, or on anything else. If the
     * only trigger is a click, then the thing to click has to be visible.
     *
     * So it borrows the Hollow Watcher, who was written for this square, is
     * re-dressed by `patch_swz_hallows_eve_ents.ts`, and has been standing nowhere
     * since the coffers took his spot. He stands on the near side of the arch facing
     * right, towards the rift he is keeping watch over.
     */
    static buildChallengeMarkerEntity(levelName?: string | null): EntityProps & Record<string, unknown> {
        return buildProp(
            HALLOWS_EVE_CHALLENGE_ENTITY_ID,
            HALLOWS_EVE_WATCHER_ENT,
            cueFor(levelName, CHALLENGE_CUE_NAME),
            CHALLENGE_POSITION,
            false
        );
    }

    /**
     * Makes an old character's keys openable.
     *
     * Keys earned before the coffer became a lockbox live only in
     * `hallowsEveKeys`; the client's panel is driven by `mOwnedLockboxes` and
     * `DragonKeys`, which those characters have none of. Without this they would
     * hold keys the skull grid refuses to open - it would say *"Maybe that old man
     * knows how to open this..."* and nothing else.
     *
     * Tops the two client-side counters up to the key count, never down: a player
     * who bought Dragon Keys keeps them.
     */
    static ensureCofferStock(character: any): boolean {
        const keys = HallowsEve.getKeys(character);
        if (!character || keys <= 0) {
            return false;
        }

        const boxes = Array.isArray(character.lockboxes) ? character.lockboxes : [];
        const entry = boxes.find(
            (row: any) => Math.round(Number(row?.lockboxID ?? 0)) === HALLOWS_EVE_COFFER_LOCKBOX_ID
        );
        const held = Math.max(0, Math.round(Number(entry?.count ?? 0)));
        let changed = false;

        if (held < keys) {
            if (entry) {
                entry.count = keys;
            } else {
                boxes.push({ lockboxID: HALLOWS_EVE_COFFER_LOCKBOX_ID, count: keys });
            }
            character.lockboxes = boxes;
            changed = true;
        }
        if (Math.max(0, Math.round(Number(character.DragonKeys ?? 0))) < keys) {
            character.DragonKeys = keys;
            changed = true;
        }
        return changed;
    }

    static buildCoffersEntity(levelName?: string | null): EntityProps & Record<string, unknown> {
        // Facing left, back towards the arch the keys come out of.
        return buildProp(
            HALLOWS_EVE_COFFERS_ENTITY_ID,
            HALLOWS_EVE_COFFERS_ENT,
            cueFor(levelName, COFFERS_CUE_NAME),
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
            normalizeName(record?.name) === normalizeName(HALLOWS_EVE_COFFERS_ENT) ||
            normalizeName(record?.name) === normalizeName(HALLOWS_EVE_HERALD_ENT)
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

    // -----------------------------------------------------------------------
    // When the two windows open
    // -----------------------------------------------------------------------

    /**
     * Records that a clear has paid a key, so the coffers can be offered as soon
     * as the Green Knight has finished talking.
     */
    static noteKeyEarned(characterName: unknown): void {
        HallowsEve.coffersOwed.add(String(characterName ?? ''));
    }

    /**
     * True once, for the cutscene end that should open the coffers.
     *
     * Spent rather than tested so the arena's *intro* cinematic can never trip it:
     * the mark is only ever laid down by a clear, and only the first cutscene end
     * after that clear takes it.
     */
    static consumeCoffersOwed(characterName: unknown): boolean {
        const name = String(characterName ?? '');
        if (!HallowsEve.coffersOwed.has(name)) {
            return false;
        }
        HallowsEve.coffersOwed.delete(name);
        return true;
    }

    /**
     * Follows a character across the arch, so an arrival in the square can be told
     * apart from a walk in off the road.
     *
     * Called on every spawn. Returns true when this spawn is the one that just came
     * back out of the arena, which is when the challenge screen is due.
     */
    static noteSpawn(characterName: unknown, levelName: string | null | undefined): boolean {
        const name = String(characterName ?? '');
        if (HallowsEve.isDungeon(levelName)) {
            HallowsEve.insideArena.add(name);
            return false;
        }
        if (!HallowsEve.insideArena.delete(name)) {
            return false;
        }
        // Only the square asks the question. Anywhere else - a recall home, a
        // teleport out - and the run simply ended.
        return HallowsEve.isTown(levelName);
    }

    /** Forgets a character entirely, for a logout. */
    static forget(characterName: unknown): void {
        const name = String(characterName ?? '');
        HallowsEve.coffersOwed.delete(name);
        HallowsEve.insideArena.delete(name);
        HallowsEve.entryGrants.delete(name);
    }

    /**
     * Raises the coffers question, wherever the player is standing.
     *
     * Returns false when there is no key to spend, which is the one case the
     * window has nothing to say - the caller decides whether that deserves a line
     * of its own or silence.
     *
     * The packet is `a_DialogBox` on 0x58, answered on 0x59; see the note above
     * `PROMPT_TOKEN_BASE` for why this rather than the shipped
     * `a_ScreenHalloweenCoffers` panel.
     */
    static raiseCoffersPrompt(client: PromptTarget): boolean {
        const character = client.character;
        const text = character ? HallowsEve.buildCoffersText(character) : null;
        if (!text) {
            return false;
        }
        const token = HallowsEve.openPrompt('coffers', character.name, client.currentLevel);
        const bb = new BitBuffer(false);
        bb.writeMethod9(token);
        bb.writeMethod26(HALLOWS_EVE_PROMPT_CONTEXT);
        bb.writeMethod26(text);
        client.sendBitBuffer(0x58, bb);
        return true;
    }

    /**
     * Raises the Green Knight's Challenge, worded off the shipped prompt screen.
     *
     * `fromLevel` is what a Yes answers the door *from*; the caller supplies it
     * because the two callers mean different things by it - the arch means the
     * square the player is standing in, and the way out of the arena means the
     * square they have just arrived in.
     */
    static raiseChallengePrompt(client: PromptTarget, fromLevel: string): number {
        const token = HallowsEve.openPrompt('challenge', client.character?.name, fromLevel);
        const bb = new BitBuffer(false);
        bb.writeMethod9(token);
        bb.writeMethod26(HALLOWS_EVE_PROMPT_CONTEXT);
        bb.writeMethod26(HallowsEve.buildChallengeText(client.character));
        client.sendBitBuffer(0x58, bb);
        return token;
    }

    /**
     * Puts the Green Knight's Challenge up on the way *out* of the arena.
     *
     * *"Zindandan çıktığımız zaman direkt bu ekran belirmeli"* - the screen the
     * original showed on the square, with the twelve-hour clock on it, so a player
     * walking out knows straight away whether another run is worth a key. A Yes
     * takes them back through the arch, which is what the original's own text
     * offered impatient heroes.
     *
     * Called for every spawn; `noteSpawn` is what tells this arrival apart from any
     * other way into the square, and answers true exactly once per trip through the
     * arch. It lives here rather than in `LevelHandler` so that `EntityHandler` -
     * which is where a spawn is finished - does not have to import it back and
     * close a loop.
     */
    static onSpawn(client: PromptTarget): void {
        const level = LevelConfig.normalizeLevelName(client.currentLevel) || String(client.currentLevel ?? '');
        if (!HallowsEve.noteSpawn(client.character?.name, level)) {
            return;
        }
        const name = String(client.character?.name ?? '');

        /**
         * **Nothing is raised here any more.**
         *
         * This used to put the challenge up in `a_DialogBox` the moment a player
         * arrived back in the square, because at the time nothing in the client
         * could open the event's own panel. Something can now: the two props in
         * the square carry cues the interact handler knows
         * (`patch-levelssrn-hallows-eve-cues.ts`), so the challenge is read off
         * `a_ScreenHalloweenDungeonPrompt` by clicking the arch and the coffer is
         * opened by clicking the skull grid - which is how the original worked, and
         * a window that opens itself over the square is exactly what it did not do.
         *
         * The coffers mark is still spent so it cannot survive to a later arrival;
         * the key it stands for is already on the character by this point and the
         * grid is what turns it into a prize.
         */
        HallowsEve.consumeCoffersOwed(name);
        console.log(`[HallowsEve] ${name} arrived in the square; the panels are on the props`);
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
            'THE COFFERS\n\n' +
            `The coffers is locked, and you are holding ${keys} key${keys === 1 ? '' : 's'}.\n\n` +
            `Spend one to open it? There is ${prize.label} inside.`
        );
    }

    /**
     * What the Herald says when there is no key to spend.
     *
     * Only used when the answer turns on the clock or on the arch; when neither
     * does, he has plenty else to say - see `getHeraldLine`.
     */
    static buildNoKeyLine(character: any): string {
        const wait = HallowsEve.secondsUntilNextKey(character);
        return wait > 0
            ? `The coffers stays shut, and you have no key. The Green Knight will grant another in ${describeHallowsEveDelay(wait)}.`
            : 'No key, no coffers. Beat the Green Knight through that arch and come back with one.';
    }

    // -----------------------------------------------------------------------
    // Keys
    // -----------------------------------------------------------------------

    /**
     * Whether this character has a coffer to open.
     *
     * The square stops drawing the skull grid when this is false, and the reason is
     * that the coffer and the Treasure Trove share one screen: the client picks which
     * lockbox to open with `mLockboxData.method_1459()`, which walks whatever the
     * player owns, and its gate (`method_662()`) only asks for **at least one lockbox
     * of any kind**. So a player out of coffers who clicks the grid gets the same
     * panel opening their *troves* - which is what happened the first time this ran:
     * two coffers paid out event pets, and the third click spent a trove.
     *
     * Refusing to spawn the grid is the honest fix. It is server-side, it costs
     * nothing, and it makes the grid mean what it looks like. The Herald is still
     * there to say when the next key is due.
     */
    static hasCoffer(character: any): boolean {
        const boxes = Array.isArray(character?.lockboxes) ? character.lockboxes : [];
        return boxes.some(
            (row: any) =>
                Math.round(Number(row?.lockboxID ?? 0)) === HALLOWS_EVE_COFFER_LOCKBOX_ID &&
                Math.round(Number(row?.count ?? 0)) > 0
        );
    }

    static getKeys(character: any): number {
        return Math.max(0, Math.round(Number(character?.[KEYS_FIELD] ?? 0)) || 0);
    }

    /** Seconds until this character can earn another key; 0 when one is due. */
    /**
     * Summons the Green Knight early, for Mammoth Idols.
     *
     * The panel's "Summon Knight Now" button is the Class Tower's *speed up the
     * research* button wearing the seasonal art - see `SUMMON_BUTTON_SOURCE` in
     * `scripts/patch-hallows-eve-challenge-screen.ts` for how the two were joined.
     * `class_69.method_1410` computes a price from the Class Tower's own timer and
     * writes it into the packet; that number is meaningless here and is ignored.
     * **The price is this constant and the check is this method** - the client is
     * never trusted with either.
     *
     * Clearing `LAST_KILL_FIELD` is all "summoning" means: the twelve-hour wait is a
     * stamp of when the Knight last fell, and `secondsUntilNextKey` reads it. With it
     * gone the arch pays a key again on the next clear.
     */
    static summonKnightNow(character: any): 'summoned' | 'first' | 'ready' | 'poor' | 'unknown' {
        if (!character) {
            return 'unknown';
        }

        /**
         * **The first visit is on the house.**
         *
         * Now that the arch itself is shut, the Summon button is the only way in, so
         * a player who has never seen the event would be asked for twenty idols
         * before ever meeting the Knight. That is the wrong first impression of a
         * seasonal event, so the first entry is free and marked, and the price starts
         * from the second.
         *
         * Marked rather than inferred from the twelve-hour stamp: that stamp is set
         * by *killing* the Knight, so someone who went in and lost would have been
         * asked to pay for a retry they had already been promised.
         */
        if (!character[FIRST_ENTRY_FIELD]) {
            character[FIRST_ENTRY_FIELD] = Math.floor(Date.now() / 1000);
            return 'first';
        }

        if (HallowsEve.secondsUntilNextKey(character) <= 0) {
            return 'ready';
        }
        const idols = Math.max(0, Math.round(Number(character.mammothIdols ?? 0)) || 0);
        if (idols < HALLOWS_EVE_SUMMON_COST_IDOLS) {
            return 'poor';
        }
        character.mammothIdols = idols - HALLOWS_EVE_SUMMON_COST_IDOLS;
        character[LAST_KILL_FIELD] = 0;
        return 'summoned';
    }

    /** A line from the figure at the arch, on the entity the panel was opened from. */
    static sayAtTheArch(client: PromptTarget, text: string): void {
        const bb = new BitBuffer();
        bb.writeMethod4(HALLOWS_EVE_CHALLENGE_ENTITY_ID);
        bb.writeMethod13(text);
        client.sendBitBuffer(0x76, bb);
    }

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

    /**
     * Puts a coffer and a key where the client can see them.
     *
     * The coffer screen is the client's own lockbox panel (see
     * `COFFERS_CUE_NAME`), and that panel is driven entirely by the two counters
     * the player-data packet carries: `mOwnedLockboxes` and `mLockboxKeys`. So a
     * Green Knight clear has to pay into *those*, not only into this feature's own
     * `hallowsEveKeys`.
     *
     * **The key becomes a Dragon Key, and that is not a choice.** The client has
     * exactly one key counter - `class_131.mLockboxKeys` - and `OpenLockbox`
     * decrements it whatever kind of box is being opened. There is no per-type
     * key anywhere in the client, so a coffer that opens on the real screen must
     * spend the same currency a Treasure Trove does. `hallowsEveKeys` is still
     * kept alongside it: it is what tells the server, when a box is opened, that
     * this one is a coffer and should pay a seasonal prize.
     */
    static grantCoffer(character: any): void {
        if (!character) {
            return;
        }
        const boxes = Array.isArray(character.lockboxes) ? character.lockboxes : [];
        const entry = boxes.find(
            (row: any) => Math.round(Number(row?.lockboxID ?? 0)) === HALLOWS_EVE_COFFER_LOCKBOX_ID
        );
        if (entry) {
            entry.count = Math.max(0, Math.round(Number(entry.count ?? 0))) + 1;
        } else {
            boxes.push({ lockboxID: HALLOWS_EVE_COFFER_LOCKBOX_ID, count: 1 });
        }
        character.lockboxes = boxes;
        character.DragonKeys = Math.max(0, Math.round(Number(character.DragonKeys ?? 0))) + 1;
    }

    /**
     * Spends one coffer, however it was opened.
     *
     * **All three counters move together**, because a clear pays all three and
     * there are two ways to open a coffer: the client's lockbox panel on the skull
     * grid, and the Herald's Yes/No window. Whichever is used, one Green Knight
     * clear has to come out as exactly one prize - so this is the single place
     * that charges for one, and both paths call it.
     *
     *   - `hallowsEveKeys` is the event's own count, and what the Herald reads;
     *   - the coffer lockbox is the stack the client's panel draws and decrements;
     *   - `DragonKeys` is the key that panel spends, because the client has only
     *     one key counter (see `grantCoffer`).
     *
     * Returns false when there is no key, and takes nothing.
     */
    static spendKey(character: any): boolean {
        const held = HallowsEve.getKeys(character);
        if (held <= 0) {
            return false;
        }
        character[KEYS_FIELD] = held - 1;

        const boxes = Array.isArray(character.lockboxes) ? character.lockboxes : [];
        const entry = boxes.find(
            (row: any) => Math.round(Number(row?.lockboxID ?? 0)) === HALLOWS_EVE_COFFER_LOCKBOX_ID
        );
        if (entry) {
            entry.count = Math.max(0, Math.round(Number(entry.count ?? 0)) - 1);
        }
        character.DragonKeys = Math.max(0, Math.round(Number(character.DragonKeys ?? 0)) - 1);
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
