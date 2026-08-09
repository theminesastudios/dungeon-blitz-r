import abilityTypes from '../data/AbilityTypes.json';
import { JsonAdapter } from '../database/JsonAdapter';
import { Client } from '../core/Client';
import { BuildingID, MasterClassID } from '../core/Enums';
import { TalentConfig } from '../core/TalentConfig';
import { BitReader } from '../network/protocol/bitReader';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { EntityHandler } from './EntityHandler';
import { isVisitingAnotherPlayersCraftTown } from '../utils/HomeVisitGuard';
import { SpeedupPricing } from '../core/SpeedupPricing';

type AbilityDef = {
    AbilityID: string;
    Rank: string;
    GoldCost?: string;
    IdolCost?: string;
    UpgradeTime?: string;
};

type CharacterRecord = Record<string, unknown>;
type SkillResearchRecord = Record<string, unknown>;
type AbilityResearchClaimResult = {
    abilityId: number;
    targetRank: number;
    currentRank: number;
    tutorialEcho: boolean;
    applied: boolean;
};

const db = new JsonAdapter();
const abilityDefs = abilityTypes as AbilityDef[];
const abilityDefsByKey = new Map<string, AbilityDef>(
    abilityDefs.map((def) => [`${def.AbilityID}:${def.Rank}`, def])
);
const knownAbilityIds = new Set<number>(
    abilityDefs.map((def) => Number(def.AbilityID ?? 0)).filter((abilityId) => abilityId > 0)
);

export class AbilityHandler {
    private static readonly STARTER_ABILITIES: Record<string, number[]> = {
        rogue: [3, 5],
        mage: [10, 14],
        paladin: [20, 24]
    };

    private static readonly MASTERCLASS_NAMES: Record<number, string> = {
        [MasterClassID.Executioner]: 'Executioner',
        [MasterClassID.Shadowwalker]: 'ShadowWalker',
        [MasterClassID.Soulthief]: 'Soulthief',
        [MasterClassID.Sentinel]: 'Sentinel',
        [MasterClassID.Justicar]: 'Justicar',
        [MasterClassID.Templar]: 'Templar',
        [MasterClassID.Frostwarden]: 'Frostwarden',
        [MasterClassID.Flameseer]: 'Flameseer',
        [MasterClassID.Necromancer]: 'Necromancer'
    };

    private static rejectsVisitedHomeMutation(client: Client): boolean {
        return isVisitingAnotherPlayersCraftTown(client);
    }

    private static getAuthoritativeTomeRank(character: CharacterRecord): number {
        const magicForge = character.magicForge && typeof character.magicForge === 'object' && !Array.isArray(character.magicForge)
            ? character.magicForge as Record<string, unknown>
            : {};
        const stats = magicForge.stats_by_building && typeof magicForge.stats_by_building === 'object' && !Array.isArray(magicForge.stats_by_building)
            ? magicForge.stats_by_building as Record<string, unknown>
            : {};
        const rank = Math.floor(Number(stats[String(BuildingID.Tome)] ?? 0));
        return Number.isFinite(rank) ? Math.max(0, Math.min(rank, 10)) : 0;
    }

    private static canResearchRank(character: CharacterRecord, rank: number): boolean {
        // Building rank N unlocks ability rank N + 1, as authored in BuildingTypes.
        return rank <= AbilityHandler.getAuthoritativeTomeRank(character) + 1;
    }

    static async handleActiveAbilitiesUpdate(client: Client, data: Buffer): Promise<void> {
        if (!client.character) return;

        const br = new BitReader(data);
        const activeAbilities = AbilityHandler.getActiveAbilities(client.character);

        for (let i = 0; i < 3; i++) {
            const changed = br.readMethod15();
            if (!changed) {
                continue;
            }

            activeAbilities[i] = br.readMethod20(7);
        }

        client.character.activeAbilities = activeAbilities;
        AbilityHandler.repairCharacterAbilityState(client.character);
        await AbilityHandler.saveCharacter(client);
    }

