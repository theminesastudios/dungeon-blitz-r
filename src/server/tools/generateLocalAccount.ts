import * as fs from 'fs/promises';
import * as path from 'path';
import { hashPlaintextPasswordForClient } from '../auth/PasswordAuth';

async function main(): Promise<void> {
    const email = process.argv[2]?.trim().toLowerCase();
    const password = process.argv[3];
    const outPath = path.resolve(process.argv[4]?.trim() || 'local-account.json');

    if (!email || !email.includes('@')) {
        throw new Error('Provide a valid email address.');
    }

    if (!password || password.length < 6) {
        throw new Error('Password must contain at least 6 characters.');
    }

    const passwordRecord = await hashPlaintextPasswordForClient(password);

    const account = {
        email,
        user_id: 14,
        ...passwordRecord
    };

    // Written to a file rather than stdout: the record carries the scrypt salt and
    // hash, and stdout ends up in terminal scrollback and CI logs.
    await fs.writeFile(outPath, JSON.stringify(account, null, 2), { mode: 0o600 });
    console.log(`Account record for ${email} written to ${outPath}`);
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
