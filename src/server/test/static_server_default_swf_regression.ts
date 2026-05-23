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
    assert.equal(selectedSwfUrl, '/p/cbp/DungeonBlitz.swf?fv=cbw&gv=cbw');
    assert.equal(fs.existsSync(selectedSwfPath), true);
}

function testStaticServerCanonicalizesDirectSwfVersionParams(): void {
    const server = new StaticServer();
    const staleRequest = {
        query: { fv: 'cbw', gv: 'cbv', lang: 'tr' },
        headers: {},
        socket: { remoteAddress: '127.0.0.1' }
    };
    const canonicalRequest = {
        query: { fv: 'cbw', gv: 'cbw' },
        headers: {},
        socket: { remoteAddress: '127.0.0.1' }
    };

    assert.equal((server as any).isCanonicalSelectedSwfRequest(staleRequest), false);
    assert.equal((server as any).isCanonicalSelectedSwfRequest(canonicalRequest), true);
    assert.equal(
        (server as any).getCanonicalSelectedSwfUrl(staleRequest),
        '/p/cbp/DungeonBlitz.swf?fv=cbw&gv=cbw&lang=tr'
    );
}

function testStaticServerRootUsesSelectedSwfUrl(): void {
    const server = new StaticServer();
    const request = {
        query: { lang: 'tr' },
        headers: {},
        socket: { remoteAddress: '127.0.0.1' }
    };

    assert.equal(
        (server as any).getCanonicalSelectedSwfUrl(request),
        '/p/cbp/DungeonBlitz.swf?fv=cbw&gv=cbw&lang=tr',
        'Static root should resolve to the same canonical SWF URL used by direct Flash playback'
    );
}

function testStaticServerSelectsLocalizedGameSwz(): void {
    const server = new StaticServer();
    const englishPath = (server as any).getGameSwzPathForLocale('en') as string;
    const turkishPath = (server as any).getGameSwzPathForLocale('tr') as string;
    const portuguesePath = (server as any).getGameSwzPathForLocale('pt-br') as string;

    assert.equal(path.basename(englishPath), 'Game.en.swz');
    assert.equal(path.basename(turkishPath), 'Game.tr.swz');
    assert.equal(path.basename(portuguesePath), 'Game.swz');
    assert.equal(fs.existsSync(englishPath), true);
    assert.equal(fs.existsSync(turkishPath), true);
    assert.equal(fs.existsSync(portuguesePath), true);
}

function testStaticServerAliasesCurrentFlashVersionManifest(): void {
    const server = new StaticServer();
    const manifestPath = (server as any).getFlashVersionAssetPath('/masterFileList.xml') as string;

    assert.equal(path.basename(path.dirname(manifestPath)), 'cbq');
    assert.equal(path.basename(manifestPath), 'masterFileList.xml');
    assert.equal(fs.existsSync(manifestPath), true);
}

