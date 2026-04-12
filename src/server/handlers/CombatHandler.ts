import { Client, clearKeepTutorialTimers } from '../core/Client';
import { BitReader } from '../network/protocol/bitReader';
import { GlobalState } from '../core/GlobalState';
import { BitBuffer } from '../network/protocol/bitBuffer';
import {
    noteDungeonRunCast,
    noteDungeonRunDeath,
    noteDungeonRunHit,
    noteDungeonRunKill
} from '../core/DungeonRunStats';
import { LevelHandler } from './LevelHandler';
import { EntityState, EntityTeam } from '../core/Entity';
import { EntityHandler } from './EntityHandler';
import { MissionHandler } from './MissionHandler';
import { areClientsInSameParty, getClientCharacterKey, sharesRoomIds, shouldShareCombatView } from '../core/PartySync';
import { areClientsInSameLevelScope, getClientLevelScope, getScopeLevelName } from '../core/LevelScope';
import {
    noteSharedDungeonHostileDestroyed,
    noteSharedDungeonHostileState,
    usesSharedDungeonProgress
} from '../core/SharedDungeonProgress';

type CombatRelayOptions = {
    includeAnchor?: boolean;
    referencedEntityIds?: number[];
};

type ContributionSnapshot = {
    nonce: number;
    contributors: string[];
};

type CombatPoint = {
    x: number;
    y: number;
};

type PowerCastRelayInfo = {
    sourceId: number;
    powerId: number;
    hasTargetEntity: boolean;
    hasTargetPos: boolean;
    targetPos: CombatPoint | null;
    projectileId: number | null;
    isPersistent: boolean;
    comboData: {
        isMelee: boolean;
        id: number;
    } | null;
};

type PowerHitRelayInfo = {
    targetId: number;
    sourceId: number;
    damage: number;
    powerId: number;
    animOverrideId: number | null;
    effectOverrideId: number | null;
    isCrit: boolean;
};

type PlayerHitResolution = {
    appliedDamage: number;
    killed: boolean;
};

export class CombatHandler {
    private static readonly RESPAWN_ENEMY_HEAL = 1_000_000;
    // Extracted from Game.swz power metadata: these target methods require a real target entity on the client.
    private static readonly UNSAFE_REMOTE_DIRECT_TARGET_POWER_IDS = new Set<number>([
        39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49,
        362, 363, 781, 1447, 1448, 1525, 1526, 1527, 1528, 1529, 1530, 1531, 1532, 1533, 1534,
        1535, 1536, 1537, 1538, 1539, 1540, 1541, 1542, 1543, 1544, 1545, 1546, 1547, 1548,
        1549, 1550, 1551, 1552, 1553, 1554, 1555, 1556, 1557, 1558
    ]);
    private static readonly PLAYER_HITPOINTS = [
        100, 7400, 8031, 8369, 8724, 9095, 9485, 9893, 10321, 10770, 11240, 11733, 12249, 12791,
        13358, 13953, 14576, 15229, 15914, 16632, 17384, 18172, 18999, 19865, 20773, 21724,
        22722, 23767, 24862, 26011, 27214, 28476, 29798, 31184, 32636, 34159, 35755, 37427,
        39180, 41017, 42943, 44961, 47077, 49294, 51618, 54054, 56607, 59283, 62088, 65028,
        68109, 71338, 74723, 78271, 81989, 85887
    ] as const;

    private static getEntityKey(levelName: string, entityId: number): string {
        return `${levelName}:${entityId}`;
    }

    private static getContributionKey(levelName: string, entityId: number, nonce: number): string {
        return `${levelName}:${entityId}:${nonce}`;
    }

    static getEntityLifeNonce(levelName: string, entityId: number): number {
        if (!levelName || entityId <= 0) {
            return 0;
        }

        return Number(GlobalState.entityLifeNonces.get(CombatHandler.getEntityKey(levelName, entityId)) ?? 0);
    }

    private static setEntityLifeNonce(levelName: string, entityId: number, nonce: number): void {
        if (!levelName || entityId <= 0) {
            return;
        }

        GlobalState.entityLifeNonces.set(CombatHandler.getEntityKey(levelName, entityId), Math.max(0, Math.floor(nonce)));
    }

    static noteEntityDestroyed(levelName: string, entityId: number): void {
        if (!levelName || entityId <= 0) {
            return;
        }

        const entityKey = CombatHandler.getEntityKey(levelName, entityId);
        const nonce = CombatHandler.getEntityLifeNonce(levelName, entityId);
        GlobalState.entityLastRewardNonces.set(entityKey, nonce);
        CombatHandler.setEntityLifeNonce(levelName, entityId, nonce + 1);
    }

    static clearEntityRewardTracking(levelName: string, entityId: number): void {
        if (!levelName || entityId <= 0) {
            return;
        }

        const entityKey = CombatHandler.getEntityKey(levelName, entityId);
        const currentNonce = CombatHandler.getEntityLifeNonce(levelName, entityId);
        GlobalState.combatContributions.delete(CombatHandler.getContributionKey(levelName, entityId, currentNonce));
        GlobalState.entityLastRewardNonces.delete(entityKey);
    }

