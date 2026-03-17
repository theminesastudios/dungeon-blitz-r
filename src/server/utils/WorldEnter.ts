import { BitBuffer } from '../network/protocol/bitBuffer';
import { Character } from '../database/Database';
import { MissionDef, MissionLoader } from '../data/MissionLoader';
import { BuildingID, ClassID, MasterClassID } from '../core/Enums';
import { GlobalState } from '../core/GlobalState';
import { normalizeFriendEntries } from '../core/SocialState';

export class WorldEnter {
    private static readonly MASTERCLASS_TO_BUILDING: Record<number, number> = {
        [MasterClassID.Executioner]: BuildingID.ExecutionerTower,
        [MasterClassID.Shadowwalker]: BuildingID.ShadowwalkerTower,
        [MasterClassID.Soulthief]: BuildingID.SoulthiefTower,
        [MasterClassID.Sentinel]: BuildingID.SentinelTower,
        [MasterClassID.Justicar]: BuildingID.JusticarTower,
        [MasterClassID.Templar]: BuildingID.TemplarTower,
        [MasterClassID.Frostwarden]: BuildingID.FrostwardenTower,
        [MasterClassID.Flameseer]: BuildingID.FlameseerTower,
        [MasterClassID.Necromancer]: BuildingID.NecromancerTower
    };

    private static readonly CLASS_TOWER_BUILDINGS: Record<string, number[]> = {
        rogue: [BuildingID.ExecutionerTower, BuildingID.ShadowwalkerTower, BuildingID.SoulthiefTower],
        paladin: [BuildingID.JusticarTower, BuildingID.SentinelTower, BuildingID.TemplarTower],
        mage: [BuildingID.FrostwardenTower, BuildingID.FlameseerTower, BuildingID.NecromancerTower]
    };

    private static readonly CLASS_DEFAULT_MASTERCLASS: Record<string, number> = {
        rogue: MasterClassID.None,
        paladin: MasterClassID.None,
        mage: MasterClassID.None
    };

    private static readonly TALENT_SLOT_MAX_POINTS: number[] = [
        5, 2, 3, 5, 5, 3, 2, 3, 2,
        5, 2, 3, 5, 5, 3, 2, 3, 2,
        5, 2, 3, 5, 5, 3, 2, 3, 2
    ];

    private static readonly TALENT_SLOT_BIT_WIDTHS: number[] = WorldEnter.TALENT_SLOT_MAX_POINTS.map((value) => {
        let bits = 0;
        if (value <= 2) {
            bits = 1;
        }
        if (value <= 4) {
            bits = 2;
        }
        if (value <= 5) {
            bits = 3;
        }
        return bits;
    });

    private static readonly DEFAULT_NEWS_EVENT = {
        icon: 'a_NewsPetXPIcon',
        url: 'Double Pet XP Event',
        body: 'Double Pet XP Event',
        tooltip: 'http://www.dungeonblitz.com/',
        startTs: 1786841238
    };

    private static asRecord(value: unknown): Record<string, any> {
        return value && typeof value === 'object' ? value as Record<string, any> : {};
    }

    private static asArray(value: unknown): any[] {
        return Array.isArray(value) ? value : [];
    }

    private static missionHasDungeonProgress(missionDef: MissionDef | undefined): boolean {
        return Boolean(String(missionDef?.Dungeon ?? '').trim());
    }

    private static getClassId(className: string): ClassID {
        switch ((className || '').toLowerCase()) {
            case 'rogue':
                return ClassID.Rogue;
            case 'mage':
                return ClassID.Mage;
            case 'paladin':
            default:
                return ClassID.Paladin;
        }
    }

