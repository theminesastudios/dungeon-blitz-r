/// <reference types="node" />

import './helpers/disable_production_mongo';
import { strict as assert } from 'assert';
import { Character } from '../database/Database';
import { JsonAdapter } from '../database/JsonAdapter';
import { AbilityHandler } from '../handlers/AbilityHandler';
import { ForgeHandler } from '../handlers/ForgeHandler';
import { CharacterHandler } from '../handlers/CharacterHandler';
import { LevelHandler } from '../handlers/LevelHandler';
import { CharmID } from '../data/runtime/Charms';
import { ConsumableID } from '../data/runtime/Consumables';
import { MaterialID } from '../data/runtime/Materials';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { WorldEnter } from '../utils/WorldEnter';

type FakeClient = {
    userId: number;
    token: number;
    currentLevel: string;
    character: Character;
    craftTownHostCharacter: Character | null;
    characters: Character[];
    socket: { destroyed: boolean };
    authenticated: boolean;
    sentPackets: Array<{ id: number; payload: Buffer }>;
    send(id: number, payload: Buffer): void;
    sendBitBuffer(id: number, bb: BitBuffer): void;
};

function clone<T>(value: T): T {
    return structuredClone(value);
}

function createCharacter(name: string, tomeRank: number, forgeRank: number): Character {
    return {
        name,
        class: 'mage',
        gender: 'male',
        level: 20,
        xp: 200000,
        gold: 10_000_000,
        mammothIdols: 500,
        learnedAbilities: [{ abilityID: 10, rank: 2 }, { abilityID: 14, rank: 1 }],
        activeAbilities: [10, 14],
        SkillResearch: {},
        craftTalentPoints: [0, 0, 0, 0, 0],
        craftXP: 0,
        materials: [{ materialID: MaterialID.TrogGoblinM, count: 2 }],
        consumables: [{ consumableID: ConsumableID.MinorRareCatalyst, count: 1 }],
        charms: [],
        magicForge: {
            stats_by_building: {
                '1': tomeRank,
                '2': forgeRank,
                '6': 1,
                '12': 1,
                '13': 1
            },
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
    };
}

function createClient(): FakeClient {
    const character = createCharacter('Visitor', 2, 1);
    const sentPackets: Array<{ id: number; payload: Buffer }> = [];
    return {
        userId: 991,
        token: 7001,
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

function startForgePacket(
    primary: number,
    materials: Array<{ id: number; count: number }> = [],
    catalystFlags: boolean[] = []
): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod20(7, primary);
    for (const material of materials) {
        bb.writeMethod15(true);
        bb.writeMethod20(7, material.id);
        bb.writeMethod20(7, material.count);
    }
    bb.writeMethod15(false);
    for (let index = 0; index < 4; index += 1) {
        bb.writeMethod15(Boolean(catalystFlags[index]));
    }
    return bb.toBuffer();
}

function abilityResearchPacket(abilityId: number, rank: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod20(7, abilityId);
    bb.writeMethod20(4, rank);
    bb.writeMethod15(false);
    return bb.toBuffer();
}

function forgeConsumablePacket(consumableId: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod20(5, consumableId);
    return bb.toBuffer();
}

async function withCapturedSaves<T>(fn: (saves: Character[]) => Promise<T>): Promise<T> {
    const original = JsonAdapter.prototype.saveCharacterSnapshot;
    const saves: Character[] = [];
    JsonAdapter.prototype.saveCharacterSnapshot = async function(_userId: number, character: Character): Promise<Character[]> {
        saves.push(clone(character));
        return [character];
    };
    try {
        return await fn(saves);
    } finally {
        JsonAdapter.prototype.saveCharacterSnapshot = original;
    }
}

function testPlayerDataAlwaysUsesVisitorAuthority(): void {
    const visitor = createCharacter('Visitor', 2, 1);
    const host = createCharacter('Host', 5, 3);
    host.magicForge = {
        ...host.magicForge,
        stats_by_building: { ...(host.magicForge?.stats_by_building ?? {}) },
        primary: CharmID.Trog03,
        ReadyTime: Math.floor(Date.now() / 1000) + 3600
    };

    const state = WorldEnter.getPlayerDataBuildingState(visitor, 'CraftTown');
    assert.equal(state.statsByBuilding['1'], 2, '0x10 building authority must stay on the visitor Tome');
    assert.equal(state.statsByBuilding['2'], 1, '0x10 building authority must stay on the visitor Forge');
    assert.equal(Number(state.magicForge.primary ?? 0), 0, 'host forge timer/result must never enter visitor player data');

    const shouldSendExtended = (CharacterHandler as any).shouldSendExtendedPlayerData as (
        firstLogin: boolean,
        pendingExtended: boolean,
        entry: { targetLevel: string }
    ) => boolean;
    assert.equal(
        shouldSendExtended(false, false, { targetLevel: 'CraftTown' }),
        false,
        'Home transfers must not replay append-only inventory collections'
    );
    assert.equal(shouldSendExtended(true, false, { targetLevel: 'CraftTown' }), true);
    assert.equal(shouldSendExtended(false, true, { targetLevel: 'CraftTown' }), true);
    assert.equal((LevelHandler as any).shouldSendExtendedOnTransfer('CraftTown'), false);
}

function testHouseHostIsExplicitAndStaleStateIsCleared(): void {
    const client = createClient();
    const host = createCharacter('Host', 5, 3);
    const resolveHost = (LevelHandler as any).resolveVisitedCraftTownHostCharacter as (
        client: FakeClient,
        token: number,
        character: Character,
        targetLevel: string,
        explicitHost?: Character | null
    ) => Character;

    assert.equal(resolveHost(client, client.token, client.character, 'CraftTown', host).name, 'Host');
    assert.equal(client.craftTownHostCharacter?.name, 'Host');
    assert.equal(resolveHost(client, client.token, client.character, 'CraftTown').name, 'Visitor');
    assert.equal(client.craftTownHostCharacter, null, 'own Home transfer must clear the previous visit host');

    client.craftTownHostCharacter = host;
    assert.equal(resolveHost(client, client.token, client.character, 'NewbieRoad').name, 'Visitor');
    assert.equal(client.craftTownHostCharacter, null, 'leaving Home must clear the visit host');
}

async function testForgePreflightIsAtomicAndUsesOwnRank(): Promise<void> {
    const client = createClient();
    await withCapturedSaves(async (saves) => {
        const baseline = clone(client.character);
        await ForgeHandler.handleStartForge(client as never, startForgePacket(CharmID.Trog03));
        assert.deepEqual(client.character, baseline, 'Forge 1 must reject a rank-3 recipe');

        await ForgeHandler.handleStartForge(client as never, startForgePacket(127));
        await ForgeHandler.handleStartForge(client as never, startForgePacket(CharmID.TripleFind));
        assert.deepEqual(client.character, baseline, 'unknown and non-craftable charm IDs must be inert');

        await ForgeHandler.handleStartForge(
            client as never,
            startForgePacket(CharmID.Trog02, [{ id: MaterialID.TrogGoblinM, count: 3 }])
        );
        assert.deepEqual(client.character, baseline, 'insufficient materials must not partially mutate inventory');

        await ForgeHandler.handleStartForge(
            client as never,
            startForgePacket(CharmID.Trog02, [], [true, true])
        );
        assert.deepEqual(client.character, baseline, 'insufficient catalysts must not partially mutate inventory');

        await ForgeHandler.handleStartForge(client as never, startForgePacket(CharmID.Trog02));
        assert.equal(Number(client.character.magicForge?.primary ?? 0), CharmID.Trog02, 'Forge 1 must allow rank-2 recipes');
        assert.ok(Number(client.character.magicForge?.ReadyTime ?? 0) > Math.floor(Date.now() / 1000));
        const activeBaseline = clone(client.character);
        await ForgeHandler.handleStartForge(client as never, startForgePacket(CharmID.Trog01));
        assert.deepEqual(client.character, activeBaseline, 'a repeated start must not replace or reset an active forge');
        assert.equal(saves.length, 1, 'only the valid forge request may persist');
    });
}

async function testVisitedHomeForgeAndTomeMutationsAreInert(): Promise<void> {
    const client = createClient();
    client.craftTownHostCharacter = createCharacter('Host', 5, 3);
    const baseline = clone(client.character);

    await withCapturedSaves(async (saves) => {
        await ForgeHandler.handleStartForge(client as never, startForgePacket(CharmID.Trog02));
        await ForgeHandler.handleForgeSpeedUpPacket(client as never, Buffer.alloc(0));
        await ForgeHandler.handleCollectForgeCharm(client as never, Buffer.alloc(0));
        await ForgeHandler.handleCancelForge(client as never, Buffer.alloc(0));
        await ForgeHandler.handleUseForgeConsumable(client as never, forgeConsumablePacket(ConsumableID.ForgeXP));
        await ForgeHandler.handleAllocateMagicForgeArtisanSkillPoints(client as never, Buffer.alloc(0));
        await ForgeHandler.handleMagicForgeReroll(client as never, Buffer.alloc(0));
        await AbilityHandler.handleStartAbilityResearch(client as never, Buffer.alloc(0));
        await AbilityHandler.handleClaimAbilityResearch(client as never);
        await AbilityHandler.handleClearAbilityResearch(client as never);
        await AbilityHandler.handleSpeedupAbilityResearch(client as never, Buffer.alloc(0));

        assert.deepEqual(client.character, baseline);
        assert.equal(saves.length, 0, 'visited Home mutations must not reach persistence');
    });
}

async function testTomeRankIsAuthoritative(): Promise<void> {
    const client = createClient();
    await withCapturedSaves(async (saves) => {
        const baseline = clone(client.character);
        await AbilityHandler.handleStartAbilityResearch(client as never, abilityResearchPacket(10, 4));
        assert.deepEqual(client.character, baseline, 'Tome 2 must reject rank-4 research');
        assert.equal(saves.length, 0);

        await AbilityHandler.handleStartAbilityResearch(client as never, abilityResearchPacket(10, 3));
        assert.equal(Number(client.character.SkillResearch?.abilityID ?? 0), 10);
        assert.equal(Number(client.character.SkillResearch?.rank ?? 0), 3);
        assert.equal(saves.length, 1, 'valid own-Tome research must persist');
    });
}

async function testCompletedForgeClaimPersistsExactlyOnce(): Promise<void> {
    const client = createClient();
    client.character.magicForge = {
        ...client.character.magicForge,
        stats_by_building: { ...(client.character.magicForge?.stats_by_building ?? {}) },
        primary: CharmID.Trog02,
        secondary: 0,
        secondary_tier: 0,
        ReadyTime: Math.floor(Date.now() / 1000) - 1,
        forge_roll_a: 1,
        forge_roll_b: 2
    };

    await withCapturedSaves(async (saves) => {
        await ForgeHandler.handleCollectForgeCharm(client as never, Buffer.alloc(0));
        await ForgeHandler.handleCollectForgeCharm(client as never, Buffer.alloc(0));
        assert.equal(saves.length, 1, 'duplicate claim packets must not create duplicate saves/rewards');
        const reloaded = clone(saves[0]);
        assert.equal(Number(reloaded.magicForge?.primary ?? 0), 0);
        assert.equal(
            Number(reloaded.charms?.find((entry: any) => Number(entry.charmID) === CharmID.Trog02)?.count ?? 0),
            1,
            'the legitimately claimed charm must survive a persistence reload'
        );
    });
}

async function main(): Promise<void> {
    testPlayerDataAlwaysUsesVisitorAuthority();
    testHouseHostIsExplicitAndStaleStateIsCleared();
    await testForgePreflightIsAtomicAndUsesOwnRank();
    await testVisitedHomeForgeAndTomeMutationsAreInert();
    await testTomeRankIsAuthoritative();
    await testCompletedForgeClaimPersistsExactlyOnce();
    console.log('Home, Forge, and Tome authority regression checks passed.');
}

void main();
