import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { Entity } from '../core/Entity';
import { GameData } from '../core/GameData';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';
import { NpcLoader } from '../data/NpcLoader';
import { EntityHandler } from '../handlers/EntityHandler';
import { HomeStatueHandler } from '../handlers/HomeStatueHandler';
import { NpcHandler } from '../handlers/NpcHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { BitReader } from '../network/protocol/bitReader';
import {
    HOME_STATUE_CUE_NAME,
    HOME_STATUE_SLOTS,
    getHomeStatueDisplayName,
    getHomeStatueSlot,
    readHomeStatues
} from '../core/HomeStatues';
import { getCraftTownHomeInstanceId } from '../utils/HomeVisitGuard';

const CLIENT_SWF = path.resolve(
    __dirname, '..', '..', 'client', 'content', 'localhost', 'p', 'cbp', 'DungeonBlitz.swf'
);

// Garden floor of a_Level_Home: a_Room_Garden sits at (3660, -1960) and its collision outline runs
// flat at y=580 across x=120..880 of an am_CollisionObject placed at (460, 260). That is world
// y=-1120 across x=4240..5000, which is the strip these three slots have to stay inside.
const GARDEN_FLOOR_Y = -1120;
const GARDEN_FLOOR_MIN_X = 4240;
const GARDEN_FLOOR_MAX_X = 5000;

function ensureDataLoaded(): void {
    const dataDir = path.resolve(__dirname, '../data');
    if (!LevelConfig.has('CraftTown')) {
        LevelConfig.load(dataDir);
    }
    if (Object.keys(GameData.ENTTYPES).length === 0) {
        GameData.load(dataDir);
    }
    if (NpcLoader.getRawNpcsForLevel('CraftTown').length === 0) {
        NpcLoader.load(dataDir);
    }
}

function makeCharacter(name: string, characterClass: string, level: number, weaponGearId: number): any {
    return {
        name,
        class: characterClass,
        gender: 'Male',
        level,
        headSet: 'Short',
        hairSet: 'Do10',
        mouthSet: 'M08',
        faceSet: 'F13',
        hairColor: 10325505,
        skinColor: 10060614,
        shirtColor: 3273228,
        pantColor: 208786,
        MasterClass: 0,
        equippedGears: [
            { gearID: 0, tier: 0, runes: [0, 0, 0], colors: [0, 0] },
            { gearID: 0, tier: 0, runes: [0, 0, 0], colors: [0, 0] },
            { gearID: 0, tier: 0, runes: [0, 0, 0], colors: [0, 0] },
            { gearID: 0, tier: 0, runes: [0, 0, 0], colors: [0, 0] },
            { gearID: weaponGearId, tier: 2, runes: [7, 0, 0], colors: [3, 4] },
            { gearID: 13, tier: 0, runes: [0, 0, 0], colors: [0, 0] }
        ]
    };
}

function createFakeClient(character: any, characters: any[], token: number, host: any = null): any {
    const sentPackets: { id: number; payload: Buffer }[] = [];
    const saveReasons: string[] = [];
    return {
        token,
        userId: 1,
        character,
        characters,
        craftTownHostCharacter: host,
        currentLevel: 'CraftTown',
        levelInstanceId: getCraftTownHomeInstanceId(character, host),
        currentRoomId: 0,
        playerSpawned: true,
        clientEntID: 1000 + token,
        knownEntityIds: new Set<number>(),
        entityIdAliases: new Map<number, number>(),
        sharedEntityRemoteUpdateDeferredIds: new Set<number>(),
        entities: new Map<number, any>(),
        sentPackets,
        saveReasons,
        scheduleCharacterSave(reason: string) { saveReasons.push(reason); },
        send(id: number, payload: Buffer) { sentPackets.push({ id, payload: Buffer.from(payload) }); },
        sendBitBuffer(id: number, bb: BitBuffer) { sentPackets.push({ id, payload: bb.toBuffer() }); }
    };
}

