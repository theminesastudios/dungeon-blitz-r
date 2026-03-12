import { Client } from '../core/Client';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { BitReader } from '../network/protocol/bitReader';
import { GameData } from '../core/GameData';
import { GlobalState } from '../core/GlobalState';
import { JsonAdapter } from '../database/JsonAdapter';

const db = new JsonAdapter();

interface RewardRequest {
    receiverId: number;
    sourceId: number;
    dropItem: boolean;
    itemMultiplier: number;
    dropGear: boolean;
    gearMultiplier: number; // Legacy packet field; client fills this with material-find multiplier.
    dropMaterial: boolean;
    dropTrove: boolean;
    exp: number;
    petExp: number;
    hpGain: number;
    gold: number;
    worldX: number;
    worldY: number;
    combo: number;
}

interface LootReward {
    gold?: number;
    health?: number;
    gear?: number;
    tier?: number;
    material?: number;
}

export class RewardHandler {
    private static nextLootId = 900000;
    private static readonly MATERIAL_DROP_CHANCE_BY_RANK: Record<string, number> = {
        Minion: 0.2,
        Lieutenant: 0.6,
        MiniBoss: 0.8,
        Boss: 1
    };
    private static readonly DUNGEON_REALM_MAP: Record<string, string> = {
        GoblinRiverDungeon: 'Goblin',
        GoblinRiverDungeonHard: 'Goblin',
        DreamDragonDungeon: 'Ghost',
        DreamDragonDungeonHard: 'Ghost',
        GoblinMineDungeon: 'Goblin',
        GoblinMineDungeonHard: 'Goblin',
        SwampCaveDungeon: 'Devourer',
        SwampCaveDungeonHard: 'Devourer',
        SpiderNestDungeon: 'Spider',
        SpiderNestDungeonHard: 'Spider',
        WyrmCaveDungeon: 'Wyrm',
        WyrmCaveDungeonHard: 'Wyrm',
        WolfDenDungeon: 'Wolf',
        WolfDenDungeonHard: 'Wolf',
        SkeletonCryptDungeon: 'Skeleton',
        SkeletonCryptDungeonHard: 'Skeleton',
        LizardTempleDungeon: 'Lizard',
        LizardTempleDungeonHard: 'Lizard',
        MummyTombDungeon: 'Mummy',
        MummyTombDungeonHard: 'Mummy'
    };

    private static buildLootdrop(
        lootId: number,
        x: number,
        y: number,
        reward: LootReward
    ): Buffer {
        const bb = new BitBuffer(false);
        bb.writeMethod4(lootId);
        bb.writeMethod45(Math.round(x));
        bb.writeMethod45(Math.round(y));

        if (reward.gear && reward.gear > 0) {
            bb.writeMethod15(true);
            bb.writeMethod6(reward.gear, 11);
            bb.writeMethod6(reward.tier ?? 0, 2);
            return bb.toBuffer();
        }
        bb.writeMethod15(false);

        if (reward.material && reward.material > 0) {
            bb.writeMethod15(true);
            bb.writeMethod4(reward.material);
            return bb.toBuffer();
        }
        bb.writeMethod15(false);

        if (reward.gold && reward.gold > 0) {
            bb.writeMethod15(true);
            bb.writeMethod4(reward.gold);
            return bb.toBuffer();
        }
        bb.writeMethod15(false);

        if (reward.health && reward.health > 0) {
            bb.writeMethod15(true);
            bb.writeMethod4(reward.health);
            return bb.toBuffer();
        }
        bb.writeMethod15(false);

        bb.writeMethod15(false);
        bb.writeMethod4(1);
        return bb.toBuffer();
    }

    private static sendXpReward(client: Client, amount: number): void {
        const bb = new BitBuffer(false);
        bb.writeMethod4(amount);
        client.sendBitBuffer(0x2B, bb);
    }

