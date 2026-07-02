import * as crypto from 'crypto';

export interface PasswordRecord {
    passwordKdf: 'scrypt';
    passwordSalt: string;
    passwordHash: string;
    passwordParams: {
        N: number;
        r: number;
        p: number;
        keylen: number;
    };
}

export interface PasswordProtectedAccount {
    passwordKdf?: unknown;
    passwordSalt?: unknown;
    passwordHash?: unknown;
    passwordParams?: {
        N?: unknown;
        r?: unknown;
        p?: unknown;
        keylen?: unknown;
    };
}

const DEFAULT_PASSWORD_PARAMS: PasswordRecord['passwordParams'] = {
    N: 16384,
    r: 8,
    p: 1,
    keylen: 64
};

function scryptAsync(
    password: string,
    salt: Buffer,
    keylen: number,
    options: crypto.ScryptOptions
): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        crypto.scrypt(password, salt, keylen, options, (err, derivedKey) => {
            if (err) {
                reject(err);
                return;
            }

            resolve(derivedKey as Buffer);
        });
    });
}

function resolvePasswordParams(account: PasswordProtectedAccount): PasswordRecord['passwordParams'] | null {
    const params = account.passwordParams;
    const N = Number(params?.N ?? 0);
    const r = Number(params?.r ?? 0);
    const p = Number(params?.p ?? 0);
    const keylen = Number(params?.keylen ?? 0);

    if (!Number.isSafeInteger(N) || !Number.isSafeInteger(r) || !Number.isSafeInteger(p) || !Number.isSafeInteger(keylen)) {
        return null;
    }

    if (N < 1024 || r <= 0 || p <= 0 || keylen < 32 || keylen > 128) {
        return null;
    }

    return { N, r, p, keylen };
}

export function normalizeAccountIdentifier(identifier: unknown): string {
    return typeof identifier === 'string' ? identifier.trim().toLowerCase() : '';
}

export function isValidPasswordInput(password: unknown): password is string {
    return typeof password === 'string' && password.length > 0;
}

export function isValidRegistrationPassword(password: unknown): password is string {
    return isValidPasswordInput(password) && password.length >= 6;
}

export async function hashPassword(password: string): Promise<PasswordRecord> {
    const salt = crypto.randomBytes(16);
    const hash = await scryptAsync(password, salt, DEFAULT_PASSWORD_PARAMS.keylen, {
        N: DEFAULT_PASSWORD_PARAMS.N,
        r: DEFAULT_PASSWORD_PARAMS.r,
        p: DEFAULT_PASSWORD_PARAMS.p
    });

    return {
        passwordKdf: 'scrypt',
        passwordSalt: salt.toString('base64'),
        passwordHash: hash.toString('base64'),
        passwordParams: { ...DEFAULT_PASSWORD_PARAMS }
    };
}

export async function verifyPassword(password: string, account: PasswordProtectedAccount): Promise<boolean> {
    if (
        account.passwordKdf !== 'scrypt' ||
        typeof account.passwordSalt !== 'string' ||
        typeof account.passwordHash !== 'string'
    ) {
        return false;
    }

    const params = resolvePasswordParams(account);
    if (!params) {
        return false;
    }

    let salt: Buffer;
    let expectedHash: Buffer;
    try {
        salt = Buffer.from(account.passwordSalt, 'base64');
        expectedHash = Buffer.from(account.passwordHash, 'base64');
    } catch {
        return false;
    }

    if (salt.length < 16 || expectedHash.length !== params.keylen) {
        return false;
    }

    const actualHash = await scryptAsync(password, salt, params.keylen, {
        N: params.N,
        r: params.r,
        p: params.p
    });

    return actualHash.length === expectedHash.length && crypto.timingSafeEqual(actualHash, expectedHash);
}
