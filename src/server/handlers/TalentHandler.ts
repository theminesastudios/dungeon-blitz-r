import { Client } from '../core/Client';
import { BitReader } from '../network/protocol/bitReader';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { JsonAdapter } from '../database/JsonAdapter';
import { TalentConfig } from '../core/TalentConfig';
import { EntityHandler } from './EntityHandler';
import { WorldEnter } from '../utils/WorldEnter';
import { SpeedupPricing } from '../core/SpeedupPricing';
import {
    HallowsEve,
    HALLOWS_EVE_SUMMON_COST_IDOLS,
    HALLOWS_EVE_DOOR_ID,
    HALLOWS_EVE_LEVEL,
    describeHallowsEveDelay
} from '../core/HallowsEve';
import { LevelConfig } from '../core/LevelConfig';
import { LevelHandler } from './LevelHandler';

type TalentResearchRecord = {
    classIndex?: number | null;
    ReadyTime?: number;
};

const db = new JsonAdapter();

export class TalentHandler {
    private static readonly MAX_TALENT_POINTS_PER_CLASS = 50;

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

            void TalentHandler.completeTalentResearch(client, classIndex, true);
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

        if (!TalentHandler.isValidTalentClassIndex(classIndex)) {
            return;
        }

        const currentPoints = Number(client.character.talentPoints[String(classIndex)] ?? 0);
        if (currentPoints >= TalentHandler.MAX_TALENT_POINTS_PER_CLASS) {
            return;
        }

        const durationIndex = currentPoints + 1;
        const goldCost = Number(TalentConfig.RESEARCH_COSTS[durationIndex] ?? 0);
        const idolCost = Number(TalentConfig.IDOL_COST[durationIndex] ?? 0);
        const now = Math.floor(Date.now() / 1000);

        if (isInstant) {
            const idols = Number(client.character.mammothIdols ?? 0);
            if (idols < idolCost) {
                return;
            }

            client.character.mammothIdols = idols - idolCost;
            TalentHandler.setPendingCompletedResearch(client.character, classIndex, now);
            await TalentHandler.completeTalentResearch(client, classIndex, false);
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
        TalentHandler.setPendingCompletedResearch(client.character, classIndex, now);

        await TalentHandler.completeTalentResearch(client, classIndex, false);
        TalentHandler.syncResearchTimer(client);
        TalentHandler.sendTalentResearchComplete(client, classIndex);
    }

