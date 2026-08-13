import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { Achievements } from '../core/Achievements';
import { Entity } from '../core/Entity';
import { GameData } from '../core/GameData';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';
import { StaticServer } from '../core/StaticServer';
import { NpcDialogueLoader } from '../data/NpcDialogueLoader';
import { NpcLoader } from '../data/NpcLoader';
import { EntityHandler } from '../handlers/EntityHandler';
import { NpcHandler } from '../handlers/NpcHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { BitReader } from '../network/protocol/bitReader';
import { parseSwz } from '../scripts/swzPatchUtils';
import { getCraftTownHomeInstanceId } from '../utils/HomeVisitGuard';

const NEO_ID = 1761501;
// Library floor of a_Level_Home: the room sits at (-260, -1880), so this puts Neo
// next to the two tomes, which stand on the same floor line at world y -1058.
const NEO_LIBRARY_X = 301;
const NEO_LIBRARY_Y = -1058;

// Neo's art is imported into the Rival slots, but it was drawn against the Book
// (Dyer) NPC, which is also where his body proportions come from. Each Rival
// shape therefore carries the matching Book part's footprint, and that footprint
// is what anchors the part on the ReadyLongCoat rig -- the stock Rival anchors
// sat ~178 twips low and buried his head in his collar.
const NEO_PART_FOOTPRINTS: Record<string, { neo: number; book: number }> = {
    Face2: { neo: 481, book: 1320 },
    OvercoatBack: { neo: 327, book: 343 },
    OvercoatFront: { neo: 301, book: 317 },
    SlackerLegs: { neo: 199, book: 217 },
    Torso07: { neo: 55, book: 71 }
};
const DEFINE_SHAPE_TAGS = new Set([2, 22, 32, 83]);
const DEFINE_SPRITE_TAG = 39;
const PLACE_OBJECT2_TAG = 26;

// Every part's placement is solved from Neo's Figma composition, mapping each
// frame through the rig chain at 21.2506 twips per Figma unit. The scales are
// non-uniform because each shape's container squashed the imported SVG; these
// matrices undo that, so the figure matches the drawn proportions. The front
// arm additionally carries the composition's -3.17 degree rotation.
const NEO_PART_PLACEMENT: Record<string, {
    sprite: number; scaleX: number; scaleY: number; rs0: number; rs1: number; x: number; y: number;
}> = {
    head: { sprite: 482, scaleX: 4.3662, scaleY: 3.0075, rs0: 0, rs1: 0, x: 857, y: 162 },
    torso: { sprite: 56, scaleX: 8.2931, scaleY: 7.0368, rs0: 0, rs1: 0, x: -39, y: 695 },
    backArm: { sprite: 328, scaleX: 4.4135, scaleY: 4.6498, rs0: 0, rs1: 0, x: -77, y: 250 },
    frontArm: { sprite: 302, scaleX: 5.5901, scaleY: 5.5598, rs0: 0.3096, rs1: -0.3079, x: 68, y: 315 },
    legs: { sprite: 200, scaleX: 7.4181, scaleY: 6.8498, rs0: 0, rs1: 0, x: 93, y: 57 }
};
function readSwfTags(file: string): { code: number; payload: Buffer }[] {
    const raw = fs.readFileSync(file);
    const body = raw.subarray(0, 3).toString('ascii') === 'CWS'
        ? zlib.inflateSync(raw.subarray(8))
        : raw.subarray(8);
    // Frame header: a RECT (5 size bits, 4 fields) then frame rate and count.
    return readTagStream(body, Math.ceil((5 + 4 * (body[0] >> 3)) / 8) + 4);
}

function readTagStream(buf: Buffer, start: number): { code: number; payload: Buffer }[] {
    const tags: { code: number; payload: Buffer }[] = [];
    let pos = start;
    while (pos + 2 <= buf.length) {
        const header = buf.readUInt16LE(pos);
        pos += 2;
        const code = header >> 6;
        let len = header & 0x3f;
        if (len === 0x3f) {
            len = buf.readUInt32LE(pos);
            pos += 4;
        }
        if (code === 0) {
            break;
        }
        tags.push({ code, payload: buf.subarray(pos, pos + len) });
        pos += len;
    }
    return tags;
}

