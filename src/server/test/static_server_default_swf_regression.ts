import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { GlobalState } from '../core/GlobalState';
import { StaticServer } from '../core/StaticServer';
import { SWF_RUNTIME_VERSION } from '../core/DungeonBlitzSwf';

function getSwfBody(buffer: Buffer): Buffer {
    const signature = buffer.subarray(0, 3).toString('ascii');
    return signature === 'CWS' ? zlib.inflateSync(buffer.subarray(8)) : buffer.subarray(8);
}

type BitCursor = {
    byte: number;
    bit: number;
};

function readUnsignedBits(data: Buffer, cursor: BitCursor, bitCount: number): number {
    let value = 0;
    for (let index = 0; index < bitCount; index += 1) {
        value = (value << 1) | ((data[cursor.byte] >> (7 - cursor.bit)) & 1);
        cursor.bit += 1;
        if (cursor.bit === 8) {
            cursor.bit = 0;
            cursor.byte += 1;
        }
    }
    return value;
}

function readSignedBits(data: Buffer, cursor: BitCursor, bitCount: number): number {
    let value = readUnsignedBits(data, cursor, bitCount);
    const signBit = 1 << (bitCount - 1);
    if ((value & signBit) !== 0) {
        value -= 1 << bitCount;
    }
    return value;
}

function alignBitCursor(cursor: BitCursor): void {
    if (cursor.bit !== 0) {
        cursor.bit = 0;
        cursor.byte += 1;
    }
}

function readSwfMatrix(data: Buffer, start: number): { tx: number; ty: number } {
    const cursor: BitCursor = { byte: start, bit: 0 };
    if (readUnsignedBits(data, cursor, 1) !== 0) {
        const scaleBits = readUnsignedBits(data, cursor, 5);
        readSignedBits(data, cursor, scaleBits);
        readSignedBits(data, cursor, scaleBits);
    }
    if (readUnsignedBits(data, cursor, 1) !== 0) {
        const rotateBits = readUnsignedBits(data, cursor, 5);
        readSignedBits(data, cursor, rotateBits);
        readSignedBits(data, cursor, rotateBits);
    }

    const translateBits = readUnsignedBits(data, cursor, 5);
    const tx = readSignedBits(data, cursor, translateBits);
    const ty = readSignedBits(data, cursor, translateBits);
    alignBitCursor(cursor);
    return { tx, ty };
}

function readSwfRect(data: Buffer, start: number): { xMax: number } {
    const cursor: BitCursor = { byte: start, bit: 0 };
    const bitCount = readUnsignedBits(data, cursor, 5);
    readSignedBits(data, cursor, bitCount);
    const xMax = readSignedBits(data, cursor, bitCount);
    readSignedBits(data, cursor, bitCount);
    readSignedBits(data, cursor, bitCount);
    return { xMax };
}

function collectDefineEditTextXMax(body: Buffer, targetIds: number[]): Map<number, number> {
    const result = new Map<number, number>();
    const idSet = new Set(targetIds);
    const nbits = body[0] >> 3;
    let pos = Math.floor((5 + nbits * 4 + 7) / 8) + 4;

    while (pos < body.length) {
        const tagCodeAndLen = body.readUInt16LE(pos);
        pos += 2;
        const tagType = tagCodeAndLen >> 6;
        let tagLen = tagCodeAndLen & 0x3f;
        if (tagLen === 0x3f) {
            tagLen = body.readUInt32LE(pos);
            pos += 4;
        }

        const dataStart = pos;
        const dataEnd = dataStart + tagLen;
        if (tagType === 37) {
            const characterId = body.readUInt16LE(dataStart);
            if (idSet.has(characterId)) {
                result.set(characterId, readSwfRect(body, dataStart + 2).xMax);
            }
        }

        pos = dataEnd;
        if (tagType === 0) {
            break;
        }
    }

    return result;
}

