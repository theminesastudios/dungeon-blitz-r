export type AdminRuntimeSettingsSnapshot = {
    revision: number;
    updatedAt: number;
    oneHitEnabled: boolean;
    godModeEnabled: boolean;
    freezeEnemies: boolean;
    damageMultiplier: number;
    playerSpeedMultiplier: number;
    gearDropMultiplier: number;
    materialDropMultiplier: number;
    goldMultiplier: number;
    xpMultiplier: number;
};

type MutableSettings = Omit<AdminRuntimeSettingsSnapshot, 'revision' | 'updatedAt'>;

const DEFAULTS: MutableSettings = {
    oneHitEnabled: false,
    godModeEnabled: false,
    freezeEnemies: false,
    damageMultiplier: 1,
    playerSpeedMultiplier: 1,
    gearDropMultiplier: 1,
    materialDropMultiplier: 1,
    goldMultiplier: 1,
    xpMultiplier: 1
};

const NUMBER_LIMITS: Record<keyof Pick<MutableSettings,
    'damageMultiplier' | 'playerSpeedMultiplier' | 'gearDropMultiplier' |
    'materialDropMultiplier' | 'goldMultiplier' | 'xpMultiplier'>, [number, number]> = {
    damageMultiplier: [0, 100],
    playerSpeedMultiplier: [0.25, 2.5],
    gearDropMultiplier: [0, 100],
    materialDropMultiplier: [0, 100],
    goldMultiplier: [0, 100],
    xpMultiplier: [0, 100]
};

export class AdminRuntimeSettings {
    private static values: MutableSettings = { ...DEFAULTS };
    private static revision = 0;
    private static updatedAt = Date.now();

    static get snapshot(): AdminRuntimeSettingsSnapshot {
        return {
            revision: AdminRuntimeSettings.revision,
            updatedAt: AdminRuntimeSettings.updatedAt,
            ...AdminRuntimeSettings.values
        };
    }

    static update(input: Record<string, unknown>): AdminRuntimeSettingsSnapshot {
        const next = { ...AdminRuntimeSettings.values };
        const booleanKeys: Array<keyof Pick<MutableSettings, 'oneHitEnabled' | 'godModeEnabled' | 'freezeEnemies'>> = [
            'oneHitEnabled',
            'godModeEnabled',
            'freezeEnemies'
        ];
        for (const key of booleanKeys) {
            if (key in input) {
                if (typeof input[key] !== 'boolean') {
                    throw new TypeError(`${key} must be a boolean.`);
                }
                next[key] = input[key];
            }
        }

        for (const [key, [min, max]] of Object.entries(NUMBER_LIMITS) as Array<[keyof typeof NUMBER_LIMITS, [number, number]]>) {
            if (!(key in input)) {
                continue;
            }
            const value = Number(input[key]);
            if (!Number.isFinite(value) || value < min || value > max) {
                throw new RangeError(`${key} must be between ${min} and ${max}.`);
            }
            next[key] = Math.round(value * 100) / 100;
        }

        AdminRuntimeSettings.values = next;
        AdminRuntimeSettings.revision += 1;
        AdminRuntimeSettings.updatedAt = Date.now();
        return AdminRuntimeSettings.snapshot;
    }

    static reset(): AdminRuntimeSettingsSnapshot {
        AdminRuntimeSettings.values = { ...DEFAULTS };
        AdminRuntimeSettings.revision += 1;
        AdminRuntimeSettings.updatedAt = Date.now();
        return AdminRuntimeSettings.snapshot;
    }

    static scaleDamage(damage: number): number {
        return Math.max(0, Math.round(Number(damage || 0) * AdminRuntimeSettings.values.damageMultiplier));
    }

    static scaleGearChance(chance: number): number {
        return Math.max(0, Math.min(1, Number(chance || 0) * AdminRuntimeSettings.values.gearDropMultiplier));
    }

    static scaleMaterialChance(chance: number): number {
        return Math.max(0, Math.min(1, Number(chance || 0) * AdminRuntimeSettings.values.materialDropMultiplier));
    }

    static scaleGold(amount: number): number {
        return Math.max(0, Math.round(Number(amount || 0) * AdminRuntimeSettings.values.goldMultiplier));
    }

    static scaleXp(amount: number): number {
        return Math.max(0, Math.round(Number(amount || 0) * AdminRuntimeSettings.values.xpMultiplier));
    }
}
