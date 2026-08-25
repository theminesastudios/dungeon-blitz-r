#!/usr/bin/env node

/**
 * Migration: reset all character dialogueLanguage fields to 'en'.
 *
 * Scans every JSON save file under src/server/data/saves/ and fixes any
 * character whose dialogueLanguage is not already 'en'.  Dry-run by
 * default; pass --apply to write changes.
 *
 * Usage:
 *   npx ts-node scripts/migrate-dialogue-language.ts          # dry-run
 *   npx ts-node scripts/migrate-dialogue-language.ts --apply   # write
 */

import * as fs from 'fs';
import * as path from 'path';

const SAVES_DIR = path.resolve(__dirname, '..', 'data', 'saves');
const APPLY = process.argv.includes('--apply');

interface Character {
    name?: string;
    dialogueLanguage?: string;
    [key: string]: unknown;
}

interface SaveFile {
    user_id?: number;
    characters?: Character[];
    [key: string]: unknown;
}

function main() {
    const files = fs.readdirSync(SAVES_DIR)
        .filter((f) => f.endsWith('.json'))
        .map((f) => path.join(SAVES_DIR, f));
    let total = 0;
    let fixed = 0;

    for (const filePath of files.sort()) {
        const raw = fs.readFileSync(filePath, 'utf8');
        const data: SaveFile = JSON.parse(raw);
        const chars = data.characters;
        if (!Array.isArray(chars)) continue;

        let fileChanged = false;

        for (const char of chars) {
            total++;
            const current = String(char.dialogueLanguage ?? '').trim().toLowerCase();
            if (current && current !== 'en') {
                console.log(
                    `  ${path.basename(filePath)}: ${char.name ?? '(unnamed)'} `
                    + `dialogueLanguage ${JSON.stringify(char.dialogueLanguage)} -> "en"`,
                );
                char.dialogueLanguage = 'en';
                fixed++;
                fileChanged = true;
            }
        }

        if (fileChanged && APPLY) {
            fs.writeFileSync(filePath, JSON.stringify(data, null, 4) + '\n');
        }
    }

    console.log(`\nScanned ${files.length} files, ${total} characters, ${fixed} fixed.`);
    if (!APPLY && fixed > 0) {
        console.log('Dry run — pass --apply to write changes.');
    }
}

main();