    static async handleStartAbilityResearch(client: Client, data: Buffer): Promise<void> {
        if (!client.character || AbilityHandler.rejectsVisitedHomeMutation(client)) return;

        const br = new BitReader(data);
        const abilityId = br.readMethod20(7);
        const rank = br.readMethod20(4);
        const payWithIdols = br.readMethod15();

        if (abilityId <= 0 || rank <= 0 || !AbilityHandler.canResearchRank(client.character, rank)) {
            return;
        }
        AbilityHandler.repairCharacterAbilityState(client.character);

        const skillResearch = AbilityHandler.getSkillResearch(client.character);
        if (Number(skillResearch.abilityID ?? 0) !== 0) {
            return;
        }

        let currentRank = AbilityHandler.getLearnedAbilityRank(client.character, abilityId);
        if (
            currentRank === 0 &&
            rank > 1 &&
            AbilityHandler.canInferMissingSavedRank(client.character, abilityId, rank)
        ) {
            currentRank = rank - 1;
            AbilityHandler.setLearnedAbilityRank(client.character, abilityId, currentRank);
        }
        if (rank !== currentRank + 1) {
            if (AbilityHandler.shouldTreatAsTutorialEcho(client, abilityId, rank, currentRank)) {
                client.character.SkillResearch = {
                    abilityID: abilityId,
                    rank,
                    ReadyTime: 0,
                    tutorialEcho: true
                };
                await AbilityHandler.saveCharacter(client);
                AbilityHandler.sendAbilityResearchDone(client, abilityId);
                return;
            }
            return;
        }

        const abilityDef = AbilityHandler.getAbilityDef(abilityId, rank);
        if (!abilityDef) {
            return;
        }

        const goldCost = Number(abilityDef.GoldCost ?? 0);
        const idolCost = Number(abilityDef.IdolCost ?? 0);
        const upgradeTime = Number(abilityDef.UpgradeTime ?? 0);

        if (payWithIdols) {
            const idols = Number(client.character.mammothIdols ?? 0);
            if (idols < idolCost) {
                return;
            }

            client.character.SkillResearch = {
                abilityID: abilityId,
                rank,
                ReadyTime: 0
            };

            const claimResult = AbilityHandler.applyCompletedAbilityResearch(client.character);
            if (!claimResult) {
                return;
            }

            client.character.mammothIdols = idols - idolCost;
            await AbilityHandler.saveCharacter(client);
            AbilityHandler.sendPremiumPurchase(client, 'AbilityResearch', idolCost);
            AbilityHandler.sendAbilityResearchDone(client, abilityId);
            AbilityHandler.refreshPlayerSnapshot(client);
            return;
        } else {
            const gold = Number(client.character.gold ?? 0);
            if (gold < goldCost) {
                return;
            }
            client.character.gold = gold - goldCost;
        }

        const now = Math.floor(Date.now() / 1000);
        client.character.SkillResearch = {
            abilityID: abilityId,
            rank,
            ReadyTime: now + upgradeTime
        };

        await AbilityHandler.saveCharacter(client);
    }

    static async handleClaimAbilityResearch(client: Client): Promise<void> {
        if (!client.character || AbilityHandler.rejectsVisitedHomeMutation(client)) return;

        const skillResearch = AbilityHandler.getSkillResearch(client.character);
        const abilityId = Number(skillResearch.abilityID ?? 0);
        if (abilityId === 0) {
            return;
        }

        const readyTime = Number(skillResearch.ReadyTime ?? 0);
        const now = Math.floor(Date.now() / 1000);
        if (readyTime > 0 && readyTime > now) {
            return;
        }

        const claimResult = AbilityHandler.applyCompletedAbilityResearch(client.character);
        if (!claimResult) {
            return;
        }

        await AbilityHandler.saveCharacter(client);
        if (claimResult.tutorialEcho && !claimResult.applied) {
            return;
        }
        AbilityHandler.refreshPlayerSnapshot(client);
    }

    static async handleClearAbilityResearch(client: Client): Promise<void> {
        if (!client.character || AbilityHandler.rejectsVisitedHomeMutation(client)) return;

        client.character.SkillResearch = {};
        await AbilityHandler.saveCharacter(client);
    }

