import { Client } from '../core/Client';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';
import { getClientLevelScope, getScopeLevelName } from '../core/LevelScope';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { BitReader } from '../network/protocol/bitReader';
import { MissionHandler } from '../handlers/MissionHandler';

type PatchedClientConstructor = typeof Client & {
    __nephitDirectRankPatchInstalled?: boolean;
};

type NephitMissionHandler = typeof MissionHandler & {
    markRequiredDungeonBossDefeated?: (levelScope: string, levelName: string | null | undefined, entity: any) => void;
};

const sentRankScopesByToken = new Set<string>();
const scheduledRankTimers = new Map<string, NodeJS.Timeout>();

function isNephitsQuestLevel(levelName: string | null | undefined): boolean {
    const normalizedLevel = LevelConfig.normalizeLevelName(levelName);
    return normalizedLevel === 'GhostBossDungeon' || normalizedLevel === 'GhostBossDungeonHard';
}

function getClientLevelName(client: any): string {
    return LevelConfig.normalizeLevelName(client?.currentLevel || String(client?.character?.CurrentLevel?.name ?? '')) ||
        getScopeLevelName(getClientLevelScope(client)) ||
        String(client?.currentLevel ?? '');
}

function isNephitClient(client: any): boolean {
    return Boolean(client?.character && getClientLevelScope(client) && isNephitsQuestLevel(getClientLevelName(client)));
}

