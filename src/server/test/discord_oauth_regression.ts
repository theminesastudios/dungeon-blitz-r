import './helpers/disable_production_mongo';
import { strict as assert } from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { StaticServer } from '../core/StaticServer';
import { GlobalState } from '../core/GlobalState';
import { JsonAdapter } from '../database/JsonAdapter';
import { DiscordAccountLinkService } from '../integrations/DiscordAccountLinkService';
import { deriveClientPasswordDigest, verifyPassword } from '../auth/PasswordAuth';

type DiscordApiUserFixture = {
    id?: string;
    username?: string;
    global_name?: string | null;
    email?: string | null;
    verified?: boolean | null;
    avatar?: string | null;
};

type SentDm = {
    discordUserId: string;
    content: string;
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

function createSponsorEligibilityStub(eligible: boolean = true): any {
    return {
        close: async () => undefined,
        checkDiscordUser: async () => ({
            eligible,
            reason: eligible ? 'ok' : 'not-found',
            message: eligible
                ? 'Discord sponsor verification succeeded.'
                : 'Discord sponsor verification is required before this game account can be created.',
            metadata: {
                sponsorEligible: eligible,
                sponsorStatus: eligible ? 'active' : 'none',
                sponsorSource: 'mongodb:test.minidb',
                sponsorCheckedAt: '2026-01-01T00:00:00.000Z',
                sponsorRecordId: eligible ? 'sponsor-record' : ''
            }
        })
    };
}

function createConfiguredService(
    adapter: JsonAdapter,
    discordUser: DiscordApiUserFixture,
    sponsorEligible: boolean = true,
    sentDms: SentDm[] = []
): any {
    const service = new DiscordAccountLinkService() as any;
    service.db = adapter;
    service.sponsorEligibility = createSponsorEligibilityStub(sponsorEligible);
    service.botApi = {
        isEnabled: () => true,
        sendDirectMessage: async (discordUserId: string, content: string) => {
            sentDms.push({ discordUserId, content });
            return true;
        }
    };
    service.appId = 'test-client-id';
    service.clientSecret = 'test-client-secret';
    service.redirectUri = 'http://127.0.0.1:8000/auth/discord/callback';
    service.stateSecret = 'test-state-secret';
    service.exchangeCode = async () => ({ access_token: 'test-access-token' });
    service.fetchCurrentUser = async () => discordUser;
    return service;
}

async function completeDiscordLogin(
    adapter: JsonAdapter,
    discordUser: DiscordApiUserFixture,
    sponsorEligible: boolean = true,
    sentDms: SentDm[] = []
) {
    const service = createConfiguredService(adapter, discordUser, sponsorEligible, sentDms);
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
        const config = await configResponse.json() as {
            configured: boolean;
            authUrl: string;
            required: boolean;
            redirectUri: string;
        };
        assert.equal(config.configured, false, 'Discord OAuth should be disabled without env vars');
        assert.equal(config.required, true, 'Discord bootstrap should be reported as required');
        assert.equal(config.authUrl, '/auth/discord');
        assert.match(config.redirectUri, /\/auth\/discord\/callback$/, 'Discord redirect should match the registered local callback path');

        const startResponse = await fetch(`${baseUrl}/auth/discord`, { redirect: 'manual' });
        assert.equal(startResponse.status, 503, 'Discord OAuth start should fail safely when disabled');
    } finally {
        await staticServer.stop();
    }
}

