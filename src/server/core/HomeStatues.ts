import { Character } from '../database/Database';
import { EntityProps, EntityState, EntityTeam } from './Entity';
import { normalizeGender } from '../utils/normalizeGender';

/**
 * Player statues in the keep garden.
 *
 * The keep (CraftTown) garden room is the walled lawn with the horse gate. One statue stands there
 * for every class the account has a character of, showing that character wearing the gear its owner
 * picked. Everyone in the garden can walk up to a statue and read its gear like an Examine Gear
 * panel; only the owner, standing in their own keep and playing that class, can re-dress it.
 *
 * A statue is spawned as a *player-shaped* entity (`isPlayer`), because that is the only entity the
 * client renders from a class + appearance + `equippedGears` block: exactly the paperdoll a statue
 * needs. Two consequences follow, and both are load-bearing:
 *
 *   - `team` is NEUTRAL (3), not PLAYER. `Entity.method_355()` in the client only offers an entity
 *     as an interact target when it has a `cue.characterName` *and* its team is NEUTRAL, so a
 *     PLAYER-team statue could never be walked up to and used.
 *   - the entity name is `<character>'s Statue`, never the bare character name. The server decides
 *     which entities a session owns by comparing normalised names
 *     (`EntityHandler.normalizeIdentityName`), so a statue named exactly like its owner would be
 *     swept along by `removeOwnedEntities` / `moveClientOwnedEntitiesBetweenScopes` and vanish (or
 *     worse, follow the player into another level scope).
 *
 * `cue.characterName` is `StatueName`. That string is deliberately one that already exists in
 * DungeonBlitz.swf's ABC constant pool: the client patch that opens the gear window compares
 * against a `pushstring` operand, and reusing a pooled string keeps the patch from having to grow
 * the constant pool. It matches none of the `Special_*` names the stock interact chain dispatches
 * on, so the stock code falls through it harmlessly.
 */

export type HomeStatueClass = 'Paladin' | 'Rogue' | 'Mage';

export interface HomeStatueGear {
    gearID: number;
    tier: number;
    runes: number[];
    colors: number[];
}

export interface HomeStatueSnapshot {
    characterName: string;
    characterClass: HomeStatueClass;
    gender: string;
    headSet: string;
    hairSet: string;
    mouthSet: string;
    faceSet: string;
    hairColor: number;
    skinColor: number;
    shirtColor: number;
    pantColor: number;
    level: number;
    masterClass: number;
    equippedGears: HomeStatueGear[];
    updatedAt: number;
}

export type HomeStatueBook = Partial<Record<HomeStatueClass, HomeStatueSnapshot>>;

export interface HomeStatueSlot {
    characterClass: HomeStatueClass;
    entityId: number;
    x: number;
    y: number;
    facingLeft: boolean;
    /** Looping idle animation the statue plays. See HOME_STATUE_SLOTS for why it rides the sleep cue. */
    sleepAnim: string;
}

/** Character field the statue book is stored under, replicated across every character of the account. */
export const HOME_STATUE_FIELD = 'homeStatues';

/** The level the statues stand in. */
export const HOME_STATUE_LEVEL = 'CraftTown';

/** Cue name the client patch matches on. See the file comment for why it is this exact string. */
export const HOME_STATUE_CUE_NAME = 'StatueName';

/**
 * Entity ids. Authored ids in this project top out around 14.4M and the server never mints ids of
 * its own, so this block cannot collide with anything.
 */
export const HOME_STATUE_ENTITY_ID_BASE = 26_000_000;

const HOME_STATUE_GEAR_SLOTS = 6;

