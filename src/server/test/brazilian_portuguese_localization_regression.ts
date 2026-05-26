import { strict as assert } from 'assert';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

type SwzEntry = {
    rootName: string;
    xml: string;
};

function rotateKey(key: number, shift: number): number {
    return (((key << (32 - shift)) >>> 0) | (key >>> shift)) >>> 0;
}

function decodeSwz(filePath: string): SwzEntry[] {
    const buffer = fs.readFileSync(filePath);
    let offset = 0;
    let key = buffer.readUInt32BE(offset) >>> 0;
    offset += 4;
    const count = buffer.readUInt32BE(offset);
    offset += 4;

    const entries: SwzEntry[] = [];
    for (let entryIndex = 0; entryIndex < count; entryIndex += 1) {
        const encodedLength = buffer.readUInt32BE(offset);
        offset += 4;
        const encoded = Buffer.alloc(encodedLength);

        for (let byteIndex = 0; byteIndex < encodedLength; byteIndex += 1) {
            const shift = byteIndex & 7;
            encoded[byteIndex] = buffer[offset++] ^ (key & 0xff);
            key = rotateKey(key, shift);
        }

        const xml = zlib.inflateSync(encoded).toString('utf8');
        entries.push({
            rootName: xml.match(/<([A-Za-z0-9_:-]+)/)?.[1] || '',
            xml
        });
    }

    return entries;
}

function testBrazilianPortugueseGameSwzExistsAndContainsLocalizedText(): void {
    const root = path.resolve(__dirname, '../../..');
    const swzPath = path.join(root, 'src/client/content/localhost/p/cbq/Game.pt-br.swz');
    assert.equal(fs.existsSync(swzPath), true, 'Game.pt-br.swz should exist');

    const entries = new Map(decodeSwz(swzPath).map((entry) => [entry.rootName, entry.xml]));
    assert.equal(entries.get('BuildingTypes')?.includes('Forja Mágica'), true);
    assert.equal(entries.get('BuildingTypes')?.includes('Magic Forge'), false);
    assert.equal(entries.get('PetTypes')?.includes('nivel do mascote'), true);
    assert.equal(entries.get('PlayerPowerTypes')?.includes('Invocar Mascote'), true);
    assert.equal(entries.get('MissionTypes')?.includes('Levado pela Maré'), true);
    assert.equal(entries.get('MissionTypes')?.includes('Capitão Fink'), true);
    assert.equal(entries.get('MissionTypes')?.includes('Levado pela Mare'), false);
    assert.equal(entries.get('MissionTypes')?.includes('Capitao Fink'), false);
    assert.equal(entries.get('LevelTypes')?.includes('<DisplayName>Perdidos no Mar</DisplayName>'), true);
    assert.equal(entries.get('LevelTypes')?.includes('<DisplayName>Pântano da Rosa Negra</DisplayName>'), true);
    assert.equal(entries.get('LevelTypes')?.includes('<DisplayName>Pantano da Rosa Negra</DisplayName>'), false);
    assert.equal(entries.get('LevelTypes')?.includes('<DisplayName>Felbridge</DisplayName>'), true);
    assert.equal(entries.get('LevelTypes')?.includes('<DisplayName>Ponte Sombria</DisplayName>'), false);
    assert.equal(entries.get('LevelTypes')?.includes('<DisplayName>Montanhas Stormshard</DisplayName>'), true);
    assert.equal(entries.get('LevelTypes')?.includes('Montanhas Estilhaco'), false);
    assert.equal(entries.get('LevelTypes')?.includes('<DisplayName>Lost at Sea</DisplayName>'), false);
    assert.equal(entries.get('TooltipTypes')?.includes('Convide um jogador para ser seu amigo.'), true);
    assert.equal(entries.get('TooltipTypes')?.includes('Não aceite mais mensagens de um jogador.'), true);
    assert.equal(entries.get('TooltipTypes')?.includes('Atalho do chat:'), true);
    assert.equal(entries.get('TooltipTypes')?.includes('Pressione [Enter] para começar'), true);
    assert.equal(entries.get('TooltipTypes')?.includes('Pressione [Enter] para enviar'), true);
}

