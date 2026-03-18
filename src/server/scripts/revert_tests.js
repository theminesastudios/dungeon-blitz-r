const fs = require('fs');
const path = require('path');

const files = [
    'client_spawn_level_regression.ts',
    'client_spawn_level_regression_hacked.ts',
    'combat_room_regression.ts'
];

for (const file of files) {
    const fullPath = path.join(__dirname, '..', 'test', file);
    if (!fs.existsSync(fullPath)) continue;
    
    let content = fs.readFileSync(fullPath, 'utf-8');
    
    content = content.replace(/\[0x07, 0x0D, 0x0F\]/g, '[0x0D, 0x0F]');
    content = content.replace(/\[7, 13, 15\]/g, '[13, 15]');
    
    fs.writeFileSync(fullPath, content, 'utf-8');
    console.log("Patched " + file);
}
