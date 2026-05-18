import { Client } from '../core/Client';
import { BitReader } from '../network/protocol/bitReader';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { JsonAdapter } from '../database/JsonAdapter';
import { TalentConfig } from '../core/TalentConfig';
import { EntityHandler } from './EntityHandler';
import { WorldEnter } from '../utils/WorldEnter';

type TalentResearchRecord = {
    classIndex?: number | null;
    ReadyTime?: number;
};

const db = new JsonAdapter();

export class TalentHandler {
    static syncResearchTimer(client: Client): void {
        TalentHandler.clearResearchTimer(client);

        if (!client.character) {
            return;
        }

        const research = TalentHandler.getTalentResearch(client.character);
        const classIndex = Number(research.classIndex ?? -1);
        const readyTime = Number(research.ReadyTime ?? 0);
        const now = Math.floor(Date.now() / 1000);
        if (classIndex < 0 || readyTime <= now) {
            return;
        }

        const delayMs = Math.max(0, (readyTime * 1000) - Date.now());
        const timer = setTimeout(() => {
            client.talentResearchTimer = null;

            if (!client.character || !client.authenticated) {
                return;
            }

            const liveResearch = TalentHandler.getTalentResearch(client.character);
            const liveClassIndex = Number(liveResearch.classIndex ?? -1);
            const liveReadyTime = Number(liveResearch.ReadyTime ?? 0);
            if (liveClassIndex !== classIndex || liveReadyTime !== readyTime) {
                return;
            }

            if (liveReadyTime > Math.floor(Date.now() / 1000)) {
                return;
            }

            TalentHandler.sendTalentResearchComplete(client, classIndex);
        }, delayMs);
        timer.unref?.();
        client.talentResearchTimer = timer;
    }

    static async handleRespecTalentTree(client: Client, _data: Buffer): Promise<void> {
        if (!client.character) {
            return;
        }

        const charms = Array.isArray(client.character.charms) ? client.character.charms : [];
        let hasStone = false;

        for (let index = 0; index < charms.length; index += 1) {
            const charm = charms[index];
            if (Number(charm?.charmID ?? 0) !== 91 || Number(charm?.count ?? 0) <= 0) {
                continue;
            }

            charm.count = Number(charm.count ?? 0) - 1;
            if (Number(charm.count ?? 0) <= 0) {
                charms.splice(index, 1);
            }
            hasStone = true;
            break;
        }

        if (!hasStone) {
            return;
        }

        const masterClassKey = String(Number(client.character.MasterClass ?? 1));
        if (!client.character.TalentTree || typeof client.character.TalentTree !== 'object') {
            client.character.TalentTree = {};
        }
        if (!client.character.TalentTree[masterClassKey]) {
            client.character.TalentTree[masterClassKey] = {};
        }

        client.character.TalentTree[masterClassKey].nodes = TalentConfig.buildEmptyTalentNodes();
        await TalentHandler.saveCharacter(client);

        if (client.playerSpawned && client.currentLevel) {
            EntityHandler.refreshPlayerSnapshot(client);
        }
    }

    static async handleAllocateTalentTreePoints(client: Client, data: Buffer): Promise<void> {
        if (!client.character) {
            return;
        }

        const br = new BitReader(data);
        const masterClassKey = String(Number(client.character.MasterClass ?? 1));
        if (!client.character.TalentTree || typeof client.character.TalentTree !== 'object') {
            client.character.TalentTree = {};
        }
        if (!client.character.TalentTree[masterClassKey]) {
            client.character.TalentTree[masterClassKey] = {};
        }

        const previousNodes = TalentHandler.getNormalizedTalentNodes(
            client.character,
            Number(client.character.MasterClass ?? 1)
        );
        const previousAllocatedPoints = TalentHandler.countAllocatedTalentPoints(previousNodes);
        const slots = TalentConfig.buildEmptyTalentNodes();
        let incomingAllocatedPoints = 0;

        for (let index = 0; index < TalentConfig.NUM_TALENT_SLOTS; index += 1) {
            const hasNode = br.readMethod15();
            if (!hasNode) {
                continue;
            }

            const nodeID = br.readMethod6(6);
            const points = br.readMethod6(TalentConfig.getSlotBitWidth(index)) + 1;
            slots[index] = {
                nodeID,
                points,
                filled: true
            };
            incomingAllocatedPoints += points;
        }

        while (br.readMethod15()) {
            const isSignet = br.readMethod15();
            br.readMethod6(6);
            if (isSignet) {
                br.readMethod6(6);
                br.readMethod6(6);
            }
        }

        if (incomingAllocatedPoints === 0 && previousAllocatedPoints > 0) {
            return;
        }

        client.character.TalentTree[masterClassKey].nodes = TalentConfig.normalizeTalentNodes(slots);
        await TalentHandler.saveCharacter(client);

        if (client.playerSpawned && client.currentLevel) {
            EntityHandler.refreshPlayerSnapshot(client);
        }
    }