/**
 * Garden floor geometry, read out of LevelsHome.swf rather than guessed:
 *   a_Room_Garden sits at (3660, -1960) inside a_Level_Home,
 *   its am_CollisionObject sits at (460, 260) inside the room, and
 *   the collision outline's flat run is y=580, x=120..880 inside that object.
 * So the walkable strip is world y=-1120 across x=4240..5000, with the entrance door at x~4056.
 * The three statues are spread across the middle of that strip, facing the door.
 *
 * Each statue loops a class-appropriate idle: Paladin sharpens, Rogue tosses a blade, Mage reads.
 * Those animations ride the *sleep* cue, never the drama cue, and that is not interchangeable:
 * `Entity.method_156()` refuses an entity as an interact target while `entState == DRAMA (2)`, so a
 * drama-posed statue could never be used - the gear window would simply never open. Sleep (1) is not
 * in that check, and `LinkUpdater` calls `BeginSleep()` on spawn, which hands
 * `cue.sleepAnim` to `Seq.method_34(..., loop = true)`.
 */
export const HOME_STATUE_SLOTS: readonly HomeStatueSlot[] = [
    { characterClass: 'Paladin', entityId: HOME_STATUE_ENTITY_ID_BASE + 1, x: 4400, y: -1120, facingLeft: true, sleepAnim: 'Sharpen' },
    { characterClass: 'Rogue', entityId: HOME_STATUE_ENTITY_ID_BASE + 2, x: 4620, y: -1120, facingLeft: true, sleepAnim: 'Toss' },
    { characterClass: 'Mage', entityId: HOME_STATUE_ENTITY_ID_BASE + 3, x: 4840, y: -1120, facingLeft: true, sleepAnim: 'Read' }
];

export function normalizeHomeStatueClass(value: unknown): HomeStatueClass | null {
    const normalized = String(value ?? '').trim().toLowerCase();
    if (normalized === 'paladin') {
        return 'Paladin';
    }
    if (normalized === 'rogue') {
        return 'Rogue';
    }
    if (normalized === 'mage') {
        return 'Mage';
    }
    return null;
}

export function getHomeStatueSlot(characterClass: HomeStatueClass): HomeStatueSlot {
    return HOME_STATUE_SLOTS.find((slot) => slot.characterClass === characterClass)!;
}

export function getHomeStatueSlotByEntityId(entityId: unknown): HomeStatueSlot | null {
    const id = Math.max(0, Math.round(Number(entityId ?? 0)));
    return HOME_STATUE_SLOTS.find((slot) => slot.entityId === id) ?? null;
}

export function isHomeStatueEntityId(entityId: unknown): boolean {
    return getHomeStatueSlotByEntityId(entityId) !== null;
}

/**
 * The name a statue stands under. Two hard constraints, both learned the hard way:
 *
 *   - **No XML metacharacters, and above all no apostrophe.** The client builds a per-player EntType
 *     by string-concatenating `<EntType EntName='<name>' parent='Player'>` and parsing it
 *     (`EntType.method_97` -> `EntType.method_57`). The attribute is *single* quoted, so an
 *     apostrophe in the name closes it early and the whole login batch dies with
 *     `Error #1090: XML parser failure`.
 *   - **Must not normalise to the owner's character name.** `EntityHandler.normalizeIdentityName`
 *     lowercases and strips non-alphanumerics before deciding which entities a session owns; the
 *     `Statue of ` prefix survives that, so a statue is never mistaken for its owner's player entity.
 *
 * The apostrophe rule is also why this reads `Statue of <name>` rather than the more natural
 * `<name>'s Statue`.
 */
