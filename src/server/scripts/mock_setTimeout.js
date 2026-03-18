const fs = require('fs');
const testFile = require('path').join(__dirname, '..', 'test', 'client_spawn_level_regression.ts');
let content = fs.readFileSync(testFile, 'utf-8');

// Replace synchronous tests with async ones, or just mock setTimeout.
// The easiest fix is to mock setTimeout at the top of the test file!

const mockCode = `
// MOCK SETTIMEOUT FOR SYNCHRONOUS TESTS
const originalSetTimeout = global.setTimeout;
global.setTimeout = ((fn: any, delay: number) => {
    // Execute immediately in tests
    fn();
    return 0 as any;
}) as any;
`;

if (!content.includes('MOCK SETTIMEOUT FOR SYNCHRONOUS TESTS')) {
    content = content.replace("function ensureLevelConfigLoaded(): void {", mockCode + "\r\nfunction ensureLevelConfigLoaded(): void {");
    fs.writeFileSync(testFile, content, 'utf-8');
    console.log('OK: test mocked');
} else {
    console.log('Test already mocked');
}
