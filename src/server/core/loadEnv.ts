import * as fs from 'fs';
import * as path from 'path';

let loaded = false;

function unquoteEnvValue(value: string): string {
    const trimmed = value.trim();
    if (trimmed.length >= 2) {
        const first = trimmed[0];
        const last = trimmed[trimmed.length - 1];
        if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
            return trimmed.slice(1, -1);
        }
    }

    return trimmed;
}

function resolveEnvPath(): string | null {
    const explicit = String(process.env.DOTENV_CONFIG_PATH ?? '').trim();
    if (explicit) {
        const explicitPath = path.resolve(process.cwd(), explicit);
        return fs.existsSync(explicitPath) ? explicitPath : null;
    }

    const candidates = [
        path.resolve(process.cwd(), '.env'),
        path.resolve(__dirname, '..', '.env'),
        path.resolve(process.cwd(), 'src/server/.env')
    ];

    return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

export function loadEnv(): void {
    if (loaded) {
        return;
    }
    loaded = true;

    const envPath = resolveEnvPath();
    if (!envPath) {
        return;
    }

    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) {
            continue;
        }

        const separator = trimmed.indexOf('=');
        if (separator <= 0) {
            continue;
        }

        const key = trimmed.slice(0, separator).trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || process.env[key] != null) {
            continue;
        }

        process.env[key] = unquoteEnvValue(trimmed.slice(separator + 1));
    }
}

loadEnv();
