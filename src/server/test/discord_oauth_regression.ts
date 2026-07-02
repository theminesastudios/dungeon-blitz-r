import { strict as assert } from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { StaticServer } from '../core/StaticServer';
import { JsonAdapter } from '../database/JsonAdapter';

function createAdapterForPaths(dataDir: string, accountsPath: string, savesDir: string): JsonAdapter {
    const adapter: any = new JsonAdapter();
    adapter.accountsPath = accountsPath;
    adapter.savesDir = savesDir;
    adapter.legacyAccountsPath = path.join(dataDir, 'Accounts.json');
    adapter.legacySavesDir = path.join(dataDir, 'saves');
    return adapter as JsonAdapter;
}

async function waitForListening(staticServer: StaticServer): Promise<number> {
    const httpServer = (staticServer as any).server;
    assert.ok(httpServer, 'static server should expose an http server after start');
    if (httpServer.listening) {
        const address = httpServer.address();
        assert.equal(typeof address, 'object');
        return Number(address.port);
    }

    return await new Promise<number>((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.once('listening', () => {
            const address = httpServer.address();
            assert.equal(typeof address, 'object');
            resolve(Number(address.port));
        });
    });
}

async function testDiscordRoutesDisabled(): Promise<void> {
    const staticServer = new StaticServer(0);
    staticServer.start();

    try {
        const port = await waitForListening(staticServer);
        const baseUrl = `http://127.0.0.1:${port}`;
        const configResponse = await fetch(`${baseUrl}/api/auth/discord/config`);
        assert.equal(configResponse.status, 200, 'Discord config endpoint should render when disabled');
        const config = await configResponse.json() as { configured: boolean; authUrl: string };
        assert.equal(config.configured, false, 'Discord OAuth should be disabled without env vars');
        assert.equal(config.authUrl, '/auth/discord');

        const startResponse = await fetch(`${baseUrl}/auth/discord`, { redirect: 'manual' });
        assert.equal(startResponse.status, 503, 'Discord OAuth start should fail safely when disabled');
    } finally {
        await staticServer.stop();
    }
}

async function testDiscordAccountLinkGuards(): Promise<void> {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'db-discord-link-'));
    const accountsPath = path.join(dataDir, 'data', 'Accounts.json');
    const savesDir = path.join(dataDir, 'data', 'saves');
    await fs.mkdir(savesDir, { recursive: true });
    await fs.writeFile(accountsPath, JSON.stringify([
        { email: 'one@example.com', user_id: 1 },
        { email: 'two@example.com', user_id: 2 }
    ], null, 2));

    const db = createAdapterForPaths(dataDir, accountsPath, savesDir);
    try {
        const linked = await db.linkDiscordToAccount(1, {
            id: 'discord-1',
            username: 'tester',
            globalName: 'Tester',
            email: 'discord@example.com',
            avatar: 'abc'
        });
        assert.equal(linked.discordId, 'discord-1', 'Discord id should be stored on the account');
        assert.equal(linked.discordEmail, 'discord@example.com', 'Discord email should be stored as metadata only');
        assert.equal((await db.findAccountByDiscordId('discord-1'))?.user_id, 1, 'Discord lookup should find linked account');

        await assert.rejects(
            () => db.linkDiscordToAccount(2, { id: 'discord-1', username: 'tester' }),
            /already linked to another game account/,
            'same Discord id cannot link to another game account'
        );

        await db.linkDiscordToAccount(1, { id: 'discord-1', username: 'tester2' });
        await assert.rejects(
            () => db.linkDiscordToAccount(1, { id: 'discord-2', username: 'tester2' }),
            /already linked to another Discord account/,
            'same game account cannot be overwritten by a different Discord id'
        );
    } finally {
        await fs.rm(dataDir, { recursive: true, force: true });
    }
}

async function main(): Promise<void> {
    await testDiscordRoutesDisabled();
    await testDiscordAccountLinkGuards();
    console.log('discord_oauth_regression: ok');
}

void main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
