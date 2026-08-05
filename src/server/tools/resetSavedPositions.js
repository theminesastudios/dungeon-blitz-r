#!/usr/bin/env node
'use strict';

/**
 * Clear saved open-world coordinates so the next login uses the level's authored spawn.
 *
 * A save written before the grounded-position fixes can hold a point the server's dead
 * reckoning had drifted away from. The client only snaps a spawn coordinate onto floor
 * within a 160px band (getFloorCollision(0, x, y - 59, Point(0, 160))), so a drifted point
 * is left in open air and the player glides down to the ground on entry. Those records are
 * replayed until something overwrites them, which is why the symptom survives the fix.
 *
 * There is no way to tell a drifted coordinate from a legitimate one -- levels have real
 * terrain thousands of pixels above and below their authored anchors, so any "plausible
 * range" check would throw away good positions. Clearing is the honest repair: a 0,0 record
 * is already treated as "no coordinate" by LevelConfig.getSpawnCoordinates, so the player
 * arrives on the level's own spawn marker and a correct position rebuilds from the first
 * grounded movement packet.
 *
 * Dry run by default. Pass --fix to write.
 *
 *   node src/server/tools/resetSavedPositions.js
 *   node src/server/tools/resetSavedPositions.js --fix
 *   node src/server/tools/resetSavedPositions.js --fix --character Telahair
 */

const fs = require('fs');
const path = require('path');

const SAVES_DIR = path.join(__dirname, '..', 'data', 'saves');

function parseArgs(argv) {
    const args = { fix: false, character: '' };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--fix') {
            args.fix = true;
        } else if (arg === '--character' || arg === '-c') {
            args.character = String(argv[index + 1] || '');
            index += 1;
        } else if (arg === '--help' || arg === '-h') {
            args.help = true;
        }
    }
    return args;
}

function collectCharacters(parsed) {
    if (Array.isArray(parsed)) {
        return parsed;
    }
    if (parsed && Array.isArray(parsed.characters)) {
        return parsed.characters;
    }
    return parsed && parsed.name ? [parsed] : [];
}

function clearRecord(record) {
    if (!record || typeof record !== 'object' || !record.name) {
        return false;
    }
    if (Number(record.x) === 0 && Number(record.y) === 0) {
        return false;
    }
    record.x = 0;
    record.y = 0;
    return true;
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        console.log('Usage: node src/server/tools/resetSavedPositions.js [--fix] [--character <name>]');
        return;
    }

    if (!fs.existsSync(SAVES_DIR)) {
        console.error(`No saves directory at ${SAVES_DIR}`);
        process.exitCode = 1;
        return;
    }

    const wanted = args.character.trim().toLowerCase();
    let changedFiles = 0;
    let changedCharacters = 0;

    for (const fileName of fs.readdirSync(SAVES_DIR)) {
        if (!fileName.endsWith('.json')) {
            continue;
        }

        const filePath = path.join(SAVES_DIR, fileName);
        let parsed;
        try {
            parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        } catch (error) {
            console.warn(`skipped ${fileName}: ${error.message}`);
            continue;
        }

        let fileChanged = false;
        for (const character of collectCharacters(parsed)) {
            if (!character || !character.name) {
                continue;
            }
            if (wanted && String(character.name).toLowerCase() !== wanted) {
                continue;
            }

            const before = {
                current: character.CurrentLevel ? { ...character.CurrentLevel } : null,
                previous: character.PreviousLevel ? { ...character.PreviousLevel } : null,
                lastRegion: character.LastRegionPosition ? { ...character.LastRegionPosition } : null
            };

            let touched = clearRecord(character.CurrentLevel);
            touched = clearRecord(character.PreviousLevel) || touched;
            if (character.LastRegionPosition) {
                delete character.LastRegionPosition;
                touched = true;
            }

            if (!touched) {
                continue;
            }

            changedCharacters += 1;
            fileChanged = true;
            console.log(
                `${fileName} ${character.name}: ` +
                `current=${JSON.stringify(before.current)} ` +
                `previous=${JSON.stringify(before.previous)} ` +
                `lastRegion=${JSON.stringify(before.lastRegion)} -> cleared`
            );
        }

        if (fileChanged && args.fix) {
            fs.copyFileSync(filePath, `${filePath}.bak-positions`);
            fs.writeFileSync(filePath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
            changedFiles += 1;
        }
    }

    console.log(
        args.fix
            ? `Cleared ${changedCharacters} character(s) across ${changedFiles} file(s). Backups written alongside as *.bak-positions.`
            : `Dry run: ${changedCharacters} character(s) would be cleared. Re-run with --fix to write.`
    );
}

main();
