const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'handlers', 'CharacterHandler.ts');

let content = fs.readFileSync(file, 'utf-8');

const targetLF = `        const isHard = currentLevelName.endsWith("Hard");

        const pkt = WorldEnter.buildEnterWorldPacket(
            syncAnchorToken || token, // Ensure Flash client uses the Host's token for Room Event Generation Offset
            0, "", false, 0, 0,`;
            
const targetCRLF = targetLF.replace(/\n/g, '\r\n');

const newLF = `        const isHard = currentLevelName.endsWith("Hard");

        const pendingEntry = GlobalState.pendingWorld.get(token);
        const resolvedTransferToken = pendingEntry?.syncAnchorToken || token;

        const pkt = WorldEnter.buildEnterWorldPacket(
            resolvedTransferToken, // Ensure Flash client uses the Host's token for Room Event Generation Offset
            0, "", false, 0, 0,`;
            
const newCRLF = newLF.replace(/\n/g, '\r\n');

if (content.includes(targetCRLF)) {
    content = content.replace(targetCRLF, newCRLF);
    fs.writeFileSync(file, content, 'utf-8');
    console.log("SUCCESS: Patched with resolvedTransferToken (CRLF)");
} else if (content.includes(targetLF)) {
    content = content.replace(targetLF, newLF);
    fs.writeFileSync(file, content, 'utf-8');
    console.log("SUCCESS: Patched with resolvedTransferToken (LF)");
} else {
    console.log("FAILED to patch CharacterHandler.ts");
}
