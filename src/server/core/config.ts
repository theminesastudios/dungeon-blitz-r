import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function resolveServerDataDir(): string {
    const candidates = [
        path.resolve(process.cwd(), 'src/server'),
        path.resolve(__dirname, '../..'),
        path.resolve(__dirname, '..'),
        process.cwd()
    ];

    for (const candidate of candidates) {
        if (fs.existsSync(path.join(candidate, 'data', 'level_config.json'))) {
            return candidate;
        }
    }

    return path.resolve(process.cwd(), 'src/server');
}

function parseBooleanEnv(name: string, fallback: boolean): boolean {
    const raw = process.env[name];
    if (raw == null) {
        return fallback;
    }

    switch (raw.trim().toLowerCase()) {
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

function parseNumberEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw == null) {
        return fallback;
    }

    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function parseStringEnv(name: string, fallback: string): string {
    const raw = process.env[name];
    if (raw == null) {
        return fallback;
    }

    const trimmed = raw.trim();
    return trimmed || fallback;
}

function parseHexEnv(name: string): string | null {
    const raw = process.env[name];
    if (raw == null) {
        return null;
    }

    const normalized = raw.trim().toLowerCase();
    return /^[0-9a-f]{32,128}$/.test(normalized) && normalized.length % 2 === 0
        ? normalized
        : null;
}

function resolveRuntimeKeyHex(): string {
    return parseHexEnv('DUNGEONBLITZ_KEY_HEX') ?? crypto.randomBytes(16).toString('hex');
}

export function normalizeHostValue(raw: string | undefined, fallback: string): string {
    const trimmed = String(raw ?? '').trim();
    if (!trimmed) {
        return fallback;
    }

    const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
    try {
        const parsed = new URL(withProtocol);
        if (parsed.hostname) {
            return parsed.hostname;
        }
    } catch {
        // Fall back to conservative string cleanup below.
    }

    return (
        trimmed
            .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
            .replace(/\/.*$/, '')
            .replace(/:\d+$/, '')
            .trim() || fallback
    );
}

function isPrivateIpv4Address(address: string): boolean {
    return (
        /^10\./.test(address) ||
        /^192\.168\./.test(address) ||
        /^172\.(1[6-9]|2\d|3[0-1])\./.test(address)
    );
}

function scoreInterfaceName(name: string): number {
    const normalized = name.trim().toLowerCase();

    if (normalized.includes('zerotier')) {
        return 400;
    }

    if (
        normalized.includes('tailscale') ||
        normalized.includes('hamachi') ||
        normalized.includes('radmin') ||
        normalized.includes('wireguard')
    ) {
        return 350;
    }

    if (
        normalized.includes('vpn') ||
        normalized.includes('tun') ||
        normalized.includes('tap') ||
        normalized.includes('virtual')
    ) {
        return 250;
    }

    if (
        normalized.includes('ethernet') ||
        normalized.includes('wi-fi') ||
        normalized.includes('wifi') ||
        normalized.includes('wlan')
    ) {
        return 100;
    }

    return 0;
}

function resolveDefaultMultiplayerHost(): string {
    const candidates: Array<{ name: string; address: string; score: number }> = [];

    for (const [name, entries] of Object.entries(os.networkInterfaces())) {
        for (const entry of entries ?? []) {
            if (entry.family !== 'IPv4' || entry.internal) {
                continue;
            }

            const privateScore = isPrivateIpv4Address(entry.address) ? 50 : 0;
            candidates.push({
                name,
                address: entry.address,
                score: scoreInterfaceName(name) + privateScore
            });
        }
    }

    candidates.sort((left, right) => right.score - left.score || left.address.localeCompare(right.address));
    return candidates[0]?.address ?? 'localhost';
}

const MULTIPLAYER_MODE = parseBooleanEnv('MULTIPLAYER_MODE', false);
const LOCAL_HOST = 'localhost';
const MULTIPLAYER_HOST = normalizeHostValue(
    parseStringEnv('MULTIPLAYER_BASE_IP', resolveDefaultMultiplayerHost()),
    LOCAL_HOST
);
const DEFAULT_STATIC_PORT = MULTIPLAYER_MODE ? 80 : 8000;
const DEFAULT_GAME_PORT = 8080;
const DEFAULT_POLICY_PORT = 843;
const REWARD_ROLL_DEBUG = parseBooleanEnv('REWARD_ROLL_DEBUG', process.env.NODE_ENV === 'test');

export const Config = {
    MULTIPLAYER_MODE,
    LOCAL_HOST,
    MULTIPLAYER_HOST,
    HOST: MULTIPLAYER_MODE ? MULTIPLAYER_HOST : LOCAL_HOST,
    BIND_HOST: MULTIPLAYER_MODE ? '0.0.0.0' : '127.0.0.1',
    STATIC_PORT: parseNumberEnv('STATIC_PORT', DEFAULT_STATIC_PORT),
    PORTS: [parseNumberEnv('GAME_PORT', DEFAULT_GAME_PORT)],
    POLICY_PORT: parseNumberEnv('POLICY_PORT', DEFAULT_POLICY_PORT),
    ENABLE_POLICY_SERVER: parseBooleanEnv('ENABLE_POLICY_SERVER', MULTIPLAYER_MODE),
    REWARD_ROLL_DEBUG,
    SECRET: resolveRuntimeKeyHex(),
    DATA_DIR: resolveServerDataDir()
};