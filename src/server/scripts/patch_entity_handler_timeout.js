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
    '        // Flash client bug: instantly destroying a local entity that is still being natively spawned',
    '        // leaves an orphaned visual "ghost" on the screen because the avatar hasn\'t hooked into',
    '        // the entity dictionary yet. Delaying the destroy by 500ms fixes this.',
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
    console.log('OK: patch EntityHandler applied');
} else {
    // try fallback with \n instead of \r\n
    const targetLF = target.split('\r\n').join('\n');
    const replacementLF = replacement.split('\r\n').join('\n');
    if (content.includes(targetLF)) {
        content = content.replace(targetLF, replacementLF);
        fs.writeFileSync(filePath, content, 'utf-8');
        console.log('OK: patch EntityHandler applied (LF)');
    } else {
        console.log('ERROR: target not found in EntityHandler');
    }
}