/** Reads a DefineShape's bounds RECT (twips), which follows the 2-byte shape id. */
function readShapeBounds(payload: Buffer): [number, number, number, number] {
    let pos = 2;
    let bit = 0;
    const read = (count: number): number => {
        let value = 0;
        for (let i = 0; i < count; i += 1) {
            value = (value << 1) | ((payload[pos] >> (7 - bit)) & 1);
            bit += 1;
            if (bit === 8) {
                bit = 0;
                pos += 1;
            }
        }
        return value;
    };
    const readSigned = (count: number): number => {
        const value = read(count);
        return count && (value & (1 << (count - 1))) ? value - (1 << count) : value;
    };

    const bits = read(5);
    return [readSigned(bits), readSigned(bits), readSigned(bits), readSigned(bits)];
}

/** Reads scale and translation out of a PlaceObject2 MATRIX. */
function readPlaceMatrix(payload: Buffer): { scaleX: number; scaleY: number; rs0: number; rs1: number; x: number; y: number } {
    const flags = payload[0];
    assert.ok(flags & 0x04, 'PlaceObject2 should carry a matrix');
    let pos = 3 + ((flags & 0x02) ? 2 : 0); // flags, depth, optional character id
    let bit = 0;
    const read = (count: number): number => {
        let value = 0;
        for (let i = 0; i < count; i += 1) {
            value = (value << 1) | ((payload[pos] >> (7 - bit)) & 1);
            bit += 1;
            if (bit === 8) {
                bit = 0;
                pos += 1;
            }
        }
        return value;
    };
    const readSigned = (count: number): number => {
        const value = read(count);
        return count && (value & (1 << (count - 1))) ? value - (1 << count) : value;
    };

    let scaleX = 1;
    let scaleY = 1;
    if (read(1)) {
        const bits = read(5);
        scaleX = readSigned(bits) / 65536; // 16.16 fixed point
        scaleY = readSigned(bits) / 65536;
    }
    let rs0 = 0;
    let rs1 = 0;
    if (read(1)) {
        const bits = read(5);
        rs0 = readSigned(bits) / 65536;
        rs1 = readSigned(bits) / 65536;
    }
    const translateBits = read(5);
    return { scaleX, scaleY, rs0, rs1, x: readSigned(translateBits), y: readSigned(translateBits) };
}

function testNeoPartPlacement(): void {
    const tags = readSwfTags(path.resolve(__dirname, '../../client/content/localhost/p/cag/Animation_NPC.swf'));
    for (const [part, expected] of Object.entries(NEO_PART_PLACEMENT)) {
        const sprite = tags.find((tag) => tag.code === DEFINE_SPRITE_TAG
            && tag.payload.length >= 4
            && tag.payload.readUInt16LE(0) === expected.sprite);
        assert.ok(sprite, `Animation_NPC.swf should define Neo's ${part} sprite ${expected.sprite}`);

        // DefineSprite payload: spriteId, frameCount, then a nested tag stream.
        const place = readTagStream(sprite!.payload, 4).find((tag) => tag.code === PLACE_OBJECT2_TAG);
        assert.ok(place, `Neo's ${part} sprite should place its shape`);

        const matrix = readPlaceMatrix(place!.payload);
        assert.deepEqual(
            { x: matrix.x, y: matrix.y },
            { x: expected.x, y: expected.y },
            `Neo's ${part} placement drifted`
        );
        // Scale is 16.16 fixed point, so fractional values need not round-trip exactly.
        for (const axis of ['scaleX', 'scaleY', 'rs0', 'rs1'] as const) {
            assert.ok(
                Math.abs(matrix[axis] - expected[axis]) < 1e-4,
                `Neo's ${part} ${axis} drifted: ${matrix[axis]} != ${expected[axis]}`
            );
        }
    }
}

