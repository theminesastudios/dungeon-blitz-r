#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { localizeText, normalizeAscii, titleCaseAscii } = require('./turkish-localization-utils');

const DEFAULT_SWZ = path.join('src', 'client', 'content', 'localhost', 'p', 'cbq', 'Game.swz');
const DEFAULT_EN_SWZ = path.join('src', 'client', 'content', 'localhost', 'p', 'cbq', 'Game.en.swz');
const DEFAULT_TR_SWZ = path.join('src', 'client', 'content', 'localhost', 'p', 'cbq', 'Game.tr.swz');
const XML_ROOT = path.join('src', 'client', 'content', 'xml');

const TRANSLATABLE_TAGS = new Set([
    'ActiveText',
    'BonusInfo',
    'Description',
    'DisplayName',
    'FlavorText',
    'LockedMessage',
    'OfferText',
    'PraiseText',
    'PreReqText',
    'ProgressText',
    'ReturnText',
    'TrackerReturn',
    'TrackerText',
    'UpgradeDescription'
]);

const TRANSLATABLE_TAGS_BY_ROOT = new Map([
    ['MissionTypes', new Set([
        'ActiveText',
        'Description',
        'DisplayName',
        'OfferText',
        'PraiseText',
        'PreReqText',
        'ProgressText',
        'ReturnText',
        'TrackerReturn',
        'TrackerText'
    ])],
    ['PlayerPowerTypes', new Set(['Description', 'DisplayName', 'UpgradeDescription'])],
    ['MonsterPowerTypes', new Set(['DisplayName'])],
    ['PowerModTypes', new Set(['Description', 'DisplayName'])],
    ['AbilityTypes', new Set([])],
    ['LevelTypes', new Set(['DisplayName'])],
    ['DoorTypes', new Set(['LockedMessage'])],
    ['MissionGroups', new Set(['DisplayName'])],
    ['BuildingTypes', new Set(['DisplayName', 'UpgradeDescription'])],
    ['ConsumableTypes', new Set(['Description', 'DisplayName'])],
    ['CharmTypes', new Set(['Description', 'DisplayName'])],
    ['DyeTypes', new Set(['DisplayName'])],
    ['EggTypes', new Set(['DisplayName'])],
    ['GearTypes', new Set(['Description', 'DisplayName'])],
    ['LockboxTypes', new Set(['Description', 'DisplayName'])],
    ['MagicTypes', new Set(['Description', 'DisplayName'])],
    ['MaterialTypes', new Set(['DisplayName'])],
    ['MountTypes', new Set(['DisplayName'])],
    ['PetTypes', new Set(['BonusInfo', 'DisplayName'])],
    ['RoyalStoreTypes', new Set(['Description', 'DisplayName'])],
    ['StatueTypes', new Set(['DisplayName', 'FlavorText'])]
]);

const MISSION_DIALOGUE_TAGS = new Set(['OfferText', 'ActiveText', 'ReturnText', 'PraiseText']);
const TRANSLATABLE_TAG_PATTERN = [...TRANSLATABLE_TAGS].join('|');
const TRANSLATABLE_TAG_REGEX = new RegExp(`<(${TRANSLATABLE_TAG_PATTERN})>([\\s\\S]*?)<\\/\\1>`, 'g');

function repoRoot() {
    return path.resolve(__dirname, '..', '..', '..');
}

function resolvePath(root, value) {
    if (value) {
        return path.isAbsolute(value) ? value : path.join(root, value);
    }

    const trSwzPath = path.join(root, DEFAULT_TR_SWZ);
    return fs.existsSync(trSwzPath) ? trSwzPath : path.join(root, DEFAULT_SWZ);
}

function resolveSourceSwzPath(root, value) {
    if (value) {
        return resolvePath(root, value);
    }

    const enSwzPath = path.join(root, DEFAULT_EN_SWZ);
    return fs.existsSync(enSwzPath) ? enSwzPath : path.join(root, DEFAULT_SWZ);
}

function resolveTargetSwzPath(root, value) {
    if (value) {
        return resolvePath(root, value);
    }

    return path.join(root, DEFAULT_TR_SWZ);
}

function rotateKey(key, shift) {
    return (((key << (32 - shift)) >>> 0) | (key >>> shift)) >>> 0;
}

