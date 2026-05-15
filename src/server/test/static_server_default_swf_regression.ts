import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { StaticServer } from '../core/StaticServer';

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

function main(): void {
    testStaticServerServesSingleSwfByDefault();
    testStaticServerSelectsLocalizedGameSwz();
    testStaticServerResolvesGameSwzLocaleFromRequest();
    console.log('static_server_default_swf_regression: ok');
}

main();
