
import { Client } from '../core/Client';
import { DebugLogger } from '../core/Debug';
import { BuildingID } from '../core/Enums';
import { BitReader } from '../network/protocol/bitReader';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { JsonAdapter } from '../database/JsonAdapter';
import { WalletService } from '../database/WalletService';
import { WorldEnter } from '../utils/WorldEnter';
import { isVisitingAnotherPlayersCraftTown } from '../utils/HomeVisitGuard';
import buildingTypes from '../data/BuildingTypes.json';

const db = new JsonAdapter();

type BuildingDef = {
    BuildingID?: string;
    Rank?: string;
    GoldCost?: string;
    IdolCost?: string;
    UpgradeTime?: string;
};

const buildingDefsByKey = new Map<string, BuildingDef>(
    (buildingTypes as BuildingDef[]).map((entry) => [
        `${Number(entry.BuildingID ?? 0)}:${Number(entry.Rank ?? 0)}`,
        entry
    ])
);

export class BuildingHandler {
    private static readonly MAX_BUILDING_UPGRADE_SECONDS = 4 * 24 * 60 * 60;
    private static readonly CRAFT_TOWN_REFRESH_RETRY_DELAYS_MS = [1200, 2800];

    private static rejectVisitedHomeMutation(client: Client, action: string): boolean {
        if (!isVisitingAnotherPlayersCraftTown(client)) {
            return false;
        }

        DebugLogger.logProgress('HomeVisit:buildingMutationBlocked', client, client.character, {
            action,
            host: client.craftTownHostCharacter?.name
        });

        if (client.playerSpawned && client.currentLevel === 'CraftTown') {
            BuildingHandler.sendBuildingUpdate(client);
        }

        return true;
    }

    private static async saveCharacter(client: Client): Promise<void> {
        if (!client.userId || !client.character) {
            return;
        }

        client.characters = await db.saveCharacterSnapshot(client.userId, client.character);
    }

    static async syncCompletionState(client: Client): Promise<void> {
        if (!client.character) {
            return;
        }

        const completed = BuildingHandler.applyCompletedBuildingUpgradeIfNeeded(client.character);
        if (!completed) {
            return;
        }

        await BuildingHandler.saveCharacter(client);
        DebugLogger.logProgress('BuildingCompletion:syncApplied', client, client.character, {
            buildingId: completed.buildingId,
            rank: completed.rank
        });

        if (client.playerSpawned && client.currentLevel === 'CraftTown') {
            BuildingHandler.sendBuildingComplete(client, completed.buildingId, completed.rank);
            BuildingHandler.sendBuildingUpdate(client);
        }
    }

    private static applyCompletedBuildingUpgradeIfNeeded(character: Record<string, any>): { buildingId: number; rank: number } | null {
        const upgrade = BuildingHandler.asRecord(character.buildingUpgrade);
        const buildingId = Math.max(0, Math.round(Number(upgrade.buildingID ?? 0)));
        const rank = Math.max(0, Math.round(Number(upgrade.rank ?? 0)));
        const readyTime = Math.max(0, Math.round(Number(upgrade.ReadyTime ?? 0)));
        if (buildingId <= 0 || rank <= 0 || readyTime <= 0 || readyTime > Math.floor(Date.now() / 1000)) {
            return null;
        }

        if (!character.magicForge || typeof character.magicForge !== 'object' || Array.isArray(character.magicForge)) {
            character.magicForge = { stats_by_building: {} };
        }
        if (!character.magicForge.stats_by_building || typeof character.magicForge.stats_by_building !== 'object' || Array.isArray(character.magicForge.stats_by_building)) {
            character.magicForge.stats_by_building = {};
        }

        const statsByBuilding = character.magicForge.stats_by_building as Record<string, number>;
        const currentRank = Number(statsByBuilding[buildingId.toString()] ?? statsByBuilding[buildingId] ?? 0);
        statsByBuilding[buildingId.toString()] = Math.max(currentRank, rank);
        character.buildingUpgrade = { buildingID: 0, rank: 0, ReadyTime: 0 };

        return { buildingId, rank: statsByBuilding[buildingId.toString()] };
    }

    private static sendPremiumPurchase(client: Client, itemName: string, cost: number): void {
        if (cost <= 0) {
            return;
        }

        const bb = new BitBuffer();
        bb.writeMethod13(itemName);
        bb.writeMethod4(cost);
        client.sendBitBuffer(0xB5, bb);
    }

    private static getBuildingDef(buildingId: number, rank: number): BuildingDef | null {
        return buildingDefsByKey.get(`${buildingId}:${rank}`) ?? null;
    }

    private static getUpgradeTimeSeconds(rawUpgradeTime: unknown): number {
        const seconds = Math.max(0, Math.round(Number(rawUpgradeTime ?? 0)));
        if (seconds <= 0) {
            return 0;
        }

        return Math.min(seconds, BuildingHandler.MAX_BUILDING_UPGRADE_SECONDS);
    }