function decodeSwz(buffer) {
    let offset = 0;
    const initialKey = buffer.readUInt32BE(offset);
    let key = initialKey >>> 0;
    offset += 4;
    const count = buffer.readUInt32BE(offset);
    offset += 4;

    const entries = [];
    for (let entryIndex = 0; entryIndex < count; entryIndex++) {
        const encodedLength = buffer.readUInt32BE(offset);
        offset += 4;
        const encoded = Buffer.alloc(encodedLength);

        for (let byteIndex = 0; byteIndex < encodedLength; byteIndex++) {
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

    return { initialKey, entries };
}

function encodeSwz(initialKey, entries) {
    const chunks = [];
    const header = Buffer.alloc(8);
    header.writeUInt32BE(initialKey >>> 0, 0);
    header.writeUInt32BE(entries.length >>> 0, 4);
    chunks.push(header);

    let key = initialKey >>> 0;
    for (const entry of entries) {
        const compressed = zlib.deflateSync(Buffer.from(entry.xml, 'utf8'));
        const length = Buffer.alloc(4);
        length.writeUInt32BE(compressed.length >>> 0, 0);
        chunks.push(length);

        const encoded = Buffer.alloc(compressed.length);
        for (let byteIndex = 0; byteIndex < compressed.length; byteIndex++) {
            const shift = byteIndex & 7;
            encoded[byteIndex] = compressed[byteIndex] ^ (key & 0xff);
            key = rotateKey(key, shift);
        }
        chunks.push(encoded);
    }

    return Buffer.concat(chunks);
}

function decodeEntities(value) {
    return String(value ?? '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&');
}

function escapeXmlText(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function normalizeKey(value) {
    return decodeEntities(value).trim().replace(/\s+/g, ' ');
}

function isLikelyAlreadyLocalized(value) {
    return /^(Yerel|Turkce|Acemi|Yesim|Kopru|Mezarlik|Eski|Zumrut|Shazari|Siyah|Kurtlarin|Firtina|Fel|Val|Kilit|Dehset|Hocke|Gorev|Zindan|Binek|Evcil|Esya|Yetenek|Saldiri|Savunma|Guc|Can|Mana|Altin|Kral|Baron|General)\b|\bBinegi\b/i.test(normalizeKey(value));
}

function normalizeUnsupportedTurkishGlyphs(value) {
    return normalizeAscii(value);
}

function loadTranslations(root) {
    const dialoguePath = path.join(root, 'src', 'server', 'data', 'DialogueTranslations.tr.json');
    const missionPath = path.join(root, 'src', 'server', 'data', 'MissionDialogues.tr.json');
    const dialogueRaw = JSON.parse(fs.readFileSync(dialoguePath, 'utf8')).translations || {};
    const missionRaw = JSON.parse(fs.readFileSync(missionPath, 'utf8')).missions || {};
    const translations = new Map();

    for (const [source, target] of Object.entries(dialogueRaw)) {
        const key = normalizeKey(source);
        const value = String(target ?? '').trim();
        if (key && value) {
            translations.set(key, value);
        }
    }

    return { translations, missions: missionRaw };
}

function shouldTranslateTag(rootName, tagName) {
    const scoped = TRANSLATABLE_TAGS_BY_ROOT.get(rootName);
    if (scoped) {
        return scoped.has(tagName);
    }

    return TRANSLATABLE_TAGS.has(tagName);
}

function translateValue(value, translations, context = {}) {
    const decoded = decodeEntities(value);
    if (context.allowAlreadyLocalizedSkip && !shouldReplaceDisplayName(decoded)) {
        return decoded;
    }

    if (context.allowAlreadyLocalizedSkip && isLikelyAlreadyLocalized(decoded)) {
        return decoded;
    }

    const exact = translations.get(normalizeKey(decoded));
    if (exact && normalizeKey(exact) !== normalizeKey(decoded)) {
        return exact;
    }

    if (!/[=]/.test(decoded)) {
        return localizeText(decoded, context);
    }

    let changed = false;
    const translated = decoded
        .split(/(=@|=)/)
        .map((part) => {
            if (part === '=' || part === '=@') {
                return part;
            }

            const replacement = translations.get(normalizeKey(part));
            if (!replacement) {
                return part;
            }

            changed = true;
            return replacement;
        })
        .join('');

    if (changed) {
        return translated;
    }

    return localizeText(decoded, context);
}

function patchMissionTypes(xml, translations, missions, stats) {
    return xml.replace(/<MissionType>[\s\S]*?<\/MissionType>/g, (entry) => {
        const missionId = entry.match(/<MissionID>(\d+)<\/MissionID>/)?.[1] || '';
        const missionDialogue = missions[missionId] || {};

        return entry.replace(TRANSLATABLE_TAG_REGEX, (match, tagName, value) => {
            if (!shouldTranslateTag('MissionTypes', tagName)) {
                return match;
            }

            const translated = MISSION_DIALOGUE_TAGS.has(tagName) && missionDialogue[tagName]
                ? missionDialogue[tagName]
                : translateValue(value, translations, { rootName: 'MissionTypes', tagName, missionId });
            const nextValue = normalizeUnsupportedTurkishGlyphs(translated || decodeEntities(value));
            if (normalizeKey(nextValue) === normalizeKey(value)) {
                return match;
            }

            stats.updated += 1;
            stats.byTag[tagName] = (stats.byTag[tagName] || 0) + 1;
            return `<${tagName}>${escapeXmlText(nextValue)}</${tagName}>`;
        });
    });
}

function patchGenericXml(xml, rootName, translations, stats, options = {}) {
    return xml.replace(TRANSLATABLE_TAG_REGEX, (match, tagName, value) => {
        if (!shouldTranslateTag(rootName, tagName)) {
            return match;
        }

        const translated = translateValue(value, translations, { rootName, tagName, ...options });
        const nextValue = normalizeUnsupportedTurkishGlyphs(translated || decodeEntities(value));
        if (normalizeKey(nextValue) === normalizeKey(value)) {
            return match;
        }

        stats.updated += 1;
        stats.byTag[tagName] = (stats.byTag[tagName] || 0) + 1;
        return `<${tagName}>${escapeXmlText(nextValue)}</${tagName}>`;
    });
}

function getAttr(entry, name) {
    return entry.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1] || '';
}

function getTag(entry, name) {
    return decodeEntities(entry.match(new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`))?.[1] || '');
}

function splitIdentifier(value) {
    return String(value || '')
        .replace(/^---?Template---?$/i, 'Template')
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .replace(/[_-]+/g, ' ')
        .replace(/\b([A-Za-z]+)(\d+)\b/g, '$1 $2')
        .replace(/\b(\d+)([A-Za-z]+)\b/g, '$1 $2')
        .replace(/\s+/g, ' ')
        .trim();
}

const SIMPLE_NAME_PARTS = new Map(Object.entries({
    Abomination: 'Hilkat Garibesi',
    Abom: 'Hilkat',
    Ancient: 'Kadim',
    Angel: 'Melek',
    Armor: 'Zirh',
    Axe: 'Balta',
    Beast: 'Canavar',
    Bear: 'Ayi',
    Bearcat: 'Megavaksak',
    Bird: 'Kus',
    Black: 'Siyah',
    Blue: 'Mavi',
    Bio: 'Yasam',
    Bone: 'Kemik',
    Boat: 'Tekne',
    Bow: 'Yay',
    Bracer: 'Bileklik',
    Bracers: 'Bileklik',
    Brown: 'Kahverengi',
    Boots: 'Cizme',
    Boss: 'Lider',
    Bridge: 'Kopru',
    Bunnybear: 'Kurt Tavsani',
    Cat: 'Kedi',
    Chain: 'Zincir',
    Cloth: 'Kumas',
    Construct: 'Yapi',
    Crow: 'Karga',
    Cyclops: 'Tepegoz',
    Dagger: 'Hancer',
    Death: 'Olum',
    Deathmask: 'Olum Maskesi',
    Demon: 'Iblis',
    Destrier: 'Savas Ati',
    Devourer: 'Yutucu',
    Djinn: 'Cin',
    Dog: 'Kopek',
    Dress: 'Elbise',
    Draconic: 'Ejderha',
    Dragon: 'Ejderha',
    Dragonette: 'Kucuk Ejder',
    Drake: 'Ejder',
    Drakon: 'Drakon',
    Draft: 'Kosum',
    Dread: 'Dehset',
    Dryad: 'Dryad',
    Earth: 'Toprak',
    Egg: 'Yumurta',
    Fairy: 'Peri',
    Falcon: 'Sahin',
    Fangrasaur: 'Disli Kerten',
    Feet: 'Ayaklik',
    Fiend: 'Iblis',
    Fire: 'Ates',
    Flameseer: 'Alevgorur',
    Focus: 'Odak',
    Forge: 'Ocak',
    Frostwarden: 'Ayaz Muhafizi',
    Gear: '',
    Ghost: 'Hayalet',
    Ghoul: 'Gulyabani',
    Giant: 'Dev',
    Glove: 'Eldiven',
    Gloves: 'Eldiven',
    Gold: 'Altin',
    Goblin: 'Goblin',
    Green: 'Yesil',
    Grey: 'Gri',
    Griffon: 'Griffon',
    Hammer: 'Cekic',
    Hands: 'El',
    Halloween: 'Cadilar Bayrami',
    Hat: 'Baslik',
    Helm: 'Migfer',
    Hero: 'Kahraman',
    Hood: 'Kapuson',
    Horse: 'At',
    Hulk: 'Dev',
    Human: 'Insan',
    Ice: 'Buz',
    Imperial: 'Imparatorluk',
    Imp: 'Imp',
    Infernal: 'Cehennem',
    Intro: 'Giris',
    Iron: 'Demir',
    Jackal: 'Cakal',
    Jewelry: 'Mucevher',
    Justicar: 'Adaletci',
    Keep: 'Hisar',
    Kirin: 'Kirin',
    L: 'Efsanevi',
    Legendary: 'Efsanevi',
    Leather: 'Deri',
    Light: 'Isik',
    Lion: 'Aslan',
    Lizard: 'Kertenkele',
    Lockbox: 'Sandik',
    Longma: 'Longma',
    Mace: 'Gurz',
    Mage: 'Buyucu',
    Magic: 'Buyu',
    Mare: 'Kisrak',
    Mask: 'Maske',
    Material: 'Malzeme',
    Minor: 'Kucuk',
    Major: 'Buyuk',
    Monkey: 'Maymun',
    Mount: '',
    Mythic: 'Efsanevi',
    Minotaur: 'Minotor',
    Mummy: 'Mumya',
    Nature: 'Doga',
    Necromancer: 'Olucagiran',
    Nethertotem: 'Nether Totemi',
    Nightmare: 'Kabus',
    Non: '',
    No: 'Yok',
    Offhand: 'Yedek El',
    Owl: 'Baykus',
    Orange: 'Turuncu',
    Paladin: 'Sovalyeci',
    Pet: 'Evcil',
    Phoenix: 'Anka',
    Pony: 'Midilli',
    Priest: 'Rahip',
    Pumpkin: 'Bal Kabagi',
    Purple: 'Mor',
    R: 'Nadir',
    Rabbit: 'Tavsan',
    Raptor: 'Yirtici',
    Rapier: 'Ince Kilic',
    Ratling: 'Ratling',
    Red: 'Kirmizi',
    Rogue: 'Haydut',
    Robe: 'Cubbe',
    Rock: 'Kaya',
    Saber: 'Pala',
    Sash: 'Kusak',
    Scarab: 'Bokbocegi',
    Scepter: 'Asa',
    Serpent: 'Yilan',
    Shade: 'Golge',
    Shield: 'Kalkan',
    Silver: 'Gumus',
    Skeleton: 'Iskelet',
    Shoes: 'Ayakkabi',
    Soulthief: 'Ruh Hirsizi',
    Special: 'Ozel',
    Spear: 'Mizrak',
    Spider: 'Orumcek',
    Spirit: 'Ruh',
    Sprite: 'Pericik',
    Stallion: 'Aygir',
    Staff: 'Asa',
    Starter: 'Baslangic',
    Steel: 'Celik',
    Statue: 'Heykel',
    Store: 'Magaza',
    Sword: 'Kilic',
    Sylvan: 'Orman',
    Templar: 'Tapinakci',
    Tome: 'Kitap',
    Tower: 'Kule',
    Treant: 'Agacadam',
    Trog: 'Trog',
    Tutorial: 'Egitim',
    Undead: 'Olumsuz',
    Unique: 'Ozel',
    Water: 'Su',
    White: 'Beyaz',
    Wolf: 'Kurt',
    Wolfbear: 'Kurt Ayi',
    Wyrm: 'Ejder',
    Yellow: 'Sari'
}));

const COLOR_SUFFIXES = new Map(Object.entries({
    Black: 'Siyah',
    Blue: 'Mavi',
    Brown: 'Kahverengi',
    Gold: 'Altin',
    Green: 'Yesil',
    Grey: 'Gri',
    Orange: 'Turuncu',
    Purple: 'Mor',
    Red: 'Kirmizi',
    Silver: 'Gumus',
    White: 'Beyaz',
    Yellow: 'Sari'
}));

function localizeIdentifier(value, rootName = '') {
    const cleaned = splitIdentifier(value)
        .replace(/\bMount\b/g, '')
        .replace(/\bPet\b/g, '')
        .replace(/\bType\b/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    if (!cleaned || /^Template$/i.test(cleaned)) {
        return 'Sablon';
    }

    const parts = cleaned.split(/\s+/).filter(Boolean);
    const translated = parts
        .map((part) => SIMPLE_NAME_PARTS.get(part) ?? part)
        .filter(Boolean)
        .join(' ')
        .replace(/\b(\w+)\s+\1\b/gi, '$1')
        .trim();

    return titleCaseAscii(translated || cleaned);
}

function colorizedIdentifier(value, rootName) {
    const raw = String(value || '');
    for (const [suffix, color] of COLOR_SUFFIXES.entries()) {
        if (raw.endsWith(suffix) && raw.length > suffix.length) {
            const base = raw.slice(0, -suffix.length);
            return titleCaseAscii(`${color} ${localizeIdentifier(base, rootName)}`);
        }
    }
    return localizeIdentifier(raw, rootName);
}

function rarityLabel(value) {
    return value === 'L' ? 'Efsanevi' : value === 'R' ? 'Nadir' : '';
}

function deriveLockboxName(name, type, rootName) {
    const raw = String(name || '');
    const rarity = raw.match(/Lockbox\d+([RL])/i)?.[1] || '';
    const color = [...COLOR_SUFFIXES.entries()].find(([suffix]) => raw.endsWith(suffix))?.[1] || '';
    const category = type === 'Mount' || /^MountLockbox/i.test(raw) ? 'Binek' : 'Evcil';
    const parts = [color, rarityLabel(rarity), category, 'Sandigi'].filter(Boolean);
    if (parts.length > 2) {
        return titleCaseAscii(parts.join(' '));
    }
    return colorizedIdentifier(raw, rootName);
}

function deriveGearDisplayName(entry) {
    const gearName = getAttr(entry, 'GearName');
    if (/^No(.+?)(Sword|Shield|Armor|Boots|Gloves|Hat)$/i.test(gearName)) {
        const [, klass, slot] = gearName.match(/^No(.+?)(Sword|Shield|Armor|Boots|Gloves|Hat)$/i);
        return titleCaseAscii(`${localizeIdentifier(klass, 'GearTypes')} ${localizeIdentifier(slot, 'GearTypes')} Yok`);
    }

    if (/Template/i.test(gearName)) {
        return 'Sablon';
    }

    const rarity = getTag(entry, 'Rarity') || gearName.match(/(\d+)([RL])$/i)?.[2] || '';
    const rarityText = rarityLabel(String(rarity).toUpperCase());
    const level = getTag(entry, 'Level') || gearName.match(/(\d+)(?:[RL])?$/i)?.[1] || '';
    const usedBy = getTag(entry, 'UsedBy');
    const classText = /^(?:Paladin|Mage|Rogue)$/i.test(usedBy) && !new RegExp(usedBy, 'i').test(gearName)
        ? localizeIdentifier(usedBy, 'GearTypes')
        : '';
    const baseName = gearName
        .replace(/(\d+)([RL])$/i, '$1')
        .replace(/\d+[A-Z]{0,2}$/i, '')
        .replace(/Lockbox\d*/gi, '')
        .replace(/\bGear\b/gi, '')
        .replace(/^(?:Unique|Special)/i, (prefix) => `${prefix} `)
        .replace(/\s+/g, ' ')
        .trim();
    const localizedBase = localizeIdentifier(baseName || getAttr(entry, 'Type') || 'Esya', 'GearTypes')
        .replace(/\b01\b/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    const levelText = level && level !== '0' ? `Seviye ${level}` : '';

    return titleCaseAscii([rarityText, classText, localizedBase, levelText].filter(Boolean).join(' '));
}

function deriveDisplayName(rootName, entry) {
    if (rootName === 'MaterialTypes') {
        const rarity = getTag(entry, 'Rarity');
        const realm = getTag(entry, 'DropRealm') || getAttr(entry, 'MaterialName');
        if (/Template/i.test(getAttr(entry, 'MaterialName'))) {
            return 'Malzeme Sablonu';
        }
        const prefix = rarity === 'L' ? 'Efsanevi ' : rarity === 'R' ? 'Nadir ' : '';
        return titleCaseAscii(`${prefix}${localizeIdentifier(realm, rootName)} Parcasi`);
    }

    if (rootName === 'PetTypes') {
        const petName = getAttr(entry, 'PetName');
        if (/Lockbox/i.test(petName)) {
            return deriveLockboxName(petName, 'Pet', rootName);
        }
        return colorizedIdentifier(getAttr(entry, 'PetName'), rootName);
    }

    if (rootName === 'MountTypes') {
        const mountName = getAttr(entry, 'MountName');
        if (/Lockbox/i.test(mountName)) {
            return deriveLockboxName(mountName, 'Mount', rootName);
        }
        return colorizedIdentifier(mountName, rootName);
    }

    if (rootName === 'GearTypes') {
        return deriveGearDisplayName(entry);
    }

    if (rootName === 'ConsumableTypes') {
        const name = getAttr(entry, 'ConsumableName');
        const exact = new Map(Object.entries({
            MinorRareCatalyst: 'Kucuk Nadir Katalizor',
            MinorLegendaryCatalyst: 'Kucuk Efsanevi Katalizor',
            MajorRareCatalyst: 'Buyuk Nadir Katalizor',
            MajorLegendaryCatalyst: 'Buyuk Efsanevi Katalizor',
            Resurrection: 'Dirilis Iksiri',
            PetFood: 'Evcil Yemi',
            RarePetFood: 'Efsanevi Evcil Yemi'
        }));
        return exact.get(name) || localizeIdentifier(name, rootName);
    }

    if (rootName === 'DyeTypes') {
        return colorizedIdentifier(getTag(entry, 'DyeName') || getAttr(entry, 'DyeName'), rootName);
    }

    if (rootName === 'RoyalStoreTypes') {
        const name = getAttr(entry, 'RoyalStoreName');
        const exact = new Map(Object.entries({
            RespecStone: 'Yetenek Sifirlama Tasi',
            Resurrection: 'Dirilis Iksiri',
            ForgeXP: 'Zanaatkar Ruhu',
            CharmRemover: 'Tilsim Sokucu',
            XPFindRegular: 'XP Artis Iksiri X3',
            MaterialFindRegular: 'Malzeme Bulma Iksiri X3',
            GoldFindRegular: 'Altin Bulma Iksiri X3',
            GearFindRegular: 'Ekipman Bulma Iksiri X3'
        }));
        if (/Lockbox/i.test(name)) {
            return deriveLockboxName(name, getTag(entry, 'Type'), rootName);
        }
        return exact.get(name) || localizeIdentifier(getAttr(entry, 'ItemName') || name || getTag(entry, 'Type'), rootName);
    }

    if (rootName === 'LockboxTypes') {
        return localizeIdentifier(getAttr(entry, 'LockboxName'), rootName);
    }

    if (rootName === 'LevelTypes') {
        const exact = new Map(Object.entries({
            TutorialBoat: 'Goblin Saldirisi',
            TutorialDungeon: 'Goblin Kaciricilar',
            GoblinRiverDungeon: 'Goblin Kampi',
            GhostBossDungeon: "Nephit'in Pesinde",
            DreamDragonDungeon: 'Ejderhanin Ruyasi'
        }));
        const levelName = getAttr(entry, 'LevelName');
        return exact.get(levelName) || localizeIdentifier(levelName, rootName);
    }

    if (rootName === 'BuildingTypes') {
        return localizeIdentifier(getAttr(entry, 'BuildingName') || getTag(entry, 'Type'), rootName);
    }

    if (rootName === 'MissionGroups') {
        return localizeIdentifier(getAttr(entry, 'MissionGroupName'), rootName);
    }

    if (rootName === 'EntTypes') {
        return localizeIdentifier(getAttr(entry, 'EntName'), rootName);
    }

    if (rootName === 'StatueTypes') {
        return localizeIdentifier(getAttr(entry, 'StatueName'), rootName);
    }

    if (rootName === 'CharmTypes') {
        return localizeIdentifier(getAttr(entry, 'CharmName'), rootName);
    }

    return '';
}

function fallbackDerivedName(rootName, entry) {
    if (rootName === 'PetTypes') {
        return titleCaseAscii(`Evcil ${getTag(entry, 'PetID') || getAttr(entry, 'PetName') || 'Sablon'}`);
    }
    if (rootName === 'MountTypes') {
        return titleCaseAscii(`Binek ${getTag(entry, 'MountID') || getAttr(entry, 'MountName') || 'Sablon'}`);
    }
    if (rootName === 'GearTypes') {
        const type = localizeIdentifier(getAttr(entry, 'Type') || 'Esya', rootName);
        const level = getTag(entry, 'Level');
        const gearId = getAttr(entry, 'GearID');
        return titleCaseAscii(`${type} ${level || gearId || ''}`.trim());
    }
    if (rootName === 'MaterialTypes') {
        return titleCaseAscii(`Malzeme ${getTag(entry, 'MaterialID') || getAttr(entry, 'MaterialName') || ''}`.trim());
    }
    if (rootName === 'DyeTypes') {
        return titleCaseAscii(`Boya ${getTag(entry, 'DyeID') || getTag(entry, 'DyeName') || ''}`.trim());
    }
    if (rootName === 'RoyalStoreTypes') {
        return titleCaseAscii(`Magaza Esyasi ${getTag(entry, 'RoyalStoreID') || getAttr(entry, 'RoyalStoreName') || ''}`.trim());
    }
    if (rootName === 'BuildingTypes') {
        return titleCaseAscii(`Bina ${getTag(entry, 'BuildingID') || getAttr(entry, 'BuildingName') || ''}`.trim());
    }
    if (rootName === 'EntTypes') {
        const level = getTag(entry, 'Level');
        return titleCaseAscii(`Varlik ${level || getAttr(entry, 'EntName') || ''}`.trim());
    }
    if (rootName === 'StatueTypes') {
        return titleCaseAscii(`Heykel ${getTag(entry, 'StatueID') || getAttr(entry, 'StatueName') || ''}`.trim());
    }
    if (rootName === 'LevelTypes') {
        return titleCaseAscii(`Bolge ${getAttr(entry, 'LevelName') || getTag(entry, 'ZoneSet') || ''}`.trim());
    }
    return '';
}

function safeDerivedName(rootName, entry) {
    const candidate = normalizeUnsupportedTurkishGlyphs(deriveDisplayName(rootName, entry) || '');
    if (candidate && !/\bYerel\b/i.test(candidate) && !/^[\s,.-]*$/.test(candidate)) {
        return candidate;
    }
    return normalizeUnsupportedTurkishGlyphs(fallbackDerivedName(rootName, entry));
}

function shouldReplaceDisplayName(value) {
    return /\bYerel\b/i.test(value) || /^[\s,.-]*$/.test(normalizeKey(value));
}

const ALWAYS_DERIVE_DISPLAY_NAMES = new Set(['GearTypes']);

const ENTRY_TAGS_BY_ROOT = new Map(Object.entries({
    BuildingTypes: 'Building',
    CharmTypes: 'CharmType',
    ConsumableTypes: 'ConsumableType',
    DyeTypes: 'DyeType',
    EntTypes: 'EntType',
    GearTypes: 'Gear',
    LevelTypes: 'LevelType',
    LockboxTypes: 'LockboxType',
    MaterialTypes: 'MaterialType',
    MissionGroups: 'MissionGroup',
    MountTypes: 'MountType',
    PetTypes: 'PetType',
    RoyalStoreTypes: 'RoyalStoreType',
    StatueTypes: 'Statue'
}));

function patchDerivedDisplayNames(xml, rootName, stats) {
    const entryTag = ENTRY_TAGS_BY_ROOT.get(rootName);
    if (!entryTag) {
        return xml;
    }

    const entryRegex = new RegExp(`<${entryTag}\\b[\\s\\S]*?<\\/${entryTag}>`, 'g');
    return xml.replace(entryRegex, (entry) => {
        const current = getTag(entry, 'DisplayName');
        if (!ALWAYS_DERIVE_DISPLAY_NAMES.has(rootName) && !shouldReplaceDisplayName(current)) {
            return entry;
        }

        const derived = safeDerivedName(rootName, entry);
        if (!derived || /\bYerel\b/i.test(derived) || normalizeKey(derived) === normalizeKey(current)) {
            return entry;
        }

        stats.updated += 1;
        stats.byTag.DisplayName = (stats.byTag.DisplayName || 0) + 1;
        return entry.replace(/<DisplayName>[\s\S]*?<\/DisplayName>/, `<DisplayName>${escapeXmlText(derived)}</DisplayName>`);
    });
}

function patchXmlResource(xml, rootName, translations, missions, stats) {
    if (rootName === 'MissionTypes') {
        return patchMissionTypes(xml, translations, missions, stats);
    }

    return patchDerivedDisplayNames(patchGenericXml(xml, rootName, translations, stats), rootName, stats);
}

function patchSwz(sourceSwzPath, targetSwzPath, translations, missions, verifyOnly) {
    const decoded = decodeSwz(fs.readFileSync(sourceSwzPath));
    const stats = { updated: 0, byTag: {} };
    const entries = decoded.entries.map((entry) => ({
        ...entry,
        xml: patchXmlResource(entry.xml, entry.rootName, translations, missions, stats)
    }));

    if (!verifyOnly) {
        fs.writeFileSync(targetSwzPath, encodeSwz(decoded.initialKey, entries));
    }

    return { stats, entries };
}

function patchStaticXml(xmlRoot, entries, translations, missions, verifyOnly, includeLooseXml) {
    const stats = { updated: 0, byTag: {} };
    if (!fs.existsSync(xmlRoot)) {
        return stats;
    }

    const entryByRoot = new Map(entries.map((entry) => [entry.rootName, entry.xml]));
    const syncedRoots = new Set();
    for (const [rootName, xml] of entryByRoot) {
        const filePath = path.join(xmlRoot, `${rootName}.xml`);
        if (!fs.existsSync(filePath)) {
            continue;
        }

        syncedRoots.add(rootName);
        const current = fs.readFileSync(filePath, 'utf8');
        if (current !== xml) {
            stats.updated += 1;
            stats.byTag[rootName] = (stats.byTag[rootName] || 0) + 1;
            if (!verifyOnly) {
                fs.writeFileSync(filePath, xml);
            }
        }
    }

    if (!includeLooseXml) {
        return stats;
    }

    for (const file of fs.readdirSync(xmlRoot)) {
        if (!file.endsWith('.xml')) {
            continue;
        }

        const rootName = path.basename(file, '.xml');
        if (syncedRoots.has(rootName)) {
            continue;
        }

        const filePath = path.join(xmlRoot, file);
        const current = fs.readFileSync(filePath, 'utf8');
        const before = stats.updated;
        const patched = patchDerivedDisplayNames(
            patchGenericXml(current, rootName, translations, stats, { allowAlreadyLocalizedSkip: true }),
            rootName,
            stats
        );
        if (!verifyOnly && stats.updated !== before) {
            fs.writeFileSync(filePath, patched);
        }
    }

    return stats;
}

function parseArgs(argv) {
    const args = {
        sourceSwz: '',
        swz: '',
        xmlRoot: XML_ROOT,
        looseXml: false,
        verify: false
    };

    for (let index = 2; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === '--swz') {
            args.swz = argv[++index] || '';
            continue;
        }
        if (arg === '--source-swz') {
            args.sourceSwz = argv[++index] || '';
            continue;
        }
        if (arg === '--xml-root') {
            args.xmlRoot = argv[++index] || '';
            continue;
        }
        if (arg === '--loose-xml') {
            args.looseXml = true;
            continue;
        }
        if (arg === '--verify') {
            args.verify = true;
            continue;
        }
        throw new Error(`Unknown argument: ${arg}`);
    }

    return args;
}

function main() {
    const args = parseArgs(process.argv);
    const root = repoRoot();
    const { translations, missions } = loadTranslations(root);
    const sourceSwzPath = resolveSourceSwzPath(root, args.sourceSwz);
    const targetSwzPath = resolveTargetSwzPath(root, args.swz);
    const xmlRoot = resolvePath(root, args.xmlRoot);

    const { stats: swzStats, entries } = patchSwz(sourceSwzPath, targetSwzPath, translations, missions, args.verify);
    const xmlStats = patchStaticXml(xmlRoot, entries, translations, missions, args.verify, args.looseXml);
    console.log(JSON.stringify({
        sourceSwz: path.relative(root, sourceSwzPath),
        targetSwz: path.relative(root, targetSwzPath),
        swz: swzStats,
        xml: xmlStats
    }, null, 2));
}

main();
