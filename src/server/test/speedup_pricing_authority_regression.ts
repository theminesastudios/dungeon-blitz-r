/// <reference types="node" />

import './helpers/disable_production_mongo';
import { strict as assert } from 'assert';
import { Character } from '../database/Database';
import { JsonAdapter } from '../database/JsonAdapter';
import { AbilityHandler } from '../handlers/AbilityHandler';
import { BuildingHandler } from '../handlers/BuildingHandler';
import { PetHandler } from '../handlers/PetHandler';
import { TalentHandler } from '../handlers/TalentHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';

/*
 * Every Speed Up button prices itself the same way client-side (Game.method_257):
 *
 *     cost = remaining <= 180 ? 0 : ceil(remaining / 1200)
 *
 * where remaining counts down against mServerGameTime -- a clock the client advances
 * itself from getTimer() (Game.method_1938). Run Flash's timer fast, with a Cheat Engine
 * speedhack or anything else, and every countdown in the game empties at that speed while
 * the button keeps asking to be billed whatever it now displays.
 *
 * The forge was fixed first (charm_speedup_pricing_regression). This covers the other five
 * screens, which all took the number in the packet at face value.
 */

const SECONDS_PER_IDOL = 1_200;
const TEN_IDOLS_OUT = 10 * SECONDS_PER_IDOL;

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
        mammothIdols: 50,
        learnedAbilities: [],
        activeAbilities: [],
        SkillResearch: {},
        talentPoints: {},
        talentResearch: {},
        TalentTree: {},
        pets: [],
        trainingPet: [],
        craftTalentPoints: [0, 0, 0, 0, 0],
        craftXP: 0,
        materials: [],
        consumables: [],
        charms: [],
        magicForge: { stats_by_building: {} },
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
        playerSpawned: false,
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

type SpeedupCase = {
    label: string;
    arm: (character: Character) => void;
    run: (client: any, packet: Buffer) => Promise<void>;
};

// Ten idols of work left, one idol declared. Anything that bills 1 is trusting the packet.
const cases: SpeedupCase[] = [
    {
        label: 'building upgrade',
        arm: (character) => {
            (character as any).buildingUpgrade = {
                buildingID: 1,
                rank: 2,
                ReadyTime: nowSeconds() + TEN_IDOLS_OUT
            };
        },
        run: (client, packet) => BuildingHandler.handleBuildingSpeedUpRequest(client, packet)
    },
    {
        label: 'ability research',
        arm: (character) => {
            (character as any).SkillResearch = {
                abilityID: 1,
                rank: 1,
                ReadyTime: nowSeconds() + TEN_IDOLS_OUT
            };
        },
        run: (client, packet) => AbilityHandler.handleSpeedupAbilityResearch(client, packet)
    },
    {
        label: 'talent research',
        arm: (character) => {
            (character as any).talentResearch = {
                classIndex: 1,
                ReadyTime: nowSeconds() + TEN_IDOLS_OUT
            };
        },
        run: (client, packet) => TalentHandler.handleTalentSpeedup(client, packet)
    },
    {
        label: 'pet training',
        arm: (character) => {
            (character as any).trainingPet = [{
                typeID: 1,
                special_id: 1,
                trainingTime: nowSeconds() + TEN_IDOLS_OUT
            }];
        },
        run: (client, packet) => PetHandler.handlePetSpeedUp(client, packet)
    },
    {
        label: 'egg hatchery',
        arm: (character) => {
            (character as any).EggHachery = {
                EggID: 1,
                ReadyTime: nowSeconds() + TEN_IDOLS_OUT,
                slotIndex: 0
            };
        },
        run: (client, packet) => PetHandler.handleEggSpeedUp(client, packet)
    }
];

async function testUnderpricedClaimsAreRepriced(): Promise<void> {
    for (const { label, arm, run } of cases) {
        const character = createCharacter();
        arm(character);
        const client = createClient(character);

        await withCapturedSaves(async () => {
            await run(client, speedUpPacket(1));
        });

        assert.equal(
            Number(character.mammothIdols ?? 0),
            40,
            `${label}: a 10-idol Speed Up must not go through for the 1 the client asked for`
        );
    }
}

// The displayed price is still honoured when the two clocks are only a little apart --
// refusing it is issue #645, and it is the reason the tolerance exists at all.
async function testHonestDriftIsStillHonoured(): Promise<void> {
    for (const { label, arm, run } of cases) {
        const character = createCharacter();
        arm(character);
        const client = createClient(character);

        await withCapturedSaves(async () => {
            await run(client, speedUpPacket(9));
        });

        assert.equal(
            Number(character.mammothIdols ?? 0),
            41,
            `${label}: one idol of clock drift must still be billed at the displayed price`
        );
    }
}

// Both pet screens spent the idols before checking there was anything to finish.
async function testNothingPendingCostsNothing(): Promise<void> {
    const paths: Array<[string, (client: any, packet: Buffer) => Promise<void>]> = [
        ['pet training', (client, packet) => PetHandler.handlePetSpeedUp(client, packet)],
        ['egg hatchery', (client, packet) => PetHandler.handleEggSpeedUp(client, packet)]
    ];

    for (const [label, run] of paths) {
        const character = createCharacter();
        const client = createClient(character);

        await withCapturedSaves(async () => {
            await run(client, speedUpPacket(5));
        });

        assert.equal(
            Number(character.mammothIdols ?? 0),
            50,
            `${label}: an empty ${label} must not take idols`
        );
        assert.ok(
            client.sentPackets.some((packet: any) => packet.id === 0xE3),
            `${label}: a refused request must refresh the screen, or the button stays dead`
        );
    }
}

async function main(): Promise<void> {
    await testUnderpricedClaimsAreRepriced();
    await testHonestDriftIsStillHonoured();
    await testNothingPendingCostsNothing();
    console.log('speedup_pricing_authority_regression: ok');
}

void main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
