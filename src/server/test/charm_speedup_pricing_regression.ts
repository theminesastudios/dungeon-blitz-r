/// <reference types="node" />

import './helpers/disable_production_mongo';
import { strict as assert } from 'assert';
import { Character } from '../database/Database';
import { JsonAdapter } from '../database/JsonAdapter';
import { ForgeHandler } from '../handlers/ForgeHandler';
import { CharmID } from '../data/runtime/Charms';
import { BitBuffer } from '../network/protocol/bitBuffer';

/*
 * Issue #645: Speed Up silently failed whenever the client's countdown and the server's
 * disagreed. Both clocks price the same button, and the server dropped the request with
 * no packet back when they landed on different sides of a boundary:
 *
 *   - the client turned the button Free while the server still wanted an idol;
 *   - the server priced a 24h Respec Stone one idol above what the player was shown, so a
 *     player holding exactly the displayed price could not pay it.
 *
 * Nothing here is about the amount being wrong. It is about the request vanishing.
 */

const SECONDS_PER_IDOL = 1_200;

function nowSeconds(): number {
    return Math.floor(Date.now() / 1000);
}

function speedUpPacket(idolCost: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod9(idolCost);
    return bb.toBuffer();
}

function createCharacter(): Character {
    return {
        name: 'Smith',
        class: 'mage',
        gender: 'male',
        level: 20,
        xp: 200_000,
        gold: 1_000,
        mammothIdols: 0,
        learnedAbilities: [],
        activeAbilities: [],
        SkillResearch: {},
        craftTalentPoints: [0, 0, 0, 0, 0],
        craftXP: 0,
        materials: [],
        consumables: [],
        charms: [],
        magicForge: {
            stats_by_building: { '1': 10, '2': 10, '6': 1, '12': 1, '13': 1 },
            primary: 0,
            secondary: 0,
            secondary_tier: 0,
            usedlist: 0,
            ReadyTime: 0,
            forge_roll_a: 0,
            forge_roll_b: 0,
            is_extended_forge: false
        },
        CurrentLevel: { name: 'CraftTown', x: 0, y: 0 },
        PreviousLevel: { name: 'NewbieRoad', x: 0, y: 0 }
    } as unknown as Character;
}

function createClient(character: Character): any {
    const sentPackets: Array<{ id: number; payload: Buffer }> = [];
    return {
        userId: 4_040,
        token: 9_100,
        currentLevel: 'CraftTown',
        character,
        craftTownHostCharacter: null,
        characters: [character],
        socket: { destroyed: false },
        authenticated: true,
        sentPackets,
        send(id: number, payload: Buffer): void {
            sentPackets.push({ id, payload: Buffer.from(payload) });
        },
        sendBitBuffer(id: number, bb: BitBuffer): void {
            sentPackets.push({ id, payload: bb.toBuffer() });
        }
    };
}

async function withCapturedSaves<T>(fn: () => Promise<T>): Promise<T> {
    const original = JsonAdapter.prototype.saveCharacterSnapshot;
    JsonAdapter.prototype.saveCharacterSnapshot = async function(_userId: number, character: Character) {
        return [character];
    };
    try {
        return await fn();
    } finally {
        JsonAdapter.prototype.saveCharacterSnapshot = original;
    }
}

function completed(character: Character): boolean {
    return Number((character as any).magicForge?.ReadyTime ?? 0) === 0;
}

// The client shows Free below three minutes on its own clock. An 11-second offset used to
// put the server outside its 10-second grace and the request went nowhere.
async function testFreeSpeedUpSurvivesClockDrift(): Promise<void> {
    const character = createCharacter();
    (character as any).magicForge.primary = CharmID.Trog02;
    (character as any).magicForge.ReadyTime = nowSeconds() + 191;
    const client = createClient(character);

    await withCapturedSaves(async () => {
        await ForgeHandler.handleForgeSpeedUpPacket(client, speedUpPacket(0));
    });

    assert.ok(completed(character), 'a Free Speed Up 11s outside the old grace must still complete');
    assert.equal(Number(character.mammothIdols ?? 0), 0, 'Free means free');
    assert.ok(client.sentPackets.some((p: any) => p.id === 0xCD), 'the client must get a result packet');
}

// A drift big enough to be a real desync is still refused rather than trusted blindly.
async function testFreeSpeedUpIsStillRefusedFarFromTheWindow(): Promise<void> {
    const character = createCharacter();
    (character as any).magicForge.primary = CharmID.Trog02;
    (character as any).magicForge.ReadyTime = nowSeconds() + 3_600;
    const client = createClient(character);

    await withCapturedSaves(async () => {
        await ForgeHandler.handleForgeSpeedUpPacket(client, speedUpPacket(0));
    });

    assert.equal(completed(character), false, 'an hour out is not the Free window on anyone\'s clock');
    assert.ok(
        client.sentPackets.some((p: any) => p.id === 0xE3),
        'a refused request must still refresh the screen, or the button stays dead'
    );
}

/*
 * The other half of "silently". class_75.method_1124 disables the Speed Up button the
 * moment it is clicked, and OnRefreshScreen is the only thing that re-enables it. Every
 * path that refuses a request has to send 0xE3 or the button is dead until relog -- which
 * is what players actually experience as "Speed Up does nothing".
 */