    private static sendGoldReward(client: Client, amount: number, suppress: boolean): void {
        const bb = new BitBuffer(false);
        bb.writeMethod4(amount);
        bb.writeMethod15(suppress);
        client.sendBitBuffer(0x35, bb);
    }

    private static sendGearReward(client: Client, gearId: number, tier: number): void {
        const bb = new BitBuffer(false);
        bb.writeMethod6(gearId, 11);
        bb.writeMethod6(tier, 2);
        client.sendBitBuffer(0x33, bb);
    }

    private static sendMaterialReward(client: Client, materialId: number, amount: number): void {
        const bb = new BitBuffer(false);
        bb.writeMethod4(materialId);
        bb.writeMethod4(amount);
        client.sendBitBuffer(0x34, bb);
    }

    private static sendEntityHeal(client: Client, entityId: number, amount: number): void {
        if (entityId <= 0 || amount <= 0) {
            return;
        }
        const bb = new BitBuffer(false);
        bb.writeMethod4(entityId);
        bb.writeMethod4(amount);
        client.sendBitBuffer(0x3B, bb);
    }

    private static resolveSourceEntity(client: Client, sourceId: number): any {
        if (client.entities.has(sourceId)) {
            return client.entities.get(sourceId);
        }
        const levelMap = client.currentLevel ? GlobalState.levelEntities.get(client.currentLevel) : null;
        return levelMap?.get(sourceId) ?? null;
    }

    private static resolveDropPosition(client: Client, sourceEntity: any, fallbackX: number, fallbackY: number): { x: number; y: number } {
        const x = Number(sourceEntity?.x ?? sourceEntity?.pos_x ?? fallbackX);
        let y = Number(sourceEntity?.y ?? sourceEntity?.pos_y ?? fallbackY);
        const entType = sourceEntity?.name ? GameData.getEntType(String(sourceEntity.name)) : null;
        if (String(entType?.Flying ?? '').toLowerCase() === 'true') {
            const playerEnt = client.entities.get(client.clientEntID);
            y = Number(playerEnt?.y ?? playerEnt?.pos_y ?? y);
        }
        return {
            x: Math.round(Number.isFinite(x) ? x : fallbackX),
            y: Math.round(Number.isFinite(y) ? y : fallbackY)
        };
    }

    private static resolveGearTier(entName: string, entLevel: number): number {
        const entType = GameData.getEntType(entName) || {};
        let dropChance = 0.01;
        const rawChance = Number(entType.ItemDropChance ?? 0);
        if (rawChance > 0) {
            dropChance = Math.min(rawChance, 1) * 0.1;
        }

        const roll = Math.random();
        if (entLevel >= 15 && roll < dropChance * 0.1) {
            return 2;
        }
        if (roll < dropChance * 0.3) {
            return 1;
        }
        return 0;
    }

    private static sanitizeDropMultiplier(value: number | undefined): number {
        return Number.isFinite(value) && Number(value) > 0 ? Number(value) : 1;
    }

    private static resolveMaterialDropChance(entType: any, reward: RewardRequest): number {
        const rank = String(entType?.EntRank ?? 'Minion');
        const baseChance = RewardHandler.MATERIAL_DROP_CHANCE_BY_RANK[rank] ?? RewardHandler.MATERIAL_DROP_CHANCE_BY_RANK.Minion;
        const multiplier = RewardHandler.sanitizeDropMultiplier(reward.gearMultiplier);
        return Math.max(0, Math.min(1, baseChance * multiplier));
    }

    private static spawnLoot(client: Client, x: number, y: number, reward: LootReward, offsetX: number = 0, offsetY: number = 0): void {
        const lootId = ++RewardHandler.nextLootId;
        client.pendingLoot.set(lootId, reward);
        client.send(0x32, RewardHandler.buildLootdrop(lootId, x + offsetX, y + offsetY, reward));
    }