    static async handleSpeedupAbilityResearch(client: Client, data: Buffer): Promise<void> {
        if (!client.character || AbilityHandler.rejectsVisitedHomeMutation(client)) return;

        const br = new BitReader(data);
        const idolCost = br.readMethod9();
        const skillResearch = AbilityHandler.getSkillResearch(client.character);
        const abilityId = Number(skillResearch.abilityID ?? 0);
        if (abilityId === 0) {
            return;
        }

        const authoritativeCost = SpeedupPricing.reconcile(skillResearch.ReadyTime, idolCost);
        const idols = Number(client.character.mammothIdols ?? 0);
        if (idols < authoritativeCost) {
            console.warn(
                `[Ability] Refused a Speed Up for ${client.character.name}: ` +
                `has ${idols} idols, needs ${authoritativeCost} (client claimed ${idolCost}).`
            );
            SpeedupPricing.refreshScreens(client);
            return;
        }

        client.character.SkillResearch = {
            ...skillResearch,
            ReadyTime: 0
        };

        const claimResult = AbilityHandler.applyCompletedAbilityResearch(client.character);
        if (!claimResult) {
            return;
        }

        client.character.mammothIdols = idols - authoritativeCost;

        await AbilityHandler.saveCharacter(client);
        AbilityHandler.sendPremiumPurchase(client, 'AbilitySpeedup', authoritativeCost);
        AbilityHandler.sendAbilityResearchDone(client, abilityId);
        AbilityHandler.refreshPlayerSnapshot(client);
    }

    static repairCharacterAbilityState(character: CharacterRecord): boolean {
        const starterAbilities = AbilityHandler.STARTER_ABILITIES[String(character.class ?? '').toLowerCase()] ?? [];
        const originalLearned = Array.isArray(character.learnedAbilities)
            ? character.learnedAbilities as Array<Record<string, number>>
            : [];
        const originalActive = Array.isArray(character.activeAbilities)
            ? character.activeAbilities.map((value) => Number(value ?? 0))
            : [];

        const learnedRanks = new Map<number, number>();
        for (const rawAbility of originalLearned) {
            const ability = rawAbility && typeof rawAbility === 'object' ? rawAbility : {};
            const abilityId = Number((ability as Record<string, number>).abilityID ?? 0);
            const rank = Number((ability as Record<string, number>).rank ?? 0);
            if (abilityId <= 0 || rank <= 0) {
                continue;
            }

            learnedRanks.set(abilityId, Math.max(rank, learnedRanks.get(abilityId) ?? 0));
        }

        for (const starterAbilityId of starterAbilities) {
            if (!learnedRanks.has(starterAbilityId)) {
                learnedRanks.set(starterAbilityId, 1);
            }
        }

        for (const defaultMasterAbilityId of AbilityHandler.getDefaultMasterAbilityIds(character)) {
            if (!learnedRanks.has(defaultMasterAbilityId)) {
                learnedRanks.set(defaultMasterAbilityId, 1);
            }
        }

        for (const rawAbilityId of originalActive) {
            const abilityId = Number(rawAbilityId ?? 0);
            if (abilityId <= 0 || !knownAbilityIds.has(abilityId) || learnedRanks.has(abilityId)) {
                continue;
            }

            learnedRanks.set(abilityId, 1);
        }

        const learnedAbilities = Array.from(learnedRanks.entries())
            .sort((left, right) => left[0] - right[0])
            .map(([abilityID, rank]) => ({ abilityID, rank }));
        character.learnedAbilities = learnedAbilities;

        const validAbilityIds = new Set(learnedAbilities.map((ability) => ability.abilityID));
        const activeAbilities: number[] = [];
        const seenActive = new Set<number>();

        for (const rawAbilityId of originalActive) {
            const abilityId = Number(rawAbilityId ?? 0);
            if (abilityId <= 0 || !validAbilityIds.has(abilityId) || seenActive.has(abilityId)) {
                continue;
            }

            activeAbilities.push(abilityId);
            seenActive.add(abilityId);
            if (activeAbilities.length >= 3) {
                break;
            }
        }

        if (activeAbilities.length < Math.min(2, starterAbilities.length)) {
            const repairedActiveAbilities: number[] = [];
            const repairedSeen = new Set<number>();

            for (const starterAbilityId of starterAbilities) {
                if (!validAbilityIds.has(starterAbilityId) || repairedSeen.has(starterAbilityId)) {
                    continue;
                }

                repairedActiveAbilities.push(starterAbilityId);
                repairedSeen.add(starterAbilityId);
                if (repairedActiveAbilities.length >= 3) {
                    break;
                }
            }

            for (const abilityId of activeAbilities) {
                if (repairedSeen.has(abilityId)) {
                    continue;
                }

                repairedActiveAbilities.push(abilityId);
                repairedSeen.add(abilityId);
                if (repairedActiveAbilities.length >= 3) {
                    break;
                }
            }

            activeAbilities.length = 0;
            activeAbilities.push(...repairedActiveAbilities);
        }

        character.activeAbilities = activeAbilities;

        const normalizedLearned = JSON.stringify(learnedAbilities);
        const normalizedActive = JSON.stringify(activeAbilities);
        return normalizedLearned !== JSON.stringify(originalLearned) || normalizedActive !== JSON.stringify(originalActive);
    }