async function testDiscordClientLaunchRedirect(): Promise<void> {
    const staticServer = new StaticServer(0);
    (staticServer as any).discordAccountLinks = {
        close: async () => undefined,
        isConfigured: () => true,
        getRedirectUri: () => 'http://127.0.0.1:8000/auth/discord/callback',
        getLinkedRolesConnectUrl: () => 'https://discord-github-assistant-bot.vercel.app/api/discord-linked-roles/connect',
        createLoginAuthorizeUrl: async () => ({
            ok: true,
            reason: 'ok',
            authorizeUrl: 'https://discord.com/oauth2/authorize?client_id=test-client&redirect_uri=http%3A%2F%2F127.0.0.1%3A8000%2Fauth%2Fdiscord%2Fcallback&response_type=code&scope=identify+email&state=test-state'
        }),
        createLinkAuthorizeUrlForAccount: async () => ({
            ok: true,
            reason: 'ok',
            authorizeUrl: 'https://discord.com/oauth2/authorize?client_id=test-client&redirect_uri=http%3A%2F%2F127.0.0.1%3A8000%2Fauth%2Fdiscord%2Fcallback&response_type=code&scope=identify+email&state=test-link-state'
        })
    };
    staticServer.start();

    try {
        const port = await waitForListening(staticServer);
        const baseUrl = `http://127.0.0.1:${port}`;
        const configResponse = await fetch(`${baseUrl}/api/auth/discord/config`);
        const config = await configResponse.json() as {
            configured: boolean;
            clientAuthUrl: string;
        };
        assert.equal(config.configured, true, 'Discord OAuth should be reported as configured');
        assert.equal(config.clientAuthUrl, '/auth/discord?client=discord', 'config should expose the Discord client launcher URL');

        const redirectResponse = await fetch(`${baseUrl}/auth/discord?client=discord`, { redirect: 'manual' });
        assert.equal(redirectResponse.status, 302, 'Discord client launch should redirect');
        const location = redirectResponse.headers.get('location') ?? '';
        assert.match(location, /^discord:\/\/-\/oauth2\/authorize\?/, 'Discord client launch should use the Discord protocol');
        assert.match(location, /client_id=test-client/, 'Discord client launch should preserve OAuth parameters');
        assert.match(location, /state=test-state/, 'Discord client launch should preserve OAuth state');
    } finally {
        await staticServer.stop();
    }
}

async function testDiscordCallbackStoresPendingLoginWhenClientIsNotOpen(): Promise<void> {
    GlobalState.pendingDiscordOAuthLogins.clear();
    const staticServer = new StaticServer(0);
    const account = {
        email: 'pending-oauth@example.com',
        user_id: 77,
        discordId: 'pending-oauth-discord',
        discordEmail: 'pending-oauth@example.com',
        discordLinkedAt: '2026-07-03T00:00:00.000Z',
        discordSyncRequired: true
    };
    (staticServer as any).discordAccountLinks = {
        close: async () => undefined,
        isConfigured: () => true,
        getRedirectUri: () => 'http://127.0.0.1:8000/auth/discord/callback',
        completeOAuth: async () => ({
            ok: true,
            reason: 'ok',
            mode: 'login',
            account,
            discordUser: {
                id: 'pending-oauth-discord',
                email: 'pending-oauth@example.com',
                emailVerified: true
            },
            message: 'Discord login successful.'
        })
    };
    staticServer.start();

    try {
        const port = await waitForListening(staticServer);
        const baseUrl = `http://127.0.0.1:${port}`;
        const response = await fetch(`${baseUrl}/auth/discord/callback?code=oauth-code&state=oauth-state`);
        assert.equal(response.status, 200, 'Discord callback should succeed without an already-open game client');
        const callbackHtml = await response.text();
        assert.match(callbackHtml, /next login connection/, 'callback should explain pending game login handoff');
        assert.match(callbackHtml, /db_discord_oauth_complete/, 'callback should notify an open host page');

        const pendingResponse = await fetch(`${baseUrl}/api/auth/discord/pending`);
        assert.equal(pendingResponse.status, 200, 'pending OAuth endpoint should render');
        const pendingPayload = await pendingResponse.json() as {
            pending: boolean;
            email: string | null;
            userId: number | null;
        };
        assert.equal(pendingPayload.pending, true, 'pending endpoint should expose the requester handoff');
        assert.equal(pendingPayload.email, 'pending-oauth@example.com');
        assert.equal(pendingPayload.userId, 77);

        const pending = GlobalState.consumeDiscordOAuthLogin('127.0.0.1');
        assert.ok(pending, 'callback should record a pending OAuth game login for the requester address');
        assert.equal(pending?.account.email, 'pending-oauth@example.com');
        assert.equal(pending?.account.user_id, 77);
    } finally {
        await staticServer.stop();
        GlobalState.pendingDiscordOAuthLogins.clear();
    }
}