function assertTagStreamWellFormed(data: Buffer, start: number, end: number, label: string): void {
    let pos = start;
    while (pos < end) {
        assert.ok(pos + 2 <= end, `${label} has a truncated tag header at ${pos}`);
        const tagCodeAndLen = data.readUInt16LE(pos);
        pos += 2;
        const tagType = tagCodeAndLen >> 6;
        let tagLen = tagCodeAndLen & 0x3f;
        if (tagLen === 0x3f) {
            assert.ok(pos + 4 <= end, `${label} has a truncated long tag length at ${pos}`);
            tagLen = data.readUInt32LE(pos);
            pos += 4;
        }

        const dataStart = pos;
        const dataEnd = dataStart + tagLen;
        assert.ok(dataEnd <= end, `${label} tag ${tagType} overruns its parent at ${dataStart}`);
        if (tagType === 39) {
            assert.ok(tagLen >= 4, `${label} has a truncated DefineSprite tag at ${dataStart}`);
            assertTagStreamWellFormed(data, dataStart + 4, dataEnd, `${label}/sprite-${data.readUInt16LE(dataStart)}`);
        }

        pos = dataEnd;
        if (tagType === 0) {
            return;
        }
    }

    assert.equal(pos, end, `${label} tag stream should end on a tag boundary`);
}

function assertSwfTagsWellFormed(body: Buffer, label: string): void {
    const nbits = body[0] >> 3;
    const firstTagPos = Math.floor((5 + nbits * 4 + 7) / 8) + 4;
    assertTagStreamWellFormed(body, firstTagPos, body.length, label);
}

