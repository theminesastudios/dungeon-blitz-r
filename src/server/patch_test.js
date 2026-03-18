const fs = require('fs');
const content = fs.readFileSync('test/client_spawn_level_regression.ts', 'utf-8');
const patchedContent = content.replace(/test[a-zA-Z0-9_]+\(\);/g, (match) => {
    return `try { console.log('Running ' + '${match}'); ${match} } catch(e) { console.error('FAILED: ' + '${match}'); console.error(e); process.exit(1); }`;
});
fs.writeFileSync('test/client_spawn_level_regression_hacked.ts', patchedContent, 'utf-8');
