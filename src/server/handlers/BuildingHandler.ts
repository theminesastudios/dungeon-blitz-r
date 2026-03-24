
import { Client } from '../core/Client';
import { DebugLogger } from '../core/Debug';
import { BitReader } from '../network/protocol/bitReader';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { JsonAdapter } from '../database/JsonAdapter';

const db = new JsonAdapter();

export class BuildingHandler {
    private static readonly CRAFT_TOWN_REFRESH_RETRY_DELAYS_MS = [1200, 2800];

    private static async saveCharacter(client: Client): Promise<void> {
        if (!client.userId || !client.character) {
            return;
        }

        client.characters = await db.saveCharacterSnapshot(client.userId, client.character);
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

        // Simplified Logic: 
        // 1. Calculate time/cost (skipped for now, assume valid)
        // 2. Set upgrade state
        
        // Mock 1 minute upgrade time
        const upgradeTime = 60; 
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
            readyTime
        });
        
        // Note: Python scheduling logic sets a timer. 
        // For now, client might handle countdown? Or we need to send immediate completion if debug?
        // We'll leave it as pending to match behavior.
    }

    // 0xDC: Building Speed Up
    // Python: idol_cost (Method9)
    static async handleBuildingSpeedUpRequest(client: Client, data: Buffer): Promise<void> {
        if (!client.userId || !client.character) return;

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
            const idols = Number(client.character.mammothIdols ?? 0);
            if (idols < idolCost) {
                return;
            }

            client.character.mammothIdols = idols - idolCost;
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
         // This needs character data
         if (!client.character || !client.character.magicForge) return;

         const mfStats = client.character.magicForge.stats_by_building || {};
         const getStat = (id: number) => mfStats[id.toString()] || 0;

         // Resolve MasterClass (can use helper if available, or just use current)
         const masterClassId = client.character.MasterClass || 0;
         
         // Helper: Map MasterClass to BuildingID for tower
         // We can use WorldEnter's map if we export it, or dup logic.
         // Let's assume a simplified map or rely on what WorldEnter sets.
         // Actually, WorldEnter.ts has this logic private.
         // Let's duplicate mapping for now or make it shared. Defaulting to 3 (Justicar) if unknown.
         
         const MASTERCLASS_TO_BUILDING: Record<number, number> = {
            1: 9, 2: 10, 3: 11, // Rogue
            4: 3, 5: 4, 6: 5,   // Paladin (Justicar=4->3, etc. Checking Python)
            // Python: {1: 9, 2: 10, 3: 11, 4: 3, 5: 4, 6: 5, 7: 6, 8: 7, 9: 8}
            // TS Original: {4: 4, 5: 3, 6: 5} -> Mismatch.
            // Python has: 4: 3, 5: 4, 6: 5. 
            // 4=Justicar(3), 5=Avenger(4), 6=Crusader(5)? 
            // Python: "MASTERCLASS_TO_BUILDING = {1:9, ... 4:3, 5:4, 6:5 ...}" 
            // Let's use Python's values.
            7: 6, 8: 7, 9: 8    // Mage
         };
         
         const towerBuildingId = MASTERCLASS_TO_BUILDING[masterClassId] || 3;
         const scaffoldingId = client.character.buildingUpgrade?.buildingID || 0;

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

         // Send updates for core buildings
         // Python: for bid in (2, 12, tower_building_id, 1, 13):
         const bids = [2, 12, towerBuildingId, 1, 13];
         for (const bid of bids) {
             sendDelta(bid, getStat(bid));
         }
    }

    private static asRecord(value: unknown): Record<string, unknown> {
        return value && typeof value === 'object' && !Array.isArray(value)
            ? value as Record<string, unknown>
            : {};
    }

    private static getBuildingRank(character: Record<string, unknown>, buildingId: number): number {
        const magicForge = BuildingHandler.asRecord(character.magicForge);
        const statsByBuilding = BuildingHandler.asRecord(magicForge.stats_by_building);
        return Number(statsByBuilding[buildingId.toString()] ?? statsByBuilding[buildingId] ?? 0);
    }
}
