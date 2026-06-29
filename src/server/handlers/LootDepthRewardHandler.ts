import type { Client } from '../core/Client';
import { BitReader } from '../network/protocol/bitReader';
import { RewardHandler } from './RewardHandler';

type LootdropKind = 'gear' | 'material' | 'gold' | 'health' | 'dye' | 'unknown';

type ParsedLootdrop = {
    kind: LootdropKind;
    lootId: number;
    x: number;
    y: number;
    amount: number;
    tier?: number;
};

type CapturedLootdrop = {
    sequence: number;
    kind: LootdropKind;
    payload: Buffer;
};

/**
 * The Flash client sorts loot drops by insert order when they share a floor Y.
 * Preserve the packet coordinates because they are also the pickup location.
 */
export class LootDepthRewardHandler {
    static handleGrantReward(client: Client, data: Buffer): void {
        const capturedLootdrops: CapturedLootdrop[] = [];
        const originalSend = client.send.bind(client);
        let sequence = 0;

        client.send = ((packetId: number, payload: Buffer) => {
            if (packetId !== 0x32) {
                originalSend(packetId, payload);
                return;
            }

            const parsed = LootDepthRewardHandler.parseLootdrop(payload);
            capturedLootdrops.push({
                sequence: sequence++,
                kind: parsed.kind,
                payload
            });
        }) as typeof client.send;

        try {
            RewardHandler.handleGrantReward(client, data);
        } finally {
            client.send = originalSend as typeof client.send;
            capturedLootdrops
                .sort((a, b) => (
                    LootDepthRewardHandler.getLootdropSortOrder(a.kind) - LootDepthRewardHandler.getLootdropSortOrder(b.kind)
                ) || (a.sequence - b.sequence))
                .forEach((entry) => originalSend(0x32, entry.payload));
        }
    }

    private static getLootdropSortOrder(kind: LootdropKind): number {
        switch (kind) {
            case 'gold':
                return 0;
            case 'health':
                return 1;
            case 'material':
            case 'dye':
                return 2;
            case 'gear':
                return 3;
            default:
                return 1;
        }
    }

    private static parseLootdrop(payload: Buffer): ParsedLootdrop {
        try {
            const br = new BitReader(payload);
            const lootId = br.readMethod4();
            const x = br.readMethod45();
            const y = br.readMethod45();

            if (br.readMethod15()) {
                const gearId = br.readMethod6(11);
                const tier = br.readMethod6(2);
                return { kind: 'gear', lootId, x, y, amount: gearId, tier };
            }

            if (br.readMethod15()) {
                return { kind: 'material', lootId, x, y, amount: br.readMethod4() };
            }

            if (br.readMethod15()) {
                return { kind: 'gold', lootId, x, y, amount: br.readMethod4() };
            }

            if (br.readMethod15()) {
                return { kind: 'health', lootId, x, y, amount: br.readMethod4() };
            }

            br.readMethod15();
            return { kind: 'dye', lootId, x, y, amount: br.readMethod4() };
        } catch {
            return { kind: 'unknown', lootId: 0, x: 0, y: 0, amount: 0 };
        }
    }

}
