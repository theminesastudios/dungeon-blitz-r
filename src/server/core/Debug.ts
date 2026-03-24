import type { Client } from './Client';

function parseBooleanEnv(name: string, fallback: boolean): boolean {
    const raw = process.env[name];
    if (raw === undefined) {
        return fallback;
    }

    switch (String(raw).trim().toLowerCase()) {
        case '1':
        case 'true':
        case 'yes':
        case 'on':
            return true;
        case '0':
        case 'false':
        case 'no':
        case 'off':
            return false;
        default:
            return fallback;
    }
}

function limitHex(data: Buffer, maxBytes: number): string {
    if (data.length <= maxBytes) {
        return data.toString('hex');
    }

    return `${data.subarray(0, maxBytes).toString('hex')}...(${data.length} bytes)`;
}

export const DebugConfig = {
    enabled: parseBooleanEnv('DEBUG_ENABLED', false),
    packets: parseBooleanEnv('DEBUG_PACKETS', parseBooleanEnv('DEBUG_ENABLED', false)),
    progress: parseBooleanEnv('DEBUG_PROGRESS', parseBooleanEnv('DEBUG_ENABLED', false)),
    packetPayloads: parseBooleanEnv('DEBUG_PACKET_PAYLOADS', false),
    unhandledPackets: parseBooleanEnv('DEBUG_UNHANDLED_PACKETS', parseBooleanEnv('DEBUG_ENABLED', false)),
    router: parseBooleanEnv('DEBUG_ROUTER', parseBooleanEnv('DEBUG_ENABLED', false)),
    payloadPreviewBytes: Math.max(1, Number(process.env.DEBUG_PAYLOAD_PREVIEW_BYTES ?? 64) || 64)
};

export class DebugLogger {
    private static asRecord(value: unknown): Record<string, unknown> {
        return value && typeof value === 'object' && !Array.isArray(value)
            ? value as Record<string, unknown>
            : {};
    }

    private static asArray(value: unknown): unknown[] {
        return Array.isArray(value) ? value : [];
    }

    private static normalizeMissionStates(value: unknown): Record<string, number> {
        const missions = DebugLogger.asRecord(value);
        const missionIds = ['1', '2', '3', '4', '5', '6'];
        const summary: Record<string, number> = {};

        for (const missionId of missionIds) {
            const entry = DebugLogger.asRecord(missions[missionId]);
            const state = Number(entry.state ?? 0);
            if (state > 0) {
                summary[missionId] = state;
            }
        }

        return summary;
    }

    private static normalizeBuildingRanks(value: unknown): Record<string, number> {
        const statsByBuilding = DebugLogger.asRecord(value);
        const buildingIds = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13'];
        const summary: Record<string, number> = {};

        for (const buildingId of buildingIds) {
            const rank = Number(statsByBuilding[buildingId] ?? 0);
            if (rank > 0) {
                summary[buildingId] = rank;
            }
        }

        return summary;
    }

    private static normalizeLearnedAbilities(value: unknown): Array<{ abilityID: number; rank: number }> {
        const learned = DebugLogger.asArray(value);
        return learned
            .map((entry) => {
                const ability = DebugLogger.asRecord(entry);
                return {
                    abilityID: Number(ability.abilityID ?? 0),
                    rank: Number(ability.rank ?? 0)
                };
            })
            .filter((entry) => entry.abilityID > 0 && entry.rank > 0)
            .sort((left, right) => left.abilityID - right.abilityID);
    }

    private static normalizeActiveAbilities(value: unknown): number[] {
        return DebugLogger.asArray(value)
            .map((entry) => Number(entry ?? 0))
            .filter((entry) => entry > 0);
    }

