import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Config } from '../core/config';

/**
 * Where the authored client XML lives, wherever this install happens to keep it.
 *
 * The server reads a few things straight out of the game's own data rather than
 * re-authoring them: gear gold-find, power cast timings. Callers name the files they need
 * so a directory holding only half the set is not mistaken for the right one.
 */
export function resolveClientXmlDir(requiredFiles: string[]): string | null {
    const envDir = process.env.DB_XML_DATA_DIR;
    const candidates = [
        envDir,
        path.resolve(Config.DATA_DIR, '../client/content/xml'),
        path.join(Config.DATA_DIR, 'xml'),
        path.join(process.cwd(), 'src/client/content/xml'),
        path.join(process.cwd(), 'xml'),
        path.join(os.homedir(), 'Desktop', 'xml')
    ].filter((value): value is string => Boolean(value));

    for (const candidate of candidates) {
        if (requiredFiles.every((file) => fs.existsSync(path.join(candidate, file)))) {
            return candidate;
        }
    }

    return null;
}
