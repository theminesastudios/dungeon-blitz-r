/// <reference types="node" />

import './helpers/disable_production_mongo';
import { strict as assert } from 'assert';
import fs from 'fs';
import path from 'path';
import { JsonAdapter } from '../database/JsonAdapter';
import { TalentHandler } from '../handlers/TalentHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';

const ROOT = path.resolve(__dirname, '..', '..', '..');

function trainTalentPacket(classIndex: number, instant: boolean): Buffer {
    const packet = new BitBuffer(false);
    packet.writeMethod20(2, classIndex);
    packet.writeMethod15(instant);
    return packet.toBuffer();
}

async function testJusticarPointFiftyCanBeBought(): Promise<void> {
    const originalSave = JsonAdapter.prototype.saveCharacterSnapshot;
    let saves = 0;
    JsonAdapter.prototype.saveCharacterSnapshot = async function(_userId, character) {
        saves += 1;
        return [character];
    };

    const sentPackets: number[] = [];
    const client = {
        userId: 610,
        authenticated: true,
        playerSpawned: false,
        currentLevel: 'CraftTown',
        talentResearchTimer: null,
        character: {
            talentPoints: { '1': 50, '2': 49, '3': 50 },
            talentResearch: { classIndex: null, ReadyTime: 0 },
            mammothIdols: 0,
            gold: 25_898_090
        },
        characters: [],
        sendBitBuffer(id: number): void {
            sentPackets.push(id);
        }
    };

    try {
        await TalentHandler.handleTrainTalentPoint(client as never, trainTalentPacket(2, false));
    } finally {
        JsonAdapter.prototype.saveCharacterSnapshot = originalSave;
    }

    assert.equal(client.character.talentPoints['2'], 50, 'Justicar must advance from 49 to 50');
    assert.equal(client.character.gold, 0, 'the rank-50 Gold cost must be charged once');
    assert.deepEqual(client.character.talentResearch, { classIndex: null, ReadyTime: 0 });
    assert.equal(saves, 1, 'the completed point must be persisted once');
    assert.deepEqual(sentPackets, [0xD5], 'the completion packet must be sent');
}

function testJusticarPreviewUsesAxeFlurryIcon(): void {
    const playerPowerTypes = fs.readFileSync(
        path.join(ROOT, 'src/client/content/xml/PlayerPowerTypes.xml'),
        'utf8'
    );
    const axeFlurryBlock = playerPowerTypes.match(
        /<Power PowerName="AxeFlurry">([\s\S]*?)<\/Power>/
    )?.[1];

    assert.ok(axeFlurryBlock, 'AxeFlurry power metadata must exist');
    assert.match(axeFlurryBlock, /<IconName>a_PowerIcon_AxeFlurry<\/IconName>/);
    assert.doesNotMatch(axeFlurryBlock, /a_PowerIcon_(?:JusticarRanged|PoisonDagger)/);
}

async function main(): Promise<void> {
    await testJusticarPointFiftyCanBeBought();
    testJusticarPreviewUsesAxeFlurryIcon();
    console.log('justicar_open_issues_regression passed');
}

void main();
