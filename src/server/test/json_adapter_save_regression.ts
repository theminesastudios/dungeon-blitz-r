import { strict as assert } from 'assert';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Config } from '../core/config';
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

async function main(): Promise<void> {
    await testSaveCharactersRetriesTransientRenameLock();
    await testSaveCharactersSerializesConcurrentWrites();
    console.log('json_adapter_save_regression: ok');
}

void main().catch((error) => {
    console.error('json_adapter_save_regression: failed');
    console.error(error);
    process.exitCode = 1;
});