/** Mirrors the isPlayer branch of Entity.serialize far enough to read back what a statue looks like. */
function readStatueSpawn(payload: Buffer): Record<string, unknown> {
    const br = new BitReader(payload);
    const id = br.readMethod4();
    const name = br.readMethod13();
    const isPlayer = br.readMethod6(1) === 1;
    assert.equal(isPlayer, true, 'statues must spawn as player-shaped entities');

    const characterClass = br.readMethod13();
    br.readMethod13(); // gender
    br.readMethod13(); // headSet
    br.readMethod13(); // hairSet
    br.readMethod13(); // mouthSet
    br.readMethod13(); // faceSet
    br.readMethod6(24); // hairColor
    br.readMethod6(24); // skinColor
    br.readMethod6(24); // shirtColor
    br.readMethod6(24); // pantColor

    const gears: Array<{ gearID: number; tier: number } | null> = [];
    for (let slot = 0; slot < 6; slot++) {
        if (!br.readMethod6(1)) {
            gears.push(null);
            continue;
        }
        const gearID = br.readMethod6(11);
        const tier = br.readMethod6(2);
        br.readMethod6(16);
        br.readMethod6(16);
        br.readMethod6(16);
        br.readMethod6(8);
        br.readMethod6(8);
        gears.push({ gearID, tier });
    }

    const x = br.readMethod45();
    const y = br.readMethod45();
    br.readMethod45(); // velocity
    const team = br.readMethod6(Entity.TEAM_BITS);

    assert.equal(br.readMethod6(1), 1, 'player extras block must be present');
    br.readMethod6(1); // idleReset
    br.readMethod6(1); // spawnFx
    br.readMethod6(7); // pet id
    br.readMethod6(6); // pet special id
    br.readMethod6(7); // mount id
    br.readMethod6(5); // consumable id
    if (br.readMethod6(1)) {
        for (let i = 0; i < 3; i++) {
            br.readMethod6(7);
            br.readMethod6(6);
        }
    }

    const characterName = br.readMethod6(1) ? br.readMethod13() : '';
    const dramaAnim = br.readMethod6(1) ? br.readMethod13() : '';
    const sleepAnim = br.readMethod6(1) ? br.readMethod13() : '';
    if (br.readMethod6(1)) {
        br.readMethod4(); // summoner id
    }
    if (br.readMethod6(1)) {
        br.readMethod4(); // power id
    }
    const entState = br.readMethod6(Entity.STATE_BITS);

    return { id, name, characterClass, x, y, team, characterName, dramaAnim, sleepAnim, entState, gears };
}

function buildTalkPacket(entityId: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(entityId);
    return bb.toBuffer();
}

/** The three slots must sit on the garden's flat floor, or the client drops the statues elsewhere. */
function testSlotsStandOnTheGardenFloor(): void {
    for (const slot of HOME_STATUE_SLOTS) {
        assert.equal(slot.y, GARDEN_FLOOR_Y, `${slot.characterClass} statue must stand on the garden floor line`);
        assert.ok(
            slot.x > GARDEN_FLOOR_MIN_X && slot.x < GARDEN_FLOOR_MAX_X,
            `${slot.characterClass} statue at x=${slot.x} is off the flat part of the garden floor`
        );
    }

    const ids = new Set(HOME_STATUE_SLOTS.map((slot) => slot.entityId));
    assert.equal(ids.size, HOME_STATUE_SLOTS.length, 'statue entity ids must be unique');

    // The idle loops each live in that class's own animation SWF, so a name is only valid for the
    // class it is assigned to.
    const animByClass: Record<string, string> = { Paladin: 'Sharpen', Rogue: 'Toss', Mage: 'Read' };
    for (const slot of HOME_STATUE_SLOTS) {
        assert.equal(slot.sleepAnim, animByClass[slot.characterClass], `${slot.characterClass} statue plays the wrong idle`);
    }

    for (const npc of NpcLoader.getRawNpcsForLevel('CraftTown')) {
        assert.equal(ids.has(Number(npc.id)), false, 'statue ids must not collide with authored Home NPCs');
    }
}

/**
 * The client builds a per-player EntType by concatenating `<EntType EntName='<name>' ...>` and
 * parsing it, with the attribute *single* quoted. An apostrophe (or any other XML metacharacter) in
 * a statue name therefore kills the whole login batch with `Error #1090: XML parser failure`.
 */