async function testDiscordOAuthCreatesLinkedAccount(): Promise<void> {
    const { adapter, dataDir, accountsPath, savesDir } = await createTempAdapter();
    try {
        const sentDms: SentDm[] = [];
        const discordUser = {
            id: '123456789',
            username: 'tester',
            global_name: 'Tester Display',
            email: 'Tester@Example.com',
            verified: true,
            avatar: 'avatar-hash'
        };
        const result = await completeDiscordLogin(adapter, discordUser, true, sentDms);
        const expectedEmail = 'tester@example.com';

        assert.equal(result.ok, true, 'Discord OAuth should create a game account');
        assert.equal(result.reason, 'created', 'first OAuth login should report account creation');
        assert.equal(result.account.email, expectedEmail, 'created account should use the Discord email directly');
        assert.equal(result.account.emailAliases, undefined, 'no alias is needed when the account email is the Discord email');
        assert.equal(result.account.discordId, '123456789', 'Discord id should be stored');
        assert.equal(result.account.discordEmail, 'tester@example.com', 'Discord email should be stored separately');
        assert.equal(result.account.discordEmailVerified, true, 'verified email state should be stored');
        assert.equal(result.account.discordUsername, 'tester', 'Discord username should be stored');
        assert.equal(result.account.discordDisplayName, 'Tester Display', 'Discord display name should be stored');
        assert.equal(result.account.discordSyncRequired, true, 'Discord sync must remain mandatory');
        assert.equal(result.account.sponsorStatus, 'active', 'sponsor status should be stored from Mongo eligibility');
        assert.equal(result.account.sponsorEligible, true, 'sponsor eligibility should be stored from Mongo eligibility');
        assert.equal(result.account.isSponsor, true, 'isSponsor should mirror Mongo sponsor eligibility');
        assert.equal(result.account.sponsorSource, 'mongodb:test.minidb', 'sponsor source should be stored');
        assert.equal(typeof result.account.passwordHash, 'string', 'OAuth bootstrap should store a DM-delivered password hash');
        assert.equal(sentDms.length, 1, 'OAuth bootstrap should send generated credentials by DM');
        assert.equal(sentDms[0].discordUserId, '123456789', 'credential DM should target the OAuth Discord user');
        assert.doesNotMatch(sentDms[0].content, /`/, 'credential DM should render the password as plain text');
        const dmPassword = /^Password: ([A-Za-z0-9]+)$/m.exec(sentDms[0].content)?.[1] ?? '';
        assert.ok(dmPassword, 'credential DM should include the generated password');
        assert.equal(
            await verifyPassword(deriveClientPasswordDigest(dmPassword), result.account),
            true,
            'DM password must verify against the digest the game client sends'
        );

        const accounts = await readAccounts(accountsPath);
        assert.equal(accounts.length, 1, 'one account should be written');
        await fs.access(path.join(savesDir, `${result.account.user_id}.json`));
    } finally {
        await fs.rm(dataDir, { recursive: true, force: true });
    }
}

async function testDiscordOAuthRejectsNonSponsorAccountCreation(): Promise<void> {
    const { adapter, dataDir, accountsPath } = await createTempAdapter();
    try {
        const result = await completeDiscordLogin(adapter, {
            id: 'non-sponsor',
            username: 'tester',
            email: 'nonsponsor@example.com',
            verified: true
        }, false);

        assert.equal(result.ok, false, 'non-sponsor Discord OAuth should not create a game account');
        assert.equal(result.reason, 'sponsor-verification-required');
        const accounts = await readAccounts(accountsPath);
        assert.equal(accounts.length, 0, 'non-sponsor Discord OAuth must not write an account');
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
    await testDiscordClientLaunchRedirect();
    await testDiscordCallbackStoresPendingLoginWhenClientIsNotOpen();
    await testDiscordOAuthCreatesLinkedAccount();
    await testDiscordOAuthRejectsNonSponsorAccountCreation();
    await testRepeatedDiscordLoginReusesSameAccount();
    await testDiscordAccountLinkGuards();
    await testMissingOrUnverifiedDiscordEmailDoesNotCreateAccount();
    console.log('discord_oauth_regression: ok');
}

void main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