    static refreshCraftTownBuildingsOnSpawn(client: Client): void {
        if (!client.character || !client.playerSpawned || client.currentLevel !== 'CraftTown') {
            return;
        }

        BuildingHandler.sendBuildingUpdate(client);
        DebugLogger.logProgress('BuildingRefresh:spawn', client, client.character, {
            reason: 'crafttown_spawn'
        });

        for (const delayMs of BuildingHandler.CRAFT_TOWN_REFRESH_RETRY_DELAYS_MS) {
            const timer = setTimeout(() => {
                if (!client.character || !client.playerSpawned || client.currentLevel !== 'CraftTown') {
                    return;
                }

                BuildingHandler.sendBuildingUpdate(client);
            }, delayMs);
            timer.unref?.();
        }
    }

    // 0xD7: Upgrade Building
    // Python: building_id (20 bits), target_rank (20 bits), used_idols (15 bits) -> weird bit counts?
    // Python: br.read_method_20(5), br.read_method_20(5), br.read_method_15()
    static async handleBuildingUpgrade(client: Client, data: Buffer): Promise<void> {
        if (!client.userId || !client.character) return;
        if (BuildingHandler.rejectVisitedHomeMutation(client, 'upgrade')) return;

        const br = new BitReader(data);
        const buildingId = br.readMethod20(5);
        const targetRank = br.readMethod20(5);
        const usedIdols = br.readMethod15();

        console.log(`[Building] Upgrade request: ID=${buildingId}, Rank=${targetRank}, Idols=${usedIdols}`);
        DebugLogger.logProgress('BuildingUpgrade:request', client, client.character, {
            buildingId,
            targetRank,
            usedIdols
        });

        const statsByBuilding = BuildingHandler.asRecord(client.character.magicForge?.stats_by_building);
        const currentRank = Number(statsByBuilding[buildingId.toString()] ?? statsByBuilding[buildingId] ?? 0);
        if (buildingId > 0 && targetRank > 0 && currentRank >= targetRank) {
            DebugLogger.logProgress('BuildingUpgrade:ignored', client, client.character, {
                buildingId,
                targetRank,
                currentRank,
                usedIdols,
                reason: 'already_at_or_above_target_rank'
            });

            if (client.playerSpawned && client.currentLevel === 'CraftTown') {
                BuildingHandler.sendBuildingComplete(client, buildingId, currentRank);
                BuildingHandler.sendBuildingUpdate(client);
            }
            return;
        }

        const buildingDef = BuildingHandler.getBuildingDef(buildingId, targetRank);
        if (!buildingDef) {
            DebugLogger.logProgress('BuildingUpgrade:rejected', client, client.character, {
                buildingId,
                targetRank,
                usedIdols,
                reason: 'missing_building_definition'
            });
            return;
        }

        const goldCost = Math.max(0, Math.round(Number(buildingDef.GoldCost ?? 0)));
        const idolCost = Math.max(0, Math.round(Number(buildingDef.IdolCost ?? 0)));
        const upgradeTime = BuildingHandler.getUpgradeTimeSeconds(buildingDef.UpgradeTime);

        if (usedIdols) {
            const didSpendIdols = await WalletService.spend(client, 'mammothIdols', idolCost);
            if (!didSpendIdols) {
                DebugLogger.logProgress('BuildingUpgrade:rejected', client, client.character, {
                    buildingId,
                    targetRank,
                    usedIdols,
                    idolCost,
                    idols: Number(client.character.mammothIdols ?? 0),
                    reason: 'not_enough_idols'
                });
                return;
            }
        } else {
            const didSpendGold = await WalletService.spend(client, 'gold', goldCost);
            if (!didSpendGold) {
                DebugLogger.logProgress('BuildingUpgrade:rejected', client, client.character, {
                    buildingId,
                    targetRank,
                    usedIdols,
                    goldCost,
                    gold: Number(client.character.gold ?? 0),
                    reason: 'not_enough_gold'
                });
                return;
            }
        }

        const readyTime = Math.floor(Date.now() / 1000) + upgradeTime;

        if (!client.character.buildingUpgrade) {
            client.character.buildingUpgrade = {
                buildingID: buildingId,
                rank: targetRank,
                ReadyTime: readyTime
            };
        } else {
            client.character.buildingUpgrade.buildingID = buildingId;
            client.character.buildingUpgrade.rank = targetRank;
            client.character.buildingUpgrade.ReadyTime = readyTime;
        }

        // Save
        await BuildingHandler.saveCharacter(client);
        DebugLogger.logProgress('BuildingUpgrade:queued', client, client.character, {
            buildingId,
            targetRank,
            readyTime,
            goldCost: usedIdols ? 0 : goldCost,
            idolCost: usedIdols ? idolCost : 0
        });

        if (usedIdols) {
            BuildingHandler.sendPremiumPurchase(client, 'BuildingUpgrade', idolCost);
        }
        
        // Note: Python scheduling logic sets a timer. 
        // For now, client might handle countdown? Or we need to send immediate completion if debug?
        // We'll leave it as pending to match behavior.
    }