export function getHomeStatueDisplayName(characterName: unknown): string {
    const safeName = String(characterName ?? '')
        .replace(/[<>&'"]/g, '')
        .trim();
    return `Statue of ${safeName}`;
}

function normalizeGear(value: unknown): HomeStatueGear {
    const raw = value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};

    const runes = Array.isArray(raw.runes) ? raw.runes : [];
    const colors = Array.isArray(raw.colors) ? raw.colors : [];

    return {
        gearID: Math.max(0, Math.round(Number(raw.gearID ?? 0)) || 0),
        tier: Math.max(0, Math.round(Number(raw.tier ?? 0)) || 0),
        runes: [0, 1, 2].map((index) => Math.max(0, Math.round(Number(runes[index] ?? 0)) || 0)),
        colors: [0, 1].map((index) => Math.max(0, Math.round(Number(colors[index] ?? 0)) || 0))
    };
}

function normalizeGearList(value: unknown): HomeStatueGear[] {
    const list = Array.isArray(value) ? value : [];
    return Array.from({ length: HOME_STATUE_GEAR_SLOTS }, (_, index) => normalizeGear(list[index]));
}

/** Freezes a character's current look and worn gear into the snapshot a statue is drawn from. */
export function buildHomeStatueSnapshot(character: Character | null | undefined): HomeStatueSnapshot | null {
    const characterClass = normalizeHomeStatueClass(character?.class);
    const characterName = String(character?.name ?? '').trim();
    if (!character || !characterClass || !characterName) {
        return null;
    }

    return {
        characterName,
        characterClass,
        gender: normalizeGender(String(character.gender ?? '')),
        headSet: String(character.headSet ?? ''),
        hairSet: String(character.hairSet ?? ''),
        mouthSet: String(character.mouthSet ?? ''),
        faceSet: String(character.faceSet ?? ''),
        hairColor: Math.max(0, Math.round(Number(character.hairColor ?? 0)) || 0),
        skinColor: Math.max(0, Math.round(Number(character.skinColor ?? 0)) || 0),
        shirtColor: Math.max(0, Math.round(Number(character.shirtColor ?? 0)) || 0),
        pantColor: Math.max(0, Math.round(Number(character.pantColor ?? 0)) || 0),
        level: Math.min(63, Math.max(1, Math.round(Number(character.level ?? 1)) || 1)),
        masterClass: Math.max(0, Math.round(Number(character.MasterClass ?? 0)) || 0),
        equippedGears: normalizeGearList(character.equippedGears),
        updatedAt: Date.now()
    };
}

function normalizeSnapshot(value: unknown): HomeStatueSnapshot | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }

    const raw = value as Record<string, unknown>;
    const characterClass = normalizeHomeStatueClass(raw.characterClass ?? raw.class);
    const characterName = String(raw.characterName ?? raw.name ?? '').trim();
    if (!characterClass || !characterName) {
        return null;
    }

    return {
        characterName,
        characterClass,
        gender: normalizeGender(String(raw.gender ?? '')),
        headSet: String(raw.headSet ?? ''),
        hairSet: String(raw.hairSet ?? ''),
        mouthSet: String(raw.mouthSet ?? ''),
        faceSet: String(raw.faceSet ?? ''),
        hairColor: Math.max(0, Math.round(Number(raw.hairColor ?? 0)) || 0),
        skinColor: Math.max(0, Math.round(Number(raw.skinColor ?? 0)) || 0),
        shirtColor: Math.max(0, Math.round(Number(raw.shirtColor ?? 0)) || 0),
        pantColor: Math.max(0, Math.round(Number(raw.pantColor ?? 0)) || 0),
        level: Math.min(63, Math.max(1, Math.round(Number(raw.level ?? 1)) || 1)),
        masterClass: Math.max(0, Math.round(Number(raw.masterClass ?? 0)) || 0),
        equippedGears: normalizeGearList(raw.equippedGears),
        updatedAt: Math.max(0, Math.round(Number(raw.updatedAt ?? 0)) || 0)
    };
}

/** Reads the statue book off a character. Never returns null entries for classes that have none. */
export function readHomeStatues(character: Character | null | undefined): HomeStatueBook {
    const stored = (character as Record<string, unknown> | null | undefined)?.[HOME_STATUE_FIELD];
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
        return {};
    }

    const book: HomeStatueBook = {};
    for (const slot of HOME_STATUE_SLOTS) {
        const snapshot = normalizeSnapshot((stored as Record<string, unknown>)[slot.characterClass]);
        if (snapshot && snapshot.characterClass === slot.characterClass) {
            book[slot.characterClass] = snapshot;
        }
    }
    return book;
}

/**
 * Writes the statue book onto every character of the account.
 *
 * The book has to be readable from whichever character happens to be hosting the keep, and a
 * visitor only ever gets the host's *active* character record (`Client.craftTownHostCharacter`), so
 * every character carries the same copy rather than the book living on one of them.
 */