    private static applyXpReward(client: Client, amount: number): boolean {
        if (!client.character || amount <= 0) {
            return false;
        }

        client.character.xp = Number(client.character.xp ?? 0) + amount;
        client.character.level = GameData.getPlayerLevelFromXp(Number(client.character.xp ?? 0));
        RewardHandler.sendXpReward(client, amount);
        return true;
    }

    private static maybeOverrideDungeonReward(client: Client, sourceEntity: any, reward: RewardRequest): {
        exp: number;
        gold: number;
        hpGain: number;
        materialId: number;
        gearId: number;
        gearTier: number;
    } {
        let exp = reward.exp;
        let gold = reward.gold;
        let hpGain = reward.hpGain;
        let materialId = 0;
        let gearId = 0;
        let gearTier = 0;

        const entName = String(sourceEntity?.name ?? '');
        const entType = entName ? GameData.getEntType(entName) : null;
        const entLevel = Math.max(1, Number(entType?.Level ?? 1));
        const playerClass = String(client.character?.class ?? '');
        const realm = String(entType?.Realm ?? RewardHandler.DUNGEON_REALM_MAP[client.currentLevel] ?? '');
        const materialChance = realm ? RewardHandler.resolveMaterialDropChance(entType, reward) : 0;

        if (realm && materialChance > 0 && Math.random() < materialChance) {
            materialId = GameData.getRandomMaterialForRealm(realm);
        }
        if (reward.dropGear) {
            gearId = GameData.getGearIdForEntity(entName, playerClass);
            gearTier = RewardHandler.resolveGearTier(entName, entLevel);
        }

        const needsFallback = gold <= 0 && !reward.dropGear && !reward.dropMaterial;
        if (!needsFallback) {
            return { exp, gold, hpGain, materialId, gearId, gearTier };
        }

        if (exp <= 1 && entName) {
            exp = GameData.calculateNpcExp(entName, entLevel);
        }

        if (gold <= 0) {
            if (entName) {
                gold = GameData.calculateNpcGold(entName, entLevel);
            } else {
                const realmLevel = Math.max(1, Number(client.character?.level ?? 1));
                const index = Math.max(0, Math.min(realmLevel, GameData.MONSTER_GOLD_TABLE.length - 1));
                const baseGold = GameData.MONSTER_GOLD_TABLE[index];
                const rollBase = 0.4 * baseGold * 0.5;
                gold = Math.max(1, Math.floor(rollBase + (rollBase * 2 + 1) * Math.random()));
            }
        }

        if (!gearId && entName && Math.random() < 0.10) {
            gearId = GameData.getGearIdForEntity(entName, playerClass);
            gearTier = RewardHandler.resolveGearTier(entName, entLevel);
        }

        if (hpGain <= 0 && Math.random() < 0.20) {
            const maxHp = Math.max(100, Number(client.authoritativeMaxHp ?? 100));
            hpGain = Math.max(1, Math.floor(maxHp * 0.15));
        }

        return { exp, gold, hpGain, materialId, gearId, gearTier };
    }

    private static async persistCharacter(client: Client): Promise<void> {
        if (!client.userId || !client.character) {
            return;
        }
        const index = client.characters.findIndex((entry) => entry.name === client.character?.name);
        if (index >= 0) {
            client.characters[index] = client.character;
        } else {
            client.characters.push(client.character);
        }
        await db.saveCharacters(client.userId, client.characters);
    }