    // 0xDC: Building Speed Up
    // Python: idol_cost (Method9)
    static async handleBuildingSpeedUpRequest(client: Client, data: Buffer): Promise<void> {
        if (!client.userId || !client.character) return;
        if (BuildingHandler.rejectVisitedHomeMutation(client, 'speedup')) return;

        const br = new BitReader(data);
        const idolCost = br.readMethod9();

        console.log(`[Building] SpeedUp request: Cost=${idolCost}`);
        DebugLogger.logProgress('BuildingSpeedup:request', client, client.character, {
            idolCost
        });

        const upgrade = client.character.buildingUpgrade;
        if (!upgrade || !upgrade.buildingID) {
            const existingRank = BuildingHandler.getBuildingRank(client.character, 1);
            DebugLogger.logProgress('BuildingSpeedup:ignored', client, client.character, {
                idolCost,
                reason: 'no_active_building_upgrade',
                existingTomeRank: existingRank
            });

            if (client.playerSpawned && client.currentLevel === 'CraftTown' && existingRank > 0) {
                BuildingHandler.sendBuildingComplete(client, 1, existingRank);
                BuildingHandler.sendBuildingUpdate(client);
            }
            return;
        }

        if (idolCost > 0) {
            const didSpendIdols = await WalletService.spend(client, 'mammothIdols', idolCost);
            if (!didSpendIdols) {
                return;
            }
        }

        // Apply Upgrade Immediately
        const buildingId = upgrade.buildingID;
        const newRank = upgrade.rank;

        // Update Stats
        if (!client.character.magicForge) {
            client.character.magicForge = { stats_by_building: {} };
        }
        client.character.magicForge.stats_by_building[buildingId.toString()] = newRank;

        client.character.buildingUpgrade = { buildingID: 0, rank: 0, ReadyTime: 0 };
        
        await BuildingHandler.saveCharacter(client);
        DebugLogger.logProgress('BuildingSpeedup:applied', client, client.character, {
            idolCost,
            buildingId,
            newRank
        });

        BuildingHandler.sendPremiumPurchase(client, 'BuildingSpeedup', idolCost);

        // Send Completion Packet (0xD8)
        BuildingHandler.sendBuildingComplete(client, buildingId, newRank);

        if (client.playerSpawned && client.currentLevel === 'CraftTown') {
            BuildingHandler.sendBuildingUpdate(client);
        }
    }

    static async handleBuildingClaim(client: Client, data: Buffer): Promise<void> {
        if (!client.userId || !client.character) return;
        if (BuildingHandler.rejectVisitedHomeMutation(client, 'claim')) return;

        const upgrade = client.character.buildingUpgrade;
        const buildingId = Number(upgrade?.buildingID ?? 0);
        const rank = Number(upgrade?.rank ?? 0);

        if (buildingId > 0 && rank > 0) {
            if (!client.character.magicForge) {
                client.character.magicForge = { stats_by_building: {} };
            }
            if (!client.character.magicForge.stats_by_building) {
                client.character.magicForge.stats_by_building = {};
            }
            client.character.magicForge.stats_by_building[buildingId.toString()] = rank;
        }

        client.character.buildingUpgrade = { buildingID: 0, rank: 0, ReadyTime: 0 };
        await BuildingHandler.saveCharacter(client);
        DebugLogger.logProgress('BuildingClaim:applied', client, client.character, {
            buildingId,
            rank
        });
    }

    static async handleBuildingCancel(client: Client, _data: Buffer): Promise<void> {
        if (!client.userId || !client.character) return;
        if (BuildingHandler.rejectVisitedHomeMutation(client, 'cancel')) return;

        const upgrade = client.character.buildingUpgrade;
        const buildingId = Number(upgrade?.buildingID ?? 0);
        const rank = Number(upgrade?.rank ?? 0);

        client.character.buildingUpgrade = { buildingID: 0, rank: 0, ReadyTime: 0 };
        await BuildingHandler.saveCharacter(client);
        DebugLogger.logProgress('BuildingCancel:applied', client, client.character, {
            buildingId,
            rank
        });

        if (client.playerSpawned && client.currentLevel === 'CraftTown') {
            BuildingHandler.sendBuildingUpdate(client);
        }
    }

