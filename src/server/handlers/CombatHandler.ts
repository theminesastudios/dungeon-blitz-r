import { Client } from '../core/Client';
import { BitReader } from '../network/protocol/bitReader';
import { GlobalState } from '../core/GlobalState';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { LevelHandler } from './LevelHandler';
import { EntityState, EntityTeam } from '../core/Entity';
import { EntityHandler } from './EntityHandler';
import { areClientsInSameParty, getClientCharacterKey, sharesRoomIds, shouldShareCombatView } from '../core/PartySync';

type CombatRelayOptions = {
    includeAnchor?: boolean;
    referencedEntityIds?: number[];
};

type ContributionSnapshot = {
    nonce: number;
    contributors: string[];
};

type PowerCastRelayInfo = {
    sourceId: number;
    hasTargetEntity: boolean;
    hasTargetPos: boolean;
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

        const levelMap = GlobalState.levelEntities.get(client.currentLevel);
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

            CombatHandler.clearEntityRewardTracking(client.currentLevel, entityId);
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

    private static isLocalOnlyClientSpawnEntity(levelName: string, entity: any): boolean {
        return Boolean(
            levelName &&
            entity &&
            !entity.isPlayer &&
            entity.clientSpawned &&
            EntityHandler.isClientSpawnLevel(levelName)
        );
    }

    private static getCombatRecipients(anchor: Client, includeAnchor: boolean = false): Client[] {
        const recipients: Client[] = [];
        const levelName = anchor.currentLevel;
        if (!levelName || !anchor.playerSpawned) {
            return recipients;
        }

        for (const other of GlobalState.sessionsByToken.values()) {
            if (!other.playerSpawned || other.currentLevel !== levelName) {
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
        levelName: string,
        entityId: number
    ): boolean {
        if (entityId <= 0) {
            return true;
        }

        if (EntityHandler.ensureEntityKnown(viewer, levelName, entityId)) {
            return true;
        }

        if (!areClientsInSameParty(anchor, viewer)) {
            return false;
        }

        const canonicalEntity = CombatHandler.resolveLevelEntity(levelName, entityId);
        if (!CombatHandler.isLocalOnlyClientSpawnEntity(levelName, canonicalEntity)) {
            return false;
        }

        const localEntity = viewer.entities.get(entityId);
        return CombatHandler.isLocalOnlyClientSpawnEntity(levelName, localEntity);
    }

    private static relayPartyLocalEntityDestroy(anchor: Client, levelName: string, entityId: number, data: Buffer): void {
        if (!levelName || entityId <= 0 || !anchor.playerSpawned) {
            return;
        }

        for (const other of GlobalState.sessionsByToken.values()) {
            if (
                other === anchor ||
                !other.playerSpawned ||
                other.currentLevel !== levelName ||
                !areClientsInSameParty(anchor, other) ||
                !CombatHandler.isLocalOnlyClientSpawnEntity(levelName, other.entities.get(entityId))
            ) {
                continue;
            }

            other.entities.delete(entityId);
            other.knownEntityIds.delete(entityId);
            other.send(0x0D, data);
        }
    }

    private static broadcastToSameLevel(
        levelName: string,
        packetId: number,
        data: Buffer,
        referencedEntityIds: number[] = [],
        excludedClient: Client | null = null
    ): void {
        if (!levelName) {
            return;
        }

        for (const other of GlobalState.sessionsByToken.values()) {
            if (!other.playerSpawned || other.currentLevel !== levelName || other === excludedClient) {
                continue;
            }

            let missingEntity = false;
            for (const entityId of referencedEntityIds) {
                if (!EntityHandler.ensureEntityKnown(other, levelName, entityId)) {
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
        levelName: string,
        sourceEntity: any,
        packetId: number,
        data: Buffer,
        referencedEntityIds: number[] = []
    ): void {
        if (!levelName) {
            return;
        }

        const sourceRoomId = Number.isFinite(Number(sourceEntity?.roomId)) ? Number(sourceEntity.roomId) : -1;
        const dedupedRefs = Array.from(new Set(referencedEntityIds.filter((id) => Number.isFinite(id) && id > 0)));

        for (const other of GlobalState.sessionsByToken.values()) {
            if (!other.playerSpawned || other.currentLevel !== levelName) {
                continue;
            }
            if (sourceRoomId >= 0 && !sharesRoomIds(other.currentRoomId, sourceRoomId)) {
                continue;
            }

            let missingEntity = false;
            for (const entityId of dedupedRefs) {
                if (!CombatHandler.canViewerResolveCombatEntity(other, levelName, entityId)) {
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
        const levelName = anchor.currentLevel;
        if (!levelName || !anchor.playerSpawned) {
            return;
        }

        for (const other of CombatHandler.getCombatRecipients(anchor, includeAnchor)) {
            let missingEntity = false;
            for (const entityId of referencedEntityIds) {
                if (!CombatHandler.canViewerResolveAnchoredCombatEntity(other, anchor, levelName, entityId)) {
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

    private static canViewerResolveCombatEntity(viewer: Client, levelName: string, entityId: number): boolean {
        if (entityId <= 0) {
            return true;
        }

        const entity = GlobalState.levelEntities.get(levelName)?.get(entityId);
        if (!entity) {
            return false;
        }

        if (EntityHandler.shouldTrackKnownEntity(levelName, entity)) {
            return EntityHandler.ensureEntityKnown(viewer, levelName, entityId);
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

        const entity = targetSession.entities.get(targetSession.clientEntID) ?? CombatHandler.resolveLevelEntity(targetSession.currentLevel, targetSession.clientEntID);
        const facingLeft = Boolean(entity?.facingLeft);
        const payload = CombatHandler.buildEntityStatePayload(targetSession.clientEntID, entState, facingLeft);
        CombatHandler.broadcastToCombatRoom(targetSession, 0x07, payload, false, [targetSession.clientEntID]);
    }

    private static isUnsafeRemotePowerCast(data: Buffer): boolean {
        const info = CombatHandler.parsePowerCastRelayInfo(data);
        if (!info) {
            return false;
        }

        // Flash clients do not receive the actual target entity id in 0x09.
        // Direct-target casts arrive with only a boolean flag, which leaves the
        // remote ActivePower instance with a null target and crashes FireThisPower.
        return info.hasTargetEntity && !info.hasTargetPos;
    }

    private static parsePowerCastRelayInfo(data: Buffer): PowerCastRelayInfo | null {
        const br = new BitReader(data);

        try {
            const sourceId = br.readMethod4();
            br.readMethod4(); // powerId
            const hasTargetEntity = br.readMethod15();
            const hasTargetPos = br.readMethod15();

            return {
                sourceId,
                hasTargetEntity,
                hasTargetPos
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

    private static shouldPreventHostilePlayerDeath(levelName: string, sourceId: number, targetSession: Client): boolean {
        if (!levelName || sourceId <= 0 || targetSession.clientEntID <= 0 || sourceId === targetSession.clientEntID) {
            return false;
        }

        const sourceSession = CombatHandler.findPlayerSessionByEntityId(sourceId);
        if (sourceSession && sourceSession.currentLevel === levelName) {
            return false;
        }

        const sourceEntity = CombatHandler.resolveLevelEntity(levelName, sourceId);
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

        const levelEntity = CombatHandler.resolveLevelEntity(targetSession.currentLevel, targetSession.clientEntID);
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

    private static maybeRecordNpcContribution(levelName: string, targetId: number, sourceId: number, damage: number, fallbackClient: Client): void {
        if (!levelName || targetId <= 0 || sourceId <= 0 || damage <= 0) {
            return;
        }

        const targetEntity = CombatHandler.resolveLevelEntity(levelName, targetId);
        if (!targetEntity || targetEntity.isPlayer || Number(targetEntity.team ?? 0) !== 2) {
            return;
        }

        const sourceSession =
            (fallbackClient.clientEntID === sourceId ? fallbackClient : null) ??
            CombatHandler.findPlayerSessionByEntityId(sourceId);
        if (!sourceSession || !sourceSession.playerSpawned || sourceSession.currentLevel !== levelName) {
            return;
        }

        CombatHandler.recordContribution(levelName, targetId, sourceSession, damage);
    }

    static async handlePowerCast(client: Client, data: Buffer): Promise<void> {
        if (CombatHandler.isUnsafeRemotePowerCast(data)) {
            return;
        }

        CombatHandler.broadcastCombatPacket(client, 0x09, data, {
            referencedEntityIds: CombatHandler.parseReferencedEntityIds(0x09, data)
        });
    }

    static async handlePowerHit(client: Client, data: Buffer): Promise<void> {
        const info = CombatHandler.parsePowerHitRelayInfo(data);
        if (!info) {
            return;
        }

        const { targetId, sourceId, damage } = info;
        const currentLevel = client.currentLevel;
        const sourceEntity = CombatHandler.resolveLevelEntity(currentLevel, sourceId);
        const isHostileNpcSource = Boolean(
            sourceEntity &&
            !sourceEntity.isPlayer &&
            Number(sourceEntity.team ?? 0) === EntityTeam.ENEMY
        );

        if (client.currentLevel === 'CraftTownTutorial' && client.keepTutorialState) {
            LevelHandler.checkCraftTownTutorialBossHealth(client, targetId, damage);
        }

        CombatHandler.maybeRecordNpcContribution(client.currentLevel, targetId, sourceId, damage, client);

        let relayDamage = damage;
        const targetSession = CombatHandler.findPlayerSessionByEntityId(targetId);
        if (targetSession && targetSession.currentLevel === client.currentLevel) {
            const preventDeath = CombatHandler.shouldPreventHostilePlayerDeath(client.currentLevel, sourceId, targetSession);
            const resolution = CombatHandler.updatePlayerTargetAfterHit(targetSession, damage, preventDeath);
            relayDamage = resolution.appliedDamage;

            if (resolution.appliedDamage > 0) {
                const hpPayload = CombatHandler.buildHpDeltaPayload(targetSession.clientEntID, -resolution.appliedDamage);
                if (isHostileNpcSource) {
                    CombatHandler.broadcastEntityViewPacket(currentLevel, sourceEntity, 0x3A, hpPayload, [targetSession.clientEntID, sourceId]);
                } else {
                    CombatHandler.broadcastPlayerHpDelta(targetSession, -resolution.appliedDamage);
                }
            }

            if (resolution.killed) {
                if (isHostileNpcSource) {
                    const entity = targetSession.entities.get(targetSession.clientEntID) ??
                        CombatHandler.resolveLevelEntity(targetSession.currentLevel, targetSession.clientEntID);
                    const facingLeft = Boolean(entity?.facingLeft);
                    const statePayload = CombatHandler.buildEntityStatePayload(targetSession.clientEntID, EntityState.DEAD, facingLeft);
                    CombatHandler.broadcastEntityViewPacket(currentLevel, sourceEntity, 0x07, statePayload, [targetSession.clientEntID, sourceId]);
                } else {
                    CombatHandler.broadcastPlayerState(targetSession, EntityState.DEAD);
                }
            }
        } else {
            CombatHandler.updateNpcTargetAfterHit(client.currentLevel, targetId, damage);
        }

        const relayPayload = relayDamage === damage ? data : CombatHandler.buildPowerHitPayload(info, relayDamage);
        if (isHostileNpcSource) {
            CombatHandler.broadcastEntityViewPacket(currentLevel, sourceEntity, 0x0A, relayPayload, [targetId, sourceId]);
            return;
        }

        CombatHandler.broadcastCombatPacket(client, 0x0A, relayPayload, {
            referencedEntityIds: [targetId, sourceId]
        });
    }

    static async handleProjectileExplode(client: Client, data: Buffer): Promise<void> {
        CombatHandler.broadcastCombatPacket(client, 0x0E, data, {
            referencedEntityIds: CombatHandler.parseReferencedEntityIds(0x0E, data)
        });
    }

    static async handleEntityDestroy(client: Client, data: Buffer): Promise<void> {
        const br = new BitReader(data);
        const entityId = br.readMethod9();
        const levelName = client.currentLevel;
        const destroyedEntity =
            client.entities.get(entityId) ??
            (levelName ? GlobalState.levelEntities.get(levelName)?.get(entityId) : null);
        const isLocalOnlyClientSpawnEntity = Boolean(
            levelName &&
            CombatHandler.isLocalOnlyClientSpawnEntity(levelName, destroyedEntity)
        );
        const shouldRelayDestroy = EntityHandler.shouldRelayEntityToOtherClients(levelName, destroyedEntity);

        if (levelName === 'CraftTownTutorial' && client.keepTutorialState) {
            const entityName = String(destroyedEntity?.name ?? '');
            if (entityName === 'GoblinShamanHood' || entityName === 'IntroGoblinShamanHood') {
                client.keepTutorialState.bossDefeated = true;
            }
        }

        client.entities.delete(entityId);

        if (levelName) {
            const levelMap = GlobalState.levelEntities.get(levelName);
            levelMap?.delete(entityId);
            if (levelMap && levelMap.size === 0) {
                GlobalState.levelEntities.delete(levelName);
            }
            CombatHandler.noteEntityDestroyed(levelName, entityId);
            EntityHandler.forgetKnownEntity(levelName, entityId);
        }

        if (shouldRelayDestroy) {
            CombatHandler.broadcastToSameLevel(levelName, 0x0D, data, [], client);
        } else if (isLocalOnlyClientSpawnEntity) {
            CombatHandler.relayPartyLocalEntityDestroy(client, levelName, entityId, data);
        }
    }

    static async handleRequestRespawn(client: Client, data: Buffer): Promise<void> {
        const br = new BitReader(data);
        const usePotion = br.readMethod15();

        if (!usePotion) {
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
            const levelEntity = CombatHandler.resolveLevelEntity(client.currentLevel, entId);
            if (levelEntity && typeof levelEntity === 'object') {
                levelEntity.dead = false;
                levelEntity.entState = EntityState.ACTIVE;
                levelEntity.hp = healAmount;
                levelEntity.maxHp = Math.max(Math.round(Number(levelEntity.maxHp ?? 0)), healAmount);
            }
        }

        if (entId === client.clientEntID) {
            client.authoritativeCurrentHp = healAmount;
            client.authoritativeMaxHp = Math.max(client.authoritativeMaxHp, healAmount);
            const facingLeft = Boolean(ent?.facingLeft ?? false);
            const statePayload = CombatHandler.buildEntityStatePayload(client.clientEntID, EntityState.ACTIVE, facingLeft);
            CombatHandler.broadcastToSameLevel(client.currentLevel, 0x07, statePayload, [client.clientEntID], client);
        }

        const bb = new BitBuffer(false);
        bb.writeMethod4(entId);
        bb.writeMethod24(healAmount);
        CombatHandler.broadcastToSameLevel(client.currentLevel, 0x82, bb.toBuffer(), [entId], client);
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
