const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'handlers', 'CharacterHandler.ts');

let content = fs.readFileSync(file, 'utf-8');

const targetCall = [
    '        const pkt = WorldEnter.buildEnterWorldPacket(',
    '            token,',
    '            oldLevelId,',
    '            oldSwf,'
];

const newCall = [
    '        const pkt = WorldWorldEnter = true;', // I need to pass syncAnchorToken. But WorldEnter.buildEnterWorldPacket is called.
    '        const pkt = WorldEnter.buildEnterWorldPacket(',
    '            syncAnchorToken || token,',
    '            oldLevelId,',
    '            oldSwf,'
];

function replace(content, targetLines, newLines) {
    const targetCRLF = targetLines.join('\r\n');
    const targetLF = targetLines.join('\n');
    // We already have WorldWorldEnter = true in newCall which was a typo, I'll just use string literal replace
    return null;
}

// I will just use string replace for safety
let modified = content.replace(
    'const pkt = WorldEnter.buildEnterWorldPacket(\r\n            token,\r\n            oldLevelId,',
    'const pkt = WorldEnter.buildEnterWorldPacket(\r\n            syncAnchorToken || token,\r\n            oldLevelId,'
);
if (modified === content) {
    modified = content.replace(
        'const pkt = WorldEnter.buildEnterWorldPacket(\n            token,\n            oldLevelId,',
        'const pkt = WorldEnter.buildEnterWorldPacket(\n            syncAnchorToken || token,\n            oldLevelId,'
    );
}

if (modified !== content) {
    fs.writeFileSync(file, modified, 'utf-8');
    console.log("SUCCESS: CharacterHandler.ts patched with syncAnchorToken!");
} else {
    console.log("FAILED to patch CharacterHandler.ts.");
}
