#!/usr/bin/env node

/**
 * Adds the Loot Hound pet (PetID 72) to the client data archives.
 *
 * The Flash client never reads src/client/content/xml — that tree is a server-side
 * reference copy. Client game data lives in the SWZ archives, so a new pet needs
 * three separate additions:
 *
 *   Login.swz  -> EntTypes         : PetHoundGreen, the follower entity the client
 *                                    renders. class_41.method_85 resolves a pet's art
 *                                    as "Pet" + PetName and logs "Missing Pet Entity"
 *                                    (blank icon) when it is absent.
 *   Game*.swz  -> PetTypes         : the pet itself.
 *   Game*.swz  -> PlayerPowerTypes : PetLootHound, the VanityPet power that supplies
 *                                    the tooltip's "Use:" line.
 *
 * The entity inherits DireBase (the shared quadruped mount skeleton) and deliberately
 * omits <Flying>, which Base defaults to false — that is what keeps this pet on the
 * ground while every stock pet hovers.
 *
 * Usage:
 *   node src/server/scripts/patch-game-swz-loot-hound-pet.js [--verify]
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PET_ID = 72;
const PET_NAME = 'HoundGreen';
const ENT_NAME = 'Pet' + PET_NAME;
const POWER_NAME = 'PetLootHound';
const POWER_ID = 6150;
const BACKUP_SUFFIX = '.bak-loothound';

const CBQ = path.join('src', 'client', 'content', 'localhost', 'p', 'cbq');
const CBP = path.join('src', 'client', 'content', 'localhost', 'p', 'cbp');

/**
 * Look of the pet. The DireMount skeleton is a layered dress-up rig: CustomArt picks the body
 * and the barding is baked into the base rig, which is why an uncoloured pet renders the stock
 * grey plates and red saddle cloth. Painting every DmArmor* key in the fur tones hides the
 * barding, leaving a plain animal.
 *
 * Body options on this rig: Tiger, Saber, Saber2 (cats) - Bear (wolf/bear) - Boar, Rhino, Drake.
 * Swap ART_BODY and re-run this script to try another animal.
 */
const ART_BODY = 'Tiger';
const ART_COLORS = [
    'DmFur=0xC8862F',
    'DmFurDk=0x9A5F22',
    'DmArmor=0xC8862F',
    'DmArmorLt=0xE0A855',
    'DmArmorDk=0x9A5F22',
    'DmArmorTrim=0xC8862F',
    'DmArmorTrimDk=0x9A5F22'
];

const LOCALES = {
    en: {
        displayName: "Neo's Minnos",
        bonusInfo: 'Picks up gold it walks over for you',
        description: 'A keen-nosed companion that trots along at your heel and snaps up any dropped gold it passes. You can still collect gold yourself.',
        powerDisplayName: "Summon Neo's Minnos",
        powerDescription: 'Summons a hound that follows you around and picks up dropped gold.'
    },
    tr: {
        displayName: "Neo's Minnos",
        bonusInfo: 'Uzerinden gectigi altinlari senin yerine toplar',
        description: 'Kesin burunlu bir yoldas. Pesinde yurur ve gectigi yerdeki dusen altinlari toplar. Altini kendin de toplayabilirsin.',
        powerDisplayName: "Neo's Minnos Cagir",
        powerDescription: 'Pesinde gezen ve dusen altinlari toplayan bir tazi cagirir.'
    }
};

