import { strict as assert } from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { StaticServer } from '../core/StaticServer';

function verifyTutorialPartyProgressPatch(repoRoot: string, swfPaths: string[] = []): void {
    const args = ['src/server/scripts/patch-dungeonblitz-tutorial-party-progress.js', '--verify'];
    for (const swfPath of swfPaths) {
        args.push('--swf', swfPath);
    }

    execFileSync(process.execPath, args, {
        cwd: repoRoot,
        stdio: 'pipe'
    });
}

function testStaticServerServesLocalhostSwfByDefault(repoRoot: string): void {
    const server = new StaticServer();
    const selectedSwfPath = (server as any).getSelectedSwfPath() as string;
    const selectedSwfUrl = (server as any).getSelectedSwfUrl() as string;

    assert.equal(path.basename(selectedSwfPath), 'DungeonBlitz.localhost.swf');
    assert.equal(selectedSwfUrl, '/p/cbp/DungeonBlitz.swf?fv=cbq&gv=cbp');
    assert.equal(fs.existsSync(selectedSwfPath), true);
    verifyTutorialPartyProgressPatch(repoRoot, [selectedSwfPath]);
}

function testTutorialPartyProgressPatchVerifiesBothServedSwfs(repoRoot: string): void {
    const servedSwfPaths = [
        path.join(repoRoot, 'src', 'client', 'content', 'localhost', 'p', 'cbp', 'DungeonBlitz.localhost.swf'),
        path.join(repoRoot, 'src', 'client', 'content', 'localhost', 'p', 'cbp', 'DungeonBlitz.multiplayer.swf')
    ];

    for (const swfPath of servedSwfPaths) {
        assert.equal(fs.existsSync(swfPath), true, `served SWF should exist: ${path.basename(swfPath)}`);
    }

    verifyTutorialPartyProgressPatch(repoRoot);
}

function main(): void {
    const repoRoot = path.resolve(__dirname, '..', '..', '..');
    testStaticServerServesLocalhostSwfByDefault(repoRoot);
    testTutorialPartyProgressPatchVerifiesBothServedSwfs(repoRoot);
    console.log('static_server_default_swf_regression: ok');
}

main();
