type TalentNode = {
    filled: boolean;
    points: number;
    nodeID: number;
};

type TalentSlot = {
    nodeID: number;
    points: number;
};

export class TalentConfig {
    static readonly NUM_TALENT_SLOTS = 27;

    static readonly RESEARCH_DURATIONS = [
        0, 180, 7200, 14400, 21600, 37800, 54000, 70200, 86400, 108000, 129600, 150750,
        171900, 195750, 219600, 268500, 317400, 337500, 357600, 434850, 512100, 532575, 553050,
        575175, 597300, 621200, 645100, 670900, 696700, 724575, 752450, 782550, 812650, 845150,
        877650, 912750, 947850, 985775, 1023700, 1064650, 1105600, 1149825, 1194050, 1241800, 1289550,
        1341125, 1392700, 1448400, 1504100, 1564275, 1624450
    ];

    static readonly RESEARCH_COSTS = [
        0, 0, 2805, 6300, 11187, 18009, 27133, 39230, 55492, 76352, 103326, 138087, 182677, 238420,
        309610, 398435, 508501, 646504, 817051, 1028027, 1287751, 1608088, 2000327, 2479956, 3067822,
        3781585, 4084112, 4410841, 4763708, 5144805, 5556389, 6000900, 6480972, 6999450, 7559406, 8164158,
        8817291, 9522674, 10284488, 11107247, 11995827, 12955493, 13991932, 15111287, 16320190, 17625805,
        19035869, 20558739, 22203438, 23979713, 25898090
    ];

    static readonly IDOL_COST = [
        0, 0, 2, 4, 6, 10, 14, 20, 28, 37, 41, 45, 51, 59, 68, 80, 95, 113, 122, 132, 145, 161, 181, 193, 204,
        219, 225, 231, 238, 246, 254, 263, 273, 283, 291, 299, 308, 318, 329, 340, 352, 366, 380, 396, 412,
        431, 450, 471, 494, 519, 545
    ];

    static readonly CONST_529 = [5, 2, 3, 5, 5, 3, 2, 3, 2, 5, 2, 3, 5, 5, 3, 2, 3, 2, 5, 2, 3, 5, 5, 3, 2, 3, 2];

    static indexToNodeId(index: number): number {
        if (index < 0) return 1;
        if (index >= TalentConfig.NUM_TALENT_SLOTS) return TalentConfig.NUM_TALENT_SLOTS;
        return index + 1;
    }

    static getSlotBitWidth(index: number): number {
        const x = TalentConfig.CONST_529[index] ?? 0;
        let width = 0;
        if (x <= 2) width = 1;
        if (x <= 4) width = 2;
        if (x <= 5) width = 3;
        return width;
    }

    static buildEmptyTalentNodes(): TalentNode[] {
        const nodes: TalentNode[] = [];
        for (let index = 0; index < TalentConfig.NUM_TALENT_SLOTS; index += 1) {
            nodes.push({
                nodeID: TalentConfig.indexToNodeId(index),
                points: 0,
                filled: false
            });
        }
        return nodes;
    }

    static normalizeTalentNodes(rawNodes: unknown): TalentNode[] {
        const normalized: TalentNode[] = [];
        const nodes = Array.isArray(rawNodes) ? rawNodes : [];

        for (let index = 0; index < TalentConfig.NUM_TALENT_SLOTS; index += 1) {
            const fallbackNodeId = TalentConfig.indexToNodeId(index);
            const rawNode = nodes[index];
            const node = rawNode && typeof rawNode === 'object' && !Array.isArray(rawNode)
                ? rawNode as Record<string, unknown>
                : null;

            if (!node || !Boolean(node.filled)) {
                normalized.push({
                    nodeID: fallbackNodeId,
                    points: 0,
                    filled: false
                });
                continue;
            }

            let nodeID = Number(node.nodeID ?? fallbackNodeId);
            if (!Number.isFinite(nodeID) || nodeID < 1 || nodeID > TalentConfig.NUM_TALENT_SLOTS) {
                nodeID = fallbackNodeId;
            }

            let points = Number(node.points ?? 0);
            const maxPoints = TalentConfig.CONST_529[index] ?? 0;
            if (!Number.isFinite(points) || points < 1) {
                points = 1;
            }
            if (points > maxPoints) {
                points = maxPoints;
            }

            normalized.push({
                nodeID,
                points,
                filled: true
            });
        }

        return normalized;
    }

    static buildTalentSlots(character: Record<string, unknown>): Array<TalentSlot | null> {
        const slots: Array<TalentSlot | null> = new Array(TalentConfig.NUM_TALENT_SLOTS).fill(null);
        const masterClass = Math.max(0, Number(character.MasterClass ?? 0));
        if (masterClass === 0) {
            return slots;
        }

        const rawTree = character.TalentTree;
        const talentTree = rawTree && typeof rawTree === 'object' && !Array.isArray(rawTree)
            ? rawTree as Record<string, unknown>
            : {};
        const rawClassTree = talentTree[String(masterClass)];
        const classTree = rawClassTree && typeof rawClassTree === 'object' && !Array.isArray(rawClassTree)
            ? rawClassTree as Record<string, unknown>
            : null;
        if (!classTree) {
            return slots;
        }

        for (const node of TalentConfig.normalizeTalentNodes(classTree.nodes)) {
            if (!node.filled) {
                continue;
            }

            if (node.nodeID <= 0 || node.points <= 0) {
                continue;
            }

            const slotIndex = node.nodeID - 1;
            if (slotIndex < 0 || slotIndex >= TalentConfig.NUM_TALENT_SLOTS) {
                continue;
            }

            slots[slotIndex] = {
                nodeID: node.nodeID,
                points: node.points
            };
        }

        return slots;
    }
}