function repoRoot() {
    return path.resolve(__dirname, '..', '..', '..');
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
        entries.push({ rootName: xml.match(/<([A-Za-z0-9_:-]+)/)?.[1] || '', xml });
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

/** Each archive uses its own line endings; match them so the diff stays clean. */
function detectEol(xml) {
    return xml.includes('\r\n') ? '\r\n' : '\n';
}

function buildEntType(eol) {
    return [
        '\t<EntType EntName="' + ENT_NAME + '" parent="DireBase">',
        '\t\t<DisplayName>Pet</DisplayName>',
        // Realm/DevStatus MUST stay "Pet" (the cosmetic vanity realm). Switching to NatureGuard's
        // "PlayerPet" realm did fix the run-after-knockback animation, but it also made the client
        // treat the pet as a room-bound combat ally: it stopped following the player through doors
        // into dungeon rooms (left behind outside), which makes a loot pet useless. Room-following is
        // essential and non-negotiable, so we keep the vanity realm and accept the cosmetic
        // hit-animation quirk. (A grounded, follow-everywhere, untargetable pet is not expressible in
        // the EntType schema — there is no untargetable flag, and the untargetable brains all hover.)
        '\t\t<DevStatus>Pet</DevStatus>',
        '\t\t<MeleeDamage>1</MeleeDamage>',
        '\t\t<MagicDamage>1</MagicDamage>',
        '\t\t<ArmorClass>1</ArmorClass>',
        // FollowPet is a grounded, *targetable* brain (only the hovering LittlePet/WanderingPet
        // brains set bUntargetable), so enemies can hit this pet. With HitPoints=1 a single stray
        // blow or AoE killed it and it vanished from the player's side mid-combat. There is no
        // untargetable flag in the EntType schema, so make it effectively immortal instead: it can
        // still be struck (and may flinch), but it will not die and disappear.
        '\t\t<HitPoints>999999</HitPoints>',
        '\t\t<Realm>Pet</Realm>',
        '\t\t<EntRank>Pet</EntRank>',
        '\t\t<Speed>13</Speed>',
        '\t\t<Width>50</Width>',
        '\t\t<Height>50</Height>',
        // LittlePet drives the hovering pet brain (BehaviorType.var_844 -> class_176), which
        // fights gravity on a grounded entity and makes the pet bounce. FollowPet is the
        // walking follower brain NatureGuard uses. Trade-off: FollowPet omits bUntargetable,
        // so this pet can be targeted; gold pickup is decided in Loot.method_1300 and is
        // unaffected either way.
        '\t\t<Behavior>FollowPet</Behavior>',
        '\t\t<EquippedGear/>',
        '\t\t<GfxType>',
        '\t\t\t<CustomArt>Animation_DireMount.swf/' + ART_BODY + '</CustomArt>',
        '\t\t\t<RandomFrameStart>FALSE</RandomFrameStart>',
        '\t\t\t<AnimScale>0.4</AnimScale>',
        '\t\t\t<MoveAnimSpeed>1.4</MoveAnimSpeed>',
        ...ART_COLORS.map((swap, index) => '\t\t\t<ColorSwap' + (index === 0 ? '' : index + 1) + '>' + swap + '</ColorSwap' + (index === 0 ? '' : index + 1) + '>'),
        '\t\t</GfxType>',
        '\t</EntType>'
    ].join(eol) + eol;
}

function buildPetType(locale, eol) {
    return [
        '\t<PetType PetName="' + PET_NAME + '">',
        '\t\t<PetID>' + PET_ID + '</PetID>',
        '\t\t<PetLevel>30</PetLevel>',
        '\t\t<IdolCost>250</IdolCost>',
        '\t\t<DisplayName>' + locale.displayName + '</DisplayName>',
        '\t\t<PetPower>' + POWER_NAME + '</PetPower>',
        '\t\t<Kingdom>Any</Kingdom>',
        '\t\t<ItemFind>true</ItemFind>',
        '\t\t<GoldFind>true</GoldFind>',
        '\t\t<BonusInfo>' + locale.bonusInfo + '</BonusInfo>',
        '\t\t<ClassType>Lockbox01</ClassType>',
        '\t\t<Color>Green</Color>',
        '\t\t<Description>' + locale.description + '</Description>',
        '\t\t<UseVanityPower>TRUE</UseVanityPower>',
        '\t\t<DisplayRarity>L</DisplayRarity>',
        '\t</PetType>'
    ].join(eol) + eol;
}

function buildPower(locale, eol) {
    return [
        '\t<Power PowerName="' + POWER_NAME + '">',
        '\t\t<PowerID>' + POWER_ID + '</PowerID>',
        '\t\t<TargetMethod>VanityPet</TargetMethod>',
        '\t\t<CastTime>800</CastTime>',
        '\t\t<DisplayName>' + locale.powerDisplayName + '</DisplayName>',
        '\t\t<Description>' + locale.powerDescription + '</Description>',
        '\t\t<IconName>a_PetIcon_Gargoyle</IconName>',
        '\t\t<CastGfx/>',
        '\t\t<FireGfx/>',
        '\t\t<HitGfx/>',
        '\t\t<ProjGfx/>',
        '\t</Power>'
    ].join(eol) + eol;
}

/** Insert `block` immediately before the document's closing root tag. */
function insertBeforeClose(xml, closeTag, block) {
    const index = xml.lastIndexOf(closeTag);
    if (index === -1) {
        throw new Error('closing tag ' + closeTag + ' not found');
    }
    return xml.slice(0, index) + block + xml.slice(index);
}

/**
 * Replace an existing block, or append it before the closing root tag.
 * Rewriting in place keeps the script re-runnable while tuning the entity, instead of
 * silently no-oping once the first version has been written into the archive.
 */
function upsertBlock(xml, existingPattern, closeTag, block) {
    const match = xml.match(existingPattern);
    if (!match) {
        return { xml: insertBeforeClose(xml, closeTag, block), action: 'added' };
    }
    // Keep the leading indentation the original block sat on.
    const trimmed = block.replace(/^\t/, '').replace(/\r?\n$/, '');
    if (match[0].replace(/^\t/, '') === trimmed) {
        return { xml, action: 'unchanged' };
    }
    return { xml: xml.slice(0, match.index) + trimmed + xml.slice(match.index + match[0].length), action: 'updated' };
}

function patchArchive(absPath, mutate, verifyOnly, stats) {
    if (!fs.existsSync(absPath)) {
        throw new Error('missing archive: ' + absPath);
    }

    const original = fs.readFileSync(absPath);
    const decoded = decodeSwz(original);
    const result = mutate(decoded.entries, path.basename(absPath));

    if (!result.changed) {
        stats.push(path.basename(absPath) + ': already patched');
        return;
    }

    if (verifyOnly) {
        stats.push(path.basename(absPath) + ': WOULD PATCH -> ' + result.notes.join(', '));
        return;
    }

    const backupPath = absPath + BACKUP_SUFFIX;
    if (!fs.existsSync(backupPath)) {
        fs.writeFileSync(backupPath, original);
    }

    const encoded = encodeSwz(decoded.initialKey, decoded.entries);
    // Round-trip before overwriting: a corrupt archive bricks the client at load.
    const reread = decodeSwz(encoded);
    if (reread.entries.length !== decoded.entries.length) {
        throw new Error('round-trip entry count mismatch for ' + absPath);
    }
    for (let i = 0; i < reread.entries.length; i++) {
        if (reread.entries[i].xml !== decoded.entries[i].xml) {
            throw new Error('round-trip XML mismatch in ' + absPath + ' entry ' + i);
        }
    }

    fs.writeFileSync(absPath, encoded);
    stats.push(path.basename(absPath) + ': patched -> ' + result.notes.join(', '));
}

function main() {
    const verifyOnly = process.argv.includes('--verify');
    const root = repoRoot();
    const stats = [];

    // 1. The follower entity.
    patchArchive(path.join(root, CBP, 'Login.swz'), (entries) => {
        const entry = entries.find((e) => e.rootName === 'EntTypes');
        if (!entry) throw new Error('EntTypes entry not found in Login.swz');
        const eol = detectEol(entry.xml);
        const result = upsertBlock(
            entry.xml,
            new RegExp('\\t?<EntType EntName="' + ENT_NAME + '"[\\s\\S]*?</EntType>'),
            '</EntTypes>',
            buildEntType(eol)
        );
        entry.xml = result.xml;
        return { changed: result.action !== 'unchanged', notes: [ENT_NAME + ' entity ' + result.action] };
    }, verifyOnly, stats);

    // 2. The pet and its vanity power, per locale archive.
    for (const file of ['Game.swz', 'Game.en.swz', 'Game.tr.swz']) {
        const locale = file === 'Game.tr.swz' ? LOCALES.tr : LOCALES.en;
        patchArchive(path.join(root, CBQ, file), (entries) => {
            const notes = [];

            const pets = entries.find((e) => e.rootName === 'PetTypes');
            if (!pets) throw new Error('PetTypes entry not found in ' + file);
            if (!pets.xml.includes('PetName="' + PET_NAME + '"') && pets.xml.includes('<PetID>' + PET_ID + '</PetID>')) {
                throw new Error('PetID ' + PET_ID + ' already taken by another pet in ' + file);
            }
            const petResult = upsertBlock(
                pets.xml,
                new RegExp('\\t?<PetType PetName="' + PET_NAME + '">[\\s\\S]*?</PetType>'),
                '</PetTypes>',
                buildPetType(locale, detectEol(pets.xml))
            );
            pets.xml = petResult.xml;
            if (petResult.action !== 'unchanged') notes.push('PetID ' + PET_ID + ' ' + petResult.action);

            const powers = entries.find((e) => e.rootName === 'PlayerPowerTypes');
            if (!powers) throw new Error('PlayerPowerTypes entry not found in ' + file);
            if (!powers.xml.includes('PowerName="' + POWER_NAME + '"') && powers.xml.includes('<PowerID>' + POWER_ID + '</PowerID>')) {
                throw new Error('PowerID ' + POWER_ID + ' already taken by another power in ' + file);
            }
            const powerResult = upsertBlock(
                powers.xml,
                new RegExp('\\t?<Power PowerName="' + POWER_NAME + '">[\\s\\S]*?</Power>'),
                '</PlayerPowerTypes>',
                buildPower(locale, detectEol(powers.xml))
            );
            powers.xml = powerResult.xml;
            if (powerResult.action !== 'unchanged') notes.push(POWER_NAME + ' ' + powerResult.action);

            return { changed: notes.length > 0, notes };
        }, verifyOnly, stats);
    }

    console.log(stats.map((line) => '  ' + line).join('\n'));
    console.log(verifyOnly ? '\nverify only, nothing written' : '\ndone');
}

main();