    static async handleTalentSpeedup(client: Client, data: Buffer): Promise<void> {
        if (!client.character) {
            return;
        }

        const br = new BitReader(data);
        const idolCost = br.readMethod9();

        /**
         * **The Green Knight's "Summon Knight Now", which arrives on this packet.**
         *
         * `class_69.method_1410` is the only sender of 0xE0 in the whole client, and
         * `class_69` is no longer the Class Tower screen - it is bound to
         * `a_ScreenHalloweenDungeonPrompt`, and the button that reaches it is the
         * seasonal panel's own Summon art moved into the `am_SpeedUpPanel.am_SpeedUp`
         * slot (see `scripts/patch-hallows-eve-challenge-screen.ts`). So in the two
         * Hallow's Eve towns this packet can only mean the Summon button.
         *
         * The talent path below is left intact rather than deleted: it is what this
         * packet meant before the screen was repointed, and it costs one branch to
         * keep it honest.
         *
         * `idolCost` is whatever the client computed from the Class Tower's timer -
         * meaningless here. The price and the check are `HallowsEve`'s.
         */
        if (HallowsEve.isTown(client.currentLevel)) {
            const outcome = HallowsEve.summonKnightNow(client.character);

            /**
             * Nothing to skip, so nothing to charge - but the button still takes you in.
             *
             * The twelve hours are the thing being bought, and when they have already
             * run out there is no purchase to make. Refusing outright was the first
             * shape of this and it read as a broken button: the player presses Summon
             * with the idols in hand, nothing is spent, nothing happens, and the panel
             * has no way to explain itself. Taking them through instead makes the
             * button mean one thing in both states - *go and fight him now* - and it
             * only ever costs idols when there is a wait to buy out of.
             */
            if (outcome === 'first' || outcome === 'ready') {
                console.log(
                    `[HallowsEve] ${String(client.character.name ?? '')} sent in free ` +
                    (outcome === 'first' ? '(first visit)' : '(no cooldown to skip)')
                );
                HallowsEve.sayAtTheArch(
                    client,
                    outcome === 'first'
                        ? 'Your first meeting is a gift. Go - he has been waiting a long time.'
                        : 'He is already waiting. Go - this one costs you nothing.'
                );
                if (outcome === 'first') {
                    await TalentHandler.saveCharacter(client);
                }
                HallowsEve.grantEntry(client.character.name);
                LevelHandler.grantDoorTransfer(
                    client,
                    LevelConfig.normalizeLevelName(client.currentLevel) || String(client.currentLevel ?? ''),
                    HALLOWS_EVE_DOOR_ID,
                    HALLOWS_EVE_LEVEL
                );
                return;
            }
            if (outcome === 'poor') {
                console.log(
                    `[HallowsEve] ${String(client.character.name ?? '')} pressed Summon with ` +
                    `${Math.max(0, Math.round(Number(client.character.mammothIdols ?? 0)) || 0)} idols; ` +
                    `needs ${HALLOWS_EVE_SUMMON_COST_IDOLS}`
                );
                /**
                 * No idols means the twelve hours stand.
                 *
                 * The wait is what the idols buy out of, so a player who cannot pay
                 * is simply told how long is left. The panel's own countdown says the
                 * same thing above the button (`HallowsEve.sendCooldownTimer`), but
                 * only the arch can answer the press itself.
                 */
                const wait = describeHallowsEveDelay(HallowsEve.secondsUntilNextKey(client.character));
                HallowsEve.sayAtTheArch(
                    client,
                    `The Green Knight sleeps for another ${wait}. ` +
                    `${HALLOWS_EVE_SUMMON_COST_IDOLS} Mammoth Idols would wake him now.`
                );
                return;
            }
            if (outcome !== 'summoned') {
                return;
            }
            TalentHandler.sendPremiumPurchase(client, 'HallowsEveSummon', HALLOWS_EVE_SUMMON_COST_IDOLS);
            console.log(
                `[HallowsEve] ${String(client.character.name ?? '')} summoned the Green Knight for ` +
                `${HALLOWS_EVE_SUMMON_COST_IDOLS} idols (client claimed ${idolCost})`
            );
            await TalentHandler.saveCharacter(client);

            /**
             * Paying takes the player in.
             *
             * "Summon Knight Now" is a purchase, and what is bought is the fight - so
             * ending on "go and walk through the arch yourself" would be charging for
             * a message. `grantDoorTransfer` emits exactly what a normal door open
             * emits, which is the same door this feature already uses: it is what the
             * old `a_DialogBox` Yes did before the panel existed
             * (`NpcHandler.tryHandleHallowsEvePromptAnswer`).
             *
             * The entry grant goes with it so the transfer is not questioned on the
             * way through.
             */
            HallowsEve.grantEntry(client.character.name);
            // The twelve hours were just bought out; the panel has to stop counting
            // them before the player is back in front of it.
            HallowsEve.sendCooldownTimer(client);
            const fromLevel =
                LevelConfig.normalizeLevelName(client.currentLevel) || String(client.currentLevel ?? '');
            LevelHandler.grantDoorTransfer(client, fromLevel, HALLOWS_EVE_DOOR_ID, HALLOWS_EVE_LEVEL);
            return;
        }

        const research = TalentHandler.getTalentResearch(client.character);
        const classIndex = Number(research.classIndex ?? -1);
        if (classIndex < 0) {
            return;
        }

        const authoritativeCost = SpeedupPricing.reconcile(research.ReadyTime, idolCost);
        if (authoritativeCost > 0) {
            const idols = Number(client.character.mammothIdols ?? 0);
            if (idols < authoritativeCost) {
                console.warn(
                    `[Talent] Refused a Speed Up for ${client.character.name}: ` +
                    `has ${idols} idols, needs ${authoritativeCost} (client claimed ${idolCost}).`
                );
                SpeedupPricing.refreshScreens(client);
                return;
            }

            client.character.mammothIdols = idols - authoritativeCost;
        }

        TalentHandler.setPendingCompletedResearch(client.character, classIndex, 0);
        await TalentHandler.completeTalentResearch(client, classIndex, false);
        TalentHandler.syncResearchTimer(client);
        TalentHandler.sendPremiumPurchase(client, 'TalentSpeedup', authoritativeCost);
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

        await TalentHandler.completeTalentResearch(client, classIndex, false);
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

    private static isValidTalentClassIndex(classIndex: number): boolean {
        return Number.isFinite(classIndex) && classIndex >= 1 && classIndex <= 3;
    }

    private static setPendingCompletedResearch(character: Record<string, unknown>, classIndex: number, readyTime: number): void {
        character.talentResearch = {
            classIndex,
            ReadyTime: readyTime
        };
    }

    private static async completeTalentResearch(client: Client, classIndex: number, notifyClient: boolean): Promise<boolean> {
        if (!client.character || !TalentHandler.isValidTalentClassIndex(classIndex)) {
            return false;
        }

        const research = TalentHandler.getTalentResearch(client.character);
        if (Number(research.classIndex ?? -1) !== classIndex) {
            return false;
        }

        if (!client.character.talentPoints || typeof client.character.talentPoints !== 'object') {
            client.character.talentPoints = {};
        }

        const key = String(classIndex);
        const currentPoints = Math.max(0, Number(client.character.talentPoints[key] ?? 0));
        client.character.talentPoints[key] = Math.min(currentPoints + 1, TalentHandler.MAX_TALENT_POINTS_PER_CLASS);
        client.character.talentResearch = {
            classIndex: null,
            ReadyTime: 0
        };

        await TalentHandler.saveCharacter(client);

        if (notifyClient) {
            TalentHandler.sendTalentResearchComplete(client, classIndex);
        }

        return true;
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

    /**
     * 0xD5, which now carries a deadline rather than a finished research.
     *
     * The client's reader was `SetCurrentResearch(index, 0)` followed by a talent
     * point and a notification; it is now `SetCurrentResearch(index, packet.method_4())`
     * and nothing else, because that is the one channel that can put the Green
     * Knight's twelve hours on his panel - see `HallowsEve.sendCooldownTimer` and
     * `scripts/patch-dungeonblitz-hallows-eve-cooldown-timer.ts`.
     *
     * So the second field is a time now, not a flag. `(0, 0)` is the idle state, which
     * is what a finished research is: the point itself is granted and saved server-side
     * either way, and the screen that used to draw it is the seasonal panel now, so
     * there is nothing left for this packet to announce.
     */
    private static sendTalentResearchComplete(client: Client, _classIndex: number): void {
        const packet = new BitBuffer();
        packet.writeMethod6(0, 2);
        packet.writeMethod4(0);
        client.sendBitBuffer(0xD5, packet);
    }

    private static async saveCharacter(client: Client): Promise<void> {
        if (!client.userId || !client.character) {
            return;
        }

        client.characters = await db.saveCharacterSnapshot(client.userId, client.character);
    }
}
