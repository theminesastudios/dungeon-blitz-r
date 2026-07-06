import fs from 'fs';
import path from 'path';
import { getScopeLevelName } from '../core/LevelScope';

const LOG_FILE_NAME = 'jc_mini1_server_authority.log';

function resolveRepoRoot(): string {
    const cwd = process.cwd();
    return cwd.endsWith(path.join('src', 'server'))
        ? path.resolve(cwd, '..', '..')
        : cwd;
}

function resolveLevelLabel(details: Record<string, unknown>): string {
    // The log is shared by every server-authority hostile dungeon
    // (JC_Mini1Hard, JC_Mini2, JC_Mini2Hard, ...), so label entries by the
    // level carried in the event's scope key when one is present.
    const scope = String(details.scope ?? details.levelScope ?? '').trim();
    return getScopeLevelName(scope) || 'JC_Mini1Hard';
}

export function logJcMini1Authority(event: string, details: Record<string, unknown> = {}): void {
    try {
        const logDir = path.join(resolveRepoRoot(), 'logs');
        fs.mkdirSync(logDir, { recursive: true });
        fs.appendFileSync(
            path.join(logDir, LOG_FILE_NAME),
            `${JSON.stringify({
                at: new Date().toISOString(),
                level: resolveLevelLabel(details),
                event,
                ...details
            })}\n`
        );
    } catch {
        // Diagnostics must never interrupt gameplay packet handling.
    }
}