    static async handleTrainTalentPoint(client: Client, data: Buffer): Promise<void> {
        if (!client.character) {
            return;
        }

        const br = new BitReader(data);
        const classIndex = br.readMethod20(2);
        const isInstant = br.readMethod15();

        if (!client.character.talentPoints || typeof client.character.talentPoints !== 'object') {
            client.character.talentPoints = {};
        }

        const currentPoints = Number(client.character.talentPoints[String(classIndex)] ?? 0);
        const durationIndex = currentPoints + 1;
        const duration = Number(TalentConfig.RESEARCH_DURATIONS[durationIndex] ?? 0);
        const goldCost = Number(TalentConfig.RESEARCH_COSTS[durationIndex] ?? 0);
        const idolCost = Number(TalentConfig.IDOL_COST[durationIndex] ?? 0);
        const now = Math.floor(Date.now() / 1000);

        if (isInstant) {
            const idols = Number(client.character.mammothIdols ?? 0);
            if (idols < idolCost) {
                return;
            }

            client.character.mammothIdols = idols - idolCost;
            client.character.talentResearch = {
                classIndex,
                ReadyTime: now
            };
            await TalentHandler.saveCharacter(client);
            TalentHandler.syncResearchTimer(client);
            TalentHandler.sendPremiumPurchase(client, 'TalentResearch', idolCost);
            TalentHandler.sendTalentResearchComplete(client, classIndex);
            return;
        }

        const gold = Number(client.character.gold ?? 0);
        if (gold < goldCost) {
            return;
        }

        client.character.gold = gold - goldCost;
        client.character.talentResearch = {
            classIndex,
            ReadyTime: now + duration
        };

        await TalentHandler.saveCharacter(client);
        TalentHandler.syncResearchTimer(client);
    }

    static async handleTalentSpeedup(client: Client, data: Buffer): Promise<void> {
        if (!client.character) {
            return;
        }

        const br = new BitReader(data);
        const idolCost = br.readMethod9();
        const research = TalentHandler.getTalentResearch(client.character);
        const classIndex = Number(research.classIndex ?? -1);
        if (classIndex < 0) {
            return;
        }

        if (idolCost > 0) {
            const idols = Number(client.character.mammothIdols ?? 0);
            if (idols < idolCost) {
                return;
            }

            client.character.mammothIdols = idols - idolCost;
        }

        client.character.talentResearch = {
            ...research,
            classIndex,
            ReadyTime: 0
        };

        await TalentHandler.saveCharacter(client);
        TalentHandler.syncResearchTimer(client);
        TalentHandler.sendPremiumPurchase(client, 'TalentSpeedup', idolCost);
        TalentHandler.sendTalentResearchComplete(client, classIndex);
    }

    static async handleTalentClaim(client: Client, _data: Buffer): Promise<void> {
        if (!client.character) {
            return;
        }

        const research = TalentHandler.getTalentResearch(client.character);
        const classIndex = Number(research.classIndex ?? -1);
        if (classIndex < 0) {
            return;
        }

        if (!client.character.talentPoints || typeof client.character.talentPoints !== 'object') {
            client.character.talentPoints = {};
        }

        const key = String(classIndex);
        client.character.talentPoints[key] = Number(client.character.talentPoints[key] ?? 0) + 1;
        client.character.talentResearch = {
            classIndex: null,
            ReadyTime: 0
        };

        await TalentHandler.saveCharacter(client);
        TalentHandler.syncResearchTimer(client);

        if (client.playerSpawned && client.currentLevel) {
            EntityHandler.refreshPlayerSnapshot(client);
        }
    }

