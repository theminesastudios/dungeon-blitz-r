/**
 * Raise every East Wing hostile to EntType level 50.
 *
 * Health for these bodies is `HOSTILE_BASE_HITPOINTS[level] * HitPoints`, and BOTH sides
 * compute it -- the server from `data/EntTypes.json`, the client from the EntTypes chunk inside
 * `Login.swz`. That shared input is the only reason the two agree on how big an enemy is, so
 * the level has to move in both places at once or the run breaks in the way
 * [[enemies-die-at-half-double-hp-apply]] describes: the server's pool and the copy on screen
 * stop being the same enemy, and whichever runs out first ends the fight early.
 *
 * Raising the tier on the server alone was tried on 2026-08-18 and reverted the same day. There
 * is no packet that fixes it either -- `Game.mBonusLevels` (0x5E) only reaches the client's
 * other spawn branch, and a hostile spawned from a level cue reads `entType.baseLevel` and
 * never sees it. Editing the data both sides read is the one route that keeps them in step.
 *
 * `GroupLevel` is deliberately left alone: it drives grouping and reward tiering rather than
 * the health pool, and the request was for health.
 *
 * Usage:
 *   ts-node scripts/patch_east_wing_enemy_level_50.ts [--verify] [--swz-path <path>]
 */
import * as fs from 'fs';
import * as path from 'path';
import { defaultLoginSwzPath, ensureBackup, parseSwz, SwzPatchError, writeSwz } from './swzPatchUtils';

const TARGET_LEVEL = 50;

// The roster of data/dungeonSpawns/levelsJC_the_east_wing.enemies.json. Every one of these was
// checked against the other dungeon spawn files first: none of them appears anywhere else, so
// raising the type raises The East Wing (and its Hard variant, which reuses the same types --
// the level SWFs carry no *Hard entity classes) and nothing else.
const TARGETS = [
    'GreaterDemonMaligner',
    'ShadeSummoner2',
    'ShadeWarrior',
    'Ghoul2',
    'Ghoul',
    'BoneFiend',
    'ImperialGuard',
    'ImperialMagus',
    'PortalFiend',
    'PortalFiend2',
    'GreaterAbyssalStinger',
    'ImperialMagi2',
    'ShadeSummoner',
    'ImperialMagi',
    'AbyssalStinger',
    'TowerGuard2'
];

function hasFlag(args: string[], flag: string): boolean {
    return args.includes(flag);
}

/**
 * Every Login.swz the static server could hand out, not just the default one.
 *
 * `StaticServer.getFlashVersionAssetPath` serves `p/<flashVersion>/<asset>` when that file
 * exists and only falls back to `p/cbq`. There are two Login.swz files in the tree with
 * different contents, so patching one and leaving the other is how a change reaches the data
 * the server reads and never reaches the client -- the exact split this whole patch exists to
 * avoid. Both get the same edit.
 */
function resolveSwzPaths(args: string[]): string[] {
    const idx = args.indexOf('--swz-path');
    if (idx !== -1 && idx + 1 < args.length) {
        return [path.resolve(args[idx + 1])];
    }

    const defaultPath = defaultLoginSwzPath();
    const versionsDir = path.resolve(defaultPath, '..', '..');
    const found = new Set<string>();
    if (fs.existsSync(defaultPath)) {
        found.add(defaultPath);
    }
    if (fs.existsSync(versionsDir)) {
        for (const entry of fs.readdirSync(versionsDir)) {
            const candidate = path.join(versionsDir, entry, 'Login.swz');
            if (fs.existsSync(candidate)) {
                found.add(candidate);
            }
        }
    }
    if (found.size === 0) {
        throw new SwzPatchError(`no Login.swz found under ${versionsDir}`);
    }
    return [...found];
}

/** Rewrite `<Level>` inside one EntType block only, leaving every other field untouched. */
function setEntTypeLevelInXml(xml: string, entName: string): { xml: string; changed: boolean; previous: number } {
    const startToken = `<EntType EntName="${entName}"`;
    const start = xml.indexOf(startToken);
    if (start === -1) {
        throw new SwzPatchError(`${entName} block not found`);
    }
    const end = xml.indexOf('</EntType>', start);
    if (end === -1) {
        throw new SwzPatchError(`${entName} closing tag not found`);
    }

    const blockEnd = end + '</EntType>'.length;
    const block = xml.slice(start, blockEnd);
    const levelMatch = block.match(/<Level>(\d+)<\/Level>/);
    if (!levelMatch) {
        throw new SwzPatchError(`${entName} has no <Level> to raise`);
    }

    const previous = Number(levelMatch[1]);
    if (previous === TARGET_LEVEL) {
        return { xml, changed: false, previous };
    }

    const updatedBlock = block.replace(/<Level>\d+<\/Level>/, `<Level>${TARGET_LEVEL}</Level>`);
    return {
        xml: `${xml.slice(0, start)}${updatedBlock}${xml.slice(blockEnd)}`,
        changed: true,
        previous
    };
}

