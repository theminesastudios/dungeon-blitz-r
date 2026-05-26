import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { GlobalState } from '../core/GlobalState';
import { StaticServer } from '../core/StaticServer';

function getSwfBody(buffer: Buffer): Buffer {
    const signature = buffer.subarray(0, 3).toString('ascii');
    return signature === 'CWS' ? zlib.inflateSync(buffer.subarray(8)) : buffer.subarray(8);
}

function testStaticServerServesSingleSwfByDefault(): void {
    const server = new StaticServer();
    const selectedSwfPath = (server as any).getSelectedSwfPath() as string;
    const selectedSwfUrl = (server as any).getSelectedSwfUrl() as string;

    assert.equal(path.basename(selectedSwfPath), 'DungeonBlitz.swf');
    assert.equal(selectedSwfUrl, '/p/cbp/DungeonBlitz.swf?fv=cbw&gv=cbv');
    assert.equal(fs.existsSync(selectedSwfPath), true);
}

function testStaticServerSelectsLocalizedGameSwz(): void {
    const server = new StaticServer();
    const englishPath = (server as any).getGameSwzPathForLocale('en') as string;
    const turkishPath = (server as any).getGameSwzPathForLocale('tr') as string;

    assert.equal(path.basename(englishPath), 'Game.en.swz');
    assert.equal(path.basename(turkishPath), 'Game.tr.swz');
    assert.equal(fs.existsSync(englishPath), true);
    assert.equal(fs.existsSync(turkishPath), true);
}

function testStaticServerAliasesCurrentFlashVersionManifest(): void {
    const server = new StaticServer();
    const manifestPath = (server as any).getFlashVersionAssetPath('/masterFileList.xml') as string;

    assert.equal(path.basename(path.dirname(manifestPath)), 'cbq');
    assert.equal(path.basename(manifestPath), 'masterFileList.xml');
    assert.equal(fs.existsSync(manifestPath), true);
}

function testBrowserEmbedFillsViewportWithoutCropping(): void {
    const server = new StaticServer();
    const contentDir = (server as any).contentDir as string;
    const indexHtml = fs.readFileSync(path.join(contentDir, 'index.html'), 'utf8');
    const embedRule = indexHtml.match(/#game-container,\s*\r?\n\s*#DungeonBlitz,\s*\r?\n\s*object#DungeonBlitz,\s*\r?\n\s*embed#DungeonBlitz\s*\{([\s\S]*?)\n    \}/);

    assert.ok(embedRule, 'DungeonBlitz embed CSS rule not found');
    assert.equal(indexHtml.includes('id="game-shell"'), false, 'Flash host must not use the removed game-shell wrapper');
    assert.equal(
        /transform\s*:\s*scale/.test(embedRule[1]),
        false,
        'DungeonBlitz embed must not browser-scale the SWF beyond the viewport'
    );
    assert.equal(
        /--game-fill/.test(embedRule[1]),
        false,
        'DungeonBlitz embed must not use a crop/fill multiplier'
    );
    assert.equal(
        /position:\s*fixed/.test(embedRule[1]) && /inset:\s*0/.test(embedRule[1]),
        true,
        'DungeonBlitz embed must be pinned to the viewport'
    );
    assert.equal(
        /width:\s*100dvw\s*!important/.test(embedRule[1]),
        true,
        'DungeonBlitz embed must fill the dynamic viewport width'
    );
    assert.equal(
        /height:\s*100dvh\s*!important/.test(embedRule[1]),
        true,
        'DungeonBlitz embed must fill the dynamic viewport height'
    );
    assert.equal(
        /aspect-ratio/.test(embedRule[1]),
        false,
        'DungeonBlitz embed must not force a 3:2 letterboxed viewport'
    );
}

function testStaticServerResolvesGameSwzLocaleFromRequest(): void {
    const server = new StaticServer();
    const queryRequest = {
        query: { lang: 'tr' },
        headers: {},
        socket: { remoteAddress: '127.0.0.1' }
    };
    const sessionRequest = {
        query: {},
        headers: {},
        socket: { remoteAddress: '127.0.0.1' }
    };
    const defaultRequest = {
        query: {},
        headers: {},
        socket: { remoteAddress: '127.0.0.1' }
    };

    assert.equal((server as any).resolveGameSwzLocale(queryRequest), 'tr');
    assert.equal((server as any).resolveSwfLocale(queryRequest), 'tr');
    assert.equal((server as any).resolveGameSwzLocale(defaultRequest), 'en');
    assert.equal((server as any).resolveSwfLocale(defaultRequest), 'en');

    GlobalState.sessionsByToken.set(1, {
        socket: { remoteAddress: '127.0.0.1' },
        playerSpawned: true,
        character: { dialogueLanguage: 'tr' }
    } as never);
    try {
        assert.equal((server as any).resolveGameSwzLocale(sessionRequest), 'tr');
        assert.equal((server as any).resolveSwfLocale(sessionRequest), 'tr');
    } finally {
        GlobalState.sessionsByToken.delete(1);
    }
}

function testStaticServerBuildsLocalizedSwfTextByLocale(): void {
    const server = new StaticServer();
    const englishBody = getSwfBody((server as any).getSelectedSwfBuffer('en') as Buffer);
    const turkishBody = getSwfBody((server as any).getSelectedSwfBuffer('tr') as Buffer);
    const englishDiscipline = Buffer.from('Blessed by the Storm Gods, you draw enemy wrath', 'utf8');
    const turkishDiscipline = Buffer.from('Firtina Tanrilari tarafindan kutsanmis olarak', 'utf8');

    assert.equal(englishBody.includes(englishDiscipline), true);
    assert.equal(englishBody.includes(turkishDiscipline), false);
    assert.equal(turkishBody.includes(englishDiscipline), false);
    assert.equal(turkishBody.includes(turkishDiscipline), true);
}

function main(): void {
    testStaticServerServesSingleSwfByDefault();
    testStaticServerSelectsLocalizedGameSwz();
    testStaticServerAliasesCurrentFlashVersionManifest();
    testBrowserEmbedFillsViewportWithoutCropping();
    testStaticServerResolvesGameSwzLocaleFromRequest();
    testStaticServerBuildsLocalizedSwfTextByLocale();
    console.log('static_server_default_swf_regression: ok');
}

main();
