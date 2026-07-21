/// <reference types="node" />

import './helpers/disable_production_mongo';
import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { GlobalState } from '../core/GlobalState';
import { EntityTeam } from '../core/Entity';
import { getLevelScopeKey } from '../core/LevelScope';
import { LevelHandler } from '../handlers/LevelHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';

const ROOT = path.resolve(__dirname, '..', '..', '..');

function targetablePacket(entityId: number, untargetable: boolean): Buffer {
    const packet = new BitBuffer(false);
    packet.writeMethod4(entityId);
    packet.writeMethod15(untargetable);
    return packet.toBuffer();
}

function testFablePhaseTargetabilityIsServerAuthoritative(): void {
    const levelName = 'JC_Mission5';
    const levelInstanceId = 'fable-phase-regression';
    const scope = getLevelScopeKey(levelName, levelInstanceId);
    const boss = {
        id: 584001,
        name: 'NephitDragon',
        characterName: ',NephitDragon',
        team: EntityTeam.ENEMY,
        isPlayer: false,
        hp: 1000,
        maxHp: 1000,
        untargetable: false
    };
    const localBoss = { ...boss };
    const client = {
        token: 584,
        currentLevel: levelName,
        levelInstanceId,
        currentRoomId: undefined,
        entities: new Map([[boss.id, localBoss]]),
        send(): void {}
    };

    GlobalState.levelEntities.set(scope, new Map([[boss.id, boss]]));
    try {
        LevelHandler.handleSetUntargetable(client as never, targetablePacket(boss.id, true));
        assert.equal(localBoss.untargetable, true, 'the local Nephit Dragon must lock during a Paladin turn');
        assert.equal(boss.untargetable, true, 'the canonical Nephit Dragon must reject damage during a Paladin turn');

        LevelHandler.handleSetUntargetable(client as never, targetablePacket(boss.id, false));
        assert.equal(localBoss.untargetable, false, 'the local Nephit Dragon must unlock for its combat phase');
        assert.equal(boss.untargetable, false, 'the canonical Nephit Dragon must unlock for its combat phase');
    } finally {
        GlobalState.levelEntities.delete(scope);
    }
}

function testAuthoredShieldAndDamageGuardRemainPresent(): void {
    const monsterBuffTypes = fs.readFileSync(
        path.join(ROOT, 'src/client/content/xml/MonsterBuffTypes.xml'),
        'utf8'
    );
    const shield = monsterBuffTypes.match(
        /<BuffType BuffName="NephitDragonShield">([\s\S]*?)<\/BuffType>/
    )?.[1];
    assert.ok(shield, 'NephitDragonShield metadata must exist');
    assert.match(shield, /<Effect>Stealthed,Invulnerable<\/Effect>/);

    const combatHandler = fs.readFileSync(path.join(__dirname, '..', 'handlers', 'CombatHandler.ts'), 'utf8');
    assert.match(
        combatHandler,
        /targetEntity\s*&&\s*!targetEntity\.isPlayer\s*&&\s*Boolean\(targetEntity\.untargetable\)[\s\S]*?return;/,
        'authoritative combat must reject damage to phase-locked enemies'
    );
}

testFablePhaseTargetabilityIsServerAuthoritative();
testAuthoredShieldAndDamageGuardRemainPresent();
console.log('Fable phase untargetable regression passed (#584).');
