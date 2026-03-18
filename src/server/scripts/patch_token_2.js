const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'handlers', 'CharacterHandler.ts');

let content = fs.readFileSync(file, 'utf-8');

const targetLF = `        const pkt = WorldEnter.buildEnterWorldPacket(
            token, // transferToken
            oldLevelId,`;
            
const targetCRLF = targetLF.replace(/\n/g, '\r\n');

const newLF = `        const pkt = WorldEnter.buildEnterWorldPacket(
            syncAnchorToken || token, // Ensure Flash client uses the Host's token for Room Event Generation Offset
            oldLevelId,`;
            
const newCRLF = newLF.replace(/\n/g, '\r\n');

if (content.includes(targetCRLF)) {
    content = content.replace(targetCRLF, newCRLF);
    fs.writeFileSync(file, content, 'utf-8');
    console.log("SUCCESS: Patched with syncAnchorToken (CRLF)");
} else if (content.includes(targetLF)) {
    content = content.replace(targetLF, newLF);
    fs.writeFileSync(file, content, 'utf-8');
    console.log("SUCCESS: Patched with syncAnchorToken (LF)");
} else {
    console.log("FAILED to patch CharacterHandler.ts");
    
    // Print around line 430
    const lines = content.split('\n');
    console.log(lines.slice(415, 425).join('\n'));
}