export function writeHomeStatues(characters: Array<Character | null | undefined>, book: HomeStatueBook): void {
    for (const character of characters) {
        if (!character || typeof character !== 'object') {
            continue;
        }
        (character as Record<string, unknown>)[HOME_STATUE_FIELD] = JSON.parse(JSON.stringify(book));
    }
}

/** True when two snapshots would draw the same statue. `updatedAt` is bookkeeping and is ignored. */
export function isSameHomeStatue(
    left: HomeStatueSnapshot | null | undefined,
    right: HomeStatueSnapshot | null | undefined
): boolean {
    if (!left || !right) {
        return left === right;
    }

    const strip = ({ updatedAt, ...rest }: HomeStatueSnapshot) => rest;
    return JSON.stringify(strip(left)) === JSON.stringify(strip(right));
}

/**
 * Gives every class on the account a statue it does not have yet, using the highest-level character
 * of that class. Returns true when something was added, so the caller knows to persist.
 */
export function seedHomeStatues(characters: Array<Character | null | undefined>, book: HomeStatueBook): boolean {
    let changed = false;

    for (const slot of HOME_STATUE_SLOTS) {
        if (book[slot.characterClass]) {
            continue;
        }

        let best: Character | null = null;
        for (const candidate of characters) {
            if (!candidate || normalizeHomeStatueClass(candidate.class) !== slot.characterClass) {
                continue;
            }
            if (!best || Number(candidate.level ?? 0) > Number(best.level ?? 0)) {
                best = candidate;
            }
        }

        const snapshot = buildHomeStatueSnapshot(best);
        if (snapshot) {
            book[slot.characterClass] = snapshot;
            changed = true;
        }
    }

    return changed;
}

/** Builds the spawn payload for one statue. Rebuilt from the snapshot on every send, never cached. */
export function buildHomeStatueEntity(slot: HomeStatueSlot, snapshot: HomeStatueSnapshot): EntityProps & Record<string, unknown> {
    return {
        id: slot.entityId,
        name: getHomeStatueDisplayName(snapshot.characterName),
        isPlayer: true,
        x: slot.x,
        y: slot.y,
        spawnX: slot.x,
        spawnY: slot.y,
        spawnEntState: EntityState.SLEEP,
        v: 0,
        team: EntityTeam.NPC,
        renderDepthOffset: 0,
        characterName: HOME_STATUE_CUE_NAME,
        dramaAnim: '',
        sleepAnim: slot.sleepAnim,
        summonerId: 0,
        powerId: 0,
        entState: EntityState.SLEEP,
        facingLeft: slot.facingLeft,
        running: false,
        jumping: false,
        dropping: false,
        backpedal: false,
        untargetable: false,
        class: snapshot.characterClass,
        gender: snapshot.gender,
        headSet: snapshot.headSet,
        hairSet: snapshot.hairSet,
        mouthSet: snapshot.mouthSet,
        faceSet: snapshot.faceSet,
        hairColor: snapshot.hairColor,
        skinColor: snapshot.skinColor,
        shirtColor: snapshot.shirtColor,
        pantColor: snapshot.pantColor,
        equippedGears: snapshot.equippedGears.map((gear) => ({
            gearID: gear.gearID,
            tier: gear.tier,
            runes: [...gear.runes],
            colors: [...gear.colors]
        })),
        abilities: [],
        level: snapshot.level,
        masterClass: snapshot.masterClass,
        talents: [],
        equippedMount: 0,
        activeConsumableId: 0,
        activePet: { petID: 0, special_id: 0 },
        healthDelta: 0,
        buffs: [],
        roomId: -1,
        // Server-side bookkeeping. `homeStatue` keeps the statue out of any code path that treats an
        // isPlayer entity as a live session, and `clientSpawned: false` keeps it out of the
        // client-spawn ownership sweeps.
        homeStatue: true,
        homeStatueClass: snapshot.characterClass,
        clientSpawned: false
    };
}