    static sendBuildingComplete(client: Client, buildingId: number, rank: number): void {
        const bb = new BitBuffer();
        bb.writeMethod6(buildingId, 5);
        bb.writeMethod6(rank, 5);
        bb.writeMethod15(true); // Complete
        
        client.sendBitBuffer(0xD8, bb);
    }

    // Ported from WorldEnter.py: send_building_update
    // Packet 0xDA
    static sendBuildingUpdate(client: Client, overrideRank: number = -1): void {
         if (!client.character) return;

         const homeCharacter = client.currentLevel === 'CraftTown' && client.craftTownHostCharacter
            ? client.craftTownHostCharacter
            : client.character;
         WorldEnter.ensureSelectedDisciplineTower(homeCharacter);
         if (!homeCharacter.magicForge) return;

         const mfStats = BuildingHandler.sanitizeBuildingStatsForClient(
            homeCharacter.magicForge.stats_by_building || {}
         );
         const getStat = (id: number): number => Number(mfStats[id.toString()] ?? 0);

         const MASTERCLASS_TO_BUILDING: Record<number, number> = {
            1: BuildingID.ExecutionerTower,
            2: BuildingID.ShadowwalkerTower,
            3: BuildingID.SoulthiefTower,
            4: BuildingID.SentinelTower,
            5: BuildingID.JusticarTower,
            6: BuildingID.TemplarTower,
            7: BuildingID.FrostwardenTower,
            8: BuildingID.FlameseerTower,
            9: BuildingID.NecromancerTower
         };
         const CLASS_TOWER_BUILDINGS: Record<string, number[]> = {
            paladin: [BuildingID.SentinelTower, BuildingID.JusticarTower, BuildingID.TemplarTower],
            mage: [BuildingID.FrostwardenTower, BuildingID.FlameseerTower, BuildingID.NecromancerTower],
            rogue: [BuildingID.ExecutionerTower, BuildingID.ShadowwalkerTower, BuildingID.SoulthiefTower]
         };
         
         const masterClassId = WorldEnter.resolveMasterClass(homeCharacter);
         const towerBuildingId = MASTERCLASS_TO_BUILDING[masterClassId] || 3;
         const buildingUpgrade = BuildingHandler.asRecord(homeCharacter.buildingUpgrade);
         const buildingReadyTime = Number(buildingUpgrade.ReadyTime ?? 0);
         const scaffoldingId = buildingReadyTime > Math.floor(Date.now() / 1000)
            ? Number(buildingUpgrade.buildingID ?? 0)
            : 0;

         const sendDelta = (bid: number, targetRank: number) => {
             const prevRank = targetRank > 0 ? targetRank - 1 : 0;
             const bb = new BitBuffer();
             // building_id (5 bits)
             bb.writeMethod6(bid, 5); // class_9.const_129
             // prev_rank (5 bits)
             bb.writeMethod6(prevRank, 5); // class_9.const_28
             // building_id again? (Python: buf.write_method_6(building_id, class_9.const_129))
             bb.writeMethod6(bid, 5);
             // target_rank (5 bits)
             bb.writeMethod6(targetRank, 5);
             // scaffolding_id (5 bits)
             bb.writeMethod6(scaffoldingId, 5);

             client.sendBitBuffer(0xDA, bb);
         };

         // Reassert every class tower. Sending only the active tower lets inactive
         // discipline towers fall back to rank 1 after a relog/House refresh.
         const classTowerIds = CLASS_TOWER_BUILDINGS[String(homeCharacter.class ?? '').toLowerCase()] ?? [towerBuildingId];
         const inactiveClassTowerIds = classTowerIds.filter((buildingId) => buildingId !== towerBuildingId);
         const bids = Array.from(new Set([2, 12, ...inactiveClassTowerIds, towerBuildingId, 1, 13]));
         for (const bid of bids) {
             sendDelta(bid, getStat(bid));
         }
    }

    private static asRecord(value: unknown): Record<string, unknown> {
        return value && typeof value === 'object' && !Array.isArray(value)
            ? value as Record<string, unknown>
            : {};
    }

    private static sanitizeBuildingStatsForClient(statsByBuilding: Record<string, unknown>): Record<string, unknown> {
        const keepRank = Number(statsByBuilding[String(BuildingID.Keep)] ?? statsByBuilding[BuildingID.Keep] ?? 0);
        if (!Number.isFinite(keepRank) || keepRank <= 0) {
            return statsByBuilding;
        }

        return {
            ...statsByBuilding,
            [BuildingID.Keep]: 0,
            [String(BuildingID.Keep)]: 0
        };
    }

    private static getBuildingRank(character: Record<string, unknown>, buildingId: number): number {
        const magicForge = BuildingHandler.asRecord(character.magicForge);
        const statsByBuilding = BuildingHandler.asRecord(magicForge.stats_by_building);
        return Number(statsByBuilding[buildingId.toString()] ?? statsByBuilding[buildingId] ?? 0);
    }
}