function testStatueNamesSurviveTheClientXmlBuilder(): void {
    for (const raw of ["Ada", "O'Brien", 'A<B>C', 'Tom & Jerry', 'Say"Hi']) {
        const name = getHomeStatueDisplayName(raw);
        assert.equal(/['"<>&]/.test(name), false, `statue name "${name}" would break EntType.method_97's XML`);
        assert.notEqual(
            name.toLowerCase().replace(/[^a-z0-9]+/g, ''),
            raw.toLowerCase().replace(/[^a-z0-9]+/g, ''),
            'a statue name must not normalise to its owner\'s character name'
        );
    }
}

/** One statue per class the account owns, seeded from the best character of that class. */
function testSeedsOneStatuePerOwnedClass(): void {
    ensureDataLoaded();
    GlobalState.levelEntities.clear();

    const paladin = makeCharacter('StatuePal', 'Paladin', 50, 111);
    const lowMage = makeCharacter('StatueMageLow', 'Mage', 12, 222);
    const highMage = makeCharacter('StatueMageHigh', 'Mage', 44, 333);
    const client = createFakeClient(paladin, [paladin, lowMage, highMage], 1);

    HomeStatueHandler.onCraftTownSpawn(client);

    const book = readHomeStatues(paladin);
    assert.equal(book.Paladin?.characterName, 'StatuePal');
    assert.equal(book.Mage?.characterName, 'StatueMageHigh', 'the highest-level character of a class owns its statue');
    assert.equal(book.Rogue, undefined, 'a class with no character gets no statue');
    assert.deepEqual(readHomeStatues(highMage), book, 'the book is replicated onto every character of the account');
    assert.ok(client.saveReasons.length > 0, 'seeding must be persisted');

    const spawns: Array<Record<string, unknown>> = client.sentPackets
        .filter((packet: any) => packet.id === 0x0F)
        .map((packet: any) => readStatueSpawn(packet.payload));
    assert.equal(spawns.length, 2, 'only owned classes get a statue');

    const paladinSlot = getHomeStatueSlot('Paladin');
    const paladinSpawn = spawns.find((entry) => entry.id === paladinSlot.entityId) as any;
    assert.ok(paladinSpawn, 'the Paladin statue must be spawned');
    assert.equal(paladinSpawn.name, 'Statue of StatuePal', 'a statue must not carry the bare character name');
    assert.equal(paladinSpawn.characterClass, 'Paladin');
    assert.equal(paladinSpawn.x, paladinSlot.x);
    assert.equal(paladinSpawn.y, paladinSlot.y);
    assert.equal(paladinSpawn.team, 3, 'the client only offers NEUTRAL entities as interact targets');
    assert.equal(paladinSpawn.characterName, HOME_STATUE_CUE_NAME);
    assert.deepEqual(paladinSpawn.gears[4], { gearID: 111, tier: 2 }, 'the statue wears the snapshot gear');
    // SLEEP (1), never DRAMA (2): Entity.method_156() refuses a DRAMA entity as an interact target,
    // which would leave the statue unusable.
    assert.equal(paladinSpawn.entState, 1, 'statues must idle in the sleep state to stay interactable');
    assert.equal(paladinSpawn.sleepAnim, 'Sharpen', 'the Paladin statue must loop its idle');
    assert.equal(paladinSpawn.dramaAnim, '');

    HomeStatueHandler.onCraftTownSpawn(client);
    assert.equal(
        client.sentPackets.filter((packet: any) => packet.id === 0x0F).length,
        2,
        'a statue already known to the client must not be spawned twice'
    );
}

/**
 * Change your set, leave the keep, come back: the statue of the class you are playing is re-cut from
 * the character on the way in. Statues of your other classes are left alone.
 */
function testHomeEntryResyncsTheActiveClassStatue(): void {
    ensureDataLoaded();
    GlobalState.levelEntities.clear();

    const paladin = makeCharacter('SyncPal', 'Paladin', 50, 111);
    const mage = makeCharacter('SyncMage', 'Mage', 40, 222);
    const client = createFakeClient(paladin, [paladin, mage], 1);

    HomeStatueHandler.onCraftTownSpawn(client);
    assert.equal(readHomeStatues(paladin).Paladin?.equippedGears[4].gearID, 111);

    // Re-entering with nothing changed must not churn a save.
    client.saveReasons.length = 0;
    client.knownEntityIds.clear();
    HomeStatueHandler.onCraftTownSpawn(client);
    assert.deepEqual(client.saveReasons, [], 'an unchanged statue must not be re-persisted on every home entry');

    // Swap the set somewhere else, then walk back in.
    paladin.equippedGears[4] = { gearID: 777, tier: 1, runes: [9, 0, 0], colors: [1, 2] };
    paladin.level = 51;
    client.knownEntityIds.clear();
    client.sentPackets.length = 0;
    HomeStatueHandler.onCraftTownSpawn(client);

    const book = readHomeStatues(paladin);
    assert.equal(book.Paladin?.equippedGears[4].gearID, 777, 'the active class statue re-cuts itself on home entry');
    assert.equal(book.Paladin?.level, 51, 'and picks up the rest of the character with it');
    assert.equal(book.Mage?.equippedGears[4].gearID, 222, 'the statues of other classes are left alone');
    assert.ok(client.saveReasons.includes('home statue sync'), 'the refreshed statue must be persisted');

    const paladinSlot = getHomeStatueSlot('Paladin');
    const spawn = client.sentPackets
        .filter((packet: any) => packet.id === 0x0F)
        .map((packet: any) => readStatueSpawn(packet.payload))
        .find((entry: Record<string, unknown>) => entry.id === paladinSlot.entityId) as any;
    assert.ok(spawn, 'the refreshed statue must be spawned');
    assert.deepEqual(spawn.gears[4], { gearID: 777, tier: 1 }, 'the spawn carries the new set');

    // A visitor of a *different* class must not create or overwrite anything in the host's keep.
    const guestCharacter = makeCharacter('SyncGuest', 'Rogue', 30, 333);
    const guest = createFakeClient(guestCharacter, [guestCharacter], 2, paladin);
    HomeStatueHandler.onCraftTownSpawn(guest);
    assert.equal(readHomeStatues(paladin).Rogue, undefined, 'a visitor never writes to the host account');
    assert.equal(readHomeStatues(paladin).Paladin?.equippedGears[4].gearID, 777);
}

/** Touching your own statue while playing that class re-dresses it and tells the room. */
function testOwnerRedressesTheirOwnClassStatue(): void {
    ensureDataLoaded();
    GlobalState.levelEntities.clear();
    GlobalState.sessionsByToken.clear();

    const paladin = makeCharacter('StatuePal', 'Paladin', 50, 111);
    const owner = createFakeClient(paladin, [paladin], 1);
    GlobalState.sessionsByToken.set(1, owner);
    HomeStatueHandler.onCraftTownSpawn(owner);

    const visitorCharacter = makeCharacter('StatueGuest', 'Rogue', 30, 444);
    const visitor = createFakeClient(visitorCharacter, [visitorCharacter], 2, paladin);
    GlobalState.sessionsByToken.set(2, visitor);
    HomeStatueHandler.onCraftTownSpawn(visitor);
    assert.equal(
        readHomeStatues(paladin).Rogue,
        undefined,
        'a visitor must never seed statues into the host account'
    );

    const slot = getHomeStatueSlot('Paladin');
    owner.sentPackets.length = 0;
    visitor.sentPackets.length = 0;

    // A visitor may look but not touch.
    NpcHandler.handleTalkToNpc(visitor, buildTalkPacket(slot.entityId));
    assert.equal(readHomeStatues(paladin).Paladin?.equippedGears[4].gearID, 111, 'a visitor cannot re-dress a statue');
    assert.equal(visitor.sentPackets.some((packet: any) => packet.id === 0x44), true, 'the visitor is told why nothing happened');
    assert.equal(visitor.sentPackets.some((packet: any) => packet.id === 0xAF), false);

    // Wrong class: the Paladin statue is not the Rogue's to change either, even at home.
    const rogueAtHome = createFakeClient(makeCharacter('StatueRogue', 'Rogue', 30, 555), [paladin], 3);
    NpcHandler.handleTalkToNpc(rogueAtHome, buildTalkPacket(slot.entityId));
    assert.equal(readHomeStatues(paladin).Paladin?.equippedGears[4].gearID, 111, 'only the matching class re-dresses a statue');

    // The owner, playing that class, swaps their weapon and touches the statue.
    paladin.equippedGears[4] = { gearID: 999, tier: 3, runes: [1, 2, 3], colors: [5, 6] };
    NpcHandler.handleTalkToNpc(owner, buildTalkPacket(slot.entityId));

    const updated = readHomeStatues(paladin).Paladin;
    assert.equal(updated?.equippedGears[4].gearID, 999, 'the statue takes the set the owner is wearing');
    assert.equal(updated?.equippedGears[4].tier, 3);
    assert.ok(owner.saveReasons.includes('home statue update'), 'the new set must be persisted');

    for (const session of [owner, visitor]) {
        const gearUpdates = session.sentPackets.filter((packet: any) => packet.id === 0xAF);
        assert.equal(gearUpdates.length, 1, 'everyone in the keep is told the statue changed');
        const br = new BitReader(gearUpdates[0].payload);
        assert.equal(br.readMethod4(), slot.entityId, 'the gear update must target the statue entity');
    }
}

/**
 * Statues are account-private. Two accounts standing in the same CraftTown level scope - which is
 * what happens if home instancing ever collapses - must still each see only their own characters,
 * and neither may leak into the shared level map that generic entity sync walks.
 */
function testStatuesNeverCrossAccounts(): void {
    ensureDataLoaded();
    GlobalState.levelEntities.clear();
    GlobalState.sessionsByToken.clear();

    const mine = makeCharacter('OwnerAlpha', 'Paladin', 50, 111);
    const theirs = makeCharacter('OwnerBeta', 'Mage', 50, 222);

    const alpha = createFakeClient(mine, [mine], 1);
    const beta = createFakeClient(theirs, [theirs], 2);
    // Force the worst case: both keeps resolved to one level scope.
    beta.levelInstanceId = alpha.levelInstanceId;
    GlobalState.sessionsByToken.set(1, alpha);
    GlobalState.sessionsByToken.set(2, beta);

    HomeStatueHandler.onCraftTownSpawn(alpha);
    HomeStatueHandler.onCraftTownSpawn(beta);

    const spawnedNames = (client: any): string[] => client.sentPackets
        .filter((packet: any) => packet.id === 0x0F)
        .map((packet: any) => String(readStatueSpawn(packet.payload).name));

    assert.deepEqual(spawnedNames(alpha), ['Statue of OwnerAlpha'], 'a player only ever sees their own account');
    assert.deepEqual(spawnedNames(beta), ['Statue of OwnerBeta'], 'another account must not receive these statues');

    // Nothing statue-shaped may sit in the shared level map, or joiner sync could hand it out.
    for (const levelMap of GlobalState.levelEntities.values()) {
        for (const slot of HOME_STATUE_SLOTS) {
            assert.equal(levelMap.has(slot.entityId), false, 'statues must never enter the shared level map');
        }
    }

    // An update in one keep must not reach a session standing in another.
    alpha.sentPackets.length = 0;
    beta.sentPackets.length = 0;
    mine.equippedGears[4] = { gearID: 888, tier: 1, runes: [0, 0, 0], colors: [0, 0] };
    NpcHandler.handleTalkToNpc(alpha, buildTalkPacket(getHomeStatueSlot('Paladin').entityId));

    assert.equal(alpha.sentPackets.some((packet: any) => packet.id === 0xAF), true, 'the owner sees their own update');
    assert.equal(
        beta.sentPackets.some((packet: any) => packet.id === 0xAF || packet.id === 0x0F),
        false,
        'another account must not be told about a statue that is not theirs'
    );

    // A client claiming a statue id must not be able to file one into the shared map either.
    const forged = new BitBuffer(false);
    forged.writeMethod4(getHomeStatueSlot('Paladin').entityId);
    forged.writeMethod24(0);
    forged.writeMethod24(0);
    forged.writeMethod24(0);
    forged.writeMethod26('Forged');
    EntityHandler.handleEntityFullUpdate(beta, forged.toBuffer());
    for (const levelMap of GlobalState.levelEntities.values()) {
        for (const slot of HOME_STATUE_SLOTS) {
            assert.equal(levelMap.has(slot.entityId), false, 'a client must not be able to inject a statue id');
        }
    }
}

/** The gear window only opens if DungeonBlitz.swf still carries the interact prologue. */
function testClientCarriesTheStatueInspectPatch(): void {
    const raw = fs.readFileSync(CLIENT_SWF);
    const body = raw.subarray(0, 3).toString('ascii') === 'CWS'
        ? zlib.inflateSync(raw.subarray(8))
        : raw.subarray(8);

    // getlocal_0, getlocal_1, callproperty GetEntFromID/1, dup, iffalse - the head of the prologue
    // prepended to Game.method_668 by patch-dungeonblitz-home-statue-inspect.ts.
    const prologueHead = Buffer.from([0xd0, 0xd1, 0x46]);
    let found = false;
    for (let index = 0; index + 16 < body.length && !found; index++) {
        if (!body.subarray(index, index + 3).equals(prologueHead)) {
            continue;
        }
        // dup + iffalse must follow the callproperty's two u30 operands.
        for (let operands = 2; operands <= 6; operands++) {
            if (body[index + 3 + operands] === 0x2a && body[index + 4 + operands] === 0x12) {
                found = true;
                break;
            }
        }
    }
    assert.equal(found, true, 'DungeonBlitz.swf is missing the keep statue interact prologue; run patch-dungeonblitz-home-statue-inspect.ts');
}

testSlotsStandOnTheGardenFloor();
testStatueNamesSurviveTheClientXmlBuilder();
testSeedsOneStatuePerOwnedClass();
testHomeEntryResyncsTheActiveClassStatue();
testOwnerRedressesTheirOwnClassStatue();
testStatuesNeverCrossAccounts();
testClientCarriesTheStatueInspectPatch();

console.log('home statue regression passed');