    private static normalizeTalentNodes(rawNodes: unknown): Array<{ filled: boolean; points: number; nodeID: number }> {
        const normalized: Array<{ filled: boolean; points: number; nodeID: number }> = [];
        const nodes = WorldEnter.asArray(rawNodes);

        for (let index = 0; index < WorldEnter.TALENT_SLOT_MAX_POINTS.length; index++) {
            const node = WorldEnter.asRecord(nodes[index]);
            if (!node.filled) {
                normalized.push({
                    filled: false,
                    points: 0,
                    nodeID: index + 1
                });
                continue;
            }

            let nodeID = Number(node.nodeID ?? index + 1);
            if (!Number.isFinite(nodeID) || nodeID < 1 || nodeID > WorldEnter.TALENT_SLOT_MAX_POINTS.length) {
                nodeID = index + 1;
            }

            let points = Number(node.points ?? 0);
            const maxPoints = WorldEnter.TALENT_SLOT_MAX_POINTS[index];
            if (!Number.isFinite(points) || points < 1) {
                points = 1;
            }
            if (points > maxPoints) {
                points = maxPoints;
            }

            normalized.push({
                filled: true,
                points,
                nodeID
            });
        }

        return normalized;
    }

    static buildEnterWorldPacket(
        transferToken: number,
        oldLevelId: number,
        oldSwf: string,
        hasOldCoord: boolean,
        oldX: number,
        oldY: number,
        host: string,
        port: number,
        newLevelSwf: string,
        newMapLvl: number,
        newBaseLvl: number,
        newInternal: string,
        newMoment: string,
        newAlter: string,
        newIsDungeon: boolean,
        newHasCoord: boolean,
        newX: number,
        newY: number,
        character: Character | null
    ): BitBuffer {
        const bb = new BitBuffer();

        bb.writeMethod4(transferToken);
        bb.writeMethod4(oldLevelId);
        bb.writeMethod13(oldSwf);
        bb.writeMethod11(hasOldCoord ? 1 : 0, 1);
        if (hasOldCoord) {
            bb.writeMethod4(oldX);
            bb.writeMethod4(oldY);
        }

        bb.writeMethod13(host);
        bb.writeMethod4(port);
        bb.writeMethod13(newLevelSwf);
        bb.writeMethod6(newMapLvl, 6);
        bb.writeMethod6(newBaseLvl, 6);
        bb.writeMethod13(newInternal);
        bb.writeMethod13(newMoment);
        bb.writeMethod13(newAlter);
        bb.writeMethod11(newIsDungeon ? 1 : 0, 1);
        bb.writeMethod11(newHasCoord ? 1 : 0, 1);
        if (newHasCoord) {
            bb.writeMethod45(newX);
            bb.writeMethod45(newY);
        }

        const isCraftTown =
            newInternal.toLowerCase().includes('crafttown') ||
            newLevelSwf.toLowerCase().includes('crafttown');

        bb.writeMethod11(isCraftTown ? 1 : 0, 1);
        if (isCraftTown && character) {
            bb.writeMethod4(transferToken);

            const masterClassId = WorldEnter.resolveMasterClass(character);
            bb.writeMethod6(masterClassId, 4);

            const statsByBuilding = WorldEnter.asRecord(character.magicForge?.stats_by_building);
            const getStat = (buildingId: number): number =>
                Number(statsByBuilding[buildingId.toString()] ?? statsByBuilding[buildingId] ?? 0);

            const towerBuildingId = WorldEnter.MASTERCLASS_TO_BUILDING[masterClassId] ?? BuildingID.JusticarTower;
            const scaffoldingLevel = Number(character.buildingUpgrade?.buildingID ?? 0);

            bb.writeMethod6(getStat(BuildingID.Forge), 5);
            bb.writeMethod6(getStat(BuildingID.Keep), 5);
            bb.writeMethod6(getStat(towerBuildingId), 5);
            bb.writeMethod6(getStat(BuildingID.Tome), 5);
            bb.writeMethod6(getStat(BuildingID.Barn), 5);
            bb.writeMethod6(scaffoldingLevel, 5);
        }

        return bb;
    }

