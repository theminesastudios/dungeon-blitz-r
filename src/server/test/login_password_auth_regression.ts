import './helpers/disable_production_mongo';
import { strict as assert } from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { CONCURRENT_ACCOUNT_EMAIL_MESSAGE, LoginHandler } from '../handlers/LoginHandler';
import { JsonAdapter } from '../database/JsonAdapter';
import { GlobalState } from '../core/GlobalState';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { BitReader } from '../network/protocol/bitReader';
import {
    deriveClientPasswordDigest,
    hashPlaintextPasswordForClient
} from '../auth/PasswordAuth';
import { deriveDiscordAccountEmail } from '../integrations/DiscordAccountLinkService';

type SentPacket = {
    id: number;
    payload: Buffer;
};

type FakeClient = {
    socket: {
        remoteAddress: string;
        destroyed: boolean;
        readyState: string;
        destroy: () => void;
    };
    userId: number | null;
    account: any;
    authenticated: boolean;
    characters: any[];
    character: any;
    sentPackets: SentPacket[];
    rawPackets: SentPacket[];
    resetForLoginCycle: (reason: string) => Promise<void>;
    send: (id: number, payload: Buffer) => void;
    sendBitBuffer: (id: number, bb: BitBuffer) => void;
};

function buildVersionPacket(version: number = 100): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod9(version);
    return bb.toBuffer();
}

function buildLoginPacket(email: string, password: string, options: { rawPassword?: boolean } = {}): Buffer {
    const passwordInput = options.rawPassword || password.length === 0
        ? password
        : deriveClientPasswordDigest(password);
    const bb = new BitBuffer(false);
    bb.writeMethod26('');
    bb.writeMethod26('');
    bb.writeMethod26(email);
    bb.writeMethod26(passwordInput);
    bb.writeMethod26('');
    return bb.toBuffer();
}

function createFakeClient(remoteAddress: string = '127.0.0.1'): FakeClient {
    const sentPackets: SentPacket[] = [];
    const rawPackets: SentPacket[] = [];
    return {
        socket: {
            remoteAddress,
            destroyed: false,
            readyState: 'open',
            destroy() {
                this.destroyed = true;
                this.readyState = 'closed';
            }
        },
        userId: null,
        account: null,
        authenticated: false,
        characters: [],
        character: null,
        sentPackets,
        rawPackets,
        async resetForLoginCycle() {
            this.userId = null;
            this.account = null;
            this.authenticated = false;
            this.characters = [];
            this.character = null;
        },
        send(id: number, payload: Buffer) {
            rawPackets.push({ id, payload });
        },
        sendBitBuffer(id: number, bb: BitBuffer) {
            sentPackets.push({ id, payload: bb.toBuffer() });
        }
    };
}

async function createTempAdapter(): Promise<{ adapter: JsonAdapter; dataDir: string; accountsPath: string; savesDir: string }> {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'db-login-auth-'));
    const accountsPath = path.join(dataDir, 'data', 'Accounts.json');
    const savesDir = path.join(dataDir, 'data', 'saves');
    const adapter = createAdapterForPaths(dataDir, accountsPath, savesDir);
    await fs.mkdir(savesDir, { recursive: true });
    return { adapter, dataDir, accountsPath, savesDir };
}