    private static getAbilityDef(abilityId: number, rank: number): AbilityDef | undefined {
        return abilityDefsByKey.get(`${abilityId}:${rank}`);
    }

    private static getDefaultMasterAbilityIds(character: CharacterRecord): number[] {
        const masterClassId = Number(character.MasterClass ?? 0);
        const masterClassName = AbilityHandler.MASTERCLASS_NAMES[masterClassId];
        if (!masterClassName) {
            return [];
        }

        const unlockedHotbarLocations = new Set<number>([4]);
        const nodes = AbilityHandler.getMasterClassTalentNodes(character, masterClassId);
        const totalTalentPoints = nodes.reduce((total, node) => total + (node.filled ? Number(node.points ?? 0) : 0), 0);
        if (totalTalentPoints >= 20 && nodes[8]?.filled) {
            unlockedHotbarLocations.add(5);
        }
        if (totalTalentPoints >= 40 && nodes[18]?.filled) {
            unlockedHotbarLocations.add(6);
        }

        return abilityDefs
            .filter((def) =>
                Number(def.Rank ?? 0) === 1 &&
                String((def as Record<string, unknown>).Class ?? '') === masterClassName &&
                unlockedHotbarLocations.has(Number((def as Record<string, unknown>).HotbarLocation ?? -1))
            )
            .map((def) => Number(def.AbilityID ?? 0))
            .filter((abilityId) => abilityId > 0);
    }

    private static getMasterClassTalentNodes(character: CharacterRecord, masterClassId: number) {
        const rawTalentTree = character.TalentTree;
        const talentTree = rawTalentTree && typeof rawTalentTree === 'object' && !Array.isArray(rawTalentTree)
            ? rawTalentTree as Record<string, unknown>
            : {};
        const rawClassTree = talentTree[String(masterClassId)];
        const classTree = rawClassTree && typeof rawClassTree === 'object' && !Array.isArray(rawClassTree)
            ? rawClassTree as Record<string, unknown>
            : {};
        return TalentConfig.normalizeTalentNodes(classTree.nodes);
    }

    private static getLearnedAbilities(character: CharacterRecord): Array<Record<string, number>> {
        const learnedAbilities = Array.isArray(character.learnedAbilities)
            ? character.learnedAbilities as Array<Record<string, number>>
            : [];

        character.learnedAbilities = learnedAbilities;
        return learnedAbilities;
    }

    private static getLearnedAbilityRank(character: CharacterRecord, abilityId: number): number {
        const learnedAbilities = AbilityHandler.getLearnedAbilities(character);
        const learned = learnedAbilities.find((ability) => Number(ability.abilityID ?? 0) === abilityId);
        return Number(learned?.rank ?? 0);
    }

    private static setLearnedAbilityRank(character: CharacterRecord, abilityId: number, rank: number): void {
        const learnedAbilities = AbilityHandler.getLearnedAbilities(character);
        const existing = learnedAbilities.find((ability) => Number(ability.abilityID ?? 0) === abilityId);
        if (existing) {
            existing.rank = Math.max(Number(existing.rank ?? 0), rank);
            return;
        }

        learnedAbilities.push({ abilityID: abilityId, rank });
    }

