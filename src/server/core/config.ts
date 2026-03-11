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

export const Config = {
    HOST: '127.0.0.1',
    PORTS: [8080],
    POLICY_PORT: 843,
    SECRET: "815bfb010cd7b1b4e6aa90abc7679028", // Matches Python Global
    DATA_DIR: resolveServerDataDir()
};