function createAdapterForPaths(dataDir: string, accountsPath: string, savesDir: string): JsonAdapter {
    const adapter: any = new JsonAdapter();
    adapter.accountsPath = accountsPath;
    adapter.savesDir = savesDir;
    adapter.legacyAccountsPath = path.join(dataDir, 'Accounts.json');
    adapter.legacySavesDir = path.join(dataDir, 'saves');
    return adapter as JsonAdapter;
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

function getLastPopupMessage(client: FakeClient): string {
    const popup = [...client.sentPackets].reverse().find((packet) => packet.id === 0x1B);
    assert.ok(popup, 'failure popup should be sent');
    return new BitReader(popup!.payload).readMethod13();
}

function getPopupCount(client: FakeClient): number {
    return client.sentPackets.filter((packet) => packet.id === 0x1B).length;
}

function assertLoginFailed(client: FakeClient, message: string): void {
    assert.equal(client.authenticated, false, `${message}: client must not be authenticated`);
    assert.equal(client.userId, null, `${message}: user id must stay unset`);
    assert.equal(client.account, null, `${message}: account must stay unset`);
    assert.deepEqual(client.characters, [], `${message}: characters must not load`);
    assert.equal(client.sentPackets.some((packet) => packet.id === 0x15), false, `${message}: character list must not be sent`);
    assert.equal(client.sentPackets.some((packet) => packet.id === 0x1B), true, `${message}: failure popup should be sent`);
}

async function createDiscordBootstrapAccount(adapter: JsonAdapter): Promise<{ email: string; alias: string }> {
    const alias = 'newuser@example.com';
    const email = deriveDiscordAccountEmail(alias, '12345');
    const account = await adapter.createDiscordAccount(email, {
        id: '12345',
        username: 'newuser',
        globalName: 'New User',
        displayName: 'New User',
        email: alias,
        emailVerified: true,
        avatar: 'avatar'
    });
    assert.equal(account.email, email, 'bootstrap should use derived primary email');
    assert.equal(account.discordSyncRequired, true, 'bootstrap should require Discord sync');
    return { email, alias };
}

async function testDirectRegistrationIsDisabled(accountsPath: string): Promise<void> {
    const client = createFakeClient();
    await LoginHandler.handleLoginCreate(client as any, buildLoginPacket('  NewUser@Example.COM ', 'correct-password'));

    assertLoginFailed(client, 'direct in-game account registration');
    assert.equal(getLastPopupMessage(client), 'Create your account in Discord with /create-account.');
    assert.deepEqual(await readAccounts(accountsPath), [], 'direct password registration must not create an account');
}

async function testInGameCreateCannotSetDiscordAccountPassword(accountsPath: string, adapter: JsonAdapter): Promise<void> {
    const { email, alias } = await createDiscordBootstrapAccount(adapter);
    const client = createFakeClient();
    await LoginHandler.handleLoginCreate(client as any, buildLoginPacket(`  ${alias.toUpperCase()} `, 'correct-password'));

    assertLoginFailed(client, 'in-game password setup for a Discord account');
    assert.equal(getLastPopupMessage(client), 'Create your account in Discord with /create-account.');

    const accounts = await readAccounts(accountsPath);
    assert.equal(accounts.length, 1, 'rejected in-game setup should keep exactly one account');
    assert.equal(accounts[0].email, email, 'rejected in-game setup should preserve the Discord account');
    assert.equal(accounts[0].password, undefined, 'rejected in-game setup must not store plaintext password');
    assert.equal(accounts[0].passwordHash, undefined, 'rejected in-game setup must not store a password hash');
    assert.equal(accounts[0].discordId, '12345', 'Discord id should remain linked');
}

async function setPasswordAsDiscordBot(adapter: JsonAdapter): Promise<void> {
    const updated = await adapter.updateAccountPassword(
        'newuser@example.com',
        await hashPlaintextPasswordForClient('correct-password')
    );
    assert.ok(updated, 'Discord bot password modal should be represented by a direct database password update');
}

async function testInGameCreateDoesNotOverwriteBotPassword(accountsPath: string): Promise<void> {
    const before = await readAccounts(accountsPath);
    const beforeHash = before[0].passwordHash;
    const client = createFakeClient();

    await LoginHandler.handleLoginCreate(client as any, buildLoginPacket('newuser@example.com', 'second-password'));

    assertLoginFailed(client, 'in-game overwrite of a bot-set password');
    assert.equal(getLastPopupMessage(client), 'Create your account in Discord with /create-account.');
    const after = await readAccounts(accountsPath);
    assert.equal(after.length, 1, 'duplicate password setup must not create another account');
    assert.equal(after[0].passwordHash, beforeHash, 'duplicate password setup must not overwrite password hash');
}

async function testCorrectPasswordLogsIn(expectedEmail: string): Promise<void> {
    const client = createFakeClient();

    await LoginHandler.handleLoginAuthenticate(client as any, buildLoginPacket('NEWUSER@example.com', 'correct-password'));

    assert.equal(client.authenticated, true, 'correct password should authenticate');
    assert.equal(client.userId, 1, 'correct login should set user id');
    assert.equal(client.account.email, expectedEmail, 'correct login should load the Discord-derived account');
    assert.equal(client.sentPackets.some((packet) => packet.id === 0x15), true, 'correct login should send character list');
}

async function testWrongPasswordFails(): Promise<void> {
    const client = createFakeClient();
    client.authenticated = true;
    client.userId = 1;
    client.account = { email: 'newuser@example.com', user_id: 1 };
    client.characters = [{ name: 'ShouldNotSurvive' }];

    await LoginHandler.handleLoginAuthenticate(client as any, buildLoginPacket('newuser@example.com', 'wrong-password'));

    assertLoginFailed(client, 'wrong password');
    assert.equal(getLastPopupMessage(client), 'Invalid email or password');
    assert.equal(client.rawPackets.some((packet) => packet.id === 0x12), true, 'wrong password should issue a fresh challenge');
}

async function testRetryAfterInvalidPassword(): Promise<void> {
    const client = createFakeClient();

    await LoginHandler.handleLoginAuthenticate(client as any, buildLoginPacket('newuser@example.com', 'correct-password'));
    assert.equal(client.authenticated, true, 'initial correct login should authenticate');

    client.sentPackets.length = 0;
    client.rawPackets.length = 0;
    await LoginHandler.handleLoginAuthenticate(client as any, buildLoginPacket('newuser@example.com', 'wrong-password'));
    assertLoginFailed(client, 'retry sequence wrong password');
    assert.equal(client.rawPackets.some((packet) => packet.id === 0x12), true, 'failed retry should send a fresh challenge');

    client.sentPackets.length = 0;
    client.rawPackets.length = 0;
    await LoginHandler.handleLoginAuthenticate(client as any, buildLoginPacket('newuser@example.com', 'correct-password'));
    assert.equal(client.authenticated, true, 'correct password after invalid attempt should authenticate');
    assert.equal(client.userId, 1, 'correct retry should restore user id');
    assert.equal(client.sentPackets.some((packet) => packet.id === 0x15), true, 'correct retry should send character list');
}

async function testUnknownAndEmptyPasswordFail(): Promise<void> {
    const unknown = createFakeClient();
    await LoginHandler.handleLoginAuthenticate(unknown as any, buildLoginPacket('missing@example.com', 'anything'));
    assertLoginFailed(unknown, 'unknown account');

    // Named for what it holds -- a fake client -- not for the password being tested, which
    // is the '' passed to buildLoginPacket below. CodeQL's clear-text-logging heuristic
    // treats any identifier matching /password/i as a sensitive source, so calling this
    // `emptyPassword` tainted the fake client and reported every production log line the
    // login path touches (JsonAdapter save paths, the Client reset log) as leaking a
    // password. None of them log one.
    const blankLoginClient = createFakeClient();
    await LoginHandler.handleLoginAuthenticate(
        blankLoginClient as any,
        buildLoginPacket('newuser@example.com', '', { rawPassword: true })
    );
    assertLoginFailed(blankLoginClient, 'empty password');
}

async function testPasswordLoginAllowsPasswordOnlyAccount(accountsPath: string, savesDir: string): Promise<void> {
    const accounts = await readAccounts(accountsPath);
    accounts.push({
        email: 'legacy@example.com',
        user_id: 2,
        ...(await hashPlaintextPasswordForClient('legacy-password'))
    });
    await fs.writeFile(accountsPath, JSON.stringify(accounts, null, 2));
    await fs.writeFile(path.join(savesDir, '2.json'), JSON.stringify({
        user_id: 2,
        characters: [{ name: 'LegacyHero', class: 'mage', gender: 'male', level: 1 }]
    }, null, 2));

    const client = createFakeClient();
    await LoginHandler.handleLoginAuthenticate(client as any, buildLoginPacket('legacy@example.com', 'legacy-password'));

    assert.equal(client.authenticated, true, 'password-only account should authenticate with the correct hash');
    assert.equal(client.userId, 2, 'password-only login should set user id');
    assert.equal(client.account.email, 'legacy@example.com', 'password-only login should load the account');
    assert.deepEqual(client.characters, [{ name: 'LegacyHero', class: 'mage', gender: 'male', level: 1 }]);
    assert.equal(client.sentPackets.some((packet) => packet.id === 0x15), true, 'password-only login should send character list');
}

async function testConcurrentEmailIdentityAllowsCharacterList(accountsPath: string, savesDir: string): Promise<void> {
    const accounts = await readAccounts(accountsPath);
    accounts.push({
        email: 'active-primary@example.com',
        emailAliases: ['shared-gmail@example.com'],
        user_id: 6,
        ...(await hashPlaintextPasswordForClient('active-password'))
    });
    accounts.push({
        email: 'second-primary@example.com',
        user_id: 7,
        discordEmail: 'shared-gmail@example.com',
        ...(await hashPlaintextPasswordForClient('second-password'))
    });
    await fs.writeFile(accountsPath, JSON.stringify(accounts, null, 2));
    await fs.writeFile(path.join(savesDir, '6.json'), JSON.stringify({
        user_id: 6,
        characters: [{ name: 'AlreadyPlaying', class: 'warrior', gender: 'male', level: 1 }]
    }, null, 2));
    await fs.writeFile(path.join(savesDir, '7.json'), JSON.stringify({
        user_id: 7,
        characters: [{ name: 'SecondHero', class: 'mage', gender: 'female', level: 1 }]
    }, null, 2));

    const activeClient = createFakeClient('127.0.0.2');
    activeClient.socket.readyState = 'readOnly';
    activeClient.userId = 6;
    activeClient.account = null;
    activeClient.authenticated = true;
    activeClient.character = { name: 'SecondHero' };
    GlobalState.clients.add(activeClient as any);

    try {
        const secondClient = createFakeClient('127.0.0.3');
        await LoginHandler.handleLoginAuthenticate(
            secondClient as any,
            buildLoginPacket('second-primary@example.com', 'second-password')
        );

        assert.equal(secondClient.authenticated, true, 'concurrent shared Gmail identity login should authenticate the character-list client');
        assert.equal(secondClient.userId, 7, 'concurrent login should use the new account user id');
        assert.equal(secondClient.account.email, 'second-primary@example.com', 'concurrent login should attach the new account');
        assert.deepEqual(secondClient.characters, [{ name: 'SecondHero', class: 'mage', gender: 'female', level: 1 }]);
        assert.equal(secondClient.sentPackets.some((packet) => packet.id === 0x15), true, 'concurrent login should send character list');
        assert.equal(secondClient.sentPackets.some((packet) => packet.id === 0x1B), false, 'concurrent login must not show the active-email popup');
        assert.equal(activeClient.socket.destroyed, false, 'character-list login should not disconnect the old active session yet');
        assert.equal(activeClient.socket.readyState, 'readOnly', 'character-list login should leave the old active socket open');

        const replacementOrder: string[] = [];
        const originalDestroy = activeClient.socket.destroy.bind(activeClient.socket);
        activeClient.socket.destroy = () => {
            replacementOrder.push('old-disconnect');
            originalDestroy();
        };
        (activeClient.socket as any).end = () => {
            replacementOrder.push('old-end');
        };
        const originalSendBitBuffer = secondClient.sendBitBuffer.bind(secondClient);
        secondClient.sendBitBuffer = (id: number, bb: BitBuffer) => {
            if (id === 0x15) {
                replacementOrder.push('character-list-reset');
            }
            if (id === 0x1B) {
                replacementOrder.push('new-popup');
            }
            originalSendBitBuffer(id, bb);
        };

        const didReplaceActiveSession = await LoginHandler.replaceAndWarnActiveAccountIdentityConflicts(
            secondClient as any,
            secondClient.account,
            'SecondHero'
        );
        assert.equal(didReplaceActiveSession, true, 'enter-game replacement should report the same-character active session conflict');
        assert.equal(activeClient.socket.destroyed, true, 'enter-game replacement should disconnect the old active session');
        assert.equal(activeClient.socket.readyState, 'closed', 'enter-game replacement should close the old active socket');
        assert.deepEqual(
            replacementOrder,
            ['old-end', 'old-disconnect', 'new-popup'],
            'enter-game replacement should disconnect the old session before warning the joining client'
        );
        assert.equal(getLastPopupMessage(secondClient), CONCURRENT_ACCOUNT_EMAIL_MESSAGE, 'enter-game replacement should warn the joining client after disconnecting the old session');

        await LoginHandler.handleLoginCreate(
            secondClient as any,
            buildLoginPacket('second-primary@example.com', 'x')
        );
        assert.equal(getLastPopupMessage(secondClient), 'Create your account in Discord with /create-account.');
    } finally {
        GlobalState.clients.delete(activeClient as any);
    }
}

async function testStalePendingWorldIdentityDoesNotBlockLogin(accountsPath: string, savesDir: string): Promise<void> {
    const accounts = await readAccounts(accountsPath);
    accounts.push({
        email: 'fresh-pending@example.com',
        user_id: 8,
        ...(await hashPlaintextPasswordForClient('fresh-password'))
    });
    accounts.push({
        email: 'stale-pending@example.com',
        user_id: 9,
        ...(await hashPlaintextPasswordForClient('stale-password'))
    });
    await fs.writeFile(accountsPath, JSON.stringify(accounts, null, 2));
    await fs.writeFile(path.join(savesDir, '8.json'), JSON.stringify({
        user_id: 8,
        characters: [{ name: 'FreshPendingHero', class: 'warrior', gender: 'male', level: 1 }]
    }, null, 2));
    await fs.writeFile(path.join(savesDir, '9.json'), JSON.stringify({
        user_id: 9,
        characters: [{ name: 'StalePendingHero', class: 'mage', gender: 'female', level: 1 }]
    }, null, 2));

    const freshToken = 800008;
    const staleToken = 900009;
    const staleAliasToken = 900010;
    try {
        GlobalState.pendingWorld.set(freshToken, {
            userId: 8,
            account: { email: 'fresh-pending@example.com', user_id: 8 },
            accountEmail: 'fresh-pending@example.com',
            character: { name: 'FreshPendingHero' },
            targetLevel: 'NewbieRoad',
            previousLevel: 'NewbieRoad',
            pendingSince: Date.now()
        } as any);
        GlobalState.pendingExtended.set(freshToken, true);

        const freshClient = createFakeClient('127.0.0.8');
        await LoginHandler.handleLoginAuthenticate(
            freshClient as any,
            buildLoginPacket('fresh-pending@example.com', 'fresh-password')
        );

        assert.equal(freshClient.authenticated, true, 'fresh pending transfer lock should not block character-list login');
        assert.equal(freshClient.userId, 8, 'fresh pending login should set the account user id');
        assert.equal(freshClient.sentPackets.some((packet) => packet.id === 0x15), true, 'fresh pending login should send character list');
        assert.equal(freshClient.sentPackets.some((packet) => packet.id === 0x1B), false, 'fresh pending login must not show the active-email popup');
        assert.equal(GlobalState.pendingWorld.has(freshToken), true, 'fresh pending transfer should stay available until character select');
        assert.equal(GlobalState.pendingExtended.has(freshToken), true, 'fresh extended transfer marker should stay available until character select');
        const didReplacePendingLock = await LoginHandler.replaceAndWarnActiveAccountIdentityConflicts(freshClient as any, freshClient.account, 'FreshPendingHero');
        assert.equal(didReplacePendingLock, true, 'enter-game replacement should report the fresh pending transfer conflict');
        assert.equal(GlobalState.pendingWorld.has(freshToken), false, 'fresh pending transfer should be cleared at enter-game replacement time');
        assert.equal(GlobalState.pendingExtended.has(freshToken), false, 'fresh extended transfer marker should be cleared at enter-game replacement time');
        assert.equal(getLastPopupMessage(freshClient), CONCURRENT_ACCOUNT_EMAIL_MESSAGE, 'enter-game replacement should warn after clearing pending transfer state');

        GlobalState.pendingWorld.set(staleToken, {
            userId: 9,
            account: { email: 'stale-pending@example.com', user_id: 9 },
            accountEmail: 'stale-pending@example.com',
            character: { name: 'StalePendingHero' },
            targetLevel: 'NewbieRoad',
            previousLevel: 'NewbieRoad',
            playSessionStartedAt: Date.now() - 120_000
        } as any);
        GlobalState.pendingExtended.set(staleToken, true);
        GlobalState.pendingTeleports.set(staleToken, {} as any);
        GlobalState.houseVisits.set(staleToken, { name: 'StalePendingHero' } as any);
        GlobalState.tokenChar.set(staleToken, { character: { name: 'StalePendingHero' } as any, userId: 9 });
        GlobalState.usedTransferTokens.set(staleToken, {
            userId: 9,
            account: { email: 'stale-pending@example.com', user_id: 9 },
            accountEmail: 'stale-pending@example.com',
            character: { name: 'StalePendingHero' },
            targetLevel: 'NewbieRoad',
            previousLevel: 'NewbieRoad'
        } as any);
        GlobalState.transferTokenAliases.set(staleAliasToken, staleToken);

        const staleClient = createFakeClient('127.0.0.9');
        await LoginHandler.handleLoginAuthenticate(
            staleClient as any,
            buildLoginPacket('stale-pending@example.com', 'stale-password')
        );

        assert.equal(staleClient.authenticated, true, 'stale pending transfer must not block login');
        assert.equal(staleClient.userId, 9, 'stale pending login should set the account user id');
        assert.equal(staleClient.sentPackets.some((packet) => packet.id === 0x15), true, 'stale pending login should send character list');
        assert.equal(GlobalState.pendingWorld.has(staleToken), true, 'stale pending transfer should stay untouched during character-list login');
        assert.equal(GlobalState.pendingExtended.has(staleToken), true, 'stale extended transfer marker should stay untouched during character-list login');
        assert.equal(GlobalState.pendingTeleports.has(staleToken), true, 'stale pending teleport should stay untouched during character-list login');
        assert.equal(GlobalState.houseVisits.has(staleToken), true, 'stale house visit should stay untouched during character-list login');
        assert.equal(GlobalState.tokenChar.has(staleToken), true, 'stale token character entry should stay untouched during character-list login');
        assert.equal(GlobalState.usedTransferTokens.has(staleToken), true, 'stale used transfer token should stay untouched during character-list login');
        assert.equal(GlobalState.transferTokenAliases.has(staleAliasToken), true, 'stale transfer alias should stay untouched during character-list login');
    } finally {
        GlobalState.pendingWorld.delete(freshToken);
        GlobalState.pendingExtended.delete(freshToken);
        GlobalState.pendingWorld.delete(staleToken);
        GlobalState.pendingExtended.delete(staleToken);
        GlobalState.pendingTeleports.delete(staleToken);
        GlobalState.houseVisits.delete(staleToken);
        GlobalState.tokenChar.delete(staleToken);
        GlobalState.usedTransferTokens.delete(staleToken);
        GlobalState.transferTokenAliases.delete(staleToken);
        GlobalState.transferTokenAliases.delete(staleAliasToken);
    }
}

async function testDiscordLinkedAccountWithoutHashFails(adapter: JsonAdapter): Promise<void> {
    const email = deriveDiscordAccountEmail('nopassword@example.com', 'no-pass');
    await adapter.createDiscordAccount(email, {
        id: 'no-pass',
        username: 'nopassword',
        email: 'nopassword@example.com',
        emailVerified: true
    });

    const client = createFakeClient();
    await LoginHandler.handleLoginAuthenticate(client as any, buildLoginPacket('nopassword@example.com', 'any-password'));

    assertLoginFailed(client, 'Discord-linked account without password hash');
    assert.equal(getLastPopupMessage(client), 'Set a password before using password login.');
}

async function testAliasResetPreservesSave(accountsPath: string, savesDir: string, expectedEmail: string): Promise<void> {
    const accounts = await readAccounts(accountsPath);
    accounts[0].emailAliases = ['newuser@example.com', 'alias@example.com'];
    await fs.writeFile(accountsPath, JSON.stringify(accounts, null, 2));

    const savePath = path.join(savesDir, '1.json');
    const beforeSave = await fs.readFile(savePath, 'utf8');
    const resetAccount = await LoginHandler.db.updateAccountPassword(
        'ALIAS@example.com',
        await hashPlaintextPasswordForClient('alias-password')
    );
    const afterSave = await fs.readFile(savePath, 'utf8');

    assert.ok(resetAccount, 'alias reset should find the primary account');
    assert.equal(resetAccount?.email, expectedEmail, 'alias reset should preserve primary derived email');
    assert.deepEqual(resetAccount?.emailAliases, ['newuser@example.com', 'alias@example.com'], 'alias reset should preserve normalized aliases');
    assert.equal(afterSave, beforeSave, 'alias password reset must not rewrite the player save');

    const aliasClient = createFakeClient();
    await LoginHandler.handleLoginAuthenticate(aliasClient as any, buildLoginPacket('alias@example.com', 'alias-password'));
    assert.equal(aliasClient.authenticated, true, 'alias email should authenticate after reset');
    assert.equal(aliasClient.userId, 1, 'alias login should use the primary account user id');
    assert.equal(aliasClient.account.email, expectedEmail, 'alias login should return the primary derived account');
}

async function testPendingDiscordOAuthLoginDelaysCharacterListAfterVersion(accountsPath: string, savesDir: string): Promise<void> {
    const accounts = await readAccounts(accountsPath);
    const account = {
        email: 'oauth-version@example.com',
        user_id: 3,
        discordId: 'oauth-version-discord',
        discordEmail: 'oauth-version@example.com',
        discordLinkedAt: '2026-07-03T00:00:00.000Z',
        discordSyncRequired: true
    };
    accounts.push(account);
    await fs.writeFile(accountsPath, JSON.stringify(accounts, null, 2));
    await fs.writeFile(path.join(savesDir, '3.json'), JSON.stringify({
        user_id: 3,
        characters: [{ name: 'OAuthVersionHero', class: 'warrior', gender: 'male', level: 1 }]
    }, null, 2));

    GlobalState.pendingDiscordOAuthLogins.clear();
    assert.equal(GlobalState.rememberDiscordOAuthLogin('127.0.0.1', account), true, 'pending OAuth login should be recorded');

    const client = createFakeClient('::ffff:127.0.0.1');
    await LoginHandler.handleLoginVersion(client as any, buildVersionPacket());

    assert.equal(client.authenticated, true, 'version handshake should attach pending OAuth account state');
    assert.equal(client.userId, 3, 'version handshake should set pending OAuth user id');
    assert.equal(client.account.email, 'oauth-version@example.com', 'version handshake should attach the pending OAuth account');
    assert.deepEqual(client.characters, [{ name: 'OAuthVersionHero', class: 'warrior', gender: 'male', level: 1 }]);
    assert.equal(client.rawPackets.some((packet) => packet.id === 0x12), true, 'version handshake should still issue challenge');
    assert.equal(client.sentPackets.some((packet) => packet.id === 0x15), false, 'version handshake must not send early character list');
    assert.equal(GlobalState.pendingDiscordOAuthLogins.size, 1, 'pending OAuth login should stay available until submit fallback or expiry');

    await new Promise((resolve) => setTimeout(resolve, 550));
    assert.equal(client.sentPackets.some((packet) => packet.id === 0x15), true, 'pending OAuth login should send delayed character list');

    client.sentPackets.length = 0;
    await LoginHandler.handleLoginAuthenticate(client as any, buildLoginPacket('oauth-version@example.com', 'wrong-password'));
    assert.equal(client.authenticated, true, 'duplicate authenticate after OAuth auto-login must not clear session');
    assert.equal(client.userId, 3, 'duplicate authenticate should keep OAuth user id');
    const authenticatedAccount = (client as any).account;
    assert.ok(authenticatedAccount, 'duplicate authenticate should keep the account attached');
    assert.equal(authenticatedAccount.email, 'oauth-version@example.com', 'duplicate authenticate should keep the OAuth account');
    assert.equal(client.sentPackets.some((packet) => packet.id === 0x15), true, 'duplicate authenticate should resend character list');
    assert.equal(GlobalState.pendingDiscordOAuthLogins.size, 0, 'duplicate authenticate should consume pending OAuth fallback');
}

async function testPendingDiscordOAuthLoginAuthenticateFallback(accountsPath: string, savesDir: string): Promise<void> {
    const accounts = await readAccounts(accountsPath);
    const account = {
        email: 'oauth-authenticate@example.com',
        user_id: 4,
        discordId: 'oauth-authenticate-discord',
        discordEmail: 'oauth-authenticate@example.com',
        discordLinkedAt: '2026-07-03T00:00:00.000Z',
        discordSyncRequired: true
    };
    accounts.push(account);
    await fs.writeFile(accountsPath, JSON.stringify(accounts, null, 2));
    await fs.writeFile(path.join(savesDir, '4.json'), JSON.stringify({
        user_id: 4,
        characters: [{ name: 'OAuthAuthenticateHero', class: 'mage', gender: 'female', level: 1 }]
    }, null, 2));

    GlobalState.pendingDiscordOAuthLogins.clear();
    assert.equal(GlobalState.rememberDiscordOAuthLogin('127.0.0.1', account), true, 'pending OAuth login should be recorded');

    const client = createFakeClient('127.0.0.1');
    await LoginHandler.handleLoginAuthenticate(client as any, buildLoginPacket('oauth-authenticate@example.com', 'wrong-password'));

    assert.equal(client.authenticated, true, 'pending OAuth login should authenticate before password verification fallback');
    assert.equal(client.userId, 4, 'pending OAuth authenticate fallback should set user id');
    assert.equal(client.account.email, 'oauth-authenticate@example.com', 'pending OAuth fallback should load the account');
    assert.deepEqual(client.characters, [{ name: 'OAuthAuthenticateHero', class: 'mage', gender: 'female', level: 1 }]);
    assert.equal(client.sentPackets.some((packet) => packet.id === 0x15), true, 'pending OAuth fallback should send character list');
    assert.equal(GlobalState.pendingDiscordOAuthLogins.size, 0, 'pending OAuth fallback should consume the handoff');
}

async function testPendingDiscordOAuthLoginDoesNotAuthorizeCreatePacket(accountsPath: string, savesDir: string): Promise<void> {
    const accounts = await readAccounts(accountsPath);
    const account = {
        email: 'oauth-create@example.com',
        user_id: 5,
        discordId: 'oauth-create-discord',
        discordEmail: 'oauth-create@example.com',
        discordLinkedAt: '2026-07-03T00:00:00.000Z',
        discordSyncRequired: true
    };
    accounts.push(account);
    await fs.writeFile(accountsPath, JSON.stringify(accounts, null, 2));
    await fs.writeFile(path.join(savesDir, '5.json'), JSON.stringify({
        user_id: 5,
        characters: [{ name: 'OAuthCreateHero', class: 'ranger', gender: 'male', level: 1 }]
    }, null, 2));

    GlobalState.pendingDiscordOAuthLogins.clear();
    assert.equal(GlobalState.rememberDiscordOAuthLogin('127.0.0.1', account), true, 'pending OAuth login should be recorded');

    const client = createFakeClient('127.0.0.1');
    await LoginHandler.handleLoginCreate(client as any, buildLoginPacket('oauth-create@example.com', 'short'));

    assertLoginFailed(client, 'pending OAuth must not authorize an account-create packet');
    assert.equal(getLastPopupMessage(client), 'Create your account in Discord with /create-account.');
    assert.equal(GlobalState.pendingDiscordOAuthLogins.size, 1, 'rejected create packet should preserve the OAuth handoff for login/version fallback');
}

async function main(): Promise<void> {
    const originalDb = LoginHandler.db;
    const { adapter, dataDir, accountsPath, savesDir } = await createTempAdapter();
    LoginHandler.db = adapter;

    try {
        await testDirectRegistrationIsDisabled(accountsPath);
        await testInGameCreateCannotSetDiscordAccountPassword(accountsPath, adapter);
        await setPasswordAsDiscordBot(adapter);
        const expectedEmail = deriveDiscordAccountEmail('newuser@example.com', '12345');
        await testInGameCreateDoesNotOverwriteBotPassword(accountsPath);
        LoginHandler.db = createAdapterForPaths(dataDir, accountsPath, savesDir);
        await testCorrectPasswordLogsIn(expectedEmail);
        await testWrongPasswordFails();
        await testRetryAfterInvalidPassword();
        await testUnknownAndEmptyPasswordFail();
        await testPasswordLoginAllowsPasswordOnlyAccount(accountsPath, savesDir);
        await testConcurrentEmailIdentityAllowsCharacterList(accountsPath, savesDir);
        await testStalePendingWorldIdentityDoesNotBlockLogin(accountsPath, savesDir);
        await testDiscordLinkedAccountWithoutHashFails(LoginHandler.db);
        await testAliasResetPreservesSave(accountsPath, savesDir, expectedEmail);
        await testPendingDiscordOAuthLoginDelaysCharacterListAfterVersion(accountsPath, savesDir);
        await testPendingDiscordOAuthLoginAuthenticateFallback(accountsPath, savesDir);
        await testPendingDiscordOAuthLoginDoesNotAuthorizeCreatePacket(accountsPath, savesDir);
        console.log('login_password_auth_regression: ok');
    } finally {
        LoginHandler.db = originalDb;
        GlobalState.pendingDiscordOAuthLogins.clear();
        await fs.rm(dataDir, { recursive: true, force: true });
    }
}

void main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
