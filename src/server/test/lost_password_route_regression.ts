import { strict as assert } from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { StaticServer } from '../core/StaticServer';
import { JsonAdapter } from '../database/JsonAdapter';
import { verifyPassword } from '../auth/PasswordAuth';

function createAdapterForPaths(dataDir: string, accountsPath: string, savesDir: string): JsonAdapter {
    const adapter: any = new JsonAdapter();
    adapter.accountsPath = accountsPath;
    adapter.savesDir = savesDir;
    adapter.legacyAccountsPath = path.join(dataDir, 'Accounts.json');
    adapter.legacySavesDir = path.join(dataDir, 'saves');
    return adapter as JsonAdapter;
}

async function createTempAdapter(): Promise<{ adapter: JsonAdapter; dataDir: string; accountsPath: string; savesDir: string }> {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'db-lostpw-'));
    const accountsPath = path.join(dataDir, 'data', 'Accounts.json');
    const savesDir = path.join(dataDir, 'data', 'saves');
    await fs.mkdir(savesDir, { recursive: true });
    await fs.writeFile(accountsPath, JSON.stringify([
        { email: 'legacy@example.com', user_id: 1 }
    ], null, 2));
    return {
        adapter: createAdapterForPaths(dataDir, accountsPath, savesDir),
        dataDir,
        accountsPath,
        savesDir
    };
}

async function readAccounts(accountsPath: string): Promise<any[]> {
    return JSON.parse(await fs.readFile(accountsPath, 'utf8'));
}

async function waitForListening(staticServer: StaticServer): Promise<number> {
    const httpServer = (staticServer as any).server;
    assert.ok(httpServer, 'static server should expose an http server after start');
    if (httpServer.listening) {
        const address = httpServer.address();
        assert.equal(typeof address, 'object', 'test server should listen on an address object');
        return Number(address.port);
    }

    return await new Promise<number>((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.once('listening', () => {
            const address = httpServer.address();
            assert.equal(typeof address, 'object', 'test server should listen on an address object');
            resolve(Number(address.port));
        });
    });
}

async function main(): Promise<void> {
    const { adapter, dataDir, accountsPath } = await createTempAdapter();
    const staticServer = new StaticServer(0);
    (staticServer as any).db = adapter;
    staticServer.start();

    try {
        const port = await waitForListening(staticServer);
        const baseUrl = `http://127.0.0.1:${port}`;

        const pageResponse = await fetch(`${baseUrl}/lostpw`);
        assert.equal(pageResponse.status, 200, 'GET /lostpw should render');
        assert.match(await pageResponse.text(), /Password Reset/, 'reset page should include the form title');

        const mismatchResponse = await fetch(`${baseUrl}/lostpw`, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                email: 'legacy@example.com',
                password: 'new-password',
                confirmPassword: 'different-password'
            })
        });
        assert.equal(mismatchResponse.status, 400, 'mismatched confirmation should fail');

        const resetResponse = await fetch(`${baseUrl}/lostpw`, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                email: ' Legacy@Example.COM ',
                password: 'new-password',
                confirmPassword: 'new-password'
            })
        });
        assert.equal(resetResponse.status, 200, 'valid reset should succeed');

        const accounts = await readAccounts(accountsPath);
        const account = accounts.find((entry) => entry.email === 'legacy@example.com');
        assert.ok(account, 'reset account should remain present');
        assert.equal(account.password, undefined, 'reset must not store plaintext password');
        assert.equal(account.passwordKdf, 'scrypt', 'reset should store the password KDF');
        assert.equal(typeof account.passwordSalt, 'string', 'reset should store a salt');
        assert.equal(typeof account.passwordHash, 'string', 'reset should store a hash');
        assert.equal(await verifyPassword('new-password', account), true, 'new password should verify');
        assert.equal(await verifyPassword('wrong-password', account), false, 'wrong password should not verify');

        console.log('lost_password_route_regression: ok');
    } finally {
        await staticServer.stop();
        await fs.rm(dataDir, { recursive: true, force: true });
    }
}

void main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