function collectSpriteCharacterPlacements(
    body: Buffer,
    targetSpriteId: number,
    characterIds: number[]
): Map<number, { tx: number; ty: number }> {
    const result = new Map<number, { tx: number; ty: number }>();
    const idSet = new Set(characterIds);
    const nbits = body[0] >> 3;
    let pos = Math.floor((5 + nbits * 4 + 7) / 8) + 4;

    while (pos < body.length) {
        const tagCodeAndLen = body.readUInt16LE(pos);
        pos += 2;
        const tagType = tagCodeAndLen >> 6;
        let tagLen = tagCodeAndLen & 0x3f;
        if (tagLen === 0x3f) {
            tagLen = body.readUInt32LE(pos);
            pos += 4;
        }

        const dataStart = pos;
        const dataEnd = dataStart + tagLen;
        if (tagType === 39 && body.readUInt16LE(dataStart) === targetSpriteId) {
            let spritePos = dataStart + 4;
            while (spritePos < dataEnd) {
                const spriteTagCodeAndLen = body.readUInt16LE(spritePos);
                spritePos += 2;
                const spriteTagType = spriteTagCodeAndLen >> 6;
                let spriteTagLen = spriteTagCodeAndLen & 0x3f;
                if (spriteTagLen === 0x3f) {
                    spriteTagLen = body.readUInt32LE(spritePos);
                    spritePos += 4;
                }

                const spriteDataStart = spritePos;
                const spriteDataEnd = spriteDataStart + spriteTagLen;
                if (spriteTagType === 26 || spriteTagType === 70) {
                    let cursor = spriteDataStart;
                    const flags = body[cursor];
                    cursor += spriteTagType === 70 ? 2 : 1;
                    cursor += 2;
                    const hasCharacter = (flags & 0x02) !== 0;
                    const hasMatrix = (flags & 0x04) !== 0;
                    if (hasCharacter) {
                        const characterId = body.readUInt16LE(cursor);
                        cursor += 2;
                        if (hasMatrix && idSet.has(characterId)) {
                            result.set(characterId, readSwfMatrix(body, cursor));
                        }
                    }
                }

                spritePos = spriteDataEnd;
                if (spriteTagType === 0) {
                    break;
                }
            }
        }

        pos = dataEnd;
        if (tagType === 0) {
            break;
        }
    }

    return result;
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
    assert.equal(path.basename(portuguesePath), 'Game.pt-br.swz');
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

function testStaticServerLocalizesPortugueseTooltipXml(): void {
    const server = new StaticServer();
    const tooltipPath = (server as any).getSharedXmlAssetPath('/TooltipTypes.xml') as string;
    const englishXml = ((server as any).getLocalizedXmlBuffer(tooltipPath, 'en') as Buffer).toString('utf8');
    const portugueseXml = ((server as any).getLocalizedXmlBuffer(tooltipPath, 'pt-br') as Buffer).toString('utf8');

    assert.equal(englishXml.includes('Invite a player to be your friend.'), true);
    assert.equal(portugueseXml.includes('Convide um jogador para ser seu amigo.'), true);
    assert.equal(portugueseXml.includes('Não aceite mais mensagens de um jogador.'), true);
    assert.equal(portugueseXml.includes('Atalho do chat:'), true);
    assert.equal(portugueseXml.includes('Pressione [Enter] para começar'), true);
    assert.equal(portugueseXml.includes('Pressione [Enter] para enviar'), true);
}

function testBrowserEmbedFillsViewportWithoutCropping(): void {
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
    assertBodyIncludesText(portugueseBody, `UI_1.swf?rv=${SWF_RUNTIME_VERSION}`, 'DungeonBlitz.swf pt-br');
    assertBodyIncludesText(portugueseBody, 'DB_LOCALIZATION_RELOAD:', 'DungeonBlitz.swf pt-br');
    assertBodyIncludesText(portugueseBody, 'http://localhost:8000/p/cbp/DungeonBlitz.swf?fv=cbw&gv=cbw&lang=pt-br', 'DungeonBlitz.swf pt-br');
    assertBodyIncludesText(portugueseBody, 'Nível da Masmorra: ', 'DungeonBlitz.swf pt-br');
    assertBodyIncludesText(portugueseBody, 'Limpe a Masmorra', 'DungeonBlitz.swf pt-br');
    assertBodyIncludesText(portugueseBody, 'Missão Disponível', 'DungeonBlitz.swf pt-br');
    assertBodyIncludesText(portugueseBody, 'Capitão Fink', 'DungeonBlitz.swf pt-br');
    assertBodyIncludesText(portugueseBody, 'Prefeito Ristas', 'DungeonBlitz.swf pt-br');
    assertBodyIncludesText(portugueseBody, 'Bem-vindo a ', 'DungeonBlitz.swf pt-br');
    assertBodyIncludesText(portugueseBody, 'Melhorar Construção', 'DungeonBlitz.swf pt-br');
    assertBodyIncludesText(portugueseBody, 'Tutorial Concluído', 'DungeonBlitz.swf pt-br');
    assertBodyIncludesText(portugueseBody, 'Uau! Minha própria incubadora. Talvez quando eu tiver mais experiência...', 'DungeonBlitz.swf pt-br');
    assertBodyIncludesText(portugueseBody, 'Espera, preciso seguir pela bifurcação.', 'DungeonBlitz.swf pt-br');
    assertBodyIncludesText(portugueseBody, 'Está aqui embaixo.', 'DungeonBlitz.swf pt-br');
    assertBodyIncludesText(portugueseBody, 'Conexão Perdida', 'DungeonBlitz.swf pt-br');
    assertBodyIncludesText(portugueseBody, 'A conexão com o\nservidor foi perdida!', 'DungeonBlitz.swf pt-br');
    assertBodyIncludesText(portugueseBody, 'Você não está em uma guilda.', 'DungeonBlitz.swf pt-br');
    assertBodyIncludesText(portugueseBody, 'Não há jogadores nesta área.', 'DungeonBlitz.swf pt-br');
    assertBodyIncludesText(portugueseBody, '/conv <player>', 'DungeonBlitz.swf pt-br');
    assertBodyIncludesText(portugueseBody, 'Convidar...', 'DungeonBlitz.swf pt-br');
    assertBodyIncludesText(portugueseBody, 'Oficiais', 'DungeonBlitz.swf pt-br');
    assertBodyIncludesText(portugueseBody, 'Guilda', 'DungeonBlitz.swf pt-br');
    assertBodyIncludesText(portugueseBody, 'Grupo', 'DungeonBlitz.swf pt-br');
    assertBodyIncludesText(portugueseBody, 'Local', 'DungeonBlitz.swf pt-br');
    assertBodyIncludesText(portugueseBody, '/officer', 'DungeonBlitz.swf pt-br');
    assertBodyIncludesText(portugueseBody, '/guild', 'DungeonBlitz.swf pt-br');
    assertBodyIncludesText(portugueseBody, '/party', 'DungeonBlitz.swf pt-br');
    assertBodyIncludesText(portugueseBody, '/say', 'DungeonBlitz.swf pt-br');
    assertBodyIncludesText(portugueseBody, 'Talvez o zelador saiba como abrir isso...', 'DungeonBlitz.swf pt-br');
    assertBodyExcludesText(portugueseBody, 'http://localhost:8000/p/cbp/DungeonBlitz.swf?fv=cbq&gv=cbp&lang=pt-br', 'DungeonBlitz.swf pt-br');
    assertBodyExcludesText(portugueseBody, 'Baglanti Koptu', 'DungeonBlitz.swf pt-br');
    assertBodyExcludesText(portugueseBody, 'Connection to the\nserver has been lost!', 'DungeonBlitz.swf pt-br');
    assertBodyExcludesText(portugueseBody, 'Pantano da Rosa Negra', 'DungeonBlitz.swf pt-br');
    assertBodyExcludesText(portugueseBody, 'Atualizar', 'DungeonBlitz.swf pt-br');
    assertBodyExcludesText(portugueseBody, 'Viajar para', 'DungeonBlitz.swf pt-br');
    assertBodyExcludesText(portugueseBody, 'Movimento', 'DungeonBlitz.swf pt-br');
    assertBodyExcludesText(portugueseBody, 'Grátis', 'DungeonBlitz.swf pt-br');
    assertBodyExcludesText(portugueseBody, 'Treinar', 'DungeonBlitz.swf pt-br');
    assertBodyExcludesText(portugueseBody, 'Wait, I need to take the fork in the road', 'DungeonBlitz.swf pt-br');
    assertBodyExcludesText(portugueseBody, "It's right below me", 'DungeonBlitz.swf pt-br');
    assertBodyExcludesText(portugueseBody, 'Maybe that old man knows how to open this...', 'DungeonBlitz.swf pt-br');
    assertBodyExcludesText(portugueseBody, "You aren't in a guild.", 'DungeonBlitz.swf pt-br');
    assertBodyExcludesText(portugueseBody, 'No players in this area.', 'DungeonBlitz.swf pt-br');
}

function assertBodyIncludesText(body: Buffer, text: string, label: string): void {
    assert.equal(body.includes(Buffer.from(text, 'utf8')), true, `${label} should include "${text}"`);
}

function assertBodyExcludesText(body: Buffer, text: string, label: string): void {
    assert.equal(body.includes(Buffer.from(text, 'utf8')), false, `${label} should not include "${text}"`);
}

function testStaticServerLocalizesPortugueseTutorialAssetTags(): void {
    const server = new StaticServer();
    const uiBody = getSwfBody((server as any).getLocalizedAssetSwfBuffer('p/cbp/UI_1.swf', 'pt-br') as Buffer);
    const ui4Body = getSwfBody((server as any).getLocalizedAssetSwfBuffer('p/cbp/UI_4.swf', 'pt-br') as Buffer);
    const homeLevelsBody = getSwfBody((server as any).getLocalizedAssetSwfBuffer('p/cbp/LevelsHome.swf', 'pt-br') as Buffer);
    const levelsBody = getSwfBody((server as any).getLocalizedAssetSwfBuffer('p/cbp/LevelsNR.swf', 'pt-br') as Buffer);
    const tutorialLevelsBody = getSwfBody((server as any).getLocalizedAssetSwfBuffer('p/cbp/LevelsTut.swf', 'pt-br') as Buffer);

    assertSwfTagsWellFormed(uiBody, 'UI_1.swf');
    assertSwfTagsWellFormed(ui4Body, 'UI_4.swf');
    assertSwfTagsWellFormed(homeLevelsBody, 'LevelsHome.swf');
    assertSwfTagsWellFormed(levelsBody, 'LevelsNR.swf');
    assertSwfTagsWellFormed(tutorialLevelsBody, 'LevelsTut.swf');

    assertBodyExcludesText(uiBody, 'Learn quest information', 'UI_1.swf');
    assertBodyExcludesText(uiBody, 'Home and Hearth', 'UI_1.swf');
    assertBodyExcludesText(levelsBody, '-You can Jump with W, Up, or Space', 'LevelsNR.swf');
    assertBodyExcludesText(levelsBody, '-Use S or Down to drop through ledges', 'LevelsNR.swf');
    assertBodyExcludesText(levelsBody, 'Breakable Objects', 'LevelsNR.swf');
    assertBodyExcludesText(levelsBody, 'Camera Bumping', 'LevelsNR.swf');
    assertBodyExcludesText(levelsBody, 'Wait, I need to take the fork in the road', 'LevelsNR.swf');
    assertBodyExcludesText(levelsBody, "It's right below me", 'LevelsNR.swf');
    assertBodyExcludesText(levelsBody, 'Get back across the sea!', 'LevelsNR.swf');
    assertBodyExcludesText(levelsBody, 'Chief Tourzahl', 'LevelsNR.swf');
    assertBodyExcludesText(levelsBody, "Sythokhan's Dream", 'LevelsNR.swf');
    assertBodyExcludesText(levelsBody, 'Nephit Knows.', 'LevelsNR.swf');
    assertBodyExcludesText(levelsBody, 'Maybe death will take me home...', 'LevelsNR.swf');
    assertBodyExcludesText(levelsBody, 'Yeargh!', 'LevelsNR.swf');
    assertBodyExcludesText(levelsBody, 'a_Animation_TutorialOverlaySaltar', 'LevelsNR.swf');
    assertBodyExcludesText(levelsBody, 'a_Animation_TutorialOverlayDescer', 'LevelsNR.swf');
    assertBodyExcludesText(uiBody, 'To melee, approach a monster', 'UI_1.swf');
    assertBodyExcludesText(uiBody, 'Magic Forge Unlocked', 'UI_1.swf');
    assertBodyExcludesText(uiBody, 'am_Sair', 'UI_1.swf');
    assertBodyIncludesText(uiBody, 'am_Leave', 'UI_1.swf');
    assertBodyIncludesText(ui4Body, 'Melhorar Construção', 'UI_4.swf');
    assertBodyIncludesText(ui4Body, 'Sair da Casa', 'UI_4.swf');
    assertBodyIncludesText(ui4Body, 'Visitar Casa', 'UI_4.swf');
    assertBodyIncludesText(ui4Body, 'Mochila', 'UI_4.swf');
    assertBodyIncludesText(ui4Body, 'Talentos', 'UI_4.swf');
    assertBodyIncludesText(ui4Body, 'Livro de Feitiços', 'UI_4.swf');
    assertBodyIncludesText(ui4Body, 'Livro de Feitiços (p)', 'UI_4.swf');
    assertBodyIncludesText(ui4Body, 'Mapa', 'UI_4.swf');
    assertBodyIncludesText(ui4Body, 'Acelerar', 'UI_4.swf');
    assertBodyIncludesText(ui4Body, 'Treinar', 'UI_4.swf');
    assertBodyIncludesText(ui4Body, 'Tomo do Poder', 'UI_4.swf');
    assertBodyIncludesText(ui4Body, 'Sair da Masmorra', 'UI_4.swf');
    assertBodyIncludesText(ui4Body, 'Tem certeza de que deseja cancelar?', 'UI_4.swf');
    assertBodyIncludesText(ui4Body, 'Sim', 'UI_4.swf');
    assertBodyIncludesText(ui4Body, 'Não', 'UI_4.swf');
    assertBodyIncludesText(ui4Body, 'Incubadora', 'UI_4.swf');
    assertBodyIncludesText(ui4Body, 'Forja Mágica', 'UI_4.swf');
    assertBodyIncludesText(ui4Body, 'Torres da Disciplina', 'UI_4.swf');
    assertBodyIncludesText(ui4Body, 'Árvores de Talentos', 'UI_4.swf');
    assertBodyIncludesText(ui4Body, 'Bem-vindo ao', 'UI_4.swf');
    assertBodyIncludesText(ui4Body, 'Bem-vindo à', 'UI_4.swf');
    assertBodyIncludesText(ui4Body, 'Choque ovos e ganhe pets', 'UI_4.swf');
    assertBodyIncludesText(ui4Body, 'Clique no ovo para iniciar', 'UI_4.swf');
    assertBodyIncludesText(ui4Body, 'Ovo leva tempo para chocar', 'UI_4.swf');
    assertBodyIncludesText(ui4Body, 'Clique em "Chocar Ovo"', 'UI_4.swf');
    assertBodyIncludesText(ui4Body, 'Chocar Ovo', 'UI_4.swf');
    assertBodyIncludesText(uiBody, 'Construa a Forja', 'UI_1.swf');
    assertBodyIncludesText(ui4Body, 'Crie gemas na sua forja', 'UI_4.swf');
    assertBodyIncludesText(ui4Body, 'Clique nesta receita para começar', 'UI_4.swf');
    assertBodyIncludesText(ui4Body, 'Esta é a receita que você vai preparar', 'UI_4.swf');
    assertBodyIncludesText(ui4Body, 'Use até 6 materiais na criação', 'UI_4.swf');
    assertBodyIncludesText(ui4Body, 'Estes são seus materiais', 'UI_4.swf');
    assertBodyIncludesText(ui4Body, 'Clique no material para usá-lo', 'UI_4.swf');
    assertBodyIncludesText(ui4Body, 'Estes são grupos de materiais', 'UI_4.swf');
    assertBodyIncludesText(ui4Body, 'gemas raras ou lendárias com mais chance', 'UI_4.swf');
    assertBodyIncludesText(ui4Body, 'Criar Gema', 'UI_4.swf');
    assertBodyIncludesText(ui4Body, 'Pegar Gema', 'UI_4.swf');
    assertBodyIncludesText(ui4Body, 'Esta é a Torre da sua disciplina', 'UI_4.swf');
    assertBodyIncludesText(ui4Body, 'Treinar Talento', 'UI_4.swf');
    assertBodyIncludesText(ui4Body, 'Estes são Pontos de Talento Livres', 'UI_4.swf');
    assertBodyIncludesText(ui4Body, 'Pedras de Talento', 'UI_4.swf');
    assertBodyIncludesText(ui4Body, 'Treinar Pontos leva tempo e custa ouro', 'UI_4.swf');
    assertBodyIncludesText(ui4Body, 'Clique aqui para abrir seus Talentos', 'UI_4.swf');
    assertBodyIncludesText(ui4Body, 'Essa é sua Árvore de Talentos atual', 'UI_4.swf');
    assertBodyIncludesText(ui4Body, 'Suba de nível para ganhar pontos', 'UI_4.swf');
    assertBodyIncludesText(ui4Body, 'Ganhe Pontos subindo de nível', 'UI_4.swf');
    assertBodyIncludesText(ui4Body, 'Gaste Pontos para encaixar pedras', 'UI_4.swf');
    assertBodyIncludesText(ui4Body, 'Clique em "Aplicar" se gostou da escolha', 'UI_4.swf');
    assertBodyIncludesText(ui4Body, 'Aplicar', 'UI_4.swf');
    assertBodyIncludesText(ui4Body, 'Desfazer', 'UI_4.swf');
    assertBodyExcludesText(ui4Body, 'The Magic Forge', 'UI_4.swf');
    assertBodyExcludesText(ui4Body, 'Visit House', 'UI_4.swf');
    assertBodyExcludesText(ui4Body, 'Craft Charm', 'UI_4.swf');
    assertBodyExcludesText(ui4Body, 'Take Charm', 'UI_4.swf');
    assertBodyExcludesText(ui4Body, 'Discipline Towers', 'UI_4.swf');
    assertBodyExcludesText(ui4Body, 'Train Talent Point', 'UI_4.swf');
    assertBodyExcludesText(ui4Body, 'These are Talentstones', 'UI_4.swf');
    assertBodyExcludesText(ui4Body, 'selected Talentstone', 'UI_4.swf');
    assertBodyIncludesText(homeLevelsBody, 'Seja bem-vindo,|bem-vinda, guerreiro.|guerreira. Aproveite o Salão da Guilda.', 'LevelsHome.swf');
    assertBodyIncludesText(homeLevelsBody, 'Por favor, choque mais ovos, amigo.|amiga. O Yval aqui talvez goste de ter um pouco mais de companhia.', 'LevelsHome.swf');
    assertBodyIncludesText(homeLevelsBody, 'um|uma herói|heroína', 'LevelsHome.swf');
    assertBodyIncludesText(homeLevelsBody, 'Volte mais tarde e eu te ensino a abrir esses baús!', 'LevelsHome.swf');
    assertBodyIncludesText(homeLevelsBody, 'Este lugar é seu agora.', 'LevelsHome.swf');
    assertBodyIncludesText(levelsBody, 'a_Animation_TutorialOverlayJumping', 'LevelsNR.swf');
    assertBodyIncludesText(levelsBody, 'a_Animation_TutorialOverlayDropping', 'LevelsNR.swf');

    for (const text of [
        'Objetos Quebráveis',
        '-Alguns objetos podem quebrar',
        '-Para quebrar, ataque de perto',
        'Saltar',
        '-Pule com W, Cima ou Espaço',
        'Descer',
        '-Use S ou Baixo para descer plataformas',
        'Portas',
        '-Clique ou aperte E para entrar',
        'Câmera',
        '-Leve o mouse até a borda da tela',
        '-para ver inimigos fora da tela',
        'Volte para o outro lado do mar!',
        'Chefe Tourzahl',
        'Sonho de Sythokahn',
        'Nephit sabe.',
        'Talvez a morte me leve para casa...',
        'Argh!',
        'Ele|Ela nos encontrou!'
    ]) {
        assertBodyIncludesText(levelsBody, text, 'LevelsNR.swf');
    }

    for (const text of [
        'Detalhes da próxima missão',
        'Conclua a primeira missão',
        'Conclua a próxima missão',
        'Clique no Capitão Fink para saber mais da missão',
        'Capitão Fink te entrega o mapa.',
        'Mapa Confiável de Fink',
        'Use este mapa para se orientar.',
        'Clique no guia de missão para abrir seu mapa',
        'Um Novo Lar',
        'Construa a Incubadora',
        'A incubadora foi liberada',
        'A forja mágica foi liberada',
        'Sua casa está pronta',
        'Torres de Disciplina liberadas',
        'Construa a Torre',
        'Construa o Tomo do Poder',
        'Sair da Masmorra',
        'Aproxime-se do monstro para lutar',
        'Segure o botão para atacar',
        'Emotes e Chat',
        '-Clique para ver comandos do chat',
        'Adicionar Amigo',
        'Adicionar aos Ignorados',
        '0 de 0 amigos online.',
        'Você foi derrotado!',
        'REVIVER',
        'ABATES',
        'TESOUROS',
        'PRECISÃO',
        'MORTES',
        'BÔNUS DE TEMPO',
        'PONTUAÇÃO TOTAL',
        'Ver Ranques',
        'RANQUE',
        'Pântano da Rosa Negra'
    ]) {
        assertBodyIncludesText(uiBody, text, 'UI_1.swf');
    }
    assertBodyExcludesText(uiBody, 'Add Friend', 'UI_1.swf');
    assertBodyExcludesText(uiBody, 'Add Ignored', 'UI_1.swf');
    assertBodyExcludesText(uiBody, '0 of 0 friends online.', 'UI_1.swf');
    assertBodyExcludesText(uiBody, 'TOTAL SCORE', 'UI_1.swf');
    assertBodyExcludesText(uiBody, 'View Ranks', 'UI_1.swf');
    assertBodyExcludesText(uiBody, 'Pantano da Rosa Negra', 'UI_1.swf');

    const cardTitleBounds = collectDefineEditTextXMax(uiBody, [85, 179, 180, 187, 431, 439, 482, 485, 493, 556, 558, 560, 625, 1136, 1141, 1271, 1272, 1287, 1288, 1289, 1290, 1291, 1303, 1305]);
    assert.ok(Number(cardTitleBounds.get(85) ?? 0) >= 4400);
    assert.ok(Number(cardTitleBounds.get(179) ?? 0) > 0);
    assert.ok(Number(cardTitleBounds.get(179) ?? 0) >= 6400);
    assert.ok(Number(cardTitleBounds.get(180) ?? 0) >= 8000);
    assert.ok(Number(cardTitleBounds.get(187) ?? 0) > 0);
    assert.ok(Number(cardTitleBounds.get(187) ?? 0) < 10000);
    assert.ok(Number(cardTitleBounds.get(431) ?? 0) >= 3900);
    assert.ok(Number(cardTitleBounds.get(439) ?? 0) >= 4532);
    assert.ok(Number(cardTitleBounds.get(482) ?? 0) >= 8000);
    assert.ok(Number(cardTitleBounds.get(485) ?? 0) >= 6800);
    assert.ok(Number(cardTitleBounds.get(493) ?? 0) >= 7600);
    assert.ok(Number(cardTitleBounds.get(556) ?? 0) >= 8200);
    assert.ok(Number(cardTitleBounds.get(558) ?? 0) >= 7200);
    assert.ok(Number(cardTitleBounds.get(560) ?? 0) >= 7200);
    assert.ok(Number(cardTitleBounds.get(625) ?? 0) >= 5100);
    assert.ok(Number(cardTitleBounds.get(1136) ?? 0) >= 5600);
    assert.ok(Number(cardTitleBounds.get(1141) ?? 0) >= 5600);
    assert.ok(Number(cardTitleBounds.get(1271) ?? 0) >= 3800);
    assert.ok(Number(cardTitleBounds.get(1272) ?? 0) >= 1600);
    assert.ok(Number(cardTitleBounds.get(1287) ?? 0) >= 1600);
    assert.ok(Number(cardTitleBounds.get(1288) ?? 0) >= 2200);
    assert.ok(Number(cardTitleBounds.get(1289) ?? 0) >= 2200);
    assert.ok(Number(cardTitleBounds.get(1290) ?? 0) >= 1700);
    assert.ok(Number(cardTitleBounds.get(1291) ?? 0) >= 3400);
    assert.ok(Number(cardTitleBounds.get(1303) ?? 0) >= 2700);
    assert.ok(Number(cardTitleBounds.get(1305) ?? 0) >= 3820);

    const ui4TooltipBounds = collectDefineEditTextXMax(ui4Body, [375, 644, 645, 655, 656, 666, 667, 688, 689, 1001, 1015, 1702, 2019, 2023, 2027, 2038, 2320, 4000]);
    assert.ok(Number(ui4TooltipBounds.get(375) ?? 0) >= 8400);
    assert.ok(Number(ui4TooltipBounds.get(644) ?? 0) >= 7600);
    assert.ok(Number(ui4TooltipBounds.get(645) ?? 0) >= 8200);
    assert.ok(Number(ui4TooltipBounds.get(655) ?? 0) >= 7600);
    assert.ok(Number(ui4TooltipBounds.get(656) ?? 0) >= 8200);
    assert.ok(Number(ui4TooltipBounds.get(666) ?? 0) >= 7600);
    assert.ok(Number(ui4TooltipBounds.get(667) ?? 0) >= 8200);
    assert.ok(Number(ui4TooltipBounds.get(688) ?? 0) >= 7600);
    assert.ok(Number(ui4TooltipBounds.get(689) ?? 0) >= 8200);
    assert.ok(Number(ui4TooltipBounds.get(1001) ?? 0) >= 7600);
    assert.ok(Number(ui4TooltipBounds.get(1015) ?? 0) >= 7600);
    assert.ok(Number(ui4TooltipBounds.get(1702) ?? 0) >= 3200);
    assert.ok(Number(ui4TooltipBounds.get(2019) ?? 0) >= 3200);
    assert.ok(Number(ui4TooltipBounds.get(2023) ?? 0) >= 4600);
    assert.ok(Number(ui4TooltipBounds.get(2027) ?? 0) >= 3200);
    assert.ok(Number(ui4TooltipBounds.get(2038) ?? 0) >= 4600);
    assert.ok(Number(ui4TooltipBounds.get(2320) ?? 0) >= 8200);
    assert.ok(Number(ui4TooltipBounds.get(4000) ?? 0) >= 8200);

    for (const [spriteId, characterId, expectedTx] of [
        [586, 577, -429],
        [586, 579, -433],
        [586, 581, -440],
        [587, 577, -429],
        [587, 579, -433],
        [587, 581, -440],
        [598, 575, -1361],
        [598, 577, -17],
        [598, 579, -21],
        [598, 597, -12],
        [604, 577, 643],
        [604, 579, 639],
        [604, 603, 613],
        [610, 577, 643],
        [610, 579, 639],
        [610, 603, 613],
        [614, 575, -1361],
        [614, 577, -17],
        [614, 579, -21],
        [614, 597, -12],
        [620, 575, -1361],
        [620, 577, -17],
        [620, 579, -21],
        [620, 597, -12]
    ] as const) {
        const placements = collectSpriteCharacterPlacements(uiBody, spriteId, [characterId]);
        assert.equal(
            placements.get(characterId)?.tx,
            expectedTx,
            `UI_1.swf sprite ${spriteId} icon ${characterId} should shift right for PT-BR`
        );
    }
}

function main(): void {
    testStaticServerServesSingleSwfByDefault();
    testStaticServerCanonicalizesDirectSwfVersionParams();
    testStaticServerRootUsesSelectedSwfUrl();
    testStaticServerSelectsLocalizedGameSwz();
    testStaticServerAliasesCurrentFlashVersionManifest();
    testStaticServerLocalizesPortugueseTooltipXml();
    testBrowserEmbedFillsViewportWithoutCropping();
    testStaticServerResolvesGameSwzLocaleFromRequest();
    testStaticServerRemembersQueryLocaleInCookie();
    testStaticServerBuildsLocalizedSwfTextByLocale();
    testStaticServerLocalizesPortugueseTutorialAssetTags();
    console.log('static_server_default_swf_regression: ok');
}

main();