function testBrowserEmbedKeepsGameAspectRatioWithoutOverflow(): void {
    const server = new StaticServer();
    const contentDir = (server as any).contentDir as string;
    const indexHtml = fs.readFileSync(path.join(contentDir, 'index.html'), 'utf8');
    const rootRule = indexHtml.match(/html,\s*body\s*\{([\s\S]*?)\n    \}/);
    const shellRule = indexHtml.match(/#game-shell\s*\{([\s\S]*?)\n    \}/);
    const stageBorderRule = indexHtml.match(/#game-stage\s*\{([\s\S]*?)\n    \}/);
    const stageRule = indexHtml.match(/#game-stage,\s*\r?\n\s*#game-container,\s*\r?\n\s*#DungeonBlitz,\s*\r?\n\s*object#DungeonBlitz,\s*\r?\n\s*embed#DungeonBlitz,\s*\r?\n\s*canvas#DungeonBlitz\s*\{([\s\S]*?)\n    \}/);
    const innerSurfaceRule = indexHtml.match(/#game-stage > \*,\s*\r?\n\s*#game-stage object,\s*\r?\n\s*#game-stage embed,\s*\r?\n\s*#game-stage canvas,\s*\r?\n\s*#game-stage > \* > object,\s*\r?\n\s*#game-stage > \* > embed,\s*\r?\n\s*#game-stage > \* > canvas,\s*\r?\n\s*#DungeonBlitz,\s*\r?\n\s*object#DungeonBlitz,\s*\r?\n\s*embed#DungeonBlitz,\s*\r?\n\s*canvas#DungeonBlitz\s*\{([\s\S]*?)\n    \}/);

    assert.ok(rootRule, 'DungeonBlitz root page CSS rule not found');
    assert.ok(shellRule, 'DungeonBlitz shell CSS rule not found');
    assert.ok(stageBorderRule, 'DungeonBlitz stage border CSS rule not found');
    assert.ok(stageRule, 'DungeonBlitz stage CSS rule not found');
    assert.ok(innerSurfaceRule, 'DungeonBlitz inner surface CSS rule not found');
    assert.equal(indexHtml.includes('id="game-shell"'), true, 'Flash host must keep a stable shell around the game');
    assert.equal(indexHtml.includes('id="game-stage"'), true, 'Flash host must keep a stable stage around the game surface');
    assert.equal(
        /box-sizing:\s*border-box/.test(indexHtml),
        true,
        'DungeonBlitz host must include borders in viewport sizing to avoid overflow'
    );
    assert.equal(
        /background:\s*#484955/.test(rootRule[1]) && /background:\s*#484955/.test(shellRule[1]),
        true,
        'DungeonBlitz host must use the configured site background behind the centered game'
    );
    assert.equal(
        /padding:\s*0\s+0\s+70px/.test(rootRule[1]),
        true,
        'DungeonBlitz root page must reserve bottom browser chrome space at body level'
    );
    assert.equal(
        /transform\s*:\s*scale/.test(stageRule[1]) || /transform\s*:\s*scale/.test(innerSurfaceRule[1]),
        false,
        'DungeonBlitz embed must not browser-scale the SWF beyond the viewport'
    );
    assert.equal(
        /--game-fill/.test(stageRule[1]) || /--game-fill/.test(innerSurfaceRule[1]),
        false,
        'DungeonBlitz embed must not use a crop/fill multiplier'
    );
    assert.equal(
        /position:\s*fixed/.test(shellRule[1]) &&
        /top:\s*40px/.test(shellRule[1]) &&
        /right:\s*0/.test(shellRule[1]) &&
        /bottom:\s*70px/.test(shellRule[1]) &&
        /left:\s*0/.test(shellRule[1]),
        true,
        'DungeonBlitz shell must be pinned inside the browser chrome offsets'
    );
    assert.equal(
        /display:\s*flex/.test(shellRule[1]) &&
        /align-items:\s*center/.test(shellRule[1]) &&
        /justify-content:\s*center/.test(shellRule[1]) &&
        /text-align:\s*center/.test(shellRule[1]),
        true,
        'DungeonBlitz shell must center the native-ratio game surface'
    );
    assert.equal(
        /width:\s*min\(100dvw,\s*150dvh\)\s*!important/.test(stageRule[1]),
        true,
        'DungeonBlitz embed must fit the dynamic viewport width without exceeding the 3:2 game ratio'
    );
    assert.equal(
        /height:\s*min\(100dvh,\s*66\.6667dvw\)\s*!important/.test(stageRule[1]),
        true,
        'DungeonBlitz embed must fit the dynamic viewport height without exceeding the 3:2 game ratio'
    );
    assert.equal(
        /aspect-ratio:\s*3\s*\/\s*2/.test(stageRule[1]) &&
        /flex:\s*0\s+0\s+auto/.test(stageRule[1]) &&
        /overflow:\s*hidden/.test(stageRule[1]),
        true,
        'DungeonBlitz stage must preserve the 3:2 viewport and clip overflow'
    );
    assert.equal(
        /border-right:\s*1px\s+solid\s+#484955/.test(stageBorderRule[1]),
        true,
        'DungeonBlitz stage must mirror the left visual border on the right inside the constrained viewport'
    );
    assert.equal(
        /width:\s*100%\s*!important/.test(innerSurfaceRule[1]) &&
        /height:\s*100%\s*!important/.test(innerSurfaceRule[1]) &&
        /max-width:\s*100%\s*!important/.test(innerSurfaceRule[1]) &&
        /max-height:\s*100%\s*!important/.test(innerSurfaceRule[1]),
        true,
        'DungeonBlitz inner canvas surfaces must fill only the constrained game viewport'
    );
    assert.equal(
        /function syncGameStageSize\(\)/.test(indexHtml) &&
        /getBoundingClientRect\(\)/.test(indexHtml) &&
        /new MutationObserver\(requestGameStageSizeSync\)/.test(indexHtml) &&
        /attributes:\s*true/.test(indexHtml) &&
        /new ResizeObserver\(requestGameStageSizeSync\)/.test(indexHtml) &&
        /function refreshGameSurfaceResizeTargets\(\)/.test(indexHtml) &&
        /"#game-stage canvas"/.test(indexHtml) &&
        /"#game-stage object"/.test(indexHtml) &&
        /"#game-stage embed"/.test(indexHtml) &&
        /fullscreenchange/.test(indexHtml) &&
        /setInterval\(requestGameStageSizeSync,\s*1000\)/.test(indexHtml) &&
        /stage\.replaceChildren\(detachedSurface\)/.test(indexHtml),
        true,
        'DungeonBlitz host must actively reclaim and resync FlashBrowser surfaces after room, fullscreen, and shell-size changes'
    );
    assert.equal(
        /swfobject\.embedSWF\([\s\S]*"1152",\s*\r?\n\s*"768"/.test(indexHtml),
        true,
        'DungeonBlitz SWF must be created at the native game canvas size'
    );
    assert.equal(
        /swfobject\.embedSWF\([\s\S]*align:\s*"center"/.test(indexHtml) &&
        /setAttribute\("align",\s*"center"\)/.test(indexHtml),
        true,
        'DungeonBlitz SWF and replaced surfaces must request centered alignment'
    );
}

function testStaticServerResolvesGameSwzLocaleFromRequest(): void {
    const server = new StaticServer();
    const queryRequest = {
        query: { lang: 'tr' },
        headers: {},
        socket: { remoteAddress: '127.0.0.1' }
    };
    const portugueseQueryRequest = {
        query: { lang: 'ptBR' },
        headers: {},
        socket: { remoteAddress: '127.0.0.1' }
    };
    const sessionRequest = {
        query: {},
        headers: {},
        socket: { remoteAddress: '127.0.0.1' }
    };
    const staleCookieSessionRequest = {
        query: {},
        headers: { cookie: 'db_lang=tr' },
        socket: { remoteAddress: '127.0.0.1' }
    };
    const defaultRequest = {
        query: {},
        headers: {},
        socket: { remoteAddress: '127.0.0.1' }
    };

    assert.equal((server as any).resolveGameSwzLocale(queryRequest), 'tr');
    assert.equal((server as any).resolveSwfLocale(queryRequest), 'tr');
    assert.equal((server as any).resolveGameSwzLocale(portugueseQueryRequest), 'pt-br');
    assert.equal((server as any).resolveSwfLocale(portugueseQueryRequest), 'pt-br');
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

    GlobalState.sessionsByToken.set(2, {
        socket: { remoteAddress: '127.0.0.1' },
        playerSpawned: false,
        dialogueLanguage: 'pt-br'
    } as never);
    try {
        assert.equal((server as any).resolveGameSwzLocale(sessionRequest), 'pt-br');
        assert.equal((server as any).resolveSwfLocale(sessionRequest), 'pt-br');
        assert.equal((server as any).resolveGameSwzLocale(staleCookieSessionRequest), 'pt-br');
        assert.equal((server as any).resolveSwfLocale(staleCookieSessionRequest), 'pt-br');
    } finally {
        GlobalState.sessionsByToken.delete(2);
    }
}

function testStaticServerRemembersQueryLocaleInCookie(): void {
    const server = new StaticServer();
    const cookies: Array<{ name: string; value: string; options: Record<string, unknown> }> = [];
    const req = {
        query: { lang: 'ptBR' }
    };
    const res = {
        cookie(name: string, value: string, options: Record<string, unknown>) {
            cookies.push({ name, value, options });
        }
    };

    (server as any).rememberQueryLocale(req, res);

    assert.equal(cookies.length, 1);
    assert.equal(cookies[0]?.name, 'db_lang');
    assert.equal(cookies[0]?.value, 'pt-br');
    assert.equal(cookies[0]?.options.path, '/');
}

function testStaticServerBuildsLocalizedSwfTextByLocale(): void {
    const server = new StaticServer();
    const englishBody = getSwfBody((server as any).getSelectedSwfBuffer('en') as Buffer);
    const turkishBody = getSwfBody((server as any).getSelectedSwfBuffer('tr') as Buffer);
    const portugueseBody = getSwfBody((server as any).getSelectedSwfBuffer('pt-br') as Buffer);
    const englishDiscipline = Buffer.from('Blessed by the Storm Gods, you draw enemy wrath', 'utf8');
    const turkishDiscipline = Buffer.from('Firtina Tanrilari tarafindan kutsanmis olarak', 'utf8');

    assert.equal(englishBody.includes(englishDiscipline), true);
    assert.equal(englishBody.includes(turkishDiscipline), false);
    assert.equal(turkishBody.includes(englishDiscipline), false);
    assert.equal(turkishBody.includes(turkishDiscipline), true);
    assert.equal(portugueseBody.includes(Buffer.from('DB_LOCALIZATION_RELOAD:', 'utf8')), true);
    assert.equal(
        portugueseBody.includes(Buffer.from('http://localhost:8000/p/cbp/DungeonBlitz.swf?fv=cbw&gv=cbv&lang=pt-br', 'utf8')),
        true
    );
    assert.equal(
        portugueseBody.includes(Buffer.from('http://localhost:8000/p/cbp/DungeonBlitz.swf?fv=cbq&gv=cbp&lang=pt-br', 'utf8')),
        false
    );
}

function main(): void {
    testStaticServerServesSingleSwfByDefault();
    testStaticServerCanonicalizesDirectSwfVersionParams();
    testStaticServerRootUsesSelectedSwfUrl();
    testStaticServerSelectsLocalizedGameSwz();
    testStaticServerAliasesCurrentFlashVersionManifest();
    testBrowserEmbedKeepsGameAspectRatioWithoutOverflow();
    testStaticServerResolvesGameSwzLocaleFromRequest();
    testStaticServerRemembersQueryLocaleInCookie();
    testStaticServerBuildsLocalizedSwfTextByLocale();
    console.log('static_server_default_swf_regression: ok');
}

main();
