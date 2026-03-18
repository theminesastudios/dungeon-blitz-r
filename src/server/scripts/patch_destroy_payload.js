const fs = require('fs');
const filePath = require('path').join(__dirname, '..', 'handlers', 'EntityHandler.ts');
let content = fs.readFileSync(filePath, 'utf-8');

const target = [
    '    private static buildDestroyEntityPayload(entityId: number): Buffer {',
    '        const bb = new BitBuffer(false);',
    '        bb.writeMethod4(entityId);',
    '        bb.writeMethod15(false);',
    '        return bb.toBuffer();',
    '    }'
].join('\r\n');

const replacement = [
    '    private static buildDestroyEntityPayload(entityId: number): Buffer {',
    '        const bb = new BitBuffer(false);',
    '        bb.writeMethod4(entityId);',
    '        bb.writeMethod15(true);',
    '        return bb.toBuffer();',
    '    }'
].join('\r\n');

if (content.includes(target)) {
    content = content.replace(target, replacement);
    fs.writeFileSync(filePath, content, 'utf-8');
    console.log('OK: Destroy payload patched to true (CRLF)');
} else {
    // try LF
    const targetLF = target.split('\r\n').join('\n');
    const replacementLF = replacement.split('\r\n').join('\n');
    if (content.includes(targetLF)) {
        content = content.replace(targetLF, replacementLF);
        fs.writeFileSync(filePath, content, 'utf-8');
        console.log('OK: Destroy payload patched to true (LF)');
    } else {
        console.log('ERROR: target not found');
        console.log("File content at line 603:");
        console.log(content.split('\\n').slice(600, 615).join('\\n'));
    }
}