function normalizeText(value: string | null | undefined): string {
    return String(value ?? '')
        .replace(/<[^>]*>/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

function isFinalNephitDialogue(text: string | null | undefined): boolean {
    const normalized = normalizeText(text);
    return normalized.includes('dream dragon') ||
        normalized.includes('mentioned might be') ||
        normalized.includes('nephit');
}

function parseRoomThoughtText(buffer: Buffer): string {
    try {
        const br = new BitReader(buffer);
        br.readMethod4();
        return String(br.readMethod13() ?? '');
    } catch {
        return '';
    }
}

function getScopeClients(levelScope: string, preferredClient?: any): any[] {
    const clients: any[] = [];
    const seen = new Set<any>();

    if (preferredClient && getClientLevelScope(preferredClient) === levelScope) {
        clients.push(preferredClient);
        seen.add(preferredClient);
    }

    for (const session of GlobalState.sessionsByToken.values()) {
        if (seen.has(session) || !session?.character || !session?.playerSpawned) {
            continue;
        }
        if (getClientLevelScope(session) !== levelScope || !isNephitClient(session)) {
            continue;
        }
        clients.push(session);
        seen.add(session);
    }

    return clients;
}

function sendDirectDungeonRank(client: any, reason: string): boolean {
    const levelScope = getClientLevelScope(client);
    if (!client?.character || !levelScope || !isNephitClient(client)) {
        return false;
    }

    const sentKey = `${client.token}:${levelScope}`;
    if (sentRankScopesByToken.has(sentKey)) {
        return false;
    }
    sentRankScopesByToken.add(sentKey);

    client.character.questTrackerState = 100;

    // Keep the visual objective in sync before the rank panel opens.
    const progress = new BitBuffer(false);
    progress.writeMethod4(100);
    client.sendBitBuffer(0xB7, progress);

    // 0x87 is the Flash Dungeon Complete / Rank Statistics panel packet.
    // These values are deliberately conservative and valid; the normal score
    // calculation can still update persisted mission data separately, but this
    // guarantees that the expected panel is shown after Nephit's post-boss scene.
    const rank = new BitBuffer(false);
    rank.writeMethod6(8, 4);          // stars
    rank.writeMethod4(100);           // result bar width/scale
    rank.writeMethod4(1);             // rank: 1st
    rank.writeMethod4(196_560);       // kills score
    rank.writeMethod4(196_560);       // accuracy score
    rank.writeMethod4(196_560);       // deaths score
    rank.writeMethod4(98_280);        // treasure score
    rank.writeMethod4(98_280);        // time bonus score
    client.sendBitBuffer(0x87, rank);

    console.log(`[NephitsQuestDirect] sent rank/statistics packet reason=${reason} token=${client.token} scope=${levelScope}`);
    return true;
}

function forceRankForScope(levelScope: string, preferredClient: any, reason: string): void {
    const clients = getScopeClients(levelScope, preferredClient);
    if (!clients.length) {
        console.log(`[NephitsQuestDirect] no clients found for rank packet reason=${reason} scope=${levelScope}`);
        return;
    }

    for (const client of clients) {
        sendDirectDungeonRank(client, reason);
    }
}

function scheduleRankForScope(levelScope: string, preferredClient: any, reason: string, delayMs: number): void {
    if (!levelScope) {
        return;
    }

    const key = `${levelScope}:${reason}`;
    const existing = scheduledRankTimers.get(key);
    if (existing) {
        clearTimeout(existing);
    }

    console.log(`[NephitsQuestDirect] scheduling rank/statistics reason=${reason} delayMs=${delayMs} scope=${levelScope}`);
    const timer = setTimeout(() => {
        scheduledRankTimers.delete(key);
        forceRankForScope(levelScope, preferredClient, reason);
    }, Math.max(0, Math.round(delayMs)));
    timer.unref?.();
    scheduledRankTimers.set(key, timer);
}

function getEntityName(entity: any): string {
    for (const raw of [entity?.name, entity?.EntName, entity?.entName, entity?.characterName, entity?.character_name]) {
        const value = String(raw ?? '').replace(/^,+/, '').trim();
        if (value) {
            return value;
        }
    }
    return '';
}

function isNephitEntityName(name: string): boolean {
    const key = String(name ?? '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    return key === 'nephit' || key === 'nephithard' || key === 'nephitlargeeye' || key === 'nephitlargeeyehard';
}

function patchClientSend(): void {
    const patchedClient = Client as PatchedClientConstructor;
    if (patchedClient.__nephitDirectRankPatchInstalled) {
        return;
    }
    patchedClient.__nephitDirectRankPatchInstalled = true;

    const originalSend = Client.prototype.send;
    Client.prototype.send = function patchedSend(this: any, packetId: number, buffer: Buffer): void {
        if (isNephitClient(this)) {
            if (packetId === 0x76) {
                const text = parseRoomThoughtText(buffer);
                if (text) {
                    console.log(`[NephitsQuestDirect] outgoing room thought text="${normalizeText(text)}"`);
                }
                if (isFinalNephitDialogue(text)) {
                    scheduleRankForScope(getClientLevelScope(this), this, 'outgoingFinalDialogue', 2500);
                }
            } else if (packetId === 0x87) {
                console.log(`[NephitsQuestDirect] outgoing vanilla rank packet observed token=${this.token}`);
            }
        }

        originalSend.call(this, packetId, buffer);
    };
}

function patchBossDefeat(): void {
    const missionHandler = MissionHandler as NephitMissionHandler & { __nephitDirectBossPatchInstalled?: boolean };
    if (missionHandler.__nephitDirectBossPatchInstalled) {
        return;
    }

    const originalMarkRequiredDungeonBossDefeated = missionHandler.markRequiredDungeonBossDefeated?.bind(MissionHandler);
    if (typeof originalMarkRequiredDungeonBossDefeated !== 'function') {
        console.log('[NephitsQuestDirect] boss defeat hook unavailable');
        return;
    }

    missionHandler.__nephitDirectBossPatchInstalled = true;
    missionHandler.markRequiredDungeonBossDefeated = (levelScope: string, levelName: string | null | undefined, entity: any): void => {
        originalMarkRequiredDungeonBossDefeated(levelScope, levelName, entity);

        const normalizedLevel = LevelConfig.normalizeLevelName(levelName) || getScopeLevelName(levelScope);
        const entityName = getEntityName(entity);
        if (!levelScope || !isNephitsQuestLevel(normalizedLevel) || (entityName && !isNephitEntityName(entityName))) {
            return;
        }

        const clients = getScopeClients(levelScope);
        const preferred = clients[0] ?? null;
        console.log(`[NephitsQuestDirect] boss defeat hook level=${normalizedLevel} entity=${entityName || 'unknown'} scope=${levelScope}`);
        scheduleRankForScope(levelScope, preferred, 'bossDefeatDirect', 12500);
    };
}

patchClientSend();
patchBossDefeat();
console.log('[NephitsQuestDirect] direct rank patch installed');
