import type { Client } from '../core/Client';
import { BitBuffer } from '../network/protocol/bitBuffer';
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
 * The Flash client sorts loot drops by their floor Y and by insert order.
 * Keep gold slightly behind and flush gear last so item silhouettes are not
 * hidden when the same reward creates both gold and gear lootdrops.
 */
export class LootDepthRewardHandler {
    private static readonly GOLD_DEPTH_Y_OFFSET = -16;
    private static readonly GEAR_DEPTH_Y_OFFSET = 24;

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
                payload: LootDepthRewardHandler.rewriteLootdropForDepth(payload, parsed)
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

    private static rewriteLootdropForDepth(payload: Buffer, parsed: ParsedLootdrop): Buffer {
        if (parsed.kind === 'unknown') {
            return payload;
        }

        const yOffset = parsed.kind === 'gear'
            ? LootDepthRewardHandler.GEAR_DEPTH_Y_OFFSET
            : parsed.kind === 'gold'
                ? LootDepthRewardHandler.GOLD_DEPTH_Y_OFFSET
                : 0;

        const bb = new BitBuffer(false);
        bb.writeMethod4(parsed.lootId);
        bb.writeMethod45(parsed.x);
        bb.writeMethod45(parsed.y + yOffset);

        if (parsed.kind === 'gear') {
            bb.writeMethod15(true);
            bb.writeMethod6(parsed.amount, 11);
            bb.writeMethod6(parsed.tier ?? 0, 2);
            return bb.toBuffer();
        }
        bb.writeMethod15(false);

        if (parsed.kind === 'material') {
            bb.writeMethod15(true);
            bb.writeMethod4(parsed.amount);
            return bb.toBuffer();
        }
        bb.writeMethod15(false);

        if (parsed.kind === 'gold') {
            bb.writeMethod15(true);
            bb.writeMethod4(parsed.amount);
            return bb.toBuffer();
        }
        bb.writeMethod15(false);

        if (parsed.kind === 'health') {
            bb.writeMethod15(true);
            bb.writeMethod4(parsed.amount);
            return bb.toBuffer();
        }
        bb.writeMethod15(false);

        bb.writeMethod15(false);
        bb.writeMethod4(parsed.amount);
        return bb.toBuffer();
    }
}