function testNeoPartsUseBookFootprints(): void {
    const tags = readSwfTags(path.resolve(__dirname, '../../client/content/localhost/p/cag/Animation_NPC.swf'));
    const bounds = new Map<number, [number, number, number, number]>();
    for (const tag of tags) {
        if (DEFINE_SHAPE_TAGS.has(tag.code) && tag.payload.length >= 2) {
            bounds.set(tag.payload.readUInt16LE(0), readShapeBounds(tag.payload));
        }
    }

    for (const [part, { neo, book }] of Object.entries(NEO_PART_FOOTPRINTS)) {
        const neoBounds = bounds.get(neo);
        const bookBounds = bounds.get(book);
        assert.ok(neoBounds, `Animation_NPC.swf should define Neo's ${part} shape ${neo}`);
        assert.ok(bookBounds, `Animation_NPC.swf should define the Book ${part} shape ${book}`);
        assert.deepEqual(
            neoBounds,
            bookBounds,
            `Neo's ${part} must keep the Book footprint so it anchors on the LongCoat rig`
        );
    }
}

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
    if (!NpcDialogueLoader.isLoaded()) {
        NpcDialogueLoader.load(dataDir);
    }
}

function createFakeClient(name: string): any {
    const sentPackets: { id: number; payload: Buffer }[] = [];
    return {
        token: 1,
        character: { name, level: 50, class: 'mage', gold: 0 },
        characters: [] as any[],
        scheduleCharacterSave() { /* persistence is not what this test covers */ },
        currentLevel: 'CraftTown',
        levelInstanceId: getCraftTownHomeInstanceId({ name } as never),
        currentRoomId: 0,
        playerSpawned: true,
        clientEntID: 1001,
        userId: 1,
        knownEntityIds: new Set<number>(),
        entityIdAliases: new Map<number, number>(),
        sharedEntityRemoteUpdateDeferredIds: new Set<number>(),
        entities: new Map<number, any>(),
        sentPackets,
        send(id: number, payload: Buffer) {
            sentPackets.push({ id, payload: Buffer.from(payload) });
        },
        sendBitBuffer(id: number, bb: BitBuffer) {
            sentPackets.push({ id, payload: bb.toBuffer() });
        }
    };
}

function readSerializedNpcEntity(payload: Buffer): Record<string, unknown> {
    const br = new BitReader(payload);
    const id = br.readMethod4();
    const name = br.readMethod13();
    const isPlayer = br.readMethod15();
    const x = br.readMethod45();
    const y = br.readMethod45();
    br.readMethod45(); // velocity
    const team = br.readMethod6(Entity.TEAM_BITS);
    br.readMethod6(1); // player extras flag
    br.readMethod6(1); // untargetable
    br.readMethod706(); // render depth offset
    if (br.readMethod6(1)) {
        br.readMethod4(); // behavior speed
    }
    // The cue's character_name is what makes the client treat an entity as a
    // talkable NPC; without it Neo is just scenery.
    const characterName = br.readMethod6(1) ? br.readMethod13() : '';
    return { id, name, isPlayer, x, y, team, characterName };
}

function testCraftTownAuthoredNeoNpcSpawnsAfterPlayerSpawn(): void {
    ensureDataLoaded();
    GlobalState.levelEntities.clear();

    const client = createFakeClient('NeoHomeOwner');
    EntityHandler.sendInitialLevelEntities(client, 'CraftTown');
    assert.equal(client.sentPackets.length, 0, 'client-spawn Home should not seed NPCs during initial level load');

    EntityHandler.sendCraftTownAuthoredNpcs(client);

    // Two server-owned figures stand in Craft Town now: Archivist Neo in the
    // library, and Titus on the path under the Legends' Inn portal. This test is
    // Neo's, so it picks him out rather than assuming he is the only one.
    const spawnPackets = client.sentPackets.filter((packet: any) => packet.id === 0x0F);
    assert.equal(spawnPackets.length, 2, 'Neo and Titus should both be sent after player spawn');
    const neoPacket = spawnPackets.find(
        (packet: any) => Number(readSerializedNpcEntity(packet.payload).id) === NEO_ID
    );
    assert.ok(neoPacket, 'authored Home NPC should be sent after player spawn');
    assert.deepEqual(readSerializedNpcEntity(neoPacket.payload), {
        id: NEO_ID,
        name: 'NPCHomeNeo',
        isPlayer: false,
        x: NEO_LIBRARY_X,
        y: NEO_LIBRARY_Y,
        team: 3,
        characterName: 'Special_XPBonus'
    });
    assert.equal(client.entities.get(NEO_ID)?.name, 'NPCHomeNeo');
    assert.equal(client.knownEntityIds.has(NEO_ID), true);

    const levelMap = GlobalState.levelEntities.get(`CraftTown#${client.levelInstanceId}`);
    assert.equal(levelMap?.get(NEO_ID)?.clientSpawned, false);

    EntityHandler.sendCraftTownAuthoredNpcs(client);
    assert.equal(
        client.sentPackets.filter((packet: any) => packet.id === 0x0F).length,
        2,
        'known Home NPCs should not duplicate'
    );
}

