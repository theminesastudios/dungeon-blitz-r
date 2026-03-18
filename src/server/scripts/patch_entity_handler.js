const fs = require('fs');
const filePath = require('path').join(__dirname, '..', 'handlers', 'EntityHandler.ts');
let content = fs.readFileSync(filePath, 'utf-8');

const target = [
    '        client.knownEntityIds.delete(duplicateId);',
    '        EntityHandler.sendDestroyEntity(client, duplicateId);',
    '        // If the canonical was already sent to the joiner (e.g. via',
    '        // sendExistingVisibleClientSpawnEntitiesToJoiner), just mark it known.',
    '        // Re-sending would cause the Flash client to show double entities.',
    '        if (client.knownEntityIds.has(canonicalId)) {',
    '            return true;',
    '        }',
    '        EntityHandler.ensureEntityKnown(client, levelName, canonicalId);',
    '        return true;'
].join('\r\n');

const replacement = [
    '        client.knownEntityIds.delete(duplicateId);',
    '',
    '        // Flash client bug: instantly destroying a local entity that is still being naturally spawned',
    '        // leaves an orphaned visual "ghost" on the screen because the avatar hasn\'t hooked into',
    '        // the entity system yet. Delaying the destroy by 500ms fixes this.',
    '        setTimeout(() => {',
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
].join('\r\n');

if (content.includes(target)) {
    content = content.replace(target, replacement);
    fs.writeFileSync(filePath, content, 'utf-8');
    console.log('OK: patch applied');
} else {
    console.log('ERROR: target not found');
}
