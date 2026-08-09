import { Client } from '../core/Client';
import { performance } from 'perf_hooks';

type PacketHandler = (client: Client, data: Buffer) => void | Promise<void>;
export type PacketQueueContext = { enqueuedAt: number; depthAtEnqueue: number };
export type PacketHandlerMetrics = {
    calls: number;
    errors: number;
    totalQueueWaitMs: number;
    maxQueueWaitMs: number;
    totalHandlerDurationMs: number;
    maxHandlerDurationMs: number;
};

export class PacketRouter {
    private handlers: Map<number, PacketHandler> = new Map();
    private metrics: Map<number, PacketHandlerMetrics> = new Map();
    private unhandledPacketIds: Set<number> = new Set();

    public register(packetId: number, handler: PacketHandler): void {
        this.handlers.set(packetId, handler);
    }

    public noteQueueDepth(_client: Client, _depth: number): void {
        // Queue depth is tracked for metrics only; do not warn or disconnect here.
    }

    public getMetrics(packetId: number): PacketHandlerMetrics | null {
        const metric = this.metrics.get(packetId);
        return metric ? { ...metric } : null;
    }

    public async handle(client: Client, packetId: number, data: Buffer, context?: PacketQueueContext): Promise<void> {
        const handler = this.handlers.get(packetId);
        if (handler) {
            const startedAt = performance.now();
            const queueWaitMs = context ? Math.max(0, startedAt - context.enqueuedAt) : 0;
            const metric = this.metrics.get(packetId) ?? {
                calls: 0,
                errors: 0,
                totalQueueWaitMs: 0,
                maxQueueWaitMs: 0,
                totalHandlerDurationMs: 0,
                maxHandlerDurationMs: 0
            };
            metric.calls += 1;
            metric.totalQueueWaitMs += queueWaitMs;
            metric.maxQueueWaitMs = Math.max(metric.maxQueueWaitMs, queueWaitMs);
            try {
                await handler(client, data);
            } catch (err) {
                metric.errors += 1;
                console.error(`[Router] Error in handler for 0x${packetId.toString(16)}:`, err);
            } finally {
                const handlerDurationMs = performance.now() - startedAt;
                metric.totalHandlerDurationMs += handlerDurationMs;
                metric.maxHandlerDurationMs = Math.max(metric.maxHandlerDurationMs, handlerDurationMs);
                this.metrics.set(packetId, metric);
            }
        } else if (!this.unhandledPacketIds.has(packetId)) {
            // Silently dropping these is why "I click it and nothing happens, and
            // nothing is logged" was impossible to chase. Once per id, so a chatty
            // client cannot flood the log.
            this.unhandledPacketIds.add(packetId);
            console.warn(`[Router] No handler registered for packet 0x${packetId.toString(16)} (${data.length} bytes)`);
        }
    }
}