    static resolveMasterClass(char: Character): number {
        const className = (char.class || '').toLowerCase();
        const towerIds = WorldEnter.CLASS_TOWER_BUILDINGS[className] || [];
        const raw = Number(char.MasterClass ?? 0);

        if (WorldEnter.MASTERCLASS_TO_BUILDING[raw]) {
            const mappedTower = WorldEnter.MASTERCLASS_TO_BUILDING[raw];
            if (towerIds.length === 0 || towerIds.includes(mappedTower)) {
                return raw;
            }
        }

        const statsByBuilding = WorldEnter.asRecord(char.magicForge?.stats_by_building);
        let bestBuildingId = 0;
        let bestRank = 0;

        for (const towerId of towerIds) {
            const rank = Number(statsByBuilding[towerId.toString()] ?? statsByBuilding[towerId] ?? 0);
            if (rank > bestRank) {
                bestRank = rank;
                bestBuildingId = towerId;
            }
        }

        if (bestRank > 0) {
            for (const [masterClassId, buildingId] of Object.entries(WorldEnter.MASTERCLASS_TO_BUILDING)) {
                if (buildingId === bestBuildingId) {
                    return Number(masterClassId);
                }
            }
        }

        return WorldEnter.CLASS_DEFAULT_MASTERCLASS[className] || 0;
    }

    static resolveMagicForgeState(magicForge: any, now: number): { has_session: boolean; in_progress: boolean; completed: boolean; ready_time?: number } {
        if (!magicForge || !magicForge.primary) {
            return {
                has_session: false,
                in_progress: false,
                completed: false
            };
        }

        const readyTime = Number(magicForge.ReadyTime ?? 0);
        if (readyTime && readyTime > now) {
            return {
                has_session: true,
                in_progress: true,
                completed: false,
                ready_time: readyTime
            };
        }

        return {
            has_session: true,
            in_progress: false,
            completed: true
        };
    }

