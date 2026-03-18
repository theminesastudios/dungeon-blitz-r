const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'handlers', 'EntityHandler.ts');

let content = fs.readFileSync(file, 'utf-8');

const targetCall = 'client.sendBitBuffer(0x07, EntityHandler.buildEntityStateDeadPayload(duplicateId));';
const newCall = 'client.send(0x07, EntityHandler.buildEntityStateDeadPayload(duplicateId));';

if (content.includes(targetCall)) {
    content = content.replace(targetCall, newCall);
    fs.writeFileSync(file, content, 'utf-8');
    console.log("SUCCESS: Fixed sendBitBuffer to send in EntityHandler.ts");
} else {
    console.log("FAILED to find target call. Was it already fixed?");
}
