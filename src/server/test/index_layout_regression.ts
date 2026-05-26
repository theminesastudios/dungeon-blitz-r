import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';

function resolveIndexPath(): string {
    const candidates = [
        path.resolve(__dirname, '../../client/content/localhost/index.html'),
        path.resolve(__dirname, '../../../client/content/localhost/index.html'),
        path.resolve(process.cwd(), 'src/client/content/localhost/index.html'),
        path.resolve(process.cwd(), '../client/content/localhost/index.html')
    ];

    const found = candidates.find((candidate) => fs.existsSync(candidate));
    assert.ok(found, 'localhost index.html should exist');
    return found;
}

function main(): void {
    const indexHtml = fs.readFileSync(resolveIndexPath(), 'utf8');

    assert.equal(indexHtml.includes('id="game-shell"'), false, 'Flash host should not wrap the game in a scaled shell');
    assert.equal(indexHtml.includes('transform: scale('), false, 'Flash host should not browser-scale the SWF');
    assert.equal(indexHtml.includes('layout=fit-center-buffer'), false, 'Flash host should not request the fit-center-buffer layout');
    assert.equal(indexHtml.includes('#DungeonBlitz'), true, 'Flash host should pin the embedded SWF object by id');
    assert.equal(indexHtml.includes('position: fixed'), true, 'Flash host should pin the embedded SWF to the viewport');
    assert.equal(indexHtml.includes('width: 100dvw !important'), true, 'Flash host should fill the dynamic viewport width');
    assert.equal(indexHtml.includes('height: 100dvh !important'), true, 'Flash host should fill the dynamic viewport height');
    assert.equal(
        indexHtml.includes('p/cbp/DungeonBlitz.swf?fv=cbw&gv=cbv'),
        true,
        'Flash host should still request the current DungeonBlitz.swf version'
    );

    console.log('index_layout_regression: ok');
}

main();
