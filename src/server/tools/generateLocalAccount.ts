import { hashPlaintextPasswordForClient } from '../src/auth/PasswordAuth';

async function main(): Promise<void> {
    const email = process.argv[2]?.trim().toLowerCase();
    const password = process.argv[3];

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

    console.log(JSON.stringify(account, null, 2));
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});