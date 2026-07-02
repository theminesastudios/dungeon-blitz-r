import { strict as assert } from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { LoginHandler } from '../handlers/LoginHandler';
import { JsonAdapter } from '../database/JsonAdapter';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { hashPassword } from '../auth/PasswordAuth';

type SentPacket = {
    id: number;
    payload: Buffer;
};

type FakeClient = {
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

function buildLoginPacket(email: string, password: string): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod26('');
    bb.writeMethod26('');
    bb.writeMethod26(email);
    bb.writeMethod26(password);
    bb.writeMethod26('');
    return bb.toBuffer();
}

function createFakeClient(): FakeClient {
    const sentPackets: SentPacket[] = [];
    const rawPackets: SentPacket[] = [];
    return {
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
    return JSON.parse(await fs.readFile(accountsPath, 'utf8'));
}

function assertLoginFailed(client: FakeClient, message: string): void {
    assert.equal(client.authenticated, false, `${message}: client must not be authenticated`);
    assert.equal(client.userId, null, `${message}: user id must stay unset`);
    assert.equal(client.account, null, `${message}: account must stay unset`);
    assert.deepEqual(client.characters, [], `${message}: characters must not load`);
    assert.equal(client.sentPackets.some((packet) => packet.id === 0x15), false, `${message}: character list must not be sent`);
    assert.equal(client.sentPackets.some((packet) => packet.id === 0x1B), true, `${message}: failure popup should be sent`);
}

async function testRegistrationStoresHash(accountsPath: string): Promise<void> {
    const client = createFakeClient();
    await LoginHandler.handleLoginCreate(client as any, buildLoginPacket('  NewUser@Example.COM ', 'correct-password'));

    assert.equal(client.authenticated, true, 'new registration should authenticate');
    assert.equal(client.account.email, 'newuser@example.com', 'registration should normalize email');
    assert.equal(client.sentPackets.some((packet) => packet.id === 0x15), true, 'registration should send character list');

    const accounts = await readAccounts(accountsPath);
    assert.equal(accounts.length, 1, 'registration should create exactly one account');
    assert.equal(accounts[0].password, undefined, 'registration must not store plaintext password');
    assert.equal(accounts[0].passwordKdf, 'scrypt', 'registration should store the password KDF');
    assert.equal(typeof accounts[0].passwordSalt, 'string', 'registration should store a salt');
    assert.equal(typeof accounts[0].passwordHash, 'string', 'registration should store a hash');
    assert.notEqual(accounts[0].passwordHash, 'correct-password', 'password hash must not equal plaintext');
}

async function testDuplicateRegistrationDoesNotOverwrite(accountsPath: string): Promise<void> {
    const before = await readAccounts(accountsPath);
    const beforeHash = before[0].passwordHash;
    const client = createFakeClient();

    await LoginHandler.handleLoginCreate(client as any, buildLoginPacket('newuser@example.com', 'second-password'));

    assertLoginFailed(client, 'duplicate registration');
    const after = await readAccounts(accountsPath);
    assert.equal(after.length, 1, 'duplicate registration must not create another account');
    assert.equal(after[0].passwordHash, beforeHash, 'duplicate registration must not overwrite password hash');
}

async function testCorrectPasswordLogsIn(): Promise<void> {
    const client = createFakeClient();

    await LoginHandler.handleLoginAuthenticate(client as any, buildLoginPacket('NEWUSER@example.com', 'correct-password'));

    assert.equal(client.authenticated, true, 'correct password should authenticate');
    assert.equal(client.userId, 1, 'correct login should set user id');
    assert.equal(client.account.email, 'newuser@example.com', 'correct login should load the normalized account');
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

    const emptyPassword = createFakeClient();
    await LoginHandler.handleLoginAuthenticate(emptyPassword as any, buildLoginPacket('newuser@example.com', ''));
    assertLoginFailed(emptyPassword, 'empty password');
}

async function testLegacyAccountWithoutHashFails(accountsPath: string, savesDir: string): Promise<void> {
    const accounts = await readAccounts(accountsPath);
    accounts.push({ email: 'legacy@example.com', user_id: 2 });
    await fs.writeFile(accountsPath, JSON.stringify(accounts, null, 2));
    await fs.writeFile(path.join(savesDir, '2.json'), JSON.stringify({
        user_id: 2,
        characters: [{ name: 'LegacyHero', class: 'mage', gender: 'male', level: 1 }]
    }, null, 2));

    const client = createFakeClient();
    await LoginHandler.handleLoginAuthenticate(client as any, buildLoginPacket('legacy@example.com', 'any-password'));

    assertLoginFailed(client, 'legacy hash-less account');
}

async function testAliasResetPreservesSave(accountsPath: string, savesDir: string): Promise<void> {
    const accounts = await readAccounts(accountsPath);
    accounts[0].emailAliases = ['alias@example.com'];
    await fs.writeFile(accountsPath, JSON.stringify(accounts, null, 2));

    const savePath = path.join(savesDir, '1.json');
    const beforeSave = await fs.readFile(savePath, 'utf8');
    const resetAccount = await LoginHandler.db.updateAccountPassword(
        'ALIAS@example.com',
        await hashPassword('alias-password')
    );
    const afterSave = await fs.readFile(savePath, 'utf8');

    assert.ok(resetAccount, 'alias reset should find the primary account');
    assert.equal(resetAccount?.email, 'newuser@example.com', 'alias reset should preserve primary email');
    assert.deepEqual(resetAccount?.emailAliases, ['alias@example.com'], 'alias reset should preserve normalized aliases');
    assert.equal(afterSave, beforeSave, 'alias password reset must not rewrite the player save');

    const aliasClient = createFakeClient();
    await LoginHandler.handleLoginAuthenticate(aliasClient as any, buildLoginPacket('alias@example.com', 'alias-password'));
    assert.equal(aliasClient.authenticated, true, 'alias email should authenticate after reset');
    assert.equal(aliasClient.userId, 1, 'alias login should use the primary account user id');
    assert.equal(aliasClient.account.email, 'newuser@example.com', 'alias login should return the primary account');
}

async function main(): Promise<void> {
    const originalDb = LoginHandler.db;
    const { adapter, dataDir, accountsPath, savesDir } = await createTempAdapter();
    LoginHandler.db = adapter;

    try {
        await testRegistrationStoresHash(accountsPath);
        await testDuplicateRegistrationDoesNotOverwrite(accountsPath);
        LoginHandler.db = createAdapterForPaths(dataDir, accountsPath, savesDir);
        await testCorrectPasswordLogsIn();
        await testWrongPasswordFails();
        await testRetryAfterInvalidPassword();
        await testUnknownAndEmptyPasswordFail();
        await testLegacyAccountWithoutHashFails(accountsPath, savesDir);
        await testAliasResetPreservesSave(accountsPath, savesDir);
        console.log('login_password_auth_regression: ok');
    } finally {
        LoginHandler.db = originalDb;
        await fs.rm(dataDir, { recursive: true, force: true });
    }
}

void main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
