import { strict as assert } from 'assert';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Config } from '../core/config';
import { GlobalState } from '../core/GlobalState';
import { JsonAdapter } from '../database/JsonAdapter';
import { Character } from '../database/Database';

function createCharacter(name: string): Character {
    return {
        name,
        class: 'Mage',
        gender: 'male',
        level: 1
    };
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTempDataDir(
    label: string,
    fn: (adapter: JsonAdapter, tempDir: string) => Promise<void>
): Promise<void> {
    const originalDataDir = Config.DATA_DIR;
    const tempDir = path.join(
        __dirname,
        '.tmp',
        `${label}_${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2)}`
    );

    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.mkdir(tempDir, { recursive: true });
    Config.DATA_DIR = tempDir;

    try {
        await fn(new JsonAdapter(), tempDir);
    } finally {
        Config.DATA_DIR = originalDataDir;
        await fs.rm(tempDir, { recursive: true, force: true });
    }
}

async function testSaveCharactersRetriesTransientRenameLock(): Promise<void> {
    await withTempDataDir('rename_retry', async (adapter, tempDir) => {
        const adapterClass = JsonAdapter as unknown as {
            renameFile: (fromPath: string, toPath: string) => Promise<void>;
        };
        const originalRenameFile = adapterClass.renameFile;
        let attempts = 0;

        adapterClass.renameFile = async (oldPath: string, newPath: string) => {
            attempts += 1;
            if (attempts < 3) {
                const error = new Error('simulated rename lock') as NodeJS.ErrnoException;
                error.code = 'EPERM';
                throw error;
            }

            return originalRenameFile(oldPath, newPath);
        };

        try {
            await adapter.saveCharacters(7, [createCharacter('RetryHero')]);
        } finally {
            adapterClass.renameFile = originalRenameFile;
        }

        const savedPath = path.join(tempDir, 'data', 'saves', '7.json');
        const saved = JSON.parse(await fs.readFile(savedPath, 'utf8')) as { characters: Character[] };
        assert.equal(attempts, 3, 'rename should retry until the lock clears');
        assert.equal(saved.characters[0]?.name, 'RetryHero');
    });
}

async function testSaveCharactersSerializesConcurrentWrites(): Promise<void> {
    await withTempDataDir('queue_serialization', async (adapter, tempDir) => {
        const adapterClass = JsonAdapter as unknown as {
            renameFile: (fromPath: string, toPath: string) => Promise<void>;
        };
        const originalRenameFile = adapterClass.renameFile;
        let activeRenames = 0;
        let maxActiveRenames = 0;

        adapterClass.renameFile = async (oldPath: string, newPath: string) => {
            activeRenames += 1;
            maxActiveRenames = Math.max(maxActiveRenames, activeRenames);

            try {
                await delay(40);
                return await originalRenameFile(oldPath, newPath);
            } finally {
                activeRenames -= 1;
            }
        };

        try {
            await Promise.all([
                adapter.saveCharacters(9, [createCharacter('FirstSave')]),
                adapter.saveCharacters(9, [createCharacter('SecondSave')])
            ]);
        } finally {
            adapterClass.renameFile = originalRenameFile;
        }

        const savedPath = path.join(tempDir, 'data', 'saves', '9.json');
        const saved = JSON.parse(await fs.readFile(savedPath, 'utf8')) as { characters: Character[] };
        assert.equal(maxActiveRenames, 1, 'same save file should not be renamed concurrently');
        assert.equal(saved.characters[0]?.name, 'SecondSave');
    });
}

async function testLoadCharactersWaitsForQueuedSave(): Promise<void> {
    await withTempDataDir('load_waits_for_queue', async (adapter) => {
        const adapterClass = JsonAdapter as unknown as {
            renameFile: (fromPath: string, toPath: string) => Promise<void>;
        };
        const originalRenameFile = adapterClass.renameFile;
        let releaseRename: () => void = () => undefined;

        const renameStarted = new Promise<void>((resolve) => {
            adapterClass.renameFile = async (oldPath: string, newPath: string) => {
                resolve();
                await new Promise<void>((renameResolve) => {
                    releaseRename = renameResolve;
                });
                return originalRenameFile(oldPath, newPath);
            };
        });

        try {
            await adapter.saveCharacters(11, [createCharacter('BeforeTransfer')]);

            const pendingSave = adapter.saveCharacters(11, [createCharacter('AfterTransfer')]);
            await renameStarted;

            const loadPromise = adapter.loadCharacters(11);
            await delay(20);
            releaseRename();

            const loadedCharacters = await loadPromise;
            await pendingSave;

            assert.equal(
                loadedCharacters[0]?.name,
                'AfterTransfer',
                'loads should wait for queued writes so transfers do not rehydrate stale character state'
            );
        } finally {
            releaseRename();
            adapterClass.renameFile = originalRenameFile;
        }
    });
}

async function testSaveCharactersMergesLiveSessionCharacter(): Promise<void> {
    await withTempDataDir('live_session_merge', async (adapter, tempDir) => {
        const staleCharacter = createCharacter('SessionHero');
        staleCharacter.level = 1;
        staleCharacter.gold = 50;

        const liveCharacter = createCharacter('SessionHero');
        liveCharacter.level = 12;
        liveCharacter.gold = 999;

        GlobalState.sessionsByUserId.set(12, { character: liveCharacter } as never);

        try {
            await adapter.saveCharacters(12, [staleCharacter]);
        } finally {
            GlobalState.sessionsByUserId.delete(12);
        }

        const savedPath = path.join(tempDir, 'data', 'saves', '12.json');
        const saved = JSON.parse(await fs.readFile(savedPath, 'utf8')) as { characters: Character[] };
        assert.equal(saved.characters[0]?.name, 'SessionHero');
        assert.equal(
            saved.characters[0]?.level,
            12,
            'live session state should win over stale character lists during saves'
        );
        assert.equal(saved.characters[0]?.gold, 999);
    });
}

async function main(): Promise<void> {
    await testSaveCharactersRetriesTransientRenameLock();
    await testSaveCharactersSerializesConcurrentWrites();
    await testLoadCharactersWaitsForQueuedSave();
    await testSaveCharactersMergesLiveSessionCharacter();
    console.log('json_adapter_save_regression: ok');
}

void main().catch((error) => {
    console.error('json_adapter_save_regression: failed');
    console.error(error);
    process.exitCode = 1;
});
