import * as fs from 'fs';
import * as path from 'path';

function resolveServerDataDir(): string {
    const candidates = [
        path.resolve(__dirname, '..'),
        path.resolve(__dirname, '../..'),
        path.resolve(process.cwd(), 'src/server'),
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

const MULTIPLAYER_MODE = parseBooleanEnv('MULTIPLAYER_MODE', false);
const LOCAL_HOST = 'localhost';
const MULTIPLAYER_HOST = '100.100.146.54';

export const Config = {
    MULTIPLAYER_MODE,
    LOCAL_HOST,
    MULTIPLAYER_HOST,
    HOST: MULTIPLAYER_MODE ? MULTIPLAYER_HOST : LOCAL_HOST,
    BIND_HOST: MULTIPLAYER_MODE ? '0.0.0.0' : '127.0.0.1',
    STATIC_PORT: 80,
    PORTS: [8080],
    POLICY_PORT: 843,
    SECRET: "815bfb010cd7b1b4e6aa90abc7679028", // Matches Python Global
    DATA_DIR: resolveServerDataDir()
};