    static buildPlayerDataPacket(
        character: Character,
        transferToken: number,
        hpScaling: number = 0,
        bonusLevels: number = 0,
        targetLevel: string = '',
        newX: number = 0,
        newY: number = 0,
        newHasCoord: boolean = false,
        sendExtended: boolean = false
    ): BitBuffer {
        const bb = new BitBuffer();
        const now = Math.floor(Date.now() / 1000);
        const equippedGears = WorldEnter.asArray(character.equippedGears);

        hpScaling = Math.max(0, Math.min(hpScaling, 3));
        bonusLevels = Math.max(0, Math.min(bonusLevels, 0xFFFFFFFF));

        bb.writeMethod4(transferToken);
        bb.writeMethod4(now);
        bb.writeMethod6(hpScaling, 2);
        bb.writeMethod4(bonusLevels);

        bb.writeMethod13(character.name || '');
        bb.writeMethod11(1, 1);
        bb.writeMethod13(character.class || '');
        bb.writeMethod13(character.gender || '');
        bb.writeMethod13(character.headSet || '');
        bb.writeMethod13(character.hairSet || '');
        bb.writeMethod13(character.mouthSet || '');
        bb.writeMethod13(character.faceSet || '');
        bb.writeMethod11(Number(character.hairColor ?? 0), 24);
        bb.writeMethod11(Number(character.skinColor ?? 0), 24);
        bb.writeMethod11(Number(character.shirtColor ?? 0), 24);
        bb.writeMethod11(Number(character.pantColor ?? 0), 24);

        for (let i = 0; i < 6; i++) {
            const gear = WorldEnter.asRecord(equippedGears[i]);
            const gearId = Number(gear.gearID ?? 0);
            if (!gearId) {
                bb.writeMethod11(0, 1);
                continue;
            }

            const runes = WorldEnter.asArray(gear.runes);
            const colors = WorldEnter.asArray(gear.colors);
            bb.writeMethod11(1, 1);
            bb.writeMethod11(gearId, 11);
            bb.writeMethod11(Number(gear.tier ?? 0), 2);
            bb.writeMethod11(Number(runes[0] ?? 0), 16);
            bb.writeMethod11(Number(runes[1] ?? 0), 16);
            bb.writeMethod11(Number(runes[2] ?? 0), 16);
            bb.writeMethod11(Number(colors[0] ?? 0), 8);
            bb.writeMethod11(Number(colors[1] ?? 0), 8);
        }

        bb.writeMethod6(Number(character.level ?? 1), 6);
        bb.writeMethod4(Number(character.xp ?? 0));
        bb.writeMethod4(Number(character.gold ?? 0));
        bb.writeMethod4(Number(character.craftXP ?? 0));
        bb.writeMethod4(Number(character.DragonOre ?? 0));
        bb.writeMethod4(Number(character.mammothIdols ?? 0));
        bb.writeMethod11(character.showHigher ? 1 : 0, 1);

        const questTrackerState = character.questTrackerState ?? 0;
        if (questTrackerState !== null) {
            bb.writeMethod11(1, 1);
            bb.writeMethod4(Number(questTrackerState));
        } else {
            bb.writeMethod11(0, 1);
        }

        if (newHasCoord && targetLevel && newX !== undefined && newY !== undefined) {
            bb.writeMethod11(1, 1);
            bb.writeMethod45(newX);
            bb.writeMethod45(newY);
        } else {
            bb.writeMethod11(0, 1);
        }

        if (sendExtended) {
            bb.writeMethod6(1, 1);

            const inventoryGears = WorldEnter.asArray(character.inventoryGears);
            bb.writeMethod6(inventoryGears.length, 11);
            for (const rawGear of inventoryGears) {
                const gear = WorldEnter.asRecord(rawGear);
                const runes = WorldEnter.asArray(gear.runes);
                const colors = WorldEnter.asArray(gear.colors);
                bb.writeMethod11(Number(gear.gearID ?? 0), 11);
                bb.writeMethod11(Number(gear.tier ?? 0), 2);

                const hasModifiers =
                    runes.some((r: unknown) => Number(r) !== 0) ||
                    colors.some((c: unknown) => Number(c) !== 0);
                bb.writeMethod11(hasModifiers ? 1 : 0, 1);
                if (hasModifiers) {
                    for (let i = 0; i < 3; i++) {
                        const rune = Number(runes[i] ?? 0);
                        bb.writeMethod11(rune !== 0 ? 1 : 0, 1);
                        if (rune !== 0) {
                            bb.writeMethod11(rune, 16);
                        }
                    }
                    for (let i = 0; i < 2; i++) {
                        const color = Number(colors[i] ?? 0);
                        bb.writeMethod11(color !== 0 ? 1 : 0, 1);
                        if (color !== 0) {
                            bb.writeMethod11(color, 8);
                        }
                    }
                }
            }

            const gearSets = WorldEnter.asArray(character.gearSets);
            bb.writeMethod6(gearSets.length, 3);
            for (const rawGearSet of gearSets) {
                const gearSet = WorldEnter.asRecord(rawGearSet);
                const slots = WorldEnter.asArray(gearSet.slots).slice(0, 7);
                while (slots.length < 7) {
                    slots.push(0);
                }

                bb.writeMethod13(String(gearSet.name ?? ''));
                bb.writeMethod11(Number(slots[1] ?? 0), 11);
                bb.writeMethod11(Number(slots[2] ?? 0), 11);
                bb.writeMethod11(Number(slots[3] ?? 0), 11);
                bb.writeMethod11(Number(slots[4] ?? 0), 11);
                bb.writeMethod11(Number(slots[5] ?? 0), 11);
                bb.writeMethod11(Number(slots[6] ?? 0), 11);
            }

            bb.writeMethod11(0, 1);

            const mounts = WorldEnter.asArray(character.mounts);
            bb.writeMethod4(mounts.length);
            for (const mountId of mounts) {
                bb.writeMethod4(Number(mountId ?? 0));
            }

            const pets = WorldEnter.asArray(character.pets);
            bb.writeMethod4(pets.length);
            for (const rawPet of pets) {
                const pet = WorldEnter.asRecord(rawPet);
                const typeId = Math.max(0, Math.min(Number(pet.typeID ?? 0), 127));
                const iteration = Math.max(0, Math.min(Number(pet.level ?? 0), 63));
                bb.writeMethod6(typeId, 7);
                bb.writeMethod6(iteration, 6);
                bb.writeMethod4(Number(pet.xp ?? 0));
                bb.writeMethod4(Number(pet.special_id ?? 0));
            }

            const charms = WorldEnter.asArray(character.charms);
            for (const rawCharm of charms) {
                const charm = WorldEnter.asRecord(rawCharm);
                const count = Number(charm.count ?? 1);
                bb.writeMethod11(1, 1);
                bb.writeMethod11(Number(charm.charmID ?? 0), 16);
                if (count !== 1) {
                    bb.writeMethod11(1, 1);
                    bb.writeMethod4(count);
                } else {
                    bb.writeMethod11(0, 1);
                }
            }
            bb.writeMethod11(0, 1);

            const materials = WorldEnter.asArray(character.materials);
            for (const rawMaterial of materials) {
                const material = WorldEnter.asRecord(rawMaterial);
                const count = Number(material.count ?? 1);
                bb.writeMethod11(1, 1);
                bb.writeMethod4(Number(material.materialID ?? 0));
                if (count !== 1) {
                    bb.writeMethod11(1, 1);
                    bb.writeMethod4(count);
                } else {
                    bb.writeMethod11(0, 1);
                }
            }
            bb.writeMethod11(0, 1);

            const lockboxes = WorldEnter.asArray(character.lockboxes);
            for (const rawLockbox of lockboxes) {
                const lockbox = WorldEnter.asRecord(rawLockbox);
                bb.writeMethod11(1, 1);
                bb.writeMethod4(Number(lockbox.lockboxID ?? 0));
                bb.writeMethod4(Number(lockbox.count ?? 1));
            }
            bb.writeMethod11(0, 1);

            bb.writeMethod4(Number(character.DragonKeys ?? 0));
            bb.writeMethod4(Number(character.SilverSigils ?? 0));
            bb.writeMethod6(Number(character.alertState ?? 0), 4);

            const ownedDyes = new Set<number>(
                WorldEnter.asArray(character.OwnedDyes).map((value: unknown) => Number(value))
            );
            for (let dyeId = 1; dyeId <= 250; dyeId++) {
                bb.writeMethod11(ownedDyes.has(dyeId) ? 1 : 0, 1);
            }

            const consumables = WorldEnter.asArray(character.consumables);
            for (const rawConsumable of consumables) {
                const consumable = WorldEnter.asRecord(rawConsumable);
                bb.writeMethod11(1, 1);
                bb.writeMethod4(Number(consumable.consumableID ?? 0));
                bb.writeMethod4(Number(consumable.count ?? 1));
            }
            bb.writeMethod11(0, 1);

            const missionsState = WorldEnter.asRecord(character.missions);
            const totalMissions = MissionLoader.getTotalMissions();
            bb.writeMethod4(totalMissions);
            for (let missionId = 1; missionId <= totalMissions; missionId++) {
                const missionDef = MissionLoader.getMissionDef(missionId);
                const missionState = WorldEnter.asRecord(missionsState[missionId.toString()]);
                const state = Number(missionState.state ?? 0);

                if (missionDef?.Tier) {
                    bb.writeMethod11(state >= 3 ? 1 : 0, 1);
                    continue;
                }

                const hasEntry = state !== 0;
                bb.writeMethod11(hasEntry ? 1 : 0, 1);
                if (!hasEntry) {
                    continue;
                }

                const isReady = state >= 2;
                bb.writeMethod11(isReady ? 1 : 0, 1);
                if (!isReady) {
                    if ((missionDef?.highscore ?? 0) > 1) {
                        bb.writeMethod4(Number(missionState.currCount ?? 0));
                    }
                    continue;
                }

                bb.writeMethod11(state >= 3 ? 1 : 0, 1);
                if (WorldEnter.missionHasDungeonProgress(missionDef)) {
                    bb.writeMethod11(Number(missionState.Tier ?? 0), 4);
                    bb.writeMethod4(Number(missionState.highscore ?? 0));
                    bb.writeMethod4(Number(missionState.Time ?? 0));
                }
            }

            const friends = normalizeFriendEntries(character.friends);
            bb.writeMethod4(friends.length);
            for (const friend of friends) {
                const friendName = String(friend.name ?? '');
                const isRequest = Boolean(friend.isRequest);
                let isOnline = false;
                let className = '';
                let level = 1;

                for (const session of GlobalState.sessionsByToken.values()) {
                    if (session.character?.name === friendName) {
                        isOnline = true;
                        className = String(session.character.class ?? '');
                        level = Number(session.character.level ?? 1);
                        break;
                    }
                }

                bb.writeMethod13(friendName);
                bb.writeMethod11(isRequest ? 1 : 0, 1);
                bb.writeMethod11(isOnline ? 1 : 0, 1);
                if (isOnline) {
                    bb.writeMethod11(0, 1);
                    bb.writeMethod11(WorldEnter.getClassId(className), 2);
                    bb.writeMethod11(level, 6);
                }
            }

            const learnedAbilities = WorldEnter.asArray(character.learnedAbilities);
            bb.writeMethod6(learnedAbilities.length, 7);
            for (const rawAbility of learnedAbilities) {
                const ability = WorldEnter.asRecord(rawAbility);
                bb.writeMethod6(Number(ability.abilityID ?? 0), 7);
                bb.writeMethod6(Number(ability.rank ?? 0), 4);
            }

            const activeAbilities = WorldEnter.asArray(character.activeAbilities).slice(0, 3);
            while (activeAbilities.length < 3) {
                activeAbilities.push(0);
            }
            for (const activeAbilityId of activeAbilities) {
                bb.writeMethod6(Number(activeAbilityId ?? 0), 7);
            }

            const craftTalentPoints = WorldEnter.asArray(character.craftTalentPoints).slice(0, 5);
            while (craftTalentPoints.length < 5) {
                craftTalentPoints.push(0);
            }
            let packedCraftTalentPoints = 0;
            for (let i = 0; i < 5; i++) {
                packedCraftTalentPoints |= (Number(craftTalentPoints[i] ?? 0) & 0xF) << (i * 4);
            }
            bb.writeMethod4(packedCraftTalentPoints);

            const talentPoints = WorldEnter.asRecord(character.talentPoints);
            for (const classIndex of [1, 2, 3]) {
                bb.writeMethod6(Number(talentPoints[classIndex.toString()] ?? 0), 6);
            }

            const magicForge = WorldEnter.asRecord(character.magicForge);
            const statsByBuilding = WorldEnter.asRecord(magicForge.stats_by_building);
            const hasForgeStats = Object.keys(statsByBuilding).length > 0;
            bb.writeMethod11(hasForgeStats ? 1 : 0, 1);
            if (hasForgeStats) {
                const className = (character.class || '').toLowerCase();
                const buildOrder = className === 'mage'
                    ? [2, 12, 6, 7, 8, 1, 13]
                    : className === 'rogue'
                        ? [2, 12, 9, 10, 11, 1, 13]
                        : [2, 12, 3, 4, 5, 1, 13];

                for (const buildingId of buildOrder) {
                    bb.writeMethod6(Number(statsByBuilding[buildingId.toString()] ?? 0), 5);
                }
            }

            const forgeState = WorldEnter.resolveMagicForgeState(magicForge, now);
            bb.writeMethod11(forgeState.has_session ? 1 : 0, 1);
            if (forgeState.has_session) {
                bb.writeMethod6(Number(magicForge.primary ?? 0), 7);
                if (forgeState.in_progress) {
                    bb.writeMethod11(1, 1);
                    bb.writeMethod4(Number(forgeState.ready_time ?? 0));
                } else {
                    const secondaryTier = Number(magicForge.secondary_tier ?? 0);
                    bb.writeMethod11(0, 1);
                    bb.writeMethod6(secondaryTier, 2);
                    if (secondaryTier > 0) {
                        bb.writeMethod6(Number(magicForge.secondary ?? 0), 5);
                        bb.writeMethod6(Number(magicForge.usedlist ?? 0), 9);
                    }
                }

                bb.writeMethod91(Math.min(Number(magicForge.forge_roll_a ?? 0), 65535));
                bb.writeMethod91(Math.min(Number(magicForge.forge_roll_b ?? 0), 65535));
            }

            bb.writeMethod11(Boolean(magicForge.is_extended_forge) ? 1 : 0, 1);

            const skillResearch = WorldEnter.asRecord(character.SkillResearch);
            const skillResearchAbilityId = Number(skillResearch.abilityID ?? 0);
            if (skillResearchAbilityId !== 0) {
                const readyTime = Number(skillResearch.ReadyTime ?? 0);
                bb.writeMethod11(1, 1);
                bb.writeMethod6(skillResearchAbilityId, 7);
                bb.writeMethod4(readyTime && readyTime <= now ? 0 : readyTime);
            } else {
                bb.writeMethod11(0, 1);
            }

            const buildingUpgrade = WorldEnter.asRecord(character.buildingUpgrade);
            const buildingReadyTime = Number(buildingUpgrade.ReadyTime ?? 0);
            const hasBuildingUpgrade = Number(buildingUpgrade.buildingID ?? 0) !== 0 && buildingReadyTime > now;
            bb.writeMethod11(hasBuildingUpgrade ? 1 : 0, 1);
            if (hasBuildingUpgrade) {
                bb.writeMethod6(Number(buildingUpgrade.buildingID ?? 0), 5);
                bb.writeMethod4(buildingReadyTime);
            }

            const talentResearch = WorldEnter.asRecord(character.talentResearch);
            const talentReadyTime = Number(talentResearch.ReadyTime ?? 0);
            const hasTalentResearch = talentReadyTime > 0 && talentReadyTime > now;
            bb.writeMethod11(hasTalentResearch ? 1 : 0, 1);
            if (hasTalentResearch) {
                bb.writeMethod6(Number(talentResearch.classIndex ?? 0), 2);
                bb.writeMethod4(talentReadyTime);
            }

            const eggHatchery = WorldEnter.asRecord(character.EggHachery);
            const eggId = Number(eggHatchery.EggID ?? 0);
            if (eggId !== 0) {
                const readyTime = Number(eggHatchery.ReadyTime ?? 0);
                bb.writeMethod11(1, 1);
                bb.writeMethod6(eggId, 6);
                bb.writeMethod4(readyTime !== 0 && readyTime <= now ? 0 : readyTime);
            } else {
                bb.writeMethod11(0, 1);
            }

            const ownedEggs = WorldEnter.asArray(character.OwnedEggsID).slice(0, 8);
            while (ownedEggs.length < 8) {
                ownedEggs.push(0);
            }
            bb.writeMethod6(8, 6);
            for (const ownedEgg of ownedEggs) {
                bb.writeMethod6(Number(ownedEgg ?? 0), 6);
            }

            bb.writeMethod4(Number(character.activeEggCount ?? 0));

            const restingPets = WorldEnter.asArray(character.restingPets).slice(0, 3);
            for (let i = 0; i < 3; i++) {
                const pet = WorldEnter.asRecord(restingPets[i]);
                if (Object.keys(pet).length === 0) {
                    bb.writeMethod11(0, 1);
                    continue;
                }

                bb.writeMethod11(1, 1);
                bb.writeMethod6(Number(pet.typeID ?? 0), 7);
                bb.writeMethod4(Number(pet.special_id ?? 0));
            }

            const trainingPets = WorldEnter.asArray(character.trainingPet);
            if (trainingPets.length > 0) {
                const pet = WorldEnter.asRecord(trainingPets[0]);
                const readyTime = Number(pet.trainingTime ?? 0);
                bb.writeMethod11(1, 1);
                bb.writeMethod6(Number(pet.typeID ?? 0), 7);
                bb.writeMethod4(Number(pet.special_id ?? 0));
                bb.writeMethod4(readyTime <= now ? 0 : readyTime);
            } else {
                bb.writeMethod11(0, 1);
            }

            bb.writeMethod13(WorldEnter.DEFAULT_NEWS_EVENT.icon);
            bb.writeMethod13(WorldEnter.DEFAULT_NEWS_EVENT.url);
            bb.writeMethod13(WorldEnter.DEFAULT_NEWS_EVENT.body);
            bb.writeMethod13(WorldEnter.DEFAULT_NEWS_EVENT.tooltip);
            bb.writeMethod4(WorldEnter.DEFAULT_NEWS_EVENT.startTs);
        } else {
            bb.writeMethod6(0, 1);
        }

        const masterClassId = WorldEnter.resolveMasterClass(character);
        if (masterClassId && Number(character.MasterClass ?? 0) !== masterClassId) {
            character.MasterClass = masterClassId;
        }
        bb.writeMethod6(masterClassId, 4);

        if (masterClassId > 0) {
            bb.writeMethod11(1, 1);
            const talentTree = WorldEnter.asRecord(character.TalentTree);
            const classTree = WorldEnter.asRecord(talentTree[masterClassId.toString()]);
            const nodes = WorldEnter.normalizeTalentNodes(classTree.nodes);

            for (let i = 0; i < WorldEnter.TALENT_SLOT_MAX_POINTS.length; i++) {
                const node = nodes[i];
                if (!node.filled) {
                    bb.writeMethod11(0, 1);
                    continue;
                }

                bb.writeMethod11(1, 1);
                bb.writeMethod6(node.nodeID, 6);
                bb.writeMethod6(node.points - 1, WorldEnter.TALENT_SLOT_BIT_WIDTHS[i]);
            }
        } else {
            bb.writeMethod11(0, 1);
        }

        for (let i = 0; i < 6; i++) {
            const gear = WorldEnter.asRecord(equippedGears[i]);
            const gearId = Number(gear.gearID ?? 0);
            if (gearId) {
                bb.writeMethod11(1, 1);
                bb.writeMethod6(gearId, 11);
            } else {
                bb.writeMethod11(0, 1);
            }
        }

        bb.writeMethod4(Number(character.equippedMount ?? 0));

        const activePet = WorldEnter.asRecord(character.activePet);
        bb.writeMethod4(Number(activePet.typeID ?? 0));
        bb.writeMethod4(Number(activePet.special_id ?? 0));

        bb.writeMethod4(Number(character.activeConsumableID ?? 0));
        bb.writeMethod4(Number(character.queuedConsumableID ?? 0));

        const guild = WorldEnter.asRecord(character.guild);
        const inGuild = Object.keys(guild).length > 0;
        bb.writeMethod11(inGuild ? 1 : 0, 1);
        if (inGuild) {
            const onlineMembers = WorldEnter.asArray(guild.onlineMembers);
            bb.writeMethod13(String(guild.name ?? ''));
            bb.writeMethod6(Number(guild.rank ?? 0), 3);
            bb.writeMethod4(onlineMembers.length);

            for (const rawMember of onlineMembers) {
                const member = WorldEnter.asRecord(rawMember);
                bb.writeMethod13(String(member.name ?? ''));
                bb.writeMethod6(Number(member.classID ?? 0), 2);
                bb.writeMethod6(Number(member.level ?? 1), 6);
                bb.writeMethod6(Number(member.rank ?? 0), 3);
            }
        }

        const completedLevels = WorldEnter.asArray(character.completed_levels);
        bb.writeMethod4(completedLevels.length);
        for (const rawLevel of completedLevels) {
            const level = WorldEnter.asRecord(rawLevel);
            const composite = `${level.id ?? ''}^${level.internal ?? ''}^${level.variant ?? ''}`;
            bb.writeMethod13(composite);
            bb.writeMethod13(String(level.state ?? ''));
        }

        const updatedRooms = WorldEnter.asArray(character.updated_rooms);
        bb.writeMethod4(updatedRooms.length);
        for (const rawRoom of updatedRooms) {
            const room = WorldEnter.asRecord(rawRoom);
            bb.writeMethod4(Number(room.id ?? 0));
            bb.writeMethod13(String(room.action ?? ''));
            bb.writeMethod13(String(room.state ?? ''));
        }

        return bb;
    }
}
