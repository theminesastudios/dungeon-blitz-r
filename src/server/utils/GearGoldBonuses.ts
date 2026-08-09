import * as fs from 'fs';
import * as path from 'path';
import { MAX_GEAR_TIER } from '../core/GameData';
import { resolveClientXmlDir } from './ClientXmlDir';

const gearGoldFindByKey = new Map<string, number>();
let loaded = false;

function parseNumber(value: string | undefined): number {
    const parsed = Number(value ?? 0);
    return Number.isFinite(parsed) ? parsed : 0;
}

function readTag(block: string, tagName: string): string {
    const match = block.match(new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, 'i'));
    return match?.[1]?.trim() ?? '';
}

function decodeXmlText(value: string): string {
    return value
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
}

function normalizeGearId(value: unknown): number {
    const gearId = Number(value ?? 0);
    return Number.isFinite(gearId) && gearId > 0 ? Math.round(gearId) : 0;
}

function normalizeTier(value: unknown): number {
    const tier = Number(value ?? 0);
    if (!Number.isFinite(tier) || tier <= 0) {
        return 0;
    }
    return Math.min(MAX_GEAR_TIER, Math.round(tier));
}

function tierFromRarity(rarity: string): number {
    switch (rarity.trim().toUpperCase()) {
        case 'R':
            return 1;
        case 'L':
            return 2;
        case 'Y':
            return 3;
        default:
            return 0;
    }
}

function loadGearGoldFind(): void {
    if (loaded) {
        return;
    }
    loaded = true;

    const xmlDir = resolveClientXmlDir(['GearTypes.xml', 'MagicTypes.xml']);
    if (!xmlDir) {
        console.warn('[GearGoldBonuses] GearTypes.xml/MagicTypes.xml not found; gear gold find is disabled.');
        return;
    }

    try {
        const magicXml = fs.readFileSync(path.join(xmlDir, 'MagicTypes.xml'), 'utf8');
        const magicGoldFindByName = new Map<string, number>();
        const magicPattern = /<MagicType\s+MagicName="([^"]+)"[\s\S]*?<\/MagicType>/g;
        let magicMatch: RegExpExecArray | null;

        while ((magicMatch = magicPattern.exec(magicXml)) !== null) {
            const magicName = decodeXmlText(magicMatch[1] ?? '').trim();
            if (magicName && magicName !== '---Template---') {
                magicGoldFindByName.set(magicName, parseNumber(readTag(magicMatch[0], 'GoldDrop')));
            }
        }

        const gearXml = fs.readFileSync(path.join(xmlDir, 'GearTypes.xml'), 'utf8');
        const gearPattern = /<Gear\s+[^>]*\bGearID="([^"]+)"[^>]*>[\s\S]*?<\/Gear>/g;
        let gearMatch: RegExpExecArray | null;

        while ((gearMatch = gearPattern.exec(gearXml)) !== null) {
            const gearId = normalizeGearId(gearMatch[1]);
            if (gearId <= 0) {
                continue;
            }

            const gearBlock = gearMatch[0];
            const magicRune = decodeXmlText(readTag(gearBlock, 'MagicRune'));
            const goldFind = magicGoldFindByName.get(magicRune) ?? 0;
            if (goldFind <= 0) {
                continue;
            }

            const tier = tierFromRarity(readTag(gearBlock, 'Rarity'));
            gearGoldFindByKey.set(`${gearId}:${tier}`, goldFind);
        }

        console.log(`[GearGoldBonuses] Loaded ${gearGoldFindByKey.size} gear gold find entries from ${xmlDir}.`);
    } catch (err) {
        gearGoldFindByKey.clear();
        console.error('[GearGoldBonuses] Failed to load gear gold find:', err);
    }
}

export function getEquippedGearGoldFind(character: any): number {
    loadGearGoldFind();

    let goldFind = 0;
    for (const rawGear of Array.isArray(character?.equippedGears) ? character.equippedGears : []) {
        const gearId = normalizeGearId(rawGear?.gearID);
        if (gearId <= 0) {
            continue;
        }

        goldFind += gearGoldFindByKey.get(`${gearId}:${normalizeTier(rawGear?.tier)}`) ?? 0;
    }

    return goldFind;
}