    static getContributionSnapshot(levelName: string, entityId: number): ContributionSnapshot {
        const currentNonce = CombatHandler.getEntityLifeNonce(levelName, entityId);
        const currentKey = CombatHandler.getContributionKey(levelName, entityId, currentNonce);
        const currentContributors = GlobalState.combatContributions.get(currentKey);
        if (currentContributors && currentContributors.size > 0) {
            return {
                nonce: currentNonce,
                contributors: Array.from(currentContributors.keys())
            };
        }

        const lastNonce = GlobalState.entityLastRewardNonces.get(CombatHandler.getEntityKey(levelName, entityId));
        if (lastNonce !== undefined) {
            const lastKey = CombatHandler.getContributionKey(levelName, entityId, Number(lastNonce));
            const previousContributors = GlobalState.combatContributions.get(lastKey);
            if (previousContributors && previousContributors.size > 0) {
                return {
                    nonce: Number(lastNonce),
                    contributors: Array.from(previousContributors.keys())
                };
            }
        }

        return {
            nonce: currentNonce,
            contributors: []
        };
    }

    private static recordContribution(levelName: string, entityId: number, contributor: Client, damage: number): void {
        if (!levelName || entityId <= 0 || damage <= 0) {
            return;
        }

        const contributorKey = getClientCharacterKey(contributor);
        if (!contributorKey) {
            return;
        }

        const nonce = CombatHandler.getEntityLifeNonce(levelName, entityId);
        const key = CombatHandler.getContributionKey(levelName, entityId, nonce);
        let contributions = GlobalState.combatContributions.get(key);
        if (!contributions) {
            contributions = new Map<string, number>();
            GlobalState.combatContributions.set(key, contributions);
        }

        contributions.set(contributorKey, Number(contributions.get(contributorKey) ?? 0) + Math.max(0, Math.round(damage)));
    }

    private static getBaseHpForLevel(level: number): number {
        const maxIndex = CombatHandler.PLAYER_HITPOINTS.length - 1;
        const clampedLevel = Math.max(1, Math.min(maxIndex, Math.floor(Number(level) || 1)));
        return CombatHandler.PLAYER_HITPOINTS[clampedLevel];
    }

    private static getRespawnHealAmount(client: Client): number {
        const characterLevel = Number(client.character?.level ?? 0);
        if (Number.isFinite(characterLevel) && characterLevel > 0) {
            return CombatHandler.getBaseHpForLevel(characterLevel);
        }

        const authoritativeMaxHp = Number(client.authoritativeMaxHp ?? 0);
        if (Number.isFinite(authoritativeMaxHp) && authoritativeMaxHp > 0) {
            return Math.round(authoritativeMaxHp);
        }

        return CombatHandler.getBaseHpForLevel(1);
    }

    private static sendCharRegen(client: Client, entityId: number, amount: number): void {
        const bb = new BitBuffer(false);
        bb.writeMethod4(entityId);
        bb.writeMethod24(amount);
        client.sendBitBuffer(0x3B, bb);
    }

    private static buildHpDeltaPayload(entityId: number, delta: number): Buffer {
        const bb = new BitBuffer(false);
        bb.writeMethod4(entityId);
        bb.writeMethod45(delta);
        return bb.toBuffer();
    }

    private static buildEntityStatePayload(entityId: number, entState: number, facingLeft: boolean): Buffer {
        const bb = new BitBuffer(false);
        bb.writeMethod4(entityId);
        bb.writeMethod45(0);
        bb.writeMethod45(0);
        bb.writeMethod45(0);
        bb.writeMethod6(entState, 2);
        bb.writeMethod15(facingLeft);
        bb.writeMethod15(false);
        bb.writeMethod15(false);
        bb.writeMethod15(false);
        bb.writeMethod15(false);
        bb.writeMethod15(false);
        return bb.toBuffer();
    }

    private static buildPowerCastPayload(info: PowerCastRelayInfo): Buffer {
        const bb = new BitBuffer(false);
        bb.writeMethod4(info.sourceId);
        bb.writeMethod4(info.powerId);
        bb.writeMethod15(info.hasTargetEntity);
        bb.writeMethod15(info.hasTargetPos && Boolean(info.targetPos));
        if (info.hasTargetPos && info.targetPos) {
            bb.writeMethod24(Math.round(info.targetPos.x));
            bb.writeMethod24(Math.round(info.targetPos.y));
        }
        bb.writeMethod15(info.projectileId !== null);
        if (info.projectileId !== null) {
            bb.writeMethod4(Math.max(0, Math.round(info.projectileId)));
        }
        bb.writeMethod15(info.isPersistent);
        bb.writeMethod15(info.comboData !== null);
        if (info.comboData) {
            bb.writeMethod15(info.comboData.isMelee);
            bb.writeMethod4(Math.max(0, Math.round(info.comboData.id)));
        }
        bb.writeMethod15(false);
        return bb.toBuffer();
    }

    private static buildPowerHitPayload(info: PowerHitRelayInfo, damage: number): Buffer {
        const bb = new BitBuffer(false);
        bb.writeMethod4(info.targetId);
        bb.writeMethod4(info.sourceId);
        bb.writeMethod24(Math.max(0, Math.round(damage)));
        bb.writeMethod4(info.powerId);
        bb.writeMethod15(info.animOverrideId !== null);
        if (info.animOverrideId !== null) {
            bb.writeMethod4(info.animOverrideId);
        }
        bb.writeMethod15(info.effectOverrideId !== null);
        if (info.effectOverrideId !== null) {
            bb.writeMethod4(info.effectOverrideId);
        }
        bb.writeMethod15(info.isCrit);
        return bb.toBuffer();
    }

    private static resetLevelEnemiesForRespawn(client: Client): void {
        if (!client.currentLevel) {
            return;
        }

        const levelScope = getClientLevelScope(client);
        const levelMap = GlobalState.levelEntities.get(levelScope);
        if (!levelMap) {
            return;
        }

        for (const [entityId, entity] of levelMap.entries()) {
            if (entityId <= 0 || entityId === client.clientEntID) {
                continue;
            }
            if (Boolean(entity?.isPlayer) || Number(entity?.team ?? 0) !== 2) {
                continue;
            }

            CombatHandler.clearEntityRewardTracking(levelScope, entityId);
            CombatHandler.sendCharRegen(client, entityId, CombatHandler.RESPAWN_ENEMY_HEAL);
        }
    }

    private static findPlayerSessionByEntityId(entityId: number): Client | null {
        for (const other of GlobalState.sessionsByToken.values()) {
            if (other.clientEntID === entityId && other.character) {
                return other;
            }
        }

        return null;
    }

    private static resolveLevelEntity(levelName: string, entityId: number): any {
        if (!levelName || entityId <= 0) {
            return null;
        }

        return GlobalState.levelEntities.get(levelName)?.get(entityId) ?? null;
    }

    private static shouldMirrorClientSpawnEntityToParty(levelName: string, entity: any): boolean {
        return EntityHandler.shouldMirrorClientSpawnEntityToParty(levelName, entity);
    }

    private static getCombatRecipients(anchor: Client, includeAnchor: boolean = false): Client[] {
        const recipients: Client[] = [];
        const levelScope = getClientLevelScope(anchor);
        if (!levelScope || !anchor.playerSpawned) {
            return recipients;
        }

        for (const other of GlobalState.sessionsByToken.values()) {
            if (!other.playerSpawned || getClientLevelScope(other) !== levelScope) {
                continue;
            }
            if (!includeAnchor && other === anchor) {
                continue;
            }
            if (!shouldShareCombatView(anchor, other)) {
                continue;
            }

            recipients.push(other);
        }

        return recipients;
    }

    private static canViewerResolveAnchoredCombatEntity(
        viewer: Client,
        anchor: Client,
        levelScope: string,
        entityId: number
    ): boolean {
        if (entityId <= 0) {
            return true;
        }

        if (EntityHandler.ensureEntityKnown(viewer, anchor.currentLevel, entityId)) {
            return true;
        }

        if (!areClientsInSameParty(anchor, viewer)) {
            return false;
        }

        const canonicalEntity = CombatHandler.resolveLevelEntity(levelScope, entityId);
        if (!CombatHandler.shouldMirrorClientSpawnEntityToParty(anchor.currentLevel, canonicalEntity)) {
            return false;
        }

        const localEntity = viewer.entities.get(entityId);
        return CombatHandler.shouldMirrorClientSpawnEntityToParty(anchor.currentLevel, localEntity);
    }

    private static relayPartyLocalEntityDestroy(anchor: Client, levelScope: string, entityId: number, data: Buffer): void {
        if (!levelScope || entityId <= 0 || !anchor.playerSpawned) {
            return;
        }

        for (const other of GlobalState.sessionsByToken.values()) {
            if (
                other === anchor ||
                !other.playerSpawned ||
                getClientLevelScope(other) !== levelScope ||
                !areClientsInSameParty(anchor, other) ||
                !CombatHandler.shouldMirrorClientSpawnEntityToParty(anchor.currentLevel, other.entities.get(entityId))
            ) {
                continue;
            }

            other.entities.delete(entityId);
            other.knownEntityIds.delete(entityId);
            other.send(0x0D, data);
        }
    }

    private static broadcastToSameLevel(
        levelScope: string,
        packetId: number,
        data: Buffer,
        referencedEntityIds: number[] = [],
        excludedClient: Client | null = null
    ): void {
        if (!levelScope) {
            return;
        }

        for (const other of GlobalState.sessionsByToken.values()) {
            if (!other.playerSpawned || getClientLevelScope(other) !== levelScope || other === excludedClient) {
                continue;
            }

            let missingEntity = false;
            for (const entityId of referencedEntityIds) {
                if (!EntityHandler.ensureEntityKnown(other, other.currentLevel, entityId)) {
                    missingEntity = true;
                    break;
                }
            }
            if (missingEntity) {
                continue;
            }

            other.send(packetId, data);
        }
    }

    static broadcastEntityViewPacket(
        levelScope: string,
        sourceEntity: any,
        packetId: number,
        data: Buffer,
        referencedEntityIds: number[] = [],
        excludedClient: Client | null = null
    ): void {
        if (!levelScope) {
            return;
        }

        const sourceRoomId = Number.isFinite(Number(sourceEntity?.roomId)) ? Number(sourceEntity.roomId) : -1;
        const dedupedRefs = Array.from(new Set(referencedEntityIds.filter((id) => Number.isFinite(id) && id > 0)));

        for (const other of GlobalState.sessionsByToken.values()) {
            if (!other.playerSpawned || getClientLevelScope(other) !== levelScope || other === excludedClient) {
                continue;
            }
            if (sourceRoomId >= 0 && !sharesRoomIds(other.currentRoomId, sourceRoomId)) {
                continue;
            }

            let missingEntity = false;
            for (const entityId of dedupedRefs) {
                if (!CombatHandler.canViewerResolveCombatEntity(other, levelScope, entityId)) {
                    missingEntity = true;
                    break;
                }
            }
            if (missingEntity) {
                continue;
            }

            other.send(packetId, data);
        }
    }

    static broadcastToCombatRoom(anchor: Client, packetId: number, data: Buffer, includeAnchor: boolean = false, referencedEntityIds: number[] = []): void {
        const levelScope = getClientLevelScope(anchor);
        if (!levelScope || !anchor.playerSpawned) {
            return;
        }

        for (const other of CombatHandler.getCombatRecipients(anchor, includeAnchor)) {
            let missingEntity = false;
            for (const entityId of referencedEntityIds) {
                if (!CombatHandler.canViewerResolveAnchoredCombatEntity(other, anchor, levelScope, entityId)) {
                    missingEntity = true;
                    break;
                }
            }
            if (missingEntity) {
                continue;
            }

            other.send(packetId, data);
        }
    }

    private static broadcastCombatPacket(anchor: Client, packetId: number, data: Buffer, options: CombatRelayOptions = {}): void {
        const referencedEntityIds = Array.from(new Set((options.referencedEntityIds ?? []).filter((id) => Number.isFinite(id) && id > 0)));
        CombatHandler.broadcastToCombatRoom(anchor, packetId, data, Boolean(options.includeAnchor), referencedEntityIds);
    }

    private static canViewerResolveCombatEntity(viewer: Client, levelScope: string, entityId: number): boolean {
        if (entityId <= 0) {
            return true;
        }

        const entity = GlobalState.levelEntities.get(levelScope)?.get(entityId);
        if (!entity) {
            return false;
        }

        if (EntityHandler.shouldTrackKnownEntity(viewer.currentLevel, entity)) {
            return EntityHandler.ensureEntityKnown(viewer, viewer.currentLevel, entityId);
        }

        const isRoomScopedClientNpc = Boolean(
            !entity.isPlayer &&
            entity.clientSpawned &&
            sharesRoomIds(viewer.currentRoomId, Number(entity.roomId ?? -1))
        );
        return isRoomScopedClientNpc;
    }

    private static broadcastPlayerHpDelta(targetSession: Client, delta: number): void {
        if (!targetSession.playerSpawned || !targetSession.currentLevel || targetSession.clientEntID <= 0) {
            return;
        }

        const payload = CombatHandler.buildHpDeltaPayload(targetSession.clientEntID, delta);
        CombatHandler.broadcastToCombatRoom(targetSession, 0x3A, payload, true, [targetSession.clientEntID]);
    }

    private static broadcastPlayerState(targetSession: Client, entState: number): void {
        if (!targetSession.playerSpawned || !targetSession.currentLevel || targetSession.clientEntID <= 0) {
            return;
        }

        const entity = targetSession.entities.get(targetSession.clientEntID) ??
            CombatHandler.resolveLevelEntity(getClientLevelScope(targetSession), targetSession.clientEntID);
        const facingLeft = Boolean(entity?.facingLeft);
        const payload = CombatHandler.buildEntityStatePayload(targetSession.clientEntID, entState, facingLeft);
        CombatHandler.broadcastToCombatRoom(targetSession, 0x07, payload, false, [targetSession.clientEntID]);
    }

    private static getEntityPosition(entity: any): CombatPoint | null {
        if (!entity || typeof entity !== 'object') {
            return null;
        }

        const x = Number(entity.physPosX ?? entity.x ?? entity.var_10 ?? NaN);
        const y = Number(entity.physPosY ?? entity.y ?? entity.var_12 ?? NaN);
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
            return null;
        }