function testBrazilianPortugueseDialogueFilesExist(): void {
    const dataDir = path.resolve(__dirname, '../data');
    const dialogueTranslations = JSON.parse(
        fs.readFileSync(path.join(dataDir, 'DialogueTranslations.pt-br.json'), 'utf8')
    ) as { translations?: Record<string, string> };
    const missionDialogues = JSON.parse(
        fs.readFileSync(path.join(dataDir, 'MissionDialogues.pt-br.json'), 'utf8')
    ) as { missions?: Record<string, unknown> };
    const npcDialogues = JSON.parse(
        fs.readFileSync(path.join(dataDir, 'NpcDialogues.pt-br.json'), 'utf8')
    ) as { levels?: Record<string, unknown> };

    assert.ok(Object.keys(dialogueTranslations.translations ?? {}).length > 4000);
    assert.ok(Object.keys(missionDialogues.missions ?? {}).length > 200);
    assert.ok(Object.keys(npcDialogues.levels ?? {}).length > 10);
    const sampleSource = Object.keys(dialogueTranslations.translations ?? {})[0];
    assert.ok(sampleSource, 'Portuguese dialogue translations should include source entries');
    assert.notEqual(
        dialogueTranslations.translations?.[sampleSource],
        sampleSource,
        'Portuguese dialogue translation should not remain English'
    );

    const newbieRoad = npcDialogues.levels?.NewbieRoad as {
        nraffric?: { displayName?: string; defaultLines?: string[] };
        nrelric?: { displayName?: string; defaultLines?: string[] };
        nrmerchant01?: { displayName?: string; defaultLines?: string[] };
        nrtrainer01?: { displayName?: string; defaultLines?: string[] };
        nrvillager02?: { defaultLines?: string[] };
    };
    assert.equal(newbieRoad.nraffric?.displayName, 'Affric');
    assert.equal(newbieRoad.nraffric?.defaultLines?.includes('Você traz notícias dos nossos amigos de Sark?'), true);
    assert.equal(newbieRoad.nrelric?.displayName, 'Ehric');
    assert.equal(newbieRoad.nrelric?.defaultLines?.includes('Conheço estas bandas há anos.'), true);
    assert.equal(newbieRoad.nrmerchant01?.displayName, 'Galrius');
    assert.equal(newbieRoad.nrmerchant01?.defaultLines?.includes('Os melhores preços do reino!'), true);
    assert.equal(newbieRoad.nrtrainer01?.displayName, 'Tess');
    assert.equal(newbieRoad.nrtrainer01?.defaultLines?.includes('Mantenha a guarda alta!'), true);
    assert.equal(
        newbieRoad.nrvillager02?.defaultLines?.includes(
            'Os goblins roubaram todas as nossas ferraduras e transformaram em argolas de nariz.'
        ),
        true
    );
}

function collectStringValues(value: unknown, output: string[] = []): string[] {
    if (typeof value === 'string') {
        output.push(value);
        return output;
    }
    if (Array.isArray(value)) {
        for (const item of value) {
            collectStringValues(item, output);
        }
        return output;
    }
    if (value && typeof value === 'object') {
        for (const item of Object.values(value)) {
            collectStringValues(item, output);
        }
    }
    return output;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function testBrazilianPortugueseDungeonDialogueDoesNotKeepCommonEnglishWords(): void {
    const dataDir = path.resolve(__dirname, '../data');
    const fileNames = [
        'DialogueTranslations.pt-br.json',
        'MissionDialogues.pt-br.json',
        'NpcDialogues.pt-br.json'
    ];
    const forbiddenWords = [
        'the', "you're", "we're", "they're", "don't", "won't", "i've", "we've", "you'd", "it'll",
        'know', 'about', 'again', 'steward', 'fight', 'fighting', 'dead', 'death', 'undead',
        'dream', 'evil', 'things', 'should', 'through', 'before', 'bring', 'give', 'doing',
        'coming', 'found', 'source', 'soldiers', 'spiders', 'without', 'please', 'secret',
        'castle', 'behold', 'despair', 'human', 'hero', 'slayer', 'leader', 'world', 'water',
        'king', 'queen', 'emperor', 'baron', 'house', 'mountain', 'forest', 'desert', 'swamp',
        'bridge', 'road', 'city', 'village', 'town', 'temple', 'tomb', 'cave', 'grave', 'ghost',
        'skeleton', 'witch', 'monster', 'creature', 'enemy', 'friend', 'power', 'magic', 'blood',
        'fire', 'ice', 'poison', 'shadow', 'light', 'spirit', 'prepare', 'hordes'
    ];

    for (const fileName of fileNames) {
        const payload = JSON.parse(fs.readFileSync(path.join(dataDir, fileName), 'utf8')) as unknown;
        const values = collectStringValues(payload);
        for (const word of forbiddenWords) {
            const pattern = new RegExp(`(?<!\\p{L})${escapeRegExp(word)}(?!\\p{L})`, 'iu');
            const sample = values.find((value) => pattern.test(value));
            assert.equal(
                sample,
                undefined,
                `${fileName} should not keep common English dungeon word "${word}" in pt-BR text: ${sample}`
            );
        }
    }
}

function main(): void {
    testBrazilianPortugueseGameSwzExistsAndContainsLocalizedText();
    testBrazilianPortugueseDialogueFilesExist();
    testBrazilianPortugueseDungeonDialogueDoesNotKeepCommonEnglishWords();
    console.log('brazilian_portuguese_localization_regression: ok');
}

main();
