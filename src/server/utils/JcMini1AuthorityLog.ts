import fs from 'fs';
import path from 'path';

const LOG_FILE_NAME = 'jc_mini1_server_authority.log';

function resolveRepoRoot(): string {
    const cwd = process.cwd();
    return cwd.endsWith(path.join('src', 'server'))
        ? path.resolve(cwd, '..', '..')
        : cwd;
}

export function logJcMini1Authority(event: string, details: Record<string, unknown> = {}): void {
    try {
        const logDir = path.join(resolveRepoRoot(), 'logs');
        fs.mkdirSync(logDir, { recursive: true });
        fs.appendFileSync(
            path.join(logDir, LOG_FILE_NAME),
            `${JSON.stringify({
                at: new Date().toISOString(),
                level: 'JC_Mini1Hard',
                event,
                ...details
            })}\n`
        );
    } catch {
        // Diagnostics must never interrupt gameplay packet handling.
    }
}
