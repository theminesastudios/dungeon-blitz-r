const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'handlers', 'EntityHandler.ts');

let content = fs.readFileSync(file, 'utf-8');

const targetCall = [
    '        // Flash client bug: instantly destroying a local entity that is still being naturally spawned',
    '        // leaves an orphaned visual "ghost" on the screen because the avatar hasn\'t hooked into',
    '        // the entity system yet. Delaying the destroy by 500ms fixes this.',
    '        // Flash client ghost bug workaround: Spoof an EntityState.DEAD (0x07) update',
    '        // just before destroying it. This forces the Flash client to play the death',
    '        // animation and cleanly dispose of the visual DisplayObject.',
    '        setTimeout(() => {',
    '            client.send(0x07, EntityHandler.buildEntityStateDeadPayload(duplicateId));',
    '            EntityHandler.sendDestroyEntity(client, duplicateId);',
    '            // If the canonical was already sent to the joiner (e.g. via',
    '            // sendExistingVisibleClientSpawnEntitiesToJoiner), just mark it known.',
    '            // Re-sending would cause the Flash client to show double entities.',
    '            if (client.knownEntityIds.has(canonicalId)) {',
    '                return;',
    '            }',
    '            EntityHandler.ensureEntityKnown(client, levelName, canonicalId);',
    '        }, 500);',
    '',
    '        return true;'
];

const newCall = [
    '        EntityHandler.sendDestroyEntity(client, duplicateId);',
    '        ',
    '        if (client.knownEntityIds.has(canonicalId)) {',
    '            return true;',
    '        }',
    '        EntityHandler.ensureEntityKnown(client, levelName, canonicalId);',
    '        ',
    '        return true;'
];

function replace(content, targetLines, newLines) {
    const targetCRLF = targetLines.join('\r\n');
    const targetLF = targetLines.join('\n');
    const newCRLF = newLines.join('\r\n');
    const newLF = newLines.join('\n');
    if (content.includes(targetCRLF)) return content.replace(targetCRLF, newCRLF);
    if (content.includes(targetLF)) return content.replace(targetLF, newLF);
    return null;
}

let changed = replace(content, targetCall, newCall);
if (changed) {
    fs.writeFileSync(file, changed, 'utf-8');
    console.log("SUCCESS: Reverted setTimeout in EntityHandler.ts");
} else {
    console.log("FAILED to find setTimeout block.");
}
