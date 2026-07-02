import { strict as assert } from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { StaticServer } from '../core/StaticServer';
import { JsonAdapter } from '../database/JsonAdapter';
import {
    deriveDiscordAccountEmail,
    DiscordAccountLinkService
} from '../integrations/DiscordAccountLinkService';

type DiscordApiUserFixture = {
    id?: string;
    username?: string;
    global_name?: string | null;
    email?: string | null;
    verified?: boolean | null;
    avatar?: string | null;
};

function createAdapterForPaths(dataDir: string, accountsPath: string, savesDir: string): JsonAdapter {
    const adapter: any = new JsonAdapter();
    adapter.accountsPath = accountsPath;
    adapter.savesDir = savesDir;
    adapter.legacyAccountsPath = path.join(dataDir, 'Accounts.json');
    adapter.legacySavesDir = path.join(dataDir, 'saves');
    return adapter as JsonAdapter;
}

async function createTempAdapter(): Promise<{ adapter: JsonAdapter; dataDir: string; accountsPath: string; savesDir: string }> {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'db-discord-oauth-'));
    const accountsPath = path.join(dataDir, 'data', 'Accounts.json');
    const savesDir = path.join(dataDir, 'data', 'saves');
    await fs.mkdir(savesDir, { recursive: true });
    return {
        adapter: createAdapterForPaths(dataDir, accountsPath, savesDir),
        dataDir,
        accountsPath,
        savesDir
    };
}

async function readAccounts(accountsPath: string): Promise<any[]> {
    try {
        return JSON.parse(await fs.readFile(accountsPath, 'utf8'));
    } catch (err: any) {
        if (err?.code === 'ENOENT') {
            return [];
        }
        throw err;
    }
}

function createConfiguredService(adapter: JsonAdapter, discordUser: DiscordApiUserFixture): any {
    const service = new DiscordAccountLinkService() as any;
    service.db = adapter;
    service.appId = 'test-client-id';
    service.clientSecret = 'test-client-secret';
    service.redirectUri = 'http://127.0.0.1:8000/auth/discord/callback';
    service.stateSecret = 'test-state-secret';
    service.exchangeCode = async () => ({ access_token: 'test-access-token' });
    service.fetchCurrentUser = async () => discordUser;
    return service;
}

async function completeDiscordLogin(adapter: JsonAdapter, discordUser: DiscordApiUserFixture) {
    const service = createConfiguredService(adapter, discordUser);
    const start = await service.createLoginAuthorizeUrl();
    assert.equal(start.ok, true, 'login authorize URL should be created');
    assert.ok(start.authorizeUrl, 'authorize URL should be present');
    const state = new URL(start.authorizeUrl).searchParams.get('state') ?? '';
    assert.ok(state, 'OAuth state should be present');
    return await service.completeOAuth('oauth-code', state);
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
        const config = await configResponse.json() as { configured: boolean; authUrl: string; required: boolean };
        assert.equal(config.configured, false, 'Discord OAuth should be disabled without env vars');
        assert.equal(config.required, true, 'Discord bootstrap should be reported as required');
        assert.equal(config.authUrl, '/auth/discord');

        const startResponse = await fetch(`${baseUrl}/auth/discord`, { redirect: 'manual' });
        assert.equal(startResponse.status, 503, 'Discord OAuth start should fail safely when disabled');
    } finally {
        await staticServer.stop();
    }
}

async function testDiscordOAuthCreatesLinkedAccount(): Promise<void> {
    const { adapter, dataDir, accountsPath, savesDir } = await createTempAdapter();
    try {
        const discordUser = {
            id: '123456789',
            username: 'tester',
            global_name: 'Tester Display',
            email: 'Tester@Example.com',
            verified: true,
            avatar: 'avatar-hash'
        };
        const result = await completeDiscordLogin(adapter, discordUser);
        const expectedEmail = deriveDiscordAccountEmail('tester@example.com', '123456789');

        assert.equal(result.ok, true, 'Discord OAuth should create a game account');
        assert.equal(result.reason, 'created', 'first OAuth login should report account creation');
        assert.equal(result.account.email, expectedEmail, 'created account should use deterministic Discord-derived email');
        assert.deepEqual(result.account.emailAliases, ['tester@example.com'], 'Discord email should be preserved as an alias when safe');
        assert.equal(result.account.discordId, '123456789', 'Discord id should be stored');
        assert.equal(result.account.discordEmail, 'tester@example.com', 'Discord email should be stored separately');
        assert.equal(result.account.discordEmailVerified, true, 'verified email state should be stored');
        assert.equal(result.account.discordUsername, 'tester', 'Discord username should be stored');
        assert.equal(result.account.discordDisplayName, 'Tester Display', 'Discord display name should be stored');
        assert.equal(result.account.discordSyncRequired, true, 'Discord sync must remain mandatory');
        assert.equal(result.account.sponsorStatus, 'unknown', 'sponsor placeholder should be present');
        assert.equal(result.account.sponsorEligible, false, 'sponsor placeholder should default safely');
        assert.equal(result.account.passwordHash, undefined, 'OAuth bootstrap must not create a password hash');

        const accounts = await readAccounts(accountsPath);
        assert.equal(accounts.length, 1, 'one account should be written');
        await fs.access(path.join(savesDir, `${result.account.user_id}.json`));
    } finally {
        await fs.rm(dataDir, { recursive: true, force: true });
    }
}