        return {
            x,
            y
        };
    }

    private static resolvePowerCastSourceEntity(levelScope: string, sourceId: number, fallbackClient: Client): any {
        if (sourceId <= 0) {
            return null;
        }

        const levelEntity = CombatHandler.resolveLevelEntity(levelScope, sourceId);
        if (levelEntity) {
            return levelEntity;
        }

        if (fallbackClient.clientEntID === sourceId) {
            return fallbackClient.entities.get(sourceId) ?? null;
        }

        return CombatHandler.findPlayerSessionByEntityId(sourceId)?.entities.get(sourceId) ?? null;
    }

    private static findSyntheticPowerCastTargetPos(levelScope: string, sourceEntity: any): CombatPoint | null {
        const sourcePos = CombatHandler.getEntityPosition(sourceEntity);
        if (!sourcePos) {
            return null;
        }

        const levelMap = GlobalState.levelEntities.get(levelScope);
        const sourceId = Number(sourceEntity?.id ?? 0);
        const sourceTeam = Number(sourceEntity?.team ?? 0);
        const sourceRoomId = Number.isFinite(Number(sourceEntity?.roomId)) ? Number(sourceEntity.roomId) : -1;
        const facingLeft = Boolean(sourceEntity?.facingLeft);

        let bestFacingTarget: { pos: CombatPoint; distanceSq: number } | null = null;
        let bestAnyTarget: { pos: CombatPoint; distanceSq: number } | null = null;

        for (const candidate of levelMap?.values() ?? []) {
            const candidateId = Number(candidate?.id ?? 0);
            if (candidateId <= 0 || candidateId === sourceId) {
                continue;
            }
            if (Boolean(candidate?.dead) || Number(candidate?.entState ?? EntityState.ACTIVE) === EntityState.DEAD) {
                continue;
            }
            if (Boolean(candidate?.untargetable)) {
                continue;
            }

            const candidateTeam = Number(candidate?.team ?? 0);
            if (sourceTeam > 0 && candidateTeam > 0 && sourceTeam === candidateTeam) {
                continue;
            }
            if (sourceRoomId >= 0 && !sharesRoomIds(sourceRoomId, Number(candidate?.roomId ?? -1))) {
                continue;
            }

            const candidatePos = CombatHandler.getEntityPosition(candidate);
            if (!candidatePos) {
                continue;
            }

            const dx = candidatePos.x - sourcePos.x;
            const dy = candidatePos.y - sourcePos.y;
            const distanceSq = dx * dx + dy * dy;
            if (distanceSq > 500 * 500) {
                continue;
            }

            if (!bestAnyTarget || distanceSq < bestAnyTarget.distanceSq) {
                bestAnyTarget = { pos: candidatePos, distanceSq };
            }

            const isFacingTarget = facingLeft ? dx <= 60 : dx >= -60;
            if (isFacingTarget && (!bestFacingTarget || distanceSq < bestFacingTarget.distanceSq)) {
                bestFacingTarget = { pos: candidatePos, distanceSq };
            }
        }

        if (bestFacingTarget) {
            return bestFacingTarget.pos;
        }
        if (bestAnyTarget) {
            return bestAnyTarget.pos;
        }

        return {
            x: sourcePos.x + (facingLeft ? -220 : 220),
            y: sourcePos.y
        };
    }

    private static normalizePowerCastRelay(client: Client, info: PowerCastRelayInfo, data: Buffer): Buffer | null {
        if (!info.hasTargetEntity) {
            return data;
        }

        if (CombatHandler.UNSAFE_REMOTE_DIRECT_TARGET_POWER_IDS.has(info.powerId)) {
            return null;
        }

        if (info.hasTargetPos) {
            return data;
        }

        const levelScope = getClientLevelScope(client);
        if (!levelScope) {
            return null;
        }

        const sourceEntity = CombatHandler.resolvePowerCastSourceEntity(levelScope, info.sourceId, client);
        const targetPos = CombatHandler.findSyntheticPowerCastTargetPos(levelScope, sourceEntity);
        if (!targetPos) {
            return null;
        }

        return CombatHandler.buildPowerCastPayload({
            ...info,
            hasTargetPos: true,
            targetPos
        });
    }

    private static parsePowerCastRelayInfo(data: Buffer): PowerCastRelayInfo | null {
        const br = new BitReader(data);

        try {
            const sourceId = br.readMethod4();
            const powerId = br.readMethod4();
            const hasTargetEntity = br.readMethod15();
            const hasTargetPos = br.readMethod15();
            const targetPos = hasTargetPos
                ? {
                    x: br.readMethod24(),
                    y: br.readMethod24()
                }
                : null;
            const projectileId = br.readMethod15() ? br.readMethod4() : null;
            const isPersistent = br.readMethod15();
            const comboData = br.readMethod15()
                ? {
                    isMelee: br.readMethod15(),
                    id: br.readMethod4()
                }
                : null;

            return {
                sourceId,
                powerId,
                hasTargetEntity,
                hasTargetPos,
                targetPos,
                projectileId,
                isPersistent,
                comboData
            };
        } catch {
            return null;
        }
    }

    private static parsePowerHitRelayInfo(data: Buffer): PowerHitRelayInfo | null {
        const br = new BitReader(data);

        try {
            const targetId = br.readMethod9();
            const sourceId = br.readMethod9();
            const damage = Math.max(0, Math.round(br.readMethod24()));
            const powerId = br.readMethod9();
            const animOverrideId = br.readMethod15() ? br.readMethod9() : null;
            const effectOverrideId = br.readMethod15() ? br.readMethod9() : null;
            const isCrit = br.readMethod15();

            return {
                targetId,
                sourceId,
                damage,
                powerId,
                animOverrideId,
                effectOverrideId,
                isCrit
            };
        } catch {
            return null;
        }
    }

    private static shouldPreventHostilePlayerDeath(levelScope: string, sourceId: number, targetSession: Client): boolean {
        if (!levelScope || sourceId <= 0 || targetSession.clientEntID <= 0 || sourceId === targetSession.clientEntID) {
            return false;
        }

        const sourceSession = CombatHandler.findPlayerSessionByEntityId(sourceId);
        if (sourceSession && getClientLevelScope(sourceSession) === levelScope) {
            return false;
        }

        const sourceEntity = CombatHandler.resolveLevelEntity(levelScope, sourceId);
        if (!sourceEntity || Boolean(sourceEntity.isPlayer)) {
            return false;
        }

        return Number(sourceEntity.team ?? 0) === EntityTeam.ENEMY;
    }

    private static updatePlayerTargetAfterHit(targetSession: Client, damage: number, preventDeath: boolean = false): PlayerHitResolution {
        if (damage <= 0 || !targetSession.character || targetSession.clientEntID <= 0) {
            return {
                appliedDamage: 0,
                killed: false
            };
        }

        const entity = targetSession.entities.get(targetSession.clientEntID) ?? {};
        const baseMaxHp = CombatHandler.getBaseHpForLevel(Number(targetSession.character.level ?? 1));
        const knownMaxHp = Math.max(
            1,
            Math.round(Number(entity.maxHp ?? targetSession.authoritativeMaxHp ?? baseMaxHp))
        );
        const currentHp = Math.max(
            0,
            Math.min(
                knownMaxHp,
                Math.round(Number(entity.hp ?? targetSession.authoritativeCurrentHp ?? knownMaxHp))
            )
        );
        if (currentHp <= 0) {
            return {
                appliedDamage: 0,
                killed: Boolean(entity.dead)
            };
        }

        const requestedDamage = Math.max(0, Math.round(damage));
        const minHpAfterHit = preventDeath ? 1 : 0;
        const appliedDamage = Math.max(0, Math.min(requestedDamage, currentHp - minHpAfterHit));
        const nextHp = Math.max(minHpAfterHit, currentHp - appliedDamage);

        entity.maxHp = knownMaxHp;
        entity.hp = nextHp;
        entity.dead = nextHp <= 0;
        entity.entState = nextHp <= 0 ? EntityState.DEAD : EntityState.ACTIVE;
        targetSession.entities.set(targetSession.clientEntID, entity);

        const levelEntity = CombatHandler.resolveLevelEntity(getClientLevelScope(targetSession), targetSession.clientEntID);
        if (levelEntity && typeof levelEntity === 'object') {
            levelEntity.maxHp = knownMaxHp;
            levelEntity.hp = nextHp;
            levelEntity.dead = entity.dead;
            levelEntity.entState = entity.entState;
        }

        targetSession.authoritativeMaxHp = knownMaxHp;
        targetSession.authoritativeCurrentHp = nextHp;
        return {
            appliedDamage,
            killed: entity.dead
        };
    }

    private static updateNpcTargetAfterHit(levelName: string, targetId: number, damage: number): void {
        if (!levelName || targetId <= 0 || damage <= 0) {
            return;
        }

        const entity = CombatHandler.resolveLevelEntity(levelName, targetId);
        if (!entity || entity.isPlayer) {
            return;
        }

        const hp = Number(entity.hp ?? NaN);
        if (Number.isFinite(hp)) {
            entity.hp = Math.max(0, Math.round(hp) - Math.max(0, Math.round(damage)));
        }
        if (Number(entity.hp ?? 1) <= 0) {
            entity.dead = true;
            entity.entState = EntityState.DEAD;
        }

        if (usesSharedDungeonProgress(getScopeLevelName(levelName))) {
            noteSharedDungeonHostileState(levelName, targetId, entity);
            LevelHandler.refreshSharedDungeonQuestProgress(levelName);
        }
    }

    private static parseReferencedEntityIds(packetId: number, data: Buffer): number[] {
        const refs: number[] = [];
        const br = new BitReader(data);

        try {
            switch (packetId) {
                case 0x09: {
                    refs.push(br.readMethod9());
                    break;
                }
                case 0x0A: {
                    refs.push(br.readMethod9());
                    refs.push(br.readMethod9());
                    break;
                }
                case 0x0B:
                case 0x0C:
                    refs.push(br.readMethod9());
                    break;
                case 0x0E:
                    refs.push(br.readMethod9());
                    refs.push(br.readMethod9());
                    break;
                default:
                    break;
            }
        } catch {
            return [];
        }

        return Array.from(new Set(refs.filter((id) => Number.isFinite(id) && id > 0)));
    }

    private static maybeRecordNpcContribution(levelScope: string, targetId: number, sourceId: number, damage: number, fallbackClient: Client): void {
        if (!levelScope || targetId <= 0 || sourceId <= 0 || damage <= 0) {
            return;
        }

        const targetEntity = CombatHandler.resolveLevelEntity(levelScope, targetId);
        if (!targetEntity || targetEntity.isPlayer || Number(targetEntity.team ?? 0) !== 2) {
            return;
        }

        const sourceEntity = CombatHandler.resolveLevelEntity(levelScope, sourceId);
        const summonerId = Number(sourceEntity?.summonerId ?? 0);
        const ownerToken = Number(sourceEntity?.ownerToken ?? 0);

        const sourceSession =
            (fallbackClient.clientEntID === sourceId ? fallbackClient : null) ??
            CombatHandler.findPlayerSessionByEntityId(sourceId) ??
            (fallbackClient.clientEntID === summonerId ? fallbackClient : null) ??
            CombatHandler.findPlayerSessionByEntityId(summonerId) ??
            (ownerToken > 0 ? GlobalState.sessionsByToken.get(ownerToken) ?? null : null);
        if (!sourceSession || !sourceSession.playerSpawned || getClientLevelScope(sourceSession) !== levelScope) {
            return;
        }

        CombatHandler.recordContribution(levelScope, targetId, sourceSession, damage);
    }

    private static resolveCombatSourceSession(levelScope: string, sourceId: number, fallbackClient: Client): Client | null {
        if (!levelScope || sourceId <= 0) {
            return null;
        }

        const sourceEntity = CombatHandler.resolveLevelEntity(levelScope, sourceId);
        const summonerId = Number(sourceEntity?.summonerId ?? 0);
        const ownerToken = Number(sourceEntity?.ownerToken ?? 0);

        const sourceSession =
            (fallbackClient.clientEntID === sourceId ? fallbackClient : null) ??
            CombatHandler.findPlayerSessionByEntityId(sourceId) ??
            (fallbackClient.clientEntID === summonerId ? fallbackClient : null) ??
            CombatHandler.findPlayerSessionByEntityId(summonerId) ??
            (ownerToken > 0 ? GlobalState.sessionsByToken.get(ownerToken) ?? null : null);
        if (!sourceSession || !sourceSession.playerSpawned || getClientLevelScope(sourceSession) !== levelScope) {
            return null;
        }

        return sourceSession;
    }

    static async handlePowerCast(client: Client, data: Buffer): Promise<void> {
        if (LevelHandler.isGoblinRiverBossIntroLocked(client)) {
            return;
        }
        const info = CombatHandler.parsePowerCastRelayInfo(data);
        if (!info) {
            return;
        }

        const sourceSession = CombatHandler.resolveCombatSourceSession(getClientLevelScope(client), info.sourceId, client);
        if (sourceSession) {
            noteDungeonRunCast(sourceSession, {
                sourceId: info.sourceId,
                powerId: info.powerId,
                hasTargetEntity: info.hasTargetEntity,
                hasTargetPos: info.hasTargetPos,
                projectileId: info.projectileId,
                isPersistent: info.isPersistent,
                comboData: info.comboData
            });
        }

        const relayPayload = CombatHandler.normalizePowerCastRelay(client, info, data);
        if (!relayPayload) {
            return;
        }

        CombatHandler.broadcastCombatPacket(client, 0x09, relayPayload, {
            referencedEntityIds: CombatHandler.parseReferencedEntityIds(0x09, relayPayload)
        });
    }

    static async handlePowerHit(client: Client, data: Buffer): Promise<void> {
        if (LevelHandler.isGoblinRiverBossIntroLocked(client)) {
            return;
        }
        const info = CombatHandler.parsePowerHitRelayInfo(data);
        if (!info) {
            return;
        }

        const { targetId, sourceId, damage } = info;
        const currentLevel = client.currentLevel;
        const levelScope = getClientLevelScope(client);
        const targetEntity = CombatHandler.resolveLevelEntity(levelScope, targetId);
        const sourceEntity = CombatHandler.resolveLevelEntity(levelScope, sourceId);
        const isHostileNpcSource = Boolean(
            sourceEntity &&
            !sourceEntity.isPlayer &&
            Number(sourceEntity.team ?? 0) === EntityTeam.ENEMY
        );
        if (targetEntity && !targetEntity.isPlayer && Boolean(targetEntity.untargetable)) {
            return;
        }

        if (client.currentLevel === 'CraftTownTutorial' && client.keepTutorialState) {
            LevelHandler.checkCraftTownTutorialBossHealth(client, targetId, damage);
        }

        CombatHandler.maybeRecordNpcContribution(levelScope, targetId, sourceId, damage, client);
        const sourceSession = CombatHandler.resolveCombatSourceSession(levelScope, sourceId, client);
        if (
            sourceSession &&
            targetEntity &&
            !targetEntity.isPlayer &&
            Number(targetEntity.team ?? 0) === EntityTeam.ENEMY &&
            damage > 0
        ) {
            noteDungeonRunHit(sourceSession, {
                sourceId,
                targetId,
                targetEntity,
                damage
            });
        }

        let relayDamage = damage;
        const targetSession = CombatHandler.findPlayerSessionByEntityId(targetId);
        if (targetSession && areClientsInSameLevelScope(client, targetSession)) {
            const preventDeath = CombatHandler.shouldPreventHostilePlayerDeath(levelScope, sourceId, targetSession);
            const resolution = CombatHandler.updatePlayerTargetAfterHit(targetSession, damage, preventDeath);
            relayDamage = resolution.appliedDamage;

            if (resolution.appliedDamage > 0 && !isHostileNpcSource) {
                CombatHandler.broadcastPlayerHpDelta(targetSession, -resolution.appliedDamage);
            }

            if (resolution.killed) {
                if (isHostileNpcSource) {
                    const entity = targetSession.entities.get(targetSession.clientEntID) ??
                        CombatHandler.resolveLevelEntity(getClientLevelScope(targetSession), targetSession.clientEntID);
                    const facingLeft = Boolean(entity?.facingLeft);
                    const statePayload = CombatHandler.buildEntityStatePayload(targetSession.clientEntID, EntityState.DEAD, facingLeft);
                    CombatHandler.broadcastEntityViewPacket(levelScope, sourceEntity, 0x07, statePayload, [targetSession.clientEntID, sourceId]);
                } else {
                    CombatHandler.broadcastPlayerState(targetSession, EntityState.DEAD);
                }
            }
        } else {
            CombatHandler.updateNpcTargetAfterHit(levelScope, targetId, damage);
        }

        const relayPayload = relayDamage === damage ? data : CombatHandler.buildPowerHitPayload(info, relayDamage);
        if (isHostileNpcSource) {
            const excludeLocalVictim = targetSession === client && relayDamage === damage ? client : null;
            CombatHandler.broadcastEntityViewPacket(levelScope, sourceEntity, 0x0A, relayPayload, [targetId, sourceId], excludeLocalVictim);
            return;
        }

        CombatHandler.broadcastCombatPacket(client, 0x0A, relayPayload, {
            referencedEntityIds: [targetId, sourceId]
        });
    }

    static async handleProjectileExplode(client: Client, data: Buffer): Promise<void> {
        if (LevelHandler.isGoblinRiverBossIntroLocked(client)) {
            return;
        }
        CombatHandler.broadcastCombatPacket(client, 0x0E, data, {
            referencedEntityIds: CombatHandler.parseReferencedEntityIds(0x0E, data)
        });
    }

    static async handleEntityDestroy(client: Client, data: Buffer): Promise<void> {
        const br = new BitReader(data);
        const entityId = br.readMethod9();
        const levelName = client.currentLevel;
        const levelScope = getClientLevelScope(client);
        const destroyedEntity =
            client.entities.get(entityId) ??
            (levelScope ? GlobalState.levelEntities.get(levelScope)?.get(entityId) : null);
        const contributionSnapshot = destroyedEntity && !destroyedEntity.isPlayer && Number(destroyedEntity.team ?? 0) === EntityTeam.ENEMY
            ? CombatHandler.getContributionSnapshot(levelScope, entityId)
            : null;
        const shouldMirrorClientSpawnEntity = Boolean(
            levelName &&
            CombatHandler.shouldMirrorClientSpawnEntityToParty(levelName, destroyedEntity)
        );
        const shouldRelayDestroy = EntityHandler.shouldRelayEntityToOtherClients(levelName, destroyedEntity);

        if (levelName === 'CraftTownTutorial' && client.keepTutorialState) {
            const entityName = String(destroyedEntity?.name ?? '');
            if (entityName === 'GoblinShamanHood' || entityName === 'IntroGoblinShamanHood') {
                client.keepTutorialState.bossDefeated = true;
                client.keepTutorialState.helperWaveActiveIds = [];
                clearKeepTutorialTimers(client.keepTutorialState);
            } else if (entityName === 'GoblinDagger') {
                LevelHandler.noteCraftTownTutorialHelperDestroyed(client, entityId);
            }
        }

        client.entities.delete(entityId);

        if (levelScope) {
            if (usesSharedDungeonProgress(getScopeLevelName(levelScope)) && destroyedEntity) {
                noteSharedDungeonHostileDestroyed(levelScope, entityId, destroyedEntity);
            }
            const levelMap = GlobalState.levelEntities.get(levelScope);
            levelMap?.delete(entityId);
            if (levelMap && levelMap.size === 0) {
                GlobalState.levelEntities.delete(levelScope);
            }
            if (contributionSnapshot?.contributors?.length) {
                noteDungeonRunKill(levelScope, contributionSnapshot.contributors, entityId, destroyedEntity);
            }
            CombatHandler.noteEntityDestroyed(levelScope, entityId);
            EntityHandler.forgetKnownEntity(levelName, entityId, client.levelInstanceId);
            if (usesSharedDungeonProgress(getScopeLevelName(levelScope)) && destroyedEntity) {
                LevelHandler.refreshSharedDungeonQuestProgress(levelScope);
            }
        }

        if (destroyedEntity && !destroyedEntity.isPlayer && Number(destroyedEntity.team ?? 0) === EntityTeam.ENEMY) {
            await MissionHandler.handleEnemyDefeatMissionProgress(client, destroyedEntity);
            await MissionHandler.handleForcedDungeonBossCompletion(client, destroyedEntity);
        }

        if (shouldRelayDestroy) {
            CombatHandler.broadcastToSameLevel(levelScope, 0x0D, data, [], client);
        } else if (shouldMirrorClientSpawnEntity) {
            CombatHandler.relayPartyLocalEntityDestroy(client, levelScope, entityId, data);
        }
    }

    static async handleRequestRespawn(client: Client, data: Buffer): Promise<void> {
        const br = new BitReader(data);
        const usePotion = br.readMethod15();

        if (!usePotion) {
            noteDungeonRunDeath(client);
            client.processedRewardSources.clear();
            CombatHandler.resetLevelEnemiesForRespawn(client);
        }

        const healAmount = CombatHandler.getRespawnHealAmount(client);

        const bb = new BitBuffer(false);
        bb.writeMethod24(healAmount);
        bb.writeMethod15(usePotion);

        client.sendBitBuffer(0x80, bb);
    }

    static async handleRespawnBroadcast(client: Client, data: Buffer): Promise<void> {
        const br = new BitReader(data);
        const entId = br.readMethod9();
        const healAmount = Math.max(0, Math.round(br.readMethod24()));
        br.readMethod15();

        const ent = client.entities.get(entId);
        if (ent) {
            ent.dead = false;
            ent.entState = EntityState.ACTIVE;
            ent.hp = healAmount;
            ent.maxHp = Math.max(Math.round(Number(ent.maxHp ?? 0)), healAmount);
        }

        if (client.currentLevel) {
            const levelEntity = CombatHandler.resolveLevelEntity(getClientLevelScope(client), entId);
            if (levelEntity && typeof levelEntity === 'object') {
                levelEntity.dead = false;
                levelEntity.entState = EntityState.ACTIVE;
                levelEntity.hp = healAmount;
                levelEntity.maxHp = Math.max(Math.round(Number(levelEntity.maxHp ?? 0)), healAmount);
            }
        }

        const levelScope = getClientLevelScope(client);
        if (usesSharedDungeonProgress(getScopeLevelName(levelScope))) {
            const levelEntity = CombatHandler.resolveLevelEntity(levelScope, entId);
            if (levelEntity && !levelEntity.isPlayer) {
                noteSharedDungeonHostileState(levelScope, entId, levelEntity);
                LevelHandler.refreshSharedDungeonQuestProgress(levelScope);
            }
        }

        if (entId === client.clientEntID) {
            client.authoritativeCurrentHp = healAmount;
            client.authoritativeMaxHp = Math.max(client.authoritativeMaxHp, healAmount);
            const facingLeft = Boolean(ent?.facingLeft ?? false);
            const statePayload = CombatHandler.buildEntityStatePayload(client.clientEntID, EntityState.ACTIVE, facingLeft);
            CombatHandler.broadcastToSameLevel(getClientLevelScope(client), 0x07, statePayload, [client.clientEntID], client);
        }

        const bb = new BitBuffer(false);
        bb.writeMethod4(entId);
        bb.writeMethod24(healAmount);
        CombatHandler.broadcastToSameLevel(getClientLevelScope(client), 0x82, bb.toBuffer(), [entId], client);
    }

    static async handleBuffTickDot(client: Client, data: Buffer): Promise<void> {
        CombatHandler.broadcastCombatPacket(client, 0x79, data);
    }

    static async handleAddBuff(client: Client, data: Buffer): Promise<void> {
        CombatHandler.broadcastCombatPacket(client, 0x0B, data, {
            referencedEntityIds: CombatHandler.parseReferencedEntityIds(0x0B, data)
        });
    }

    static async handleRemoveBuff(client: Client, data: Buffer): Promise<void> {
        CombatHandler.broadcastCombatPacket(client, 0x0C, data, {
            referencedEntityIds: CombatHandler.parseReferencedEntityIds(0x0C, data)
        });
    }
}