/** Talking to an NPC is packet 0x7A: a single method_9 entity id. */
function talkTo(client: any, npcId: number): string {
    const bb = new BitBuffer();
    bb.writeMethod9(npcId);
    client.sentPackets.length = 0;
    NpcHandler.handleTalkToNpc(client, bb.toBuffer());

    const bubble = client.sentPackets.find((packet: any) => packet.id === 0x76);
    assert.ok(bubble, `talking to ${npcId} should send a room-thought bubble`);
    const br = new BitReader(bubble.payload);
    br.readMethod4(); // entity id
    return br.readMethod13();
}

function testHomeNpcsAnswerWhenTalkedTo(): void {
    ensureDataLoaded();
    GlobalState.levelEntities.clear();

    const client = createFakeClient('NeoHomeTalker');
    EntityHandler.sendCraftTownAuthoredNpcs(client);
    // The tomes and the mailbox are authored in LevelsHome.swf, so the client spawns
    // them and reports them with an entity name but no character_name.
    for (const [id, name] of [[900001, 'NPCHomeMailbox'], [900002, 'NPCHomeXPBonus']] as const) {
        client.entities.set(id, { id, name, isPlayer: false, characterName: '' });
    }

    for (const [id, npcKey] of [
        [900001, 'npchomemailbox'],
        [900002, 'npchomexpbonus']
    ] as const) {
        const line = talkTo(client, id);
        const expected = NpcDialogueLoader.getLinesForNpc('CraftTown', npcKey, client.character, 'en');
        assert.ok(expected.length > 0, `CraftTown should define dialogue for ${npcKey}`);
        assert.ok(
            expected.includes(line),
            `${npcKey} answered with "${line}" instead of one of its authored lines`
        );
    }
}

/**
 * Neo hands out achievements: the ledger is server-side and his bubble is the whole
 * UI, so talking to him has to report progress and pay out exactly once.
 */
function testNeoRunsTheAchievementLedger(): void {
    ensureDataLoaded();
    GlobalState.levelEntities.clear();

    const client = createFakeClient('NeoLedgerTester');
    client.character.gold = 0;
    EntityHandler.sendCraftTownAuthoredNpcs(client);

    const offer = talkTo(client, NEO_ID);
    assert.ok(offer.includes('two hundred and fifty goblin heads'), `expected the goblin offer, got "${offer}"`);

    for (let i = 0; i < 249; i += 1) {
        Achievements.noteEnemyDefeat(client.character, ['GoblinDagger']);
    }
    assert.ok(talkTo(client, NEO_ID).includes('249 of 250'), 'progress should be read back from the ledger');
    assert.equal(client.character.gold, 0, 'nothing is paid before the goal');

    Achievements.noteEnemyDefeat(client.character, ['IntroGoblinClub']);
    Achievements.notePlayerPosition(client.character, 'TutorialBoat', 60);
    const claim = talkTo(client, NEO_ID);
    assert.ok(claim.includes('I counted twice'), `expected the goblin payout, got "${claim}"`);
    assert.ok(claim.includes('king of nothing'), 'the boat climb should pay out in the same breath');
    assert.equal(client.character.gold, 30000, 'both rewards land on the character');
    assert.equal(
        client.sentPackets.filter((packet: any) => packet.id === 0x35).length,
        2,
        'each payout sends its own gold reward packet'
    );

    talkTo(client, NEO_ID);
    assert.equal(client.character.gold, 30000, 'a claimed achievement never pays twice');

    // Walking up to him is the real interaction: the Home level plays NPC chat
    // client-side, so a talk packet never arrives.
    const walker = createFakeClient('NeoWalker');
    assert.equal(Achievements.shouldGreet(walker, 400, 1000), false, 'far away is not a greeting');
    assert.equal(Achievements.shouldGreet(walker, 100, 1000), true, 'stepping into range greets once');
    assert.equal(Achievements.shouldGreet(walker, 100, 1500), false, 'standing there does not repeat it');
    assert.equal(Achievements.shouldGreet(walker, 300, 2000), false, 'walking away only re-arms');
    assert.equal(Achievements.shouldGreet(walker, 100, 40000), true, 'coming back later greets again');

    // Non-goblins and the wrong level must not move the ledger.
    const other = createFakeClient('NeoLedgerControl');
    assert.equal(Achievements.noteEnemyDefeat(other.character, ['BanditRogue2']), false);
    assert.equal(Achievements.notePlayerPosition(other.character, 'CraftTown', -5000), false);
    assert.equal(Achievements.notePlayerPosition(other.character, 'TutorialBoat', 600), false);
}