async function testRepeatedDiscordLoginReusesSameAccount(): Promise<void> {
    const { adapter, dataDir, accountsPath } = await createTempAdapter();
    try {
        const first = await completeDiscordLogin(adapter, {
            id: '42',
            username: 'first',
            global_name: 'First',
            email: 'repeat@example.com',
            verified: true
        });
        const second = await completeDiscordLogin(adapter, {
            id: '42',
            username: 'second',
            global_name: 'Second',
            email: 'repeat@example.com',
            verified: true
        });

        assert.equal(second.ok, true, 'repeated Discord login should succeed');
        assert.equal(second.account.user_id, first.account.user_id, 'repeated Discord login should reuse the account');
        assert.equal(second.account.discordUsername, 'second', 'repeated Discord login should refresh Discord metadata');
        const accounts = await readAccounts(accountsPath);
        assert.equal(accounts.length, 1, 'repeated Discord login must not create duplicate accounts');
    } finally {
        await fs.rm(dataDir, { recursive: true, force: true });
    }
}

async function testDiscordAccountLinkGuards(): Promise<void> {
    const { adapter, dataDir, accountsPath } = await createTempAdapter();
    await fs.writeFile(accountsPath, JSON.stringify([
        { email: 'one@example.com', user_id: 1 },
        { email: 'two@example.com', user_id: 2 }
    ], null, 2));

    try {
        const linked = await adapter.linkDiscordToAccount(1, {
            id: 'discord-1',
            username: 'tester',
            globalName: 'Tester',
            displayName: 'Tester',
            email: 'discord@example.com',
            emailVerified: true,
            avatar: 'abc'
        });
        assert.equal(linked.discordId, 'discord-1', 'Discord id should be stored on the account');
        assert.equal(linked.discordEmail, 'discord@example.com', 'Discord email should be stored as metadata');
        assert.equal(linked.discordSyncRequired, true, 'linked account should require Discord sync for password auth');
        assert.equal((await adapter.findAccountByDiscordId('discord-1'))?.user_id, 1, 'Discord lookup should find linked account');

        await assert.rejects(
            () => adapter.linkDiscordToAccount(2, {
                id: 'discord-1',
                username: 'tester',
                email: 'discord@example.com',
                emailVerified: true
            }),
            /already linked to another game account/,
            'same Discord id cannot link to another game account'
        );

        await adapter.linkDiscordToAccount(1, {
            id: 'discord-1',
            username: 'tester2',
            email: 'discord@example.com',
            emailVerified: true
        });
        await assert.rejects(
            () => adapter.linkDiscordToAccount(1, {
                id: 'discord-2',
                username: 'tester2',
                email: 'discord2@example.com',
                emailVerified: true
            }),
            /already linked to another Discord account/,
            'same game account cannot be overwritten by a different Discord id'
        );
    } finally {
        await fs.rm(dataDir, { recursive: true, force: true });
    }
}

async function testMissingOrUnverifiedDiscordEmailDoesNotCreateAccount(): Promise<void> {
    const { adapter, dataDir, accountsPath } = await createTempAdapter();
    try {
        const missingEmail = await completeDiscordLogin(adapter, {
            id: 'no-email',
            username: 'missing',
            verified: true
        });
        assert.equal(missingEmail.ok, false, 'missing email should reject OAuth account creation');
        assert.equal(missingEmail.reason, 'missing-discord-email');

        const unverifiedEmail = await completeDiscordLogin(adapter, {
            id: 'unverified',
            username: 'unverified',
            email: 'unverified@example.com',
            verified: false
        });
        assert.equal(unverifiedEmail.ok, false, 'unverified email should reject OAuth account creation');
        assert.equal(unverifiedEmail.reason, 'discord-email-unverified');

        const accounts = await readAccounts(accountsPath);
        assert.equal(accounts.length, 0, 'unsafe Discord email responses must not create accounts');
    } finally {
        await fs.rm(dataDir, { recursive: true, force: true });
    }
}

async function main(): Promise<void> {
    await testDiscordRoutesDisabled();
    await testDiscordOAuthCreatesLinkedAccount();
    await testRepeatedDiscordLoginReusesSameAccount();
    await testDiscordAccountLinkGuards();
    await testMissingOrUnverifiedDiscordEmailDoesNotCreateAccount();
    console.log('discord_oauth_regression: ok');
}

void main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
