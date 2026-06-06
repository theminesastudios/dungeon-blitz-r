import * as fs from 'fs';
import * as path from 'path';
import { ensureBackup, parseSwz, writeSwz } from './swzPatchUtils';

type PatchStats = {
    powerBlocks: number;
    buffBlocks: number;
    modBlocks: number;
    changes: number;
};

type PatchResult = {
    xml: string;
    stats: PatchStats;
};

const EMPTY_STATS: PatchStats = {
    powerBlocks: 0,
    buffBlocks: 0,
    modBlocks: 0,
    changes: 0
};

const SERVER_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(SERVER_ROOT, '..', '..');
const XML_DIR = path.join(REPO_ROOT, 'src', 'client', 'content', 'xml');
const CBQ_DIR = path.join(REPO_ROOT, 'src', 'client', 'content', 'localhost', 'p', 'cbq');

const POWER_XML = path.join(XML_DIR, 'PlayerPowerTypes.xml');
const BUFF_XML = path.join(XML_DIR, 'PlayerBuffTypes.xml');
const POWER_MOD_XML = path.join(XML_DIR, 'PowerModTypes.xml');

const PYROMANIA_EXPIRE_COOLDOWN_MS = '10000';
const PYROMANIA_MANA_COST_BY_RANK = new Map<number, string>([
    [0, '40'],
    [1, '20'],
    [2, '20'],
    [3, '15'],
    [4, '15'],
    [5, '15'],
    [6, '15'],
    [7, '10'],
    [8, '10'],
    [9, '10'],
    [10, '10']
]);

const FIREBRAND_SHOTS = [
    { name: 'FireBrandShot1', powerID: 6143, aoeRadius: 90, baseDamageMult: '1', addTargetBuff: 'Scorched' },
    { name: 'FireBrandShot3', powerID: 6144, aoeRadius: 105, baseDamageMult: '1', addTargetBuff: 'Scorched' },
    { name: 'FireBrandShot6', powerID: 6145, aoeRadius: 120, baseDamageMult: '0.5', addTargetBuff: 'Scorched,Burned' },
    { name: 'FlameAxeFireBrandShot8', powerID: 6146, range: 800, baseDamageMult: '1', addTargetBuff: 'Scorched' },
    { name: 'FlameAxeFireBrandShot8Pierce', powerID: 6147, range: 800, baseDamageMult: '0.75', addTargetBuff: 'Scorched' }
];

type DragonSoulShotEffect = {
    aoeRadius?: string;
    range?: string;
    addTargetBuff: string;
};

const DRAGON_SOUL_SPAWN_DURATION_BY_RANK = new Map<number, string>([
    [0, '13000'],
    [1, '11000'],
    [2, '12000'],
    [3, '13000'],
    [4, '13000'],
    [5, '13000'],
    [6, '13500'],
    [7, '13500'],
    [8, '14500'],
    [9, '15000'],
    [10, '15000']
]);

const FIREBRAND_OVERRIDE_BY_BUFF = new Map<string, string>([
    ['FireBrand', 'FireBrandShot1'],
    ['FireBrandRank1', 'FireBrandShot1'],
    ['FireBrandRank3', 'FireBrandShot3'],
    ['FireBrandRank6', 'FireBrandShot6'],
    ['FireBrandRank8', 'FlameAxeFireBrandShot8']
]);

const ACCELERANT_VALUES_BY_RANK = ['.02', '.04', '.06', '.09', '.15'];
const ACCELERANT_DESCRIPTION = 'Yanma Hasari artar.@Yanma Hasari:, +6%, +13%, +20%, +30%, +50%';

function cloneStats(): PatchStats {
    return { ...EMPTY_STATS };
}

function mergeStats(...stats: PatchStats[]): PatchStats {
    return stats.reduce((merged, item) => ({
        powerBlocks: merged.powerBlocks + item.powerBlocks,
        buffBlocks: merged.buffBlocks + item.buffBlocks,
        modBlocks: merged.modBlocks + item.modBlocks,
        changes: merged.changes + item.changes
    }), cloneStats());
}