function testStaticServerAliasesVersionedManifestRequests(): void {
    const server = new StaticServer();
    const manifestRoute = (server as any).app.router.stack.find((layer: any) => {
        return String(layer.route?.path ?? '').includes('masterFileList');
    });

    assert.ok(manifestRoute, 'Static server should alias stale manifest requests such as /p/cbw/masterFileList.xml');
    assert.ok(manifestRoute.matchers?.[0]?.('/p/cbw/masterFileList.xml'));
    assert.equal(
        fs.existsSync(path.resolve(__dirname, '../../client/content/localhost/p/cbw/masterFileList.xml')),
        true
    );
}

function testLoginSwzIncludesHomeNeoEntType(): void {
    const ctx = parseSwz(path.resolve(__dirname, '../../client/content/localhost/p/cbq/Login.swz'));
    const entTypes = ctx.chunks.find((entry: any) => entry.xml.includes('<EntTypes'));

    assert.ok(entTypes, 'Login.swz should include EntTypes data');
    const neo = entTypes!.xml.match(/<EntType EntName="NPCHomeNeo"[\s\S]*?<\/EntType>/);
    assert.ok(neo, 'Login.swz should include the NPCHomeNeo EntType');
    assert.equal(neo![0].includes('<DisplayName>Archivist Neo</DisplayName>'), true);
    assert.equal(neo![0].includes('<BaseAnim>ReadyLongCoat</BaseAnim>'), true);
    assert.equal(neo![0].includes('<CustomArt>Animation_NPC.swf/Rival</CustomArt>'), true);
    // Other NPCs on this rig sit at 0.6-0.7; Neo is deliberately the largest.
    assert.equal(neo![0].includes('<AnimScale>0.88</AnimScale>'), true);
}

function testNeoScaleMatchesSourceEntTypes(): void {
    const xml = fs.readFileSync(path.resolve(__dirname, '../../client/content/xml/EntTypes.xml'), 'utf8');
    const neo = xml.match(/<EntType EntName="NPCHomeNeo"[\s\S]*?<\/EntType>/);
    assert.ok(neo, 'source EntTypes.xml should include NPCHomeNeo');
    assert.equal(neo![0].includes('<AnimScale>0.88</AnimScale>'), true, 'source EntTypes.xml must not drift from Login.swz');
    assert.equal(neo![0].includes('<DisplayName>Archivist Neo</DisplayName>'), true, 'source EntTypes.xml must not drift from Login.swz');
}

function main(): void {
    testCraftTownAuthoredNeoNpcSpawnsAfterPlayerSpawn();
    testHomeNpcsAnswerWhenTalkedTo();
    testNeoRunsTheAchievementLedger();
    testStaticServerAliasesVersionedManifestRequests();
    testLoginSwzIncludesHomeNeoEntType();
    testNeoScaleMatchesSourceEntTypes();
    testNeoPartsUseBookFootprints();
    testNeoPartPlacement();
    console.log('npc_home_neo_regression passed');
}

main();
