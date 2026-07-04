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

export interface DiscordLinkedAccount {
    discordId?: unknown;
    discordEmail?: unknown;
    discordLinkedAt?: unknown;
    discordSyncRequired?: unknown;
}

export const DISCORD_SYNC_REQUIRED_MESSAGE = 'Discord sync is required before password login.';

const DEFAULT_PASSWORD_PARAMS: PasswordRecord['passwordParams'] = {
    N: 16384,
    r: 8,
    p: 1,
    keylen: 64
};
const CLIENT_PASSWORD_DIGEST_PATTERN = /^[0-9a-f]{64}$/i;

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

export function hasValidDiscordSync(account: DiscordLinkedAccount | null | undefined): boolean {
    return (
        typeof account?.discordId === 'string' &&
        account.discordId.trim().length > 0 &&
        typeof account.discordEmail === 'string' &&
        normalizeAccountIdentifier(account.discordEmail).length > 0 &&
        typeof account.discordLinkedAt === 'string' &&
        account.discordLinkedAt.trim().length > 0 &&
        account.discordSyncRequired === true
    );
}

/**
 * The Flash client never sends the plaintext password: ScreenLogin submits
 * Crypto.method_164("#bmg#" + password), a lowercase-hex SHA-256 digest.
 * Any server-side flow that starts from a plaintext password (web reset,
 * generated credentials, admin script) must store the scrypt hash of this
 * digest so in-game login can match it.
 */
export function deriveClientPasswordDigest(plainPassword: string): string {
    return crypto.createHash('sha256').update(`#bmg#${plainPassword}`, 'utf8').digest('hex');
}

export function isClientPasswordDigest(password: unknown): password is string {
    return typeof password === 'string' && CLIENT_PASSWORD_DIGEST_PATTERN.test(password);
}

export function normalizeClientPasswordInput(password: string): string {
    return isClientPasswordDigest(password)
        ? password.toLowerCase()
        : deriveClientPasswordDigest(password);
}

/**
 * Before sending, Game.method_267's login path XORs each hex nibble of the
 * SHA-256 password digest with the matching nibble of the 16-char login
 * challenge (see Game.as: parseInt(challenge.charAt(i),16) ^ parseInt(digest
 * .charAt(i),16)). Past the challenge length parseInt('') is NaN, which AS3
 * coerces to 0, leaving the remaining 48 nibbles unchanged. This reverses
 * that mask; XOR is its own inverse, so the same nibble walk recovers the
 * plain digest. Non-digest inputs (web/plaintext flows) pass through as-is.
 */
export function unmaskChallengeXorClientPassword(password: string, challenge: string | null | undefined): string {
    const masked = String(password ?? '');
    const challengeStr = String(challenge ?? '');
    if (!challengeStr || !isClientPasswordDigest(masked)) {
        return masked;
    }

    let unmasked = '';
    for (let i = 0; i < masked.length; i += 1) {
        const maskedNibble = parseInt(masked.charAt(i), 16);
        const challengeNibbleRaw = parseInt(challengeStr.charAt(i), 16);
        const challengeNibble = Number.isNaN(challengeNibbleRaw) ? 0 : challengeNibbleRaw;
        unmasked += (maskedNibble ^ challengeNibble).toString(16);
    }

    return unmasked;
}

export async function hashClientPasswordInput(password: string): Promise<PasswordRecord> {
    return hashPassword(normalizeClientPasswordInput(password));
}

export async function hashPlaintextPasswordForClient(plainPassword: string): Promise<PasswordRecord> {
    return hashPassword(deriveClientPasswordDigest(plainPassword));
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

export async function verifyClientPasswordInput(password: string, account: PasswordProtectedAccount): Promise<boolean> {
    return verifyPassword(normalizeClientPasswordInput(password), account);
}
