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
    private lastQueueDepthWarningAt = new WeakMap<Client, number>();
    private readonly slowQueueWaitMs = Math.max(10, Number(process.env.PACKET_SLOW_QUEUE_WAIT_MS ?? 100));
    private readonly slowHandlerMs = Math.max(10, Number(process.env.PACKET_SLOW_HANDLER_MS ?? 50));
    private readonly excessiveQueueDepth = Math.max(10, Number(process.env.PACKET_EXCESSIVE_QUEUE_DEPTH ?? 100));

    public register(packetId: number, handler: PacketHandler): void {
        this.handlers.set(packetId, handler);
    }

    public noteQueueDepth(client: Client, depth: number): void {
        if (depth < this.excessiveQueueDepth) {
            return;
        }
        const now = performance.now();
        const lastWarningAt = this.lastQueueDepthWarningAt.get(client) ?? 0;
        if (now - lastWarningAt < 1000) {
            return;
        }
        this.lastQueueDepthWarningAt.set(client, now);
        console.warn(`[Router] Excessive packet queue depth=${depth} token=${client.token}`);
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
                if (queueWaitMs >= this.slowQueueWaitMs || handlerDurationMs >= this.slowHandlerMs) {
                    console.warn(
                        `[Router] Slow packet handler packet=0x${packetId.toString(16)} ` +
                        `queueWaitMs=${queueWaitMs.toFixed(1)} handlerMs=${handlerDurationMs.toFixed(1)} ` +
                        `depth=${context?.depthAtEnqueue ?? 0} token=${client.token}`
                    );
                }
            }
        }
    }
}