function applyPatch(block: string, stats: PatchStats, patch: { block: string; changed: boolean }): string {
    if (patch.changed) {
        stats.changes += 1;
    }
    return patch.block;
}

function rankOf(powerName: string, baseName: string): number {
    if (powerName === baseName) {
        return 0;
    }
    const suffix = powerName.slice(baseName.length);
    return Math.max(1, Number(suffix) || 1);
}

function replaceTag(block: string, tag: string, value: string): { block: string; changed: boolean } {
    const next = block.replace(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`), `<${tag}>${value}</${tag}>`);
    return { block: next, changed: next !== block };
}

function removeTag(block: string, tag: string): { block: string; changed: boolean } {
    const next = block.replace(new RegExp(`\\r?\\n\\t\\t<${tag}>[\\s\\S]*?</${tag}>`, 'g'), '');
    return { block: next, changed: next !== block };
}

function upsertTagAfter(block: string, tag: string, value: string, afterTag: string): { block: string; changed: boolean } {
    if (new RegExp(`<${tag}>`).test(block)) {
        return replaceTag(block, tag, value);
    }
    const next = block.replace(
        new RegExp(`(<${afterTag}>[\\s\\S]*?</${afterTag}>)`),
        `$1\r\n\t\t<${tag}>${value}</${tag}>`
    );
    return { block: next, changed: next !== block };
}

function addBuffs(list: string, ...buffs: string[]): string {
    const parts = list.split(',').map((part) => part.trim()).filter(Boolean);
    for (const buff of buffs) {
        if (!parts.includes(buff)) {
            parts.push(buff);
        }
    }
    return parts.join(',');
}

function addTargetBuff(block: string, ...buffs: string[]): { block: string; changed: boolean } {
    const match = block.match(/<AddTargetBuff>([^<]*)<\/AddTargetBuff>/);
    if (match) {
        return replaceTag(block, 'AddTargetBuff', addBuffs(match[1], ...buffs));
    }
    return upsertTagAfter(block, 'AddTargetBuff', buffs.join(','), 'PowerGroup');
}

function dragonSoulShotEffectForRank(rank: number): DragonSoulShotEffect {
    if (rank >= 8) {
        return { range: '800', addTargetBuff: 'Scorched' };
    }
    if (rank >= 6) {
        return { aoeRadius: '120', addTargetBuff: 'Scorched,Burned' };
    }
    if (rank >= 3) {
        return { aoeRadius: '105', addTargetBuff: 'Scorched' };
    }
    return { aoeRadius: '90', addTargetBuff: 'Scorched' };
}

function patchDragonSoulShotBlock(block: string, rank: number, stats: PatchStats): string {
    const effect = dragonSoulShotEffectForRank(rank);
    let next = block;
    stats.powerBlocks += 1;
    next = applyPatch(next, stats, removeTag(next, effect.range ? 'AoERadius' : 'Range'));
    if (effect.range) {
        next = applyPatch(next, stats, upsertTagAfter(next, 'Range', effect.range, 'TargetMethod'));
    }
    if (effect.aoeRadius) {
        next = applyPatch(next, stats, upsertTagAfter(next, 'AoERadius', effect.aoeRadius, 'TargetMethod'));
    }
    next = applyPatch(next, stats, addTargetBuff(next, ...effect.addTargetBuff.split(',')));
    return next;
}

function buildFireBrandShotPower(def: (typeof FIREBRAND_SHOTS)[number]): string {
    const areaTags = [
        'range' in def ? `\t\t<Range>${def.range}</Range>` : '',
        'aoeRadius' in def ? `\t\t<AoERadius>${def.aoeRadius}</AoERadius>` : ''
    ].filter(Boolean).join('\r\n');
    const isPiercingBasicShot = def.name === 'FlameAxeFireBrandShot8' || def.name === 'FlameAxeFireBrandShot8Pierce';

    return [
        `\t<Power PowerName="${def.name}">`,
        `\t\t<PowerID>${def.powerID}</PowerID>`,
        '\t\t<TargetMethod>ProjectileCombo</TargetMethod>',
        areaTags,
        '\t\t<CastAnim>Shoot</CastAnim>',
        '\t\t<CastTime>0</CastTime>',
        '\t\t<RecoverTime>500</RecoverTime>',
        '\t\t<CoolDownTime>0</CoolDownTime>',
        '\t\t<ManaCost>0</ManaCost>',
        `\t\t<BaseDamageMult>${def.baseDamageMult}</BaseDamageMult>`,
        '\t\t<ProcModifier>0</ProcModifier>',
        '\t\t<DamageType>Fire</DamageType>',
        '\t\t<PowerGroup>FireBrandShot</PowerGroup>',
        `\t\t<AddTargetBuff>${def.addTargetBuff}</AddTargetBuff>`,
        isPiercingBasicShot ? '\t\t<DisplayName>Ates Topu</DisplayName>' : '\t\t<DisplayName>Alev Damgasi Atisi</DisplayName>',
        def.name === 'FlameAxeFireBrandShot8Pierce'
            ? '\t\t<Description>Alevgorur temel menzilli saldirisi. Ilk hedeften sonraki hedeflere azaltimli hasar verir.</Description>'
            : isPiercingBasicShot
                ? '\t\t<Description>Alevgorur temel menzilli saldirisi. Hedeflere carpinca durmak yerine iclerinden gecer.</Description>'
                : '\t\t<Description>Alev Damgasi etkinken menzilli saldirilar alev alan hasari verir.</Description>',
        isPiercingBasicShot ? '\t\t<IconName>a_PowerIcon_FireBall</IconName>' : '\t\t<IconName>a_PowerIcon_CrimsonShot</IconName>',
        isPiercingBasicShot
            ? '\t\t<CastSound>CHR_FlameSeer_Fireball_Fire_01|CHR_FlameSeer_Fireball_Fire_02|CHR_FlameSeer_Fireball_Fire_03</CastSound>'
            : '\t\t<CastSound>CHR_Flameseer_CrimsonShot_A</CastSound>',
        '\t\t<CastGfx/>',
        '\t\t<CastAnimSource>Feet</CastAnimSource>',
        '\t\t<FireSound>snd_pwr_range_fireball_imp_01</FireSound>',
        '\t\t<FireAnimSource>Center</FireAnimSource>',
        isPiercingBasicShot
            ? '\t\t<FireGfx>\r\n\t\t\t<AnimFile>SFX_1.swf</AnimFile>\r\n\t\t\t<AnimClass>a_CrimsonShotImpact</AnimClass>\r\n\t\t\t<AnimScale>1</AnimScale>\r\n\t\t\t<FireAndForget>true</FireAndForget>\r\n\t\t</FireGfx>'
            : '\t\t<FireGfx/>',
        '\t\t<HitGfx/>',
        '\t\t<ProjGfx>',
        '\t\t\t<AnimFile>SFX_1.swf</AnimFile>',
        '\t\t\t<AnimClass>a_CrimsonShotMolten,a_CrimsonShotSuper</AnimClass>',
        '\t\t\t<AnimScale>1</AnimScale>',
        '\t\t\t<FireAndForget>FALSE</FireAndForget>',
        '\t\t</ProjGfx>',
        '\t</Power>'
    ].filter(Boolean).join('\r\n');
}

function ensureFireBrandShotPowers(xml: string, stats: PatchStats): string {
    const withoutGeneratedShots = xml.replace(
        /\r?\n\t<Power PowerName="(?:FireBrandShot(?:1|3|4|6|7|8)|FlameAxeFireBrandShot8(?:Pierce)?)">[\s\S]*?\r?\n\t<\/Power>/g,
        ''
    );
    const fireBrandShotXml = FIREBRAND_SHOTS.map(buildFireBrandShotPower).join('\r\n');
    const patched = withoutGeneratedShots.replace(
        /(\r?\n\t<Power PowerName="FireBrand10">[\s\S]*?\r?\n\t<\/Power>)/,
        `$1\r\n${fireBrandShotXml}`
    );
    if (patched !== xml) {
        stats.changes += 1;
    }
    return patched;
}

function patchPowerBlock(powerName: string, block: string, stats: PatchStats): string {
    let next = block;
    if (/^IridescentBurst(?:\d+)?$/.test(powerName)) {
        stats.powerBlocks += 1;
        next = applyPatch(next, stats, addTargetBuff(next, 'Weakened'));
    } else if (/^FlameStrike(?:\d+)?$/.test(powerName)) {
        stats.powerBlocks += 1;
        next = applyPatch(next, stats, addTargetBuff(next, 'ConflagrationSlow'));
    } else if (/^MoltenFist(?:\d+)?$/.test(powerName)) {
        stats.powerBlocks += 1;
        const rank = rankOf(powerName, 'MoltenFist');
        const stunBuff = rank >= 6 ? 'MoltenFistStun2000' : 'MoltenFistStun1000';
        next = applyPatch(next, stats, addTargetBuff(next, 'Crippled', stunBuff));
    } else if (/^Pyromania(?:\d+)?$/.test(powerName)) {
        stats.powerBlocks += 1;
        const rank = rankOf(powerName, 'Pyromania');
        next = applyPatch(next, stats, replaceTag(next, 'ManaCost', PYROMANIA_MANA_COST_BY_RANK.get(rank) ?? '10'));
        next = applyPatch(next, stats, replaceTag(next, 'CoolDownTime', '0'));
    } else if (powerName === 'EndPyromania') {
        stats.powerBlocks += 1;
        next = applyPatch(next, stats, replaceTag(next, 'CoolDownTime', PYROMANIA_EXPIRE_COOLDOWN_MS));
    } else if (/^SummonDragonSoul(?:\d+)?$/.test(powerName)) {
        stats.powerBlocks += 1;
        const rank = rankOf(powerName, 'SummonDragonSoul');
        const duration = DRAGON_SOUL_SPAWN_DURATION_BY_RANK.get(rank);
        if (duration) {
            next = applyPatch(next, stats, replaceTag(next, 'SpawnDuration', duration));
        }
        next = applyPatch(
            next,
            stats,
            replaceTag(
                next,
                'Description',
                'Hedeflerine ates eden bir Alev Ruhu cagirir. Sure boyunca hasarin artar.'
            )
        );
        if (next.includes('<UpgradeDescription>Hedeflerine ates eden bir Alev Ruhu cagirir. Sure boyunca hasarin artar ama savunman azalir.</UpgradeDescription>')) {
            next = applyPatch(
                next,
                stats,
                replaceTag(
                    next,
                    'UpgradeDescription',
                    'Hedeflerine ates eden bir Alev Ruhu cagirir. Sure boyunca hasarin artar.'
                )
            );
        }
    } else if (/^DragonSoulShot(?:\d+)?$/.test(powerName)) {
        next = patchDragonSoulShotBlock(next, rankOf(powerName, 'DragonSoulShot'), stats);
    }
    return next;
}

export function patchPlayerPowers(xml: string): PatchResult {
    const stats = cloneStats();
    let patchedXml = ensureFireBrandShotPowers(xml, stats);
    patchedXml = patchedXml.replace(
        /<Power PowerName="([^"]+)">[\s\S]*?<\/Power>/g,
        (powerBlock, powerName) => patchPowerBlock(powerName, powerBlock, stats)
    );
    return { xml: patchedXml, stats };
}

function buildFlameseerUtilityBuffs(): string {
    return [
        '\t<BuffType BuffName="ConflagrationSlow">',
        '\t\t<BuffID>741</BuffID>',
        '\t\t<Attack>true</Attack>',
        '\t\t<Duration>3000</Duration>',
        '\t\t<SpeedChange>-0.1</SpeedChange>',
        '\t\t<StackCount>1</StackCount>',
        '\t\t<BuffIcon>a_StatusIcon_SpeedDown</BuffIcon>',
        '\t\t<GfxType/>',
        '\t</BuffType>',
        '\t<BuffType BuffName="MoltenFistStun1000">',
        '\t\t<BuffID>739</BuffID>',
        '\t\t<Attack>true</Attack>',
        '\t\t<Duration>2000</Duration>',
        '\t\t<Effect>Stunned</Effect>',
        '\t\t<BuffIcon>a_StatusIcon_Immobile</BuffIcon>',
        '\t\t<GfxType>',
        '\t\t\t<AnimScale>0.25</AnimScale>',
        '\t\t\t<AnimFile>SFX_1.swf</AnimFile>',
        '\t\t\t<AnimClass>a_StunEffect</AnimClass>',
        '\t\t</GfxType>',
        '\t</BuffType>',
        '\t<BuffType BuffName="MoltenFistStun2000">',
        '\t\t<BuffID>740</BuffID>',
        '\t\t<Attack>true</Attack>',
        '\t\t<Duration>4000</Duration>',
        '\t\t<Effect>Stunned</Effect>',
        '\t\t<BuffIcon>a_StatusIcon_Immobile</BuffIcon>',
        '\t\t<GfxType>',
        '\t\t\t<AnimScale>0.25</AnimScale>',
        '\t\t\t<AnimFile>SFX_1.swf</AnimFile>',
        '\t\t\t<AnimClass>a_StunEffect</AnimClass>',
        '\t\t</GfxType>',
        '\t</BuffType>'
    ].join('\r\n');
}

function ensureFlameseerUtilityBuffs(xml: string, stats: PatchStats): string {
    const cleaned = xml.replace(
        /\r?\n\t<BuffType BuffName="(?:ConflagrationSlow|MoltenFistStun(?:1000|2000))">[\s\S]*?\r?\n\t<\/BuffType>/g,
        ''
    );
    const utilityBuffs = buildFlameseerUtilityBuffs();
    const patched = cleaned.replace(
        /(\r?\n\t<BuffType BuffName="Dazed">[\s\S]*?\r?\n\t<\/BuffType>)/,
        `$1\r\n${utilityBuffs}`
    );
    if (patched !== xml) {
        stats.changes += 1;
    }
    return patched;
}

function patchBuffBlock(buffName: string, block: string, stats: PatchStats): string {
    let next = block;
    const rangedOverride = FIREBRAND_OVERRIDE_BY_BUFF.get(buffName);
    if (rangedOverride) {
        stats.buffBlocks += 1;
        next = applyPatch(next, stats, upsertTagAfter(next, 'RangedOverride', rangedOverride, 'Duration'));
    }
    if (/^DragonSoul(?:Effect|Rank\d+)$/.test(buffName)) {
        if (!rangedOverride) {
            stats.buffBlocks += 1;
        }
        next = applyPatch(next, stats, removeTag(next, 'RangedOverride'));
        next = applyPatch(next, stats, removeTag(next, 'MagicDefense'));
        next = applyPatch(next, stats, removeTag(next, 'MeleeDefense'));
    }
    return next;
}

export function patchPlayerBuffs(xml: string): PatchResult {
    const stats = cloneStats();
    const withUtilityBuffs = ensureFlameseerUtilityBuffs(xml, stats);
    const patchedXml = withUtilityBuffs.replace(
        /<BuffType BuffName="([^"]+)">[\s\S]*?<\/BuffType>/g,
        (buffBlock, buffName) => patchBuffBlock(buffName, buffBlock, stats)
    );
    return { xml: patchedXml, stats };
}

function patchPowerModBlock(modName: string, block: string, stats: PatchStats): string {
    let next = block;
    const accelerantMatch = modName.match(/^BurnDmg([1-5])$/);
    if (accelerantMatch) {
        stats.modBlocks += 1;
        const rank = Number(accelerantMatch[1]);
        next = applyPatch(next, stats, replaceTag(next, 'BuffValue', ACCELERANT_VALUES_BY_RANK[rank - 1]));
        if (rank === 1) {
            next = applyPatch(next, stats, replaceTag(next, 'Description', ACCELERANT_DESCRIPTION));
        }
    }
    return next;
}

export function patchPowerMods(xml: string): PatchResult {
    const stats = cloneStats();
    const patchedXml = xml.replace(
        /<PowerModType>\s*<ModName>([^<]+)<\/ModName>[\s\S]*?<\/PowerModType>/g,
        (modBlock, modName) => patchPowerModBlock(modName.trim(), modBlock, stats)
    );
    return { xml: patchedXml, stats };
}

function patchFile(filePath: string, patcher: (xml: string) => PatchResult, verifyOnly: boolean): PatchStats {
    const original = fs.readFileSync(filePath, 'utf8');
    const patched = patcher(original);
    if (!verifyOnly && patched.xml !== original) {
        fs.writeFileSync(filePath, patched.xml, 'utf8');
    }
    return patched.stats;
}

function patchSwz(swzPath: string, verifyOnly: boolean): PatchStats {
    const ctx = parseSwz(swzPath);
    const resources = [
        { marker: '<PlayerPowerTypes', patcher: patchPlayerPowers },
        { marker: '<PlayerBuffTypes', patcher: patchPlayerBuffs },
        { marker: '<PowerModTypes', patcher: patchPowerMods }
    ];
    const stats: PatchStats[] = [];
    let changed = false;

    for (const resource of resources) {
        const chunk = ctx.chunks.find((entry) => entry.xml.includes(resource.marker));
        if (!chunk) {
            continue;
        }
        const original = chunk.xml;
        const patched = resource.patcher(original);
        stats.push(patched.stats);
        if (patched.xml !== original) {
            chunk.xml = patched.xml;
            changed = true;
        }
    }

    if (!verifyOnly && changed) {
        ensureBackup(swzPath);
        writeSwz(ctx);
    }

    return mergeStats(...stats);
}

function powerBlock(xml: string, powerName: string): string {
    const match = new RegExp(`<Power PowerName="${powerName}">[\\s\\S]*?</Power>`).exec(xml);
    if (!match) {
        throw new Error(`Missing power block: ${powerName}`);
    }
    return match[0];
}

function buffBlock(xml: string, buffName: string): string {
    const match = new RegExp(`<BuffType BuffName="${buffName}">[\\s\\S]*?</BuffType>`).exec(xml);
    if (!match) {
        throw new Error(`Missing buff block: ${buffName}`);
    }
    return match[0];
}

function tagValue(block: string, tag: string): string {
    return new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(block)?.[1].trim() ?? '';
}

function buffList(block: string, tag: string): string[] {
    return tagValue(block, tag).split(',').map((item) => item.trim()).filter(Boolean);
}

function assertIncludes(list: string[], value: string, label: string): void {
    if (!list.includes(value)) {
        throw new Error(`${label} missing ${value}`);
    }
}

export function verifyFlameseerImprovements(powerXml: string, buffXml: string, powerModXml: string): void {
    for (const baseName of ['IridescentBurst', 'FlameStrike', 'MoltenFist']) {
        const expectedCount = 11;
        const actualCount = [...powerXml.matchAll(new RegExp(`<Power PowerName="${baseName}(?:\\d+)?">`, 'g'))].length;
        if (actualCount !== expectedCount) {
            throw new Error(`${baseName} expected ${expectedCount} power blocks, found ${actualCount}`);
        }
    }

    for (const suffix of ['', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10']) {
        assertIncludes(buffList(powerBlock(powerXml, `IridescentBurst${suffix}`), 'AddTargetBuff'), 'Weakened', `IridescentBurst${suffix}`);
        assertIncludes(buffList(powerBlock(powerXml, `FlameStrike${suffix}`), 'AddTargetBuff'), 'ConflagrationSlow', `FlameStrike${suffix}`);
        const moltenBuffs = buffList(powerBlock(powerXml, `MoltenFist${suffix}`), 'AddTargetBuff');
        assertIncludes(moltenBuffs, 'Crippled', `MoltenFist${suffix}`);
        assertIncludes(moltenBuffs, Number(suffix || 0) >= 6 ? 'MoltenFistStun2000' : 'MoltenFistStun1000', `MoltenFist${suffix}`);
    }

    for (const shot of FIREBRAND_SHOTS) {
        powerBlock(powerXml, shot.name);
    }

    for (const suffix of ['', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10']) {
        const pyroBlock = powerBlock(powerXml, `Pyromania${suffix}`);
        const rank = Number(suffix || 0);
        const expectedManaCost = PYROMANIA_MANA_COST_BY_RANK.get(rank) ?? '10';
        if (tagValue(pyroBlock, 'ManaCost') !== expectedManaCost) {
            throw new Error(`Pyromania${suffix} ManaCost must be ${expectedManaCost}`);
        }
        if (tagValue(pyroBlock, 'CoolDownTime') !== '0') {
            throw new Error(`Pyromania${suffix} should not use activation cooldown`);
        }
    }
    if (tagValue(powerBlock(powerXml, 'EndPyromania'), 'CoolDownTime') !== PYROMANIA_EXPIRE_COOLDOWN_MS) {
        throw new Error(`EndPyromania CoolDownTime must be ${PYROMANIA_EXPIRE_COOLDOWN_MS}`);
    }

    for (const [rank, duration] of DRAGON_SOUL_SPAWN_DURATION_BY_RANK.entries()) {
        const powerName = rank === 0 ? 'SummonDragonSoul' : `SummonDragonSoul${rank}`;
        if (tagValue(powerBlock(powerXml, powerName), 'SpawnDuration') !== duration) {
            throw new Error(`${powerName} SpawnDuration must be ${duration}`);
        }
    }

    for (let rank = 0; rank <= 10; rank += 1) {
        const powerName = rank === 0 ? 'DragonSoulShot' : `DragonSoulShot${rank}`;
        const block = powerBlock(powerXml, powerName);
        const effect = dragonSoulShotEffectForRank(rank);
        if (effect.range) {
            if (tagValue(block, 'Range') !== effect.range) {
                throw new Error(`${powerName} Range must be ${effect.range}`);
            }
            if (tagValue(block, 'AoERadius')) {
                throw new Error(`${powerName} should use piercing range instead of splash radius`);
            }
        }
        if (effect.aoeRadius && tagValue(block, 'AoERadius') !== effect.aoeRadius) {
            throw new Error(`${powerName} AoERadius must be ${effect.aoeRadius}`);
        }
        for (const buff of effect.addTargetBuff.split(',')) {
            assertIncludes(buffList(block, 'AddTargetBuff'), buff, powerName);
        }
    }

    for (const [buffName, overrideName] of FIREBRAND_OVERRIDE_BY_BUFF.entries()) {
        const block = buffBlock(buffXml, buffName);
        if (tagValue(block, 'RangedOverride') !== overrideName) {
            throw new Error(`${buffName} RangedOverride must be ${overrideName}`);
        }
    }

    for (const buffName of ['DragonSoulEffect', 'DragonSoulRank1', 'DragonSoulRank3', 'DragonSoulRank8']) {
        const block = buffBlock(buffXml, buffName);
        if (block.includes('<MagicDefense>') || block.includes('<MeleeDefense>')) {
            throw new Error(`${buffName} must not reduce defenses`);
        }
        if (block.includes('<RangedOverride>')) {
            throw new Error(`${buffName} must not override player ranged attacks`);
        }
    }

    if (tagValue(buffBlock(buffXml, 'ConflagrationSlow'), 'SpeedChange') !== '-0.1') {
        throw new Error('ConflagrationSlow SpeedChange must be -0.1');
    }
    if (tagValue(buffBlock(buffXml, 'ConflagrationSlow'), 'BuffID') !== '741') {
        throw new Error('ConflagrationSlow BuffID must be 741');
    }
    const buffIds = new Map<string, string>();
    for (const match of buffXml.matchAll(/<BuffType BuffName="([^"]+)">[\s\S]*?<BuffID>([^<]+)<\/BuffID>[\s\S]*?<\/BuffType>/g)) {
        const [, buffName, buffId] = match;
        const previous = buffIds.get(buffId);
        if (previous) {
            throw new Error(`Duplicate BuffID ${buffId}: ${previous}, ${buffName}`);
        }
        buffIds.set(buffId, buffName);
    }
    if (tagValue(buffBlock(buffXml, 'MoltenFistStun1000'), 'Duration') !== '2000') {
        throw new Error('MoltenFistStun1000 duration must be 2000');
    }
    if (tagValue(buffBlock(buffXml, 'MoltenFistStun2000'), 'Duration') !== '4000') {
        throw new Error('MoltenFistStun2000 duration must be 4000');
    }

    for (let rank = 1; rank <= 5; rank += 1) {
        const block = new RegExp(`<PowerModType>\\s*<ModName>BurnDmg${rank}</ModName>[\\s\\S]*?</PowerModType>`).exec(powerModXml)?.[0];
        if (!block) {
            throw new Error(`Missing BurnDmg${rank}`);
        }
        if (tagValue(block, 'BuffValue') !== ACCELERANT_VALUES_BY_RANK[rank - 1]) {
            throw new Error(`BurnDmg${rank} BuffValue must be ${ACCELERANT_VALUES_BY_RANK[rank - 1]}`);
        }
    }
}

function verifySwz(swzPath: string): void {
    const ctx = parseSwz(swzPath);
    const powerXml = ctx.chunks.find((entry) => entry.xml.includes('<PlayerPowerTypes'))?.xml;
    const buffXml = ctx.chunks.find((entry) => entry.xml.includes('<PlayerBuffTypes'))?.xml;
    const powerModXml = ctx.chunks.find((entry) => entry.xml.includes('<PowerModTypes'))?.xml;
    if (!powerXml || !buffXml || !powerModXml) {
        throw new Error(`${swzPath} is missing a required gameplay XML chunk`);
    }
    verifyFlameseerImprovements(powerXml, buffXml, powerModXml);
}

function hasFlag(args: string[], flag: string): boolean {
    return args.includes(flag);
}

function main(): number {
    const args = process.argv.slice(2);
    const verifyOnly = hasFlag(args, '--verify') || hasFlag(args, '--dry-run');
    const swzPaths = ['Game.swz', 'Game.en.swz', 'Game.tr.swz']
        .map((file) => path.join(CBQ_DIR, file))
        .filter(fs.existsSync);

    const xmlStats = mergeStats(
        patchFile(POWER_XML, patchPlayerPowers, verifyOnly),
        patchFile(BUFF_XML, patchPlayerBuffs, verifyOnly),
        patchFile(POWER_MOD_XML, patchPowerMods, verifyOnly)
    );
    const swzStats = mergeStats(...swzPaths.map((swzPath) => patchSwz(swzPath, verifyOnly)));
    const stats = mergeStats(xmlStats, swzStats);

    verifyFlameseerImprovements(
        fs.readFileSync(POWER_XML, 'utf8'),
        fs.readFileSync(BUFF_XML, 'utf8'),
        fs.readFileSync(POWER_MOD_XML, 'utf8')
    );
    for (const swzPath of swzPaths) {
        verifySwz(swzPath);
    }

    console.log(JSON.stringify({ verifyOnly, swzPaths, stats }, null, 2));
    console.log(stats.changes === 0 ? 'No changes needed.' : verifyOnly ? 'Patch required.' : 'Patch apply complete.');
    return verifyOnly && stats.changes > 0 ? 1 : 0;
}

if (require.main === module) {
    try {
        process.exit(main());
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[patch_gameswz_flameseer_improvements] ${message}`);
        process.exit(1);
    }
}
