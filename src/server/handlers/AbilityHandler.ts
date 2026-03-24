import abilityTypes from '../data/AbilityTypes.json';
import { JsonAdapter } from '../database/JsonAdapter';
import { Client } from '../core/Client';
import { DebugLogger } from '../core/Debug';
import { BitReader } from '../network/protocol/bitReader';
import { BitBuffer } from '../network/protocol/bitBuffer';

type AbilityDef = {
    AbilityID: string;
    Rank: string;
    GoldCost?: string;
    IdolCost?: string;
    UpgradeTime?: string;
};

type CharacterRecord = Record<string, unknown>;
type SkillResearchRecord = Record<string, unknown>;

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
        if (!client.character) return;

        const br = new BitReader(data);
        const abilityId = br.readMethod20(7);
        const rank = br.readMethod20(4);
        const payWithIdols = br.readMethod15();
        DebugLogger.logProgress('AbilityResearch:startRequest', client, client.character, {
            abilityId,
            rank,
            payWithIdols,
            raw: DebugLogger.previewBuffer(data)
        });

        if (abilityId <= 0 || rank <= 0) {
            DebugLogger.logProgress('AbilityResearch:startRejected', client, client.character, {
                abilityId,
                rank,
                payWithIdols,
                reason: 'invalid_ability_or_rank',
                raw: DebugLogger.previewBuffer(data)
            });
            return;
        }

        const skillResearch = AbilityHandler.getSkillResearch(client.character);
        if (Number(skillResearch.abilityID ?? 0) !== 0) {
            DebugLogger.logProgress('AbilityResearch:startRejected', client, client.character, {
                abilityId,
                rank,
                payWithIdols,
                reason: 'research_already_active',
                existingResearch: {
                    abilityID: Number(skillResearch.abilityID ?? 0),
                    rank: Number(skillResearch.rank ?? 0),
                    ReadyTime: Number(skillResearch.ReadyTime ?? 0)
                },
                raw: DebugLogger.previewBuffer(data)
            });
            return;
        }

        const currentRank = AbilityHandler.getLearnedAbilityRank(client.character, abilityId);
        if (rank !== currentRank + 1) {
            if (AbilityHandler.shouldTreatAsTutorialEcho(client, abilityId, rank, currentRank)) {
                client.character.SkillResearch = {
                    abilityID: abilityId,
                    rank,
                    ReadyTime: 0,
                    tutorialEcho: true
                };
                await AbilityHandler.saveCharacter(client);
                DebugLogger.logProgress('AbilityResearch:tutorialEchoAccepted', client, client.character, {
                    abilityId,
                    rank,
                    currentRank,
                    payWithIdols,
                    raw: DebugLogger.previewBuffer(data)
                });
                AbilityHandler.sendAbilityResearchDone(client, abilityId);
                return;
            }

            DebugLogger.logProgress('AbilityResearch:startRejected', client, client.character, {
                abilityId,
                rank,
                currentRank,
                expectedRank: currentRank + 1,
                payWithIdols,
                reason: 'rank_not_next_upgrade',
                raw: DebugLogger.previewBuffer(data)
            });
            return;
        }

        const abilityDef = AbilityHandler.getAbilityDef(abilityId, rank);
        if (!abilityDef) {
            DebugLogger.logProgress('AbilityResearch:startRejected', client, client.character, {
                abilityId,
                rank,
                payWithIdols,
                reason: 'missing_ability_definition',
                raw: DebugLogger.previewBuffer(data)
            });
            return;
        }

        const goldCost = Number(abilityDef.GoldCost ?? 0);
        const idolCost = Number(abilityDef.IdolCost ?? 0);
        const upgradeTime = Number(abilityDef.UpgradeTime ?? 0);

        if (payWithIdols) {
            const idols = Number(client.character.mammothIdols ?? 0);
            if (idols < idolCost) {
                DebugLogger.logProgress('AbilityResearch:startRejected', client, client.character, {
                    abilityId,
                    rank,
                    payWithIdols,
                    idolCost,
                    idols,
                    reason: 'not_enough_idols',
                    raw: DebugLogger.previewBuffer(data)
                });
                return;
            }
            client.character.mammothIdols = idols - idolCost;
        } else {
            const gold = Number(client.character.gold ?? 0);
            if (gold < goldCost) {
                DebugLogger.logProgress('AbilityResearch:startRejected', client, client.character, {
                    abilityId,
                    rank,
                    payWithIdols,
                    goldCost,
                    gold,
                    reason: 'not_enough_gold',
                    raw: DebugLogger.previewBuffer(data)
                });
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
        DebugLogger.logProgress('AbilityResearch:started', client, client.character, {
            abilityId,
            rank,
            payWithIdols,
            upgradeTime
        });
    }

    static async handleClaimAbilityResearch(client: Client): Promise<void> {
        if (!client.character) return;

        const skillResearch = AbilityHandler.getSkillResearch(client.character);
        const abilityId = Number(skillResearch.abilityID ?? 0);
        DebugLogger.logProgress('AbilityResearch:claimRequest', client, client.character, {
            abilityId
        });
        if (abilityId === 0) {
            DebugLogger.logProgress('AbilityResearch:claimRejected', client, client.character, {
                reason: 'no_active_research'
            });
            return;
        }

        const readyTime = Number(skillResearch.ReadyTime ?? 0);
        const now = Math.floor(Date.now() / 1000);
        if (readyTime > 0 && readyTime > now) {
            DebugLogger.logProgress('AbilityResearch:claimRejected', client, client.character, {
                abilityId,
                readyTime,
                now,
                reason: 'research_not_ready'
            });
            return;
        }

        const learnedAbilities = AbilityHandler.getLearnedAbilities(client.character);
        const targetRank = Number(skillResearch.rank ?? AbilityHandler.getLearnedAbilityRank(client.character, abilityId) + 1);
        const currentRank = AbilityHandler.getLearnedAbilityRank(client.character, abilityId);
        const isTutorialEcho = Boolean(skillResearch.tutorialEcho);

        if (isTutorialEcho && currentRank >= targetRank) {
            client.character.SkillResearch = {};
            await AbilityHandler.saveCharacter(client);
            DebugLogger.logProgress('AbilityResearch:claimTutorialEcho', client, client.character, {
                abilityId,
                targetRank,
                currentRank
            });
            return;
        }

        const existing = learnedAbilities.find((ability) => Number(ability.abilityID ?? 0) === abilityId);
        if (existing) {
            existing.rank = Math.max(Number(existing.rank ?? 0), targetRank);
        } else {
            learnedAbilities.push({ abilityID: abilityId, rank: targetRank });
        }

        client.character.SkillResearch = {};
        await AbilityHandler.saveCharacter(client);
        DebugLogger.logProgress('AbilityResearch:claimed', client, client.character, {
            abilityId,
            targetRank
        });
    }

    static async handleClearAbilityResearch(client: Client): Promise<void> {
        if (!client.character) return;

        client.character.SkillResearch = {};
        await AbilityHandler.saveCharacter(client);
        DebugLogger.logProgress('AbilityResearch:cleared', client, client.character);
    }

    static async handleSpeedupAbilityResearch(client: Client, data: Buffer): Promise<void> {
        if (!client.character) return;

        const br = new BitReader(data);
        const idolCost = br.readMethod9();
        const skillResearch = AbilityHandler.getSkillResearch(client.character);
        const abilityId = Number(skillResearch.abilityID ?? 0);
        DebugLogger.logProgress('AbilityResearch:speedupRequest', client, client.character, {
            abilityId,
            idolCost,
            raw: DebugLogger.previewBuffer(data)
        });
        if (abilityId === 0) {
            DebugLogger.logProgress('AbilityResearch:speedupRejected', client, client.character, {
                idolCost,
                reason: 'no_active_research',
                raw: DebugLogger.previewBuffer(data)
            });
            return;
        }

        const idols = Number(client.character.mammothIdols ?? 0);
        if (idols < idolCost) {
            DebugLogger.logProgress('AbilityResearch:speedupRejected', client, client.character, {
                abilityId,
                idolCost,
                idols,
                reason: 'not_enough_idols',
                raw: DebugLogger.previewBuffer(data)
            });
            return;
        }

        client.character.mammothIdols = idols - idolCost;
        client.character.SkillResearch = {
            ...skillResearch,
            ReadyTime: 0
        };

        await AbilityHandler.saveCharacter(client);
        DebugLogger.logProgress('AbilityResearch:speedupApplied', client, client.character, {
            abilityId,
            idolCost
        });
        AbilityHandler.sendAbilityResearchDone(client, abilityId);
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

    private static async saveCharacter(client: Client): Promise<void> {
        if (!client.userId || !client.character) {
            return;
        }

        AbilityHandler.repairCharacterAbilityState(client.character);
        client.characters = await db.saveCharacterSnapshot(client.userId, client.character);
    }
}
