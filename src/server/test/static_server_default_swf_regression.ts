import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { StaticServer } from '../core/StaticServer';

const BASE_SWF_PATH = path.resolve(__dirname, '../../client/content/localhost/p/cbp/DungeonBlitz.swf');
const INDEX_HTML_PATH = path.resolve(__dirname, '../../client/content/localhost/index.html');

function testStaticServerServesSingleSwfByDefault(): void {
    const server = new StaticServer();
    const selectedSwfPath = (server as any).getSelectedSwfPath() as string;
    const selectedSwfUrl = (server as any).getSelectedSwfUrl() as string;

    assert.equal(path.basename(selectedSwfPath), 'DungeonBlitz.swf');
    assert.equal(selectedSwfUrl, '/p/cbp/DungeonBlitz.swf?fv=cbq&gv=cbp');
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

function testStaticServerResolvesGameSwzLocaleFromRequest(): void {
    const server = new StaticServer();
    const queryRequest = {
        query: { lang: 'en' },
        headers: {},
        socket: { remoteAddress: '127.0.0.1' }
    };
    const cookieRequest = {
        query: {},
        headers: { cookie: 'db_lang=en' },
        socket: { remoteAddress: '127.0.0.1' }
    };
    const defaultRequest = {
        query: {},
        headers: {},
        socket: { remoteAddress: '127.0.0.1' }
    };

    assert.equal((server as any).resolveGameSwzLocale(queryRequest), 'en');
    assert.equal((server as any).resolveGameSwzLocale(cookieRequest), 'en');
    assert.equal((server as any).resolveGameSwzLocale(defaultRequest), 'tr');
}

function testStaticServerRefreshesSwfBufferWhenSourceMetadataChanges(): void {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'db-static-swf-cache-'));
    const swfDir = path.join(tempRoot, 'p', 'cbp');
    const swfPath = path.join(swfDir, 'DungeonBlitz.swf');

    fs.mkdirSync(swfDir, { recursive: true });
    fs.writeFileSync(path.join(tempRoot, 'index.html'), '<!doctype html>');
    fs.copyFileSync(BASE_SWF_PATH, swfPath);

    try {
        const server = new StaticServer(0, tempRoot);
        const firstBuffer = (server as any).getSelectedSwfBuffer() as Buffer;
        const firstCachedBuffer = (server as any).getSelectedSwfBuffer() as Buffer;
        assert.strictEqual(firstCachedBuffer, firstBuffer);

        const future = new Date(Date.now() + 60_000);
        fs.utimesSync(swfPath, future, future);

        const refreshedBuffer = (server as any).getSelectedSwfBuffer() as Buffer;
        assert.notStrictEqual(refreshedBuffer, firstBuffer);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
}

function testIndexUsesCurrentSwfCacheBuster(): void {
    const indexHtml = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
    assert.equal(indexHtml.includes('rv=20260517-class82-bitmapdata'), true);
    assert.equal(indexHtml.includes('rv=20260517-superanim-conditional'), false);
    assert.equal(indexHtml.includes('rv=20260516-superanim-bitmapdata'), false);
    assert.equal(indexHtml.includes('rv=20260515b'), false);
}

function main(): void {
    testStaticServerServesSingleSwfByDefault();
    testStaticServerSelectsLocalizedGameSwz();
    testStaticServerResolvesGameSwzLocaleFromRequest();
    testStaticServerRefreshesSwfBufferWhenSourceMetadataChanges();
    testIndexUsesCurrentSwfCacheBuster();
    console.log('static_server_default_swf_regression: ok');
}

main();