    private static snapshotCharacterProgress(character: Record<string, unknown> | null | undefined): Record<string, unknown> {
        const safeCharacter = DebugLogger.asRecord(character);
        const currentLevel = DebugLogger.asRecord(safeCharacter.CurrentLevel);
        const previousLevel = DebugLogger.asRecord(safeCharacter.PreviousLevel);
        const magicForge = DebugLogger.asRecord(safeCharacter.magicForge);
        const skillResearch = DebugLogger.asRecord(safeCharacter.SkillResearch);
        const buildingUpgrade = DebugLogger.asRecord(safeCharacter.buildingUpgrade);

        return {
            name: String(safeCharacter.name ?? ''),
            class: String(safeCharacter.class ?? ''),
            currentLevel: String(currentLevel.name ?? ''),
            previousLevel: String(previousLevel.name ?? ''),
            questTrackerState: Number(safeCharacter.questTrackerState ?? 0),
            missions: DebugLogger.normalizeMissionStates(safeCharacter.missions),
            learnedAbilities: DebugLogger.normalizeLearnedAbilities(safeCharacter.learnedAbilities),
            activeAbilities: DebugLogger.normalizeActiveAbilities(safeCharacter.activeAbilities),
            buildingRanks: DebugLogger.normalizeBuildingRanks(magicForge.stats_by_building),
            buildingUpgrade: {
                buildingID: Number(buildingUpgrade.buildingID ?? 0),
                rank: Number(buildingUpgrade.rank ?? 0),
                ReadyTime: Number(buildingUpgrade.ReadyTime ?? 0)
            },
            skillResearch: {
                abilityID: Number(skillResearch.abilityID ?? 0),
                rank: Number(skillResearch.rank ?? 0),
                ReadyTime: Number(skillResearch.ReadyTime ?? 0)
            }
        };
    }

    private static formatClient(client: Client | null | undefined): string {
        if (!client) {
            return 'user=- token=0 char=- level=- ent=0';
        }

        return [
            `user=${client.userId ?? '-'}`,
            `token=${client.token ?? 0}`,
            `char=${client.character?.name ?? '-'}`,
            `level=${client.currentLevel || '-'}`,
            `ent=${client.clientEntID || 0}`
        ].join(' ');
    }

    private static formatPayload(data: Buffer): string {
        const hex = DebugConfig.packetPayloads
            ? data.toString('hex')
            : limitHex(data, DebugConfig.payloadPreviewBytes);
        return `payload=${hex}`;
    }

    static previewBuffer(data: Buffer): string {
        return DebugConfig.packetPayloads
            ? data.toString('hex')
            : limitHex(data, DebugConfig.payloadPreviewBytes);
    }

    static log(scope: string, message: string): void {
        if (!DebugConfig.enabled) {
            return;
        }

        console.log(`[Debug][${scope}] ${message}`);
    }

    static logPacket(direction: 'IN' | 'OUT', client: Client, packetId: number, data: Buffer): void {
        if (!DebugConfig.packets) {
            return;
        }

        const details = [
            `0x${packetId.toString(16)}`,
            `len=${data.length}`,
            DebugLogger.formatClient(client),
            DebugLogger.formatPayload(data)
        ].join(' ');
        console.log(`[Debug][Packet ${direction}] ${details}`);
    }

    static logRouter(client: Client, packetId: number, handlerName: string, data: Buffer): void {
        if (!DebugConfig.router) {
            return;
        }

        console.log(
            `[Debug][Router] handled=0x${packetId.toString(16)} handler=${handlerName || 'anonymous'} len=${data.length} ${DebugLogger.formatClient(client)}`
        );
    }

    static logUnhandledPacket(client: Client, packetId: number, data: Buffer): void {
        if (!DebugConfig.unhandledPackets) {
            return;
        }

        console.warn(
            `[Debug][Unhandled] 0x${packetId.toString(16)} len=${data.length} ${DebugLogger.formatClient(client)} ${DebugLogger.formatPayload(data)}`
        );
    }

    static logProgress(
        scope: string,
        client?: Client | null,
        character?: Record<string, unknown> | null,
        extra?: Record<string, unknown>
    ): void {
        if (!DebugConfig.progress) {
            return;
        }

        const snapshot = DebugLogger.snapshotCharacterProgress(
            character ?? (client?.character as Record<string, unknown> | null | undefined)
        );
        const details = {
            ...(extra ?? {}),
            snapshot
        };

        console.log(
            `[Debug][Progress][${scope}] ${DebugLogger.formatClient(client)} ${JSON.stringify(details)}`
        );
    }

    static logStartup(): void {
        if (!DebugConfig.enabled) {
            return;
        }

        console.log(
            `[Debug] enabled packets=${DebugConfig.packets} progress=${DebugConfig.progress} router=${DebugConfig.router} unhandled=${DebugConfig.unhandledPackets} payloads=${DebugConfig.packetPayloads}`
        );
    }
}
