import { strict as assert } from 'assert';
import * as path from 'path';
import { Character } from '../database/Database';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';
import { SocialHandler } from '../handlers/SocialHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { BitReader } from '../network/protocol/bitReader';

type SentPacket = {
    id: number;
    payload: Buffer;
};

type FakeClient = {
    token: number;
    userId: number | null;
    character: Character;
    characters: Character[];
    currentLevel: string;
    levelInstanceId: string;
    craftTownHostCharacter: Character | null;
    lastDoorId: number;
    lastDoorTargetLevel: string;
    mountTransferGraceUntil: number;
    armPendingTransferGrace: () => void;
    sentPackets: SentPacket[];
    send: (id: number, payload: Buffer) => void;
    sendBitBuffer: (id: number, bb: BitBuffer) => void;
};

function ensureLevelConfigLoaded(): void {
    if (!LevelConfig.has('NewbieRoad')) {
        LevelConfig.load(path.resolve(__dirname, '../data'));
    }
}

function createFakeClient(gold: number): FakeClient {
    const sentPackets: SentPacket[] = [];
    const character: Character = {
        name: 'Teleporter',
        class: 'Paladin',
        gender: 'male',
        level: 50,
        gold
    };

    return {
        token: Math.floor(Math.random() * 100000) + 1,
        userId: null,
        character,
        characters: [character],
        currentLevel: 'CraftTown',
        levelInstanceId: 'social-teleport-command-regression',
        craftTownHostCharacter: null,
        lastDoorId: -1,
        lastDoorTargetLevel: '',
        mountTransferGraceUntil: 0,
        armPendingTransferGrace() {
            return;
        },
        sentPackets,
        send(id: number, payload: Buffer) {
            sentPackets.push({ id, payload: Buffer.from(payload) });
        },
        sendBitBuffer(id: number, bb: BitBuffer) {
            sentPackets.push({ id, payload: bb.toBuffer() });
        }
    };
}

function buildPublicChatPacket(message: string): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod9(0);
    bb.writeMethod13(message);
    return bb.toBuffer();
}

function decodeGoldLoss(payload: Buffer): number {
    const br = new BitReader(payload);
    return br.readMethod4();
}

function decodeDoorTarget(payload: Buffer): { doorId: number; targetLevel: string } {
    const br = new BitReader(payload);
    return {
        doorId: br.readMethod4(),
        targetLevel: br.readMethod13()
    };
}

function decodeStatus(payload: Buffer): string {
    const br = new BitReader(payload);
    return br.readMethod13();
}

async function runTeleportCommand(client: FakeClient, command: string): Promise<void> {
    await SocialHandler.handlePublicChat(client as never, buildPublicChatPacket(command));
}

async function testPaidNormalTeleport(): Promise<void> {
    const client = createFakeClient(25_000);

    await runTeleportCommand(client, '/teleport:wolfs-end');

    assert.equal(client.character.gold, 5_000, 'normal teleport should deduct 20,000 gold');
    assert.equal(client.lastDoorId, 0);
    assert.equal(client.lastDoorTargetLevel, 'NewbieRoad');
    assert.equal(GlobalState.pendingTeleports.get(client.token)?.targetLevel, 'NewbieRoad');

    const goldLossPacket = client.sentPackets.find((packet) => packet.id === 0xB4);
    const transferPacket = client.sentPackets.find((packet) => packet.id === 0x2e);
    assert.ok(goldLossPacket, 'normal teleport should notify the gold loss');
    assert.ok(transferPacket, 'normal teleport should ask the client to transfer levels');
    assert.equal(decodeGoldLoss(goldLossPacket!.payload), 20_000);
    assert.deepEqual(decodeDoorTarget(transferPacket!.payload), {
        doorId: 0,
        targetLevel: 'NewbieRoad'
    });
}

async function testPaidDreadTeleport(): Promise<void> {
    const client = createFakeClient(40_000);

    await runTeleportCommand(client, '/teleport:dread-valhaven');

    assert.equal(client.character.gold, 0, 'dread teleport should deduct 40,000 gold');
    assert.equal(client.lastDoorTargetLevel, 'JadeCityHard');
    assert.equal(GlobalState.pendingTeleports.get(client.token)?.targetLevel, 'JadeCityHard');

    const goldLossPacket = client.sentPackets.find((packet) => packet.id === 0xB4);
    const transferPacket = client.sentPackets.find((packet) => packet.id === 0x2e);
    assert.ok(goldLossPacket, 'dread teleport should notify the gold loss');
    assert.ok(transferPacket, 'dread teleport should ask the client to transfer levels');
    assert.equal(decodeGoldLoss(goldLossPacket!.payload), 40_000);
    assert.deepEqual(decodeDoorTarget(transferPacket!.payload), {
        doorId: 0,
        targetLevel: 'JadeCityHard'
    });
}

async function testCemetryHillSlugMatchesRequestedCommand(): Promise<void> {
    const client = createFakeClient(20_000);

    await runTeleportCommand(client, '/teleport:cemetry-hill');

    assert.equal(client.character.gold, 0, 'cemetry-hill teleport should deduct 20,000 gold');
    assert.equal(GlobalState.pendingTeleports.get(client.token)?.targetLevel, 'CemeteryHill');
}

async function testInsufficientGoldBlocksTeleport(): Promise<void> {
    const client = createFakeClient(19_999);

    await runTeleportCommand(client, '/teleport:felbridge');

    assert.equal(client.character.gold, 19_999, 'failed teleport should not spend gold');
    assert.equal(GlobalState.pendingTeleports.has(client.token), false, 'failed teleport should not queue a transfer');
    assert.equal(client.sentPackets.some((packet) => packet.id === 0xB4), false, 'failed teleport should not send gold loss');
    assert.equal(client.sentPackets.some((packet) => packet.id === 0x2e), false, 'failed teleport should not ask for level transfer');

    const statusPacket = client.sentPackets.find((packet) => packet.id === 0x44);
    assert.ok(statusPacket, 'failed teleport should explain the missing gold');
    assert.equal(decodeStatus(statusPacket!.payload), 'You need 20,000 gold to teleport to Felbridge.');
}

async function main(): Promise<void> {
    ensureLevelConfigLoaded();

    try {
        GlobalState.pendingTeleports.clear();
        await testPaidNormalTeleport();

        GlobalState.pendingTeleports.clear();
        await testPaidDreadTeleport();

        GlobalState.pendingTeleports.clear();
        await testCemetryHillSlugMatchesRequestedCommand();

        GlobalState.pendingTeleports.clear();
        await testInsufficientGoldBlocksTeleport();
    } finally {
        GlobalState.pendingTeleports.clear();
    }

    console.log('social_teleport_command_regression: ok');
}

void main().catch((error) => {
    console.error('social_teleport_command_regression: failed');
    console.error(error);
    process.exitCode = 1;
});
