import './helpers/disable_production_mongo';
import { strict as assert } from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { StaticServer } from '../core/StaticServer';
import { JsonAdapter } from '../database/JsonAdapter';
import { deriveClientPasswordDigest, verifyPassword } from '../auth/PasswordAuth';
import { DiscordAccountLinkService } from '../integrations/DiscordAccountLinkService';

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
        { email: 'legacy@example.com', user_id: 1 },
        {
            email: 'linked@example.com',
            user_id: 2,
            discordId: 'discord-linked',
            discordEmail: 'linked@example.com',
            discordLinkedAt: '2026-07-02T00:00:00.000Z',
            discordSyncRequired: true
        }
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
    const sentDms: Array<{ discordUserId: string; content: string }> = [];
    const discordAccountLinks = new DiscordAccountLinkService() as any;
    discordAccountLinks.db = adapter;
    discordAccountLinks.botApi = {
        isEnabled: () => true,
        sendDirectMessage: async (discordUserId: string, content: string) => {
            sentDms.push({ discordUserId, content });
            return true;
        }
    };

    const staticServer = new StaticServer(0);
    (staticServer as any).db = adapter;
    (staticServer as any).discordAccountLinks = discordAccountLinks;
    staticServer.start();

    try {
        const port = await waitForListening(staticServer);
        const baseUrl = `http://127.0.0.1:${port}`;

        const pageResponse = await fetch(`${baseUrl}/lostpw`);
        assert.equal(pageResponse.status, 200, 'GET /lostpw should render');
        const pageHtml = await pageResponse.text();
        assert.match(pageHtml, /Password Reset/, 'reset page should include the form title');
        assert.doesNotMatch(pageHtml, /New password/, 'visible reset form should not ask players to type a new password');

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

        const unlinkedDiscordResponse = await fetch(`${baseUrl}/lostpw`, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                email: ' Legacy@Example.COM '
            })
        });
        assert.equal(unlinkedDiscordResponse.status, 400, 'email-only reset should require a Discord-linked account');

        const resetResponse = await fetch(`${baseUrl}/lostpw`, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                email: ' Linked@Example.COM '
            })
        });
        assert.equal(resetResponse.status, 200, 'Discord-linked reset should send a DM');
        assert.equal(sentDms.length, 1, 'Discord-linked reset should send one DM');
        assert.equal(sentDms[0].discordUserId, 'discord-linked', 'reset DM should target the linked Discord id');
        const dmPassword = /^Password: ([A-Za-z0-9]+)$/m.exec(sentDms[0].content)?.[1] ?? '';
        assert.ok(dmPassword, 'reset DM should include the generated password as plain text');

        const accounts = await readAccounts(accountsPath);
        const account = accounts.find((entry) => entry.email === 'linked@example.com');
        assert.ok(account, 'reset account should remain present');
        assert.equal(account.password, undefined, 'reset must not store plaintext password');
        assert.equal(account.passwordKdf, 'scrypt', 'reset should store the password KDF');
        assert.equal(typeof account.passwordSalt, 'string', 'reset should store a salt');
        assert.equal(typeof account.passwordHash, 'string', 'reset should store a hash');
        assert.equal(
            await verifyPassword(deriveClientPasswordDigest(dmPassword), account),
            true,
            'DM reset password must verify against the digest the game client sends'
        );
        assert.equal(await verifyPassword(dmPassword, account), false, 'plaintext must not verify directly');
        assert.equal(
            await verifyPassword(deriveClientPasswordDigest('wrong-password'), account),
            false,
            'wrong password should not verify'
        );

        const manualResponse = await fetch(`${baseUrl}/lostpw`, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                email: ' Legacy@Example.COM ',
                password: 'manual-password',
                confirmPassword: 'manual-password'
            })
        });
        assert.equal(manualResponse.status, 200, 'dev/admin manual reset fallback should still work for unlinked accounts');
        const afterManualAccounts = await readAccounts(accountsPath);
        const legacyAccount = afterManualAccounts.find((entry) => entry.email === 'legacy@example.com');
        assert.equal(
            await verifyPassword(deriveClientPasswordDigest('manual-password'), legacyAccount),
            true,
            'manual fallback should also store the client digest hash'
        );

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
