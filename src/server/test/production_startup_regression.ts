import { strict as assert } from 'assert';
import fs from 'fs';
import path from 'path';

function main(): void {
    const repoRoot = path.resolve(__dirname, '..', '..', '..');
    const serverPackage = JSON.parse(fs.readFileSync(path.join(repoRoot, 'src/server/package.json'), 'utf8'));
    for (const script of ['multiplayer', 'start:multiplayer', 'start:multiplayer:game']) {
        assert.equal(serverPackage.scripts[script], 'node dist/main.js');
    }

    const entrypoint = fs.readFileSync(path.join(repoRoot, 'Container/entrypoint.sh'), 'utf8');
    assert.match(entrypoint, /exec node dist\/main\.js/);
    assert.doesNotMatch(entrypoint, /npm (install|ci|run build)|ts-node/);

    const launcher = fs.readFileSync(path.join(repoRoot, 'src/server/tools/startMultiplayerServer.js'), 'utf8');
    assert.match(launcher, /dist\/main\.js/);
    assert.doesNotMatch(launcher, /ts-node|cleanup-dev-instance/);

    const localAccountTool = fs.readFileSync(path.join(repoRoot, 'src/server/tools/generateLocalAccount.ts'), 'utf8');
    assert.match(localAccountTool, /from ['"]\.\.\/auth\/PasswordAuth['"]/);
    assert.doesNotMatch(localAccountTool, /\.\.\/src\/auth\/PasswordAuth/);
    console.log('production_startup_regression: ok');
}

main();
