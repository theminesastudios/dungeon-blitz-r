const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'handlers', 'EntityHandler.ts');

let content = fs.readFileSync(file, 'utf-8');

const targetMethod = [
    '    private static buildDestroyEntityPayload(entityId: number): Buffer {',
    '        const bb = new BitBuffer(false);',
    '        bb.writeMethod4(entityId);',
    '        bb.writeMethod15(true);',
    '        return bb.toBuffer();',
    '    }'
];

const newMethod = [
    '    private static buildEntityStateDeadPayload(entityId: number): Buffer {',
    '        const bb = new BitBuffer(false);',
    '        bb.writeMethod4(entityId);',
    '        bb.writeMethod45(0);',
    '        bb.writeMethod45(0);',
    '        bb.writeMethod45(0);',
    '        bb.writeMethod6(3, 2); // EntityState.DEAD = 3',
    '        bb.writeMethod15(false);',
    '        bb.writeMethod15(false);',
    '        bb.writeMethod15(false);',
    '        bb.writeMethod15(false);',
    '        bb.writeMethod15(false);',
    '        bb.writeMethod15(false);',
    '        return bb.toBuffer();',
    '    }',
    '',
    '    private static buildDestroyEntityPayload(entityId: number): Buffer {',
    '        const bb = new BitBuffer(false);',
    '        bb.writeMethod4(entityId);',
    '        bb.writeMethod15(true);',
    '        return bb.toBuffer();',
    '    }'
];

const targetCall = [
    '        setTimeout(() => {',
    '            EntityHandler.sendDestroyEntity(client, duplicateId);'
];

const newCall = [
    '        // Flash client ghost bug workaround: Spoof an EntityState.DEAD (0x07) update',
    '        // just before destroying it. This forces the Flash client to play the death',
    '        // animation and cleanly dispose of the visual DisplayObject.',
    '        setTimeout(() => {',
    '            client.sendBitBuffer(0x07, EntityHandler.buildEntityStateDeadPayload(duplicateId));',
    '            EntityHandler.sendDestroyEntity(client, duplicateId);'
];

function replace(content, targetLines, newLines) {
    const targetCRLF = targetLines.join('\r\n');
    const targetLF = targetLines.join('\n');
    const newCRLF = newLines.join('\r\n');
    const newLF = newLines.join('\n');
    if (content.includes(targetCRLF)) return content.replace(targetCRLF, newCRLF);
    if (content.includes(targetLF)) return content.replace(targetLF, newLF);
    
    // Check if the file already has the new content
    if (content.includes(newCRLF) || content.includes(newLF)) {
        return content;
    }

    console.log("Could not find target block:");
    console.log(targetLF);
    return null;
}

let changed = replace(content, targetMethod, newMethod);
if (changed) {
    let changed2 = replace(changed, targetCall, newCall);
    if (changed2) {
        fs.writeFileSync(file, changed2, 'utf-8');
        console.log("SUCCESS: EntityHandler.ts patched with EntityState.DEAD spoof!");
    } else {
        console.log("FAILED to patch the setTimeout call.");
    }
} else {
    console.log("FAILED to patch buildDestroyEntityPayload (fallback failed).");
}