function patchXmlFile(filePath: string, verifyOnly: boolean): boolean {
    if (!fs.existsSync(filePath)) {
        throw new SwzPatchError(`missing file: ${filePath}`);
    }

    let xml = fs.readFileSync(filePath, 'utf8');
    let changed = false;
    for (const entName of TARGETS) {
        const patched = setEntTypeLevelInXml(xml, entName);
        xml = patched.xml;
        changed = changed || patched.changed;
    }

    if (changed && !verifyOnly) {
        ensureBackup(filePath);
        fs.writeFileSync(filePath, xml, 'utf8');
    }
    return changed;
}

function patchJsonFile(filePath: string, verifyOnly: boolean): boolean {
    if (!fs.existsSync(filePath)) {
        throw new SwzPatchError(`missing file: ${filePath}`);
    }

    const raw = fs.readFileSync(filePath, 'utf8');
    // The file ships with a UTF-8 BOM and the loader tolerates it, so it has to survive the
    // round trip -- stripping it here would quietly change every consumer's first key.
    const bom = raw.startsWith('﻿') ? '﻿' : '';
    const data = JSON.parse(bom ? raw.slice(1) : raw);
    const list: any[] = data?.EntTypes?.EntType ?? [];
    let changed = false;
    for (const entName of TARGETS) {
        const entry = list.find((candidate) => String(candidate?.EntName ?? '') === entName);
        if (!entry) {
            throw new SwzPatchError(`${entName} not present in ${path.basename(filePath)}`);
        }
        const previous = Math.round(Number(entry.Level ?? 0));
        if (previous === TARGET_LEVEL) {
            continue;
        }
        // Kept as the same JSON type it already was, so the file round-trips unchanged for
        // every entry this script does not touch.
        entry.Level = typeof entry.Level === 'string' ? String(TARGET_LEVEL) : TARGET_LEVEL;
        changed = true;
    }

    if (changed && !verifyOnly) {
        ensureBackup(filePath);
        const trailingNewline = raw.endsWith('\n') ? '\n' : '';
        fs.writeFileSync(filePath, `${bom}${JSON.stringify(data, null, 2)}${trailingNewline}`, 'utf8');
    }
    return changed;
}

function patchLoginSwz(swzPath: string, verifyOnly: boolean): boolean {
    const ctx = parseSwz(swzPath);
    const chunk = ctx.chunks.find((entry) => entry.xml.includes('<EntType EntName="ShadeWarrior"'));
    if (!chunk) {
        throw new SwzPatchError('EntTypes chunk not found in Login.swz');
    }

    let xml = chunk.xml;
    let changed = false;
    for (const entName of TARGETS) {
        const patched = setEntTypeLevelInXml(xml, entName);
        xml = patched.xml;
        changed = changed || patched.changed;
    }

    if (changed && !verifyOnly) {
        ensureBackup(swzPath);
        chunk.xml = xml;
        writeSwz(ctx);
    }
    return changed;
}

function main(): number {
    const args = process.argv.slice(2);
    const verifyOnly = hasFlag(args, '--verify') || hasFlag(args, '--dry-run');
    const serverRoot = path.resolve(__dirname, '..');
    const repoRoot = path.resolve(serverRoot, '../..');
    const jsonPath = path.join(serverRoot, 'data', 'EntTypes.json');
    const referenceXmlPath = path.join(repoRoot, 'src', 'client', 'content', 'xml', 'EntTypes.xml');
    try {
        const swzPaths = resolveSwzPaths(args);
        const jsonChanged = patchJsonFile(jsonPath, verifyOnly);
        const xmlChanged = patchXmlFile(referenceXmlPath, verifyOnly);
        let swzChanged = false;

        console.log(`server data : ${jsonPath} -> ${jsonChanged ? 'patch required' : 'already level 50'}`);
        console.log(`reference   : ${referenceXmlPath} -> ${xmlChanged ? 'patch required' : 'already level 50'}`);
        for (const swzPath of swzPaths) {
            const changed = patchLoginSwz(swzPath, verifyOnly);
            swzChanged = swzChanged || changed;
            console.log(`client swz  : ${swzPath} -> ${changed ? 'patch required' : 'already level 50'}`);
        }

        if (!jsonChanged && !xmlChanged && !swzChanged) {
            console.log('No changes needed.');
            return 0;
        }
        console.log(verifyOnly ? 'Verify only; nothing written.' : 'Patch apply complete.');
        if (!verifyOnly && jsonChanged) {
            // `nodemon` watches main.ts, auth, core, database, handlers, integrations, network
            // and utils -- not `data`. So EntTypes.json changes under a running server without
            // restarting it, and `GameData.load` only runs at boot: the server keeps serving
            // the OLD pool while the client, which refetches Login.swz on every login, is
            // already on the new one. The two then disagree by the ratio between the tiers and
            // enemies get executed with the bar most of the way full -- indistinguishable from
            // the bug this dungeon just spent days on. It has already happened once.
            console.log('');
            console.log('!! RESTART THE SERVER. `data/EntTypes.json` is not watched by nodemon, so a');
            console.log('!! running server keeps the old pools while the client already has the new ones.');
            console.log('!! Verify with the `pool=` field on any [EnemyDestroy] line after restarting:');
            console.log('!!   GreaterDemonMaligner 161472, ShadeWarrior/Ghoul 26912, TowerGuard2 403680.');
        }
        return 0;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Patch error: ${message}`);
        return 1;
    }
}

process.exit(main());