    static async handleClearTalentResearch(client: Client, _data: Buffer): Promise<void> {
        if (!client.character) {
            return;
        }

        client.character.talentResearch = {
            classIndex: null,
            ReadyTime: 0
        };
        await TalentHandler.saveCharacter(client);
        TalentHandler.syncResearchTimer(client);
    }

    static async handleActiveTalentChangeRequest(client: Client, data: Buffer): Promise<void> {
        if (!client.character) {
            return;
        }

        const br = new BitReader(data);
        const entityId = br.readMethod4();
        const masterClassId = br.readMethod6(4);

        client.character.MasterClass = masterClassId;
        WorldEnter.ensureSelectedDisciplineTower(client.character);
        await TalentHandler.saveCharacter(client);

        const response = new BitBuffer();
        response.writeMethod4(entityId);
        response.writeMethod6(masterClassId, 4);
        client.sendBitBuffer(0xC3, response);
        TalentHandler.sendActiveTalentTreeData(client, entityId, masterClassId);

        if (client.playerSpawned && client.currentLevel) {
            EntityHandler.refreshPlayerSnapshot(client);
        }
    }

    private static sendActiveTalentTreeData(client: Client, entityId: number, masterClassId: number): void {
        if (!client.character) {
            return;
        }

        const packet = new BitBuffer();
        packet.writeMethod4(entityId);

        const nodes = TalentHandler.getNormalizedTalentNodes(client.character, masterClassId);
        for (let index = 0; index < TalentConfig.NUM_TALENT_SLOTS; index += 1) {
            const node = nodes[index] ?? {
                filled: false,
                points: 0,
                nodeID: TalentConfig.indexToNodeId(index)
            };

            if (!node.filled) {
                packet.writeMethod6(0, 1);
                continue;
            }

            packet.writeMethod6(1, 1);
            packet.writeMethod6(node.nodeID, 6);
            packet.writeMethod6(node.points - 1, TalentConfig.getSlotBitWidth(index));
        }

        client.sendBitBuffer(0xC1, packet);
    }

    private static getNormalizedTalentNodes(character: Record<string, unknown>, masterClassId: number) {
        const rawTree = character.TalentTree;
        const talentTree = rawTree && typeof rawTree === 'object' && !Array.isArray(rawTree)
            ? rawTree as Record<string, unknown>
            : {};
        const rawClassTree = talentTree[String(masterClassId)];
        const classTree = rawClassTree && typeof rawClassTree === 'object' && !Array.isArray(rawClassTree)
            ? rawClassTree as Record<string, unknown>
            : {};
        return TalentConfig.normalizeTalentNodes(classTree.nodes);
    }

    private static countAllocatedTalentPoints(nodes: Array<{ filled: boolean; points: number }>): number {
        return nodes.reduce((total, node) => total + (node.filled ? Number(node.points ?? 0) : 0), 0);
    }

    private static getTalentResearch(character: Record<string, unknown>): TalentResearchRecord {
        const research = character.talentResearch;
        if (!research || typeof research !== 'object' || Array.isArray(research)) {
            return {};
        }
        return research as TalentResearchRecord;
    }

    private static clearResearchTimer(client: Client): void {
        if (client.talentResearchTimer) {
            clearTimeout(client.talentResearchTimer);
            client.talentResearchTimer = null;
        }
    }

    private static sendPremiumPurchase(client: Client, itemName: string, cost: number): void {
        const packet = new BitBuffer();
        packet.writeMethod13(itemName);
        packet.writeMethod4(cost);
        client.sendBitBuffer(0xB5, packet);
    }

    private static sendTalentResearchComplete(client: Client, classIndex: number): void {
        const packet = new BitBuffer();
        packet.writeMethod6(classIndex, 2);
        packet.writeMethod6(1, 1);
        client.sendBitBuffer(0xD5, packet);
    }

    private static async saveCharacter(client: Client): Promise<void> {
        if (!client.userId || !client.character) {
            return;
        }

        client.characters = await db.saveCharacterSnapshot(client.userId, client.character);
    }
}