async function testEveryRefusalRefreshesTheForgeScreen(): Promise<void> {
    const cases: Array<[string, (c: Character) => void, Buffer]> = [
        ['no active forge', () => {}, speedUpPacket(3)],
        [
            'not enough idols',
            (c) => {
                (c as any).magicForge.primary = CharmID.Trog02;
                (c as any).magicForge.ReadyTime = nowSeconds() + 7_200;
                c.mammothIdols = 0;
            },
            speedUpPacket(6)
        ],
        [
            'malformed packet',
            (c) => {
                (c as any).magicForge.primary = CharmID.Trog02;
                (c as any).magicForge.ReadyTime = nowSeconds() + 7_200;
            },
            Buffer.alloc(0)
        ]
    ];

    for (const [label, arrange, packet] of cases) {
        const character = createCharacter();
        arrange(character);
        const client = createClient(character);

        await withCapturedSaves(async () => {
            await ForgeHandler.handleForgeSpeedUpPacket(client, packet);
        });

        assert.ok(
            !client.sentPackets.some((p: any) => p.id === 0xCD),
            `${label}: a refused request must not report a finished charm`
        );
        assert.ok(
            client.sentPackets.some((p: any) => p.id === 0xE3),
            `${label}: must refresh the forge screen so the button comes back`
        );
    }
}

function armExtendedRespecStone(character: Character, remainingSeconds: number): void {
    // persistedDuration === target && startedAt > 0 makes enforceActiveRespecStoneDuration
    // leave ReadyTime alone, so the test controls the remaining time exactly.
    const forge: any = (character as any).magicForge;
    forge.primary = CharmID.RespecStone;
    forge.is_extended_forge = true;
    forge.respec_duration_seconds = 86_400;
    forge.respec_started_time = nowSeconds() - 10;
    forge.ReadyTime = nowSeconds() + remainingSeconds;
}

// The reported case: at a 20-minute boundary the server ceils to one idol more than the
// client displayed, and a player holding exactly the displayed price was refused.
async function testRespecStoneHonoursTheDisplayedPrice(): Promise<void> {
    const character = createCharacter();
    armExtendedRespecStone(character, 2 * SECONDS_PER_IDOL + 1);
    character.mammothIdols = 2;
    const client = createClient(character);

    await withCapturedSaves(async () => {
        await ForgeHandler.handleForgeSpeedUpPacket(client, speedUpPacket(2));
    });

    assert.ok(completed(character), 'the Speed Up the player was shown must go through');
    assert.equal(Number(character.mammothIdols ?? 0), 0, 'and bill exactly the displayed price');
    assert.ok(client.sentPackets.some((p: any) => p.id === 0xCD), 'the client must get a result packet');
}

// The tolerance is one idol, not a blank cheque.
async function testRespecStoneRejectsAnUnderpricedClaim(): Promise<void> {
    const character = createCharacter();
    armExtendedRespecStone(character, 10 * SECONDS_PER_IDOL);
    character.mammothIdols = 50;
    const client = createClient(character);

    await withCapturedSaves(async () => {
        await ForgeHandler.handleForgeSpeedUpPacket(client, speedUpPacket(1));
    });

    assert.ok(completed(character), 'the forge still completes -- the player can afford the real price');
    assert.equal(
        Number(character.mammothIdols ?? 0),
        40,
        'a claim more than one idol under the server price is ignored and the real price billed'
    );
}

// Every charm is priced from the server's timer, not just the Respec Stone. A client whose
// clock runs fast -- a Cheat Engine speedhack drives mServerGameTime, which is what the
// Speed Up button prices from -- declares a price far under ours and used to be billed it.
async function testOrdinaryCharmRejectsAnUnderpricedClaim(): Promise<void> {
    const character = createCharacter();
    (character as any).magicForge.primary = CharmID.Trog02;
    (character as any).magicForge.ReadyTime = nowSeconds() + (10 * SECONDS_PER_IDOL);
    character.mammothIdols = 50;
    const client = createClient(character);

    await withCapturedSaves(async () => {
        await ForgeHandler.handleForgeSpeedUpPacket(client, speedUpPacket(1));
    });

    assert.ok(completed(character), 'the forge still completes -- the player can afford the real price');
    assert.equal(Number(character.mammothIdols ?? 0), 40, 'a 10-idol Speed Up must not go through for 1');
}

// A truncated packet must be named, not thrown into the router's catch where it looks
// exactly like the silent failure being fixed.
async function testMalformedPacketIsIgnoredCleanly(): Promise<void> {
    const character = createCharacter();
    (character as any).magicForge.primary = CharmID.Trog02;
    (character as any).magicForge.ReadyTime = nowSeconds() + 3_600;
    const client = createClient(character);

    await withCapturedSaves(async () => {
        await ForgeHandler.handleForgeSpeedUpPacket(client, Buffer.alloc(0));
    });

    assert.equal(completed(character), false, 'a malformed packet must not complete a forge');
}

async function main(): Promise<void> {
    await testFreeSpeedUpSurvivesClockDrift();
    await testFreeSpeedUpIsStillRefusedFarFromTheWindow();
    await testRespecStoneHonoursTheDisplayedPrice();
    await testRespecStoneRejectsAnUnderpricedClaim();
    await testOrdinaryCharmRejectsAnUnderpricedClaim();
    await testMalformedPacketIsIgnoredCleanly();
    await testEveryRefusalRefreshesTheForgeScreen();
    console.log('charm_speedup_pricing_regression: ok');
}

void main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