    static async handleGrantReward(client: Client, data: Buffer): Promise<void> {
        const br = new BitReader(data);
        const reward: RewardRequest = {
            receiverId: br.readMethod9(),
            sourceId: br.readMethod9(),
            dropItem: br.readMethod15(),
            itemMultiplier: br.readMethod309(),
            dropGear: br.readMethod15(),
            gearMultiplier: br.readMethod309(),
            dropMaterial: br.readMethod15(),
            dropTrove: br.readMethod15(),
            exp: br.readMethod9(),
            petExp: br.readMethod9(),
            hpGain: br.readMethod9(),
            gold: br.readMethod9(),
            worldX: br.readMethod24(),
            worldY: br.readMethod24(),
            combo: br.readMethod15() ? br.readMethod9() : 0
        };

        if (!client.character || !client.currentLevel) {
            return;
        }

        const rewardKey = `${client.currentLevel}:${reward.sourceId}`;
        if (client.processedRewardSources.has(rewardKey)) {
            return;
        }
        client.processedRewardSources.add(rewardKey);

        const sourceEntity = RewardHandler.resolveSourceEntity(client, reward.sourceId);
        const dropPosition = RewardHandler.resolveDropPosition(client, sourceEntity, reward.worldX, reward.worldY);
        const resolved = RewardHandler.maybeOverrideDungeonReward(client, sourceEntity, reward);

        const shouldSave =
            RewardHandler.applyXpReward(client, resolved.exp);

        if (resolved.gold > 0) {
            RewardHandler.spawnLoot(client, dropPosition.x, dropPosition.y, { gold: resolved.gold });
        }
        if (resolved.hpGain > 0) {
            RewardHandler.spawnLoot(client, dropPosition.x, dropPosition.y, { health: resolved.hpGain }, Math.floor(Math.random() * 31) - 15, Math.floor(Math.random() * 31) - 15);
        }
        if (resolved.gearId > 0) {
            RewardHandler.spawnLoot(client, dropPosition.x, dropPosition.y, { gear: resolved.gearId, tier: resolved.gearTier }, Math.floor(Math.random() * 41) - 20, Math.floor(Math.random() * 21) - 10);
        }
        if (resolved.materialId > 0) {
            RewardHandler.spawnLoot(client, dropPosition.x, dropPosition.y, { material: resolved.materialId }, Math.floor(Math.random() * 41) - 20, Math.floor(Math.random() * 21) - 10);
        }

        if (shouldSave) {
            await RewardHandler.persistCharacter(client);
        }
    }

    static async handlePickupLootdrop(client: Client, data: Buffer): Promise<void> {
        const br = new BitReader(data);
        const lootId = br.readMethod9();
        const reward = client.pendingLoot.get(lootId);
        if (!reward || !client.character) {
            return;
        }

        client.pendingLoot.delete(lootId);

        let shouldSave = false;

        if (reward.gold && reward.gold > 0) {
            client.character.gold = Number(client.character.gold ?? 0) + reward.gold;
            RewardHandler.sendGoldReward(client, reward.gold, false);
            shouldSave = true;
        }

        if (reward.material && reward.material > 0) {
            const materials = Array.isArray(client.character.materials) ? client.character.materials : [];
            const existing = materials.find((entry: any) => Number(entry.materialID ?? 0) === reward.material);
            if (existing) {
                existing.count = Number(existing.count ?? 0) + 1;
            } else {
                materials.push({ materialID: reward.material, count: 1 });
            }
            client.character.materials = materials;
            RewardHandler.sendMaterialReward(client, reward.material, 1);
            shouldSave = true;
        }

        if (reward.gear && reward.gear > 0) {
            const inventory = Array.isArray(client.character.inventoryGears) ? client.character.inventoryGears : [];
            inventory.push({
                gearID: reward.gear,
                tier: reward.tier ?? 0,
                runes: [0, 0, 0],
                colors: [0, 0]
            });
            client.character.inventoryGears = inventory;
            RewardHandler.sendGearReward(client, reward.gear, reward.tier ?? 0);
            shouldSave = true;
        }

        if (reward.health && reward.health > 0) {
            client.authoritativeCurrentHp = Math.min(
                Math.max(0, Number(client.authoritativeCurrentHp ?? reward.health) + reward.health),
                Math.max(1, Number(client.authoritativeMaxHp ?? 100))
            );
            RewardHandler.sendEntityHeal(client, client.clientEntID, reward.health);
        }

        if (shouldSave) {
            await RewardHandler.persistCharacter(client);
        }
    }
}
