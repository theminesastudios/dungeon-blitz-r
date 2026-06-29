const fs = require('fs');
const path = require('path');

const LOG_PREFIX = '[SaveRecovery]';

function readJson(filePath) {
    try {
        const text = fs.readFileSync(filePath, 'utf8');
        if (!text.trim()) {
            return null;
        }
        return JSON.parse(text);
    } catch {
        return null;
    }
}

function countCharactersInSaves(savesDir) {
    if (!savesDir || !fs.existsSync(savesDir)) {
        return 0;
    }

    let count = 0;
    for (const entry of fs.readdirSync(savesDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) {
            continue;
        }

        const save = readJson(path.join(savesDir, entry.name));
        if (!Array.isArray(save?.characters)) {
            continue;
        }

        count += save.characters.filter((character) =>
            character && String(character.name ?? '').trim()
        ).length;
    }

    return count;
}

function hasCharacters(layout) {
    return countCharactersInSaves(layout.preferredSavesDir) > 0 ||
        countCharactersInSaves(layout.legacySavesDir) > 0;
}

function buildLayout(repoRoot) {
    const serverDir = path.join(repoRoot, 'src', 'server');
    return {
        preferredAccountsPath: path.join(serverDir, 'data', 'Accounts.json'),
        preferredSavesDir: path.join(serverDir, 'data', 'saves'),
        legacyAccountsPath: path.join(serverDir, 'Accounts.json'),
        legacySavesDir: path.join(serverDir, 'saves')
    };
}

function defaultOldRepoRoot(activeRepoRoot) {
    return path.join(path.dirname(activeRepoRoot), `${path.basename(activeRepoRoot)}-old`);
}

function getExistingSourceLayout(oldLayout) {
    const preferredHasSaves = countCharactersInSaves(oldLayout.preferredSavesDir) > 0;
    if (preferredHasSaves) {
        return {
            accountsPath: fs.existsSync(oldLayout.preferredAccountsPath) ? oldLayout.preferredAccountsPath : '',
            savesDir: oldLayout.preferredSavesDir
        };
    }

    const legacyHasSaves = countCharactersInSaves(oldLayout.legacySavesDir) > 0;
    if (legacyHasSaves) {
        return {
            accountsPath: fs.existsSync(oldLayout.legacyAccountsPath) ? oldLayout.legacyAccountsPath : '',
            savesDir: oldLayout.legacySavesDir
        };
    }

    return null;
}

function restoreAccounts(sourcePath, targetPath, logger) {
    if (!sourcePath) {
        return false;
    }

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(sourcePath, targetPath);
    logger(`${LOG_PREFIX} Restored Accounts.json from old repo.`);
    return true;
}

function restoreSaves(sourceDir, targetDir, logger) {
    fs.mkdirSync(path.dirname(targetDir), { recursive: true });
    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.cpSync(sourceDir, targetDir, { recursive: true });
    logger(`${LOG_PREFIX} Restored saves directory from old repo.`);
}

function recoverLocalSaves(options = {}) {
    const logger = typeof options.logger === 'function' ? options.logger : console.log;
    const activeRepoRoot = path.resolve(
        options.activeRepoRoot ||
        process.env.DUNGEON_BLITZ_ACTIVE_REPO ||
        path.join(__dirname, '..', '..', '..')
    );
    const oldRepoRoot = path.resolve(
        options.oldRepoRoot ||
        process.env.DUNGEON_BLITZ_OLD_REPO ||
        defaultOldRepoRoot(activeRepoRoot)
    );

    const activeLayout = buildLayout(activeRepoRoot);
    if (hasCharacters(activeLayout)) {
        logger(`${LOG_PREFIX} Active save data already contains characters; skipping recovery.`);
        return { restored: false, reason: 'active-has-characters' };
    }

    const oldLayout = buildLayout(oldRepoRoot);
    const source = getExistingSourceLayout(oldLayout);
    if (!source) {
        logger(`${LOG_PREFIX} No old save data found; cannot recover automatically.`);
        return { restored: false, reason: 'no-old-save-data' };
    }

    const restoredAccounts = restoreAccounts(source.accountsPath, activeLayout.preferredAccountsPath, logger);
    restoreSaves(source.savesDir, activeLayout.preferredSavesDir, logger);
    return { restored: true, restoredAccounts };
}

if (require.main === module) {
    recoverLocalSaves();
}

module.exports = {
    buildLayout,
    countCharactersInSaves,
    hasCharacters,
    recoverLocalSaves
};
