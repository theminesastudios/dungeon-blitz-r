/// <reference types="node" />

import { hashPlaintextPasswordForClient, isValidRegistrationPassword, normalizeAccountIdentifier } from '../auth/PasswordAuth';
import { JsonAdapter } from '../database/JsonAdapter';

function readArg(name: string): string {
    const prefix = `--${name}=`;
    for (let i = 2; i < process.argv.length; i += 1) {
        const arg = String(process.argv[i] ?? '');
        if (arg.startsWith(prefix)) {
            return arg.slice(prefix.length);
        }
        if (arg === `--${name}`) {
            return String(process.argv[i + 1] ?? '');
        }
    }
    return '';
}

async function main(): Promise<void> {
    const email = normalizeAccountIdentifier(readArg('email') || process.argv[2]);
    const password = readArg('password') || process.env.DB_ACCOUNT_PASSWORD;

    if (!email || !isValidRegistrationPassword(password)) {
        console.error('Usage: npm run reset-password -- --email user@example.com --password <6+ chars>');
        console.error('This is a dev/admin-only local reset helper. It never stores or prints plaintext passwords.');
        process.exitCode = 1;
        return;
    }

    const db = new JsonAdapter();
    const account = await db.updateAccountPassword(email, await hashPlaintextPasswordForClient(password));
    if (account) {
        console.log(`[set_account_password] Account found: ${account.email}`);
        console.log(`[set_account_password] Password hash updated for ${account.email}`);
        console.log('[set_account_password] Success');
        return;
    }

    console.error(`[set_account_password] Account not found: ${email}`);
    process.exitCode = 1;
}

void main().catch((err) => {
    console.error('[set_account_password] Failed:', err);
    process.exitCode = 1;
});
