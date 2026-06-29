import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const {
    recoverLocalSaves
} = require('../tools/recoverLocalSaves') as {
    recoverLocalSaves(options: {
        activeRepoRoot: string;
        oldRepoRoot: string;
        logger: (line: string) => void;
    }): { restored: boolean; reason?: string; restoredAccounts?: boolean };
};

function writeJson(filePath: string, value: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function readJson(filePath: string): any {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function saveData(userId: number, names: string[]): any {
    return {
        user_id: userId,
        characters: names.map((name) => ({ name }))
    };
}

function createTempWorkspace(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'db-save-recovery-'));
}

function makeRepo(root: string): void {
    fs.mkdirSync(path.join(root, 'src', 'server', 'data', 'saves'), { recursive: true });
}

function collectRecoveryLogs(): { logs: string[]; logger: (line: string) => void } {
    const logs: string[] = [];
    return {
        logs,
        logger(line: string): void {
            logs.push(line);
        }
    };
}

function testSkipsWhenActiveHasCharacters(): void {
    const workspace = createTempWorkspace();
    try {
        const activeRoot = path.join(workspace, 'dungeon-blitz-typescript');
        const oldRoot = path.join(workspace, 'dungeon-blitz-typescript-old');
        makeRepo(activeRoot);
        makeRepo(oldRoot);

        writeJson(path.join(activeRoot, 'src', 'server', 'data', 'Accounts.json'), [
            { email: 'active@example.com', user_id: 1 }
        ]);
        writeJson(path.join(activeRoot, 'src', 'server', 'data', 'saves', '1.json'), saveData(1, ['ActiveHero']));
        writeJson(path.join(oldRoot, 'src', 'server', 'data', 'Accounts.json'), [
            { email: 'old@example.com', user_id: 2 }
        ]);
        writeJson(path.join(oldRoot, 'src', 'server', 'data', 'saves', '2.json'), saveData(2, ['OldHero']));

        const { logs, logger } = collectRecoveryLogs();
        const result = recoverLocalSaves({ activeRepoRoot: activeRoot, oldRepoRoot: oldRoot, logger });

        assert.equal(result.restored, false);
        assert.equal(result.reason, 'active-has-characters');
        assert.ok(logs.includes('[SaveRecovery] Active save data already contains characters; skipping recovery.'));
        assert.equal(readJson(path.join(activeRoot, 'src', 'server', 'data', 'saves', '1.json')).characters[0].name, 'ActiveHero');
        assert.equal(fs.existsSync(path.join(activeRoot, 'src', 'server', 'data', 'saves', '2.json')), false);
    } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
    }
}

function testRestoresPreferredOldDataWhenActiveIsEmpty(): void {
    const workspace = createTempWorkspace();
    try {
        const activeRoot = path.join(workspace, 'dungeon-blitz-typescript');
        const oldRoot = path.join(workspace, 'dungeon-blitz-typescript-old');
        makeRepo(activeRoot);
        makeRepo(oldRoot);

        writeJson(path.join(activeRoot, 'src', 'server', 'data', 'Accounts.json'), []);
        writeJson(path.join(activeRoot, 'src', 'server', 'data', 'saves', '1.json'), saveData(1, []));
        writeJson(path.join(oldRoot, 'src', 'server', 'data', 'Accounts.json'), [
            { email: 'old@example.com', user_id: 7 }
        ]);
        writeJson(path.join(oldRoot, 'src', 'server', 'data', 'saves', '7.json'), saveData(7, ['RestoredHero']));

        const { logs, logger } = collectRecoveryLogs();
        const result = recoverLocalSaves({ activeRepoRoot: activeRoot, oldRepoRoot: oldRoot, logger });

        assert.equal(result.restored, true);
        assert.equal(result.restoredAccounts, true);
        assert.ok(logs.includes('[SaveRecovery] Restored Accounts.json from old repo.'));
        assert.ok(logs.includes('[SaveRecovery] Restored saves directory from old repo.'));
        assert.equal(readJson(path.join(activeRoot, 'src', 'server', 'data', 'Accounts.json'))[0].email, 'old@example.com');
        assert.equal(readJson(path.join(activeRoot, 'src', 'server', 'data', 'saves', '7.json')).characters[0].name, 'RestoredHero');
        assert.equal(fs.existsSync(path.join(activeRoot, 'src', 'server', 'data', 'saves', '1.json')), false);
    } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
    }
}

function testRestoresLegacyOldDataWhenPreferredIsMissing(): void {
    const workspace = createTempWorkspace();
    try {
        const activeRoot = path.join(workspace, 'dungeon-blitz-typescript');
        const oldRoot = path.join(workspace, 'dungeon-blitz-typescript-old');
        makeRepo(activeRoot);

        writeJson(path.join(oldRoot, 'src', 'server', 'Accounts.json'), [
            { email: 'legacy@example.com', user_id: 8 }
        ]);
        writeJson(path.join(oldRoot, 'src', 'server', 'saves', '8.json'), saveData(8, ['LegacyHero']));

        const { logs, logger } = collectRecoveryLogs();
        const result = recoverLocalSaves({ activeRepoRoot: activeRoot, oldRepoRoot: oldRoot, logger });

        assert.equal(result.restored, true);
        assert.equal(result.restoredAccounts, true);
        assert.ok(logs.includes('[SaveRecovery] Restored Accounts.json from old repo.'));
        assert.ok(logs.includes('[SaveRecovery] Restored saves directory from old repo.'));
        assert.equal(readJson(path.join(activeRoot, 'src', 'server', 'data', 'Accounts.json'))[0].email, 'legacy@example.com');
        assert.equal(readJson(path.join(activeRoot, 'src', 'server', 'data', 'saves', '8.json')).characters[0].name, 'LegacyHero');
    } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
    }
}

function testLogsWhenNoOldSaveDataExists(): void {
    const workspace = createTempWorkspace();
    try {
        const activeRoot = path.join(workspace, 'dungeon-blitz-typescript');
        const oldRoot = path.join(workspace, 'dungeon-blitz-typescript-old');
        makeRepo(activeRoot);

        const { logs, logger } = collectRecoveryLogs();
        const result = recoverLocalSaves({ activeRepoRoot: activeRoot, oldRepoRoot: oldRoot, logger });

        assert.equal(result.restored, false);
        assert.equal(result.reason, 'no-old-save-data');
        assert.ok(logs.includes('[SaveRecovery] No old save data found; cannot recover automatically.'));
    } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
    }
}

function main(): void {
    testSkipsWhenActiveHasCharacters();
    testRestoresPreferredOldDataWhenActiveIsEmpty();
    testRestoresLegacyOldDataWhenPreferredIsMissing();
    testLogsWhenNoOldSaveDataExists();
    console.log('save_recovery_regression: ok');
}

try {
    main();
} catch (error) {
    console.error('save_recovery_regression: failed');
    console.error(error);
    process.exitCode = 1;
}
