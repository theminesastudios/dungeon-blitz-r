import { strict as assert } from 'assert';
import * as path from 'path';
import { GameData } from '../core/GameData';
import { LevelConfig } from '../core/LevelConfig';
import { ForgeHandler } from '../handlers/ForgeHandler';
import { CombatHandler } from '../handlers/CombatHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';

type FakeClient = {
    token: number;
    userId: number | null;
    character: any;
    characters: any[];
    currentLevel: string;
    levelInstanceId: string;
    currentRoomId: number;
    playerSpawned: boolean;
    clientEntID: number;
    sentPackets: Array<{ id: number; payload: Buffer }>;
    send: (id: number, payload: Buffer) => void;
    sendBitBuffer: (id: number, bb: BitBuffer) => void;
};

function ensureDataLoaded(): void {
    const dataDir = path.resolve(__dirname, '../data');
    if (!LevelConfig.has('CraftTown')) {
        LevelConfig.load(dataDir);
    }
    if (Object.keys(GameData.ENTTYPES).length === 0 || GameData.CHARMS.length === 0) {
        GameData.load(dataDir);
    }
}

function createFakeClient(character: any): FakeClient {
    const sentPackets: Array<{ id: number; payload: Buffer }> = [];
    return {
        token: 88001,
        userId: null,
        character,
        characters: [character],
        currentLevel: 'CraftTown',
        levelInstanceId: '',
        currentRoomId: 1,
        playerSpawned: true,
        clientEntID: 99001,
        sentPackets,
        send(id: number, payload: Buffer) {
            sentPackets.push({ id, payload: Buffer.from(payload) });
        },
        sendBitBuffer(id: number, bb: BitBuffer) {
            sentPackets.push({ id, payload: bb.toBuffer() });
        }
    };
}

async function assertOverflowedForgeReadyTimeIsClamped(): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const character = {
        name: 'ForgeOverflow',
        craftTalentPoints: [0, 0, 0, 0, 0],
        magicForge: {
            primary: 13,
            secondary: 0,
            secondary_tier: 0,
            usedlist: 0,
            ReadyTime: now + (49_710 * 24 * 60 * 60),
            forge_roll_a: 0,
            forge_roll_b: 0,
            is_extended_forge: false,
            stats_by_building: { '2': 3 }
        }
    };
    const client = createFakeClient(character);

    await ForgeHandler.syncCompletionState(client as never);

    const remainingSeconds = Number(character.magicForge.ReadyTime ?? 0) - Math.floor(Date.now() / 1000);
    assert.ok(remainingSeconds > 0, 'active forge should remain active after clamp');
    assert.ok(remainingSeconds <= 1_800, `streaked diamond forge time should clamp near its legal duration, got ${remainingSeconds}`);
}

function assertCriticalPowerNormalizesCritDamage(): void {
    const sourceClient = createFakeClient({
        name: 'CritPower',
        equippedGears: [
            {
                runes: [59]
            }
        ]
    });

    const normalized = (CombatHandler as any).normalizePlayerCriticalHitDamage(sourceClient, {
        targetId: 1,
        sourceId: sourceClient.clientEntID,
        damage: 11_196,
        powerId: 77,
        animOverrideId: null,
        effectOverrideId: null,
        isCrit: true
    });

    assert.equal(normalized, 22_952, 'Draconic10 critical power should make 11196 crit damage display as 22952');
    assert.equal(
        (CombatHandler as any).normalizePlayerCriticalHitDamage(sourceClient, {
            targetId: 1,
            sourceId: sourceClient.clientEntID,
            damage: 28_757,
            powerId: 77,
            animOverrideId: null,
            effectOverrideId: null,
            isCrit: true
        }),
        58_952,
        'Draconic10 critical power should make 28757 crit damage display as 58952'
    );
    assert.equal(
        (CombatHandler as any).normalizePlayerCriticalHitDamage(sourceClient, {
            targetId: 1,
            sourceId: sourceClient.clientEntID,
            damage: 11_196,
            powerId: 77,
            animOverrideId: null,
            effectOverrideId: null,
            isCrit: false
        }),
        11_196,
        'non-critical hits should not be multiplied'
    );
}

async function main(): Promise<void> {
    ensureDataLoaded();
    await assertOverflowedForgeReadyTimeIsClamped();
    assertCriticalPowerNormalizesCritDamage();
    console.log('forge_and_critical_regression passed');
}

void main().catch((error) => {
    console.error(error);
    process.exit(1);
});