    private static applyCompletedAbilityResearch(character: CharacterRecord): AbilityResearchClaimResult | null {
        const skillResearch = AbilityHandler.getSkillResearch(character);
        const abilityId = Number(skillResearch.abilityID ?? 0);
        if (abilityId <= 0) {
            return null;
        }

        const currentRank = AbilityHandler.getLearnedAbilityRank(character, abilityId);
        const targetRank = Number(skillResearch.rank ?? currentRank + 1);
        if (!Number.isFinite(targetRank) || targetRank <= 0) {
            return null;
        }

        const tutorialEcho = Boolean(skillResearch.tutorialEcho);
        if (tutorialEcho && currentRank >= targetRank) {
            character.SkillResearch = {};
            return {
                abilityId,
                targetRank,
                currentRank,
                tutorialEcho,
                applied: false
            };
        }

        AbilityHandler.setLearnedAbilityRank(character, abilityId, targetRank);
        character.SkillResearch = {};
        return {
            abilityId,
            targetRank,
            currentRank,
            tutorialEcho,
            applied: targetRank > currentRank
        };
    }

    private static isActiveMasterClassAbility(character: CharacterRecord, abilityId: number): boolean {
        const masterClassName = AbilityHandler.MASTERCLASS_NAMES[Number(character.MasterClass ?? 0)];
        if (!masterClassName) {
            return false;
        }

        return abilityDefs.some((def) =>
            Number(def.AbilityID ?? 0) === abilityId &&
            String((def as Record<string, unknown>).Class ?? '') === masterClassName
        );
    }

    private static canInferMissingSavedRank(character: CharacterRecord, abilityId: number, requestedRank: number): boolean {
        if (AbilityHandler.isActiveMasterClassAbility(character, abilityId)) {
            return true;
        }

        const characterClass = String(character.class ?? '').toLowerCase();
        if (!characterClass) {
            return false;
        }

        const previousRank = requestedRank - 1;
        if (previousRank <= 0) {
            return false;
        }

        return abilityDefs.some((def) =>
            Number(def.AbilityID ?? 0) === abilityId &&
            Number(def.Rank ?? 0) === previousRank &&
            String((def as Record<string, unknown>).BaseClass ?? '').toLowerCase() === characterClass
        );
    }

    private static getActiveAbilities(character: CharacterRecord): number[] {
        const activeAbilities = Array.isArray(character.activeAbilities)
            ? character.activeAbilities.map((value) => Number(value ?? 0)).slice(0, 3)
            : [];

        while (activeAbilities.length < 3) {
            activeAbilities.push(0);
        }

        return activeAbilities;
    }

    private static getSkillResearch(character: CharacterRecord): Record<string, unknown> {
        const research = character.SkillResearch;
        return research && typeof research === 'object' && !Array.isArray(research)
            ? research as Record<string, unknown>
            : {};
    }

    private static shouldTreatAsTutorialEcho(
        client: Client,
        abilityId: number,
        requestedRank: number,
        currentRank: number
    ): boolean {
        if (!client.character) {
            return false;
        }

        if (client.currentLevel !== 'CraftTown') {
            return false;
        }

        if (Number(client.character.questTrackerState ?? 0) < 100) {
            return false;
        }

        const statsByBuilding = AbilityHandler.asRecord(client.character.magicForge)?.stats_by_building;
        const buildingRanks = AbilityHandler.asRecord(statsByBuilding);
        const tomeRank = Number(buildingRanks['1'] ?? buildingRanks[1] ?? 0);
        if (tomeRank < 1) {
            return false;
        }

        return requestedRank > 0 && currentRank >= requestedRank;
    }

    private static asRecord(value: unknown): Record<string, unknown> {
        return value && typeof value === 'object' && !Array.isArray(value)
            ? value as Record<string, unknown>
            : {};
    }

    private static sendAbilityResearchDone(client: Client, abilityId: number): void {
        const bb = new BitBuffer();
        bb.writeMethod6(abilityId, 7);
        client.sendBitBuffer(0xBF, bb);
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

    private static refreshPlayerSnapshot(client: Client): void {
        if (client.playerSpawned && client.currentLevel) {
            EntityHandler.refreshPlayerSnapshot(client);
        }
    }

    private static async saveCharacter(client: Client): Promise<void> {
        if (!client.userId || !client.character) {
            return;
        }

        AbilityHandler.repairCharacterAbilityState(client.character);
        client.characters = await db.saveCharacterSnapshot(client.userId, client.character);
    }
}
