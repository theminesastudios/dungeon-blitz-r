import { Client } from '../core/Client';
import { BitReader } from '../network/protocol/bitReader';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { Config } from '../core/config';
import * as crypto from 'crypto';
import { JsonAdapter } from '../database/JsonAdapter';
import {
    hashPassword,
    isValidPasswordInput,
    isValidRegistrationPassword,
    normalizeAccountIdentifier,
    verifyPassword
} from '../auth/PasswordAuth';

const INVALID_CREDENTIALS_MESSAGE = "Invalid email or password";

interface LoginPayload {
    email: string;
    password: string;
}

export class LoginHandler {
    public static db: JsonAdapter = new JsonAdapter();

    private static issueChallenge(client: Client): string {
        const sid = crypto.randomInt(0, 65536);
        const secret = Buffer.from(Config.SECRET, 'hex');
        const sidBytes = Buffer.alloc(2);
        sidBytes.writeUInt16BE(sid);

        const digest = crypto.createHmac('sha256', secret).update(sidBytes).digest('hex').substring(0, 12);
        const challenge = `${sid.toString(16).padStart(4, '0')}${digest}`;
        client.challengeStr = challenge;

        const challengeBuf = Buffer.from(challenge, 'utf-8');
        const payload = Buffer.alloc(2 + challengeBuf.length);
        payload.writeUInt16BE(challengeBuf.length, 0);
        challengeBuf.copy(payload, 2);

        const send = (client as Client & { send?: (id: number, payload: Buffer) => void }).send;
        if (typeof send === 'function') {
            send.call(client, 0x12, payload);
        }

        return challenge;
    }

    private static parseLoginPayload(data: Buffer): LoginPayload | null {
        try {
            const br = new BitReader(data);
            br.readMethod26(); // fbId
            br.readMethod26(); // kongId
            const email = normalizeAccountIdentifier(br.readMethod26());
            const password = br.readMethod26();
            br.readMethod26(); // legacyKey

            if (!email || !isValidPasswordInput(password)) {
                return null;
            }

            return { email, password };
        } catch (err) {
            console.warn(`[Login] Rejected malformed login payload: ${(err as Error).message}`);
            return null;
        }
    }

    private static clearFailedAuthState(client: Client): void {
        client.userId = null;
        client.account = null;
        client.authenticated = false;
        client.characters = [];
        client.character = null;
    }

    private static rejectLogin(client: Client, email: string, reason: string): void {
        LoginHandler.clearFailedAuthState(client);
        console.warn(`[Login] Authentication failed for ${email || '(missing account id)'}: ${reason}`);
        LoginHandler.sendPopup(client, INVALID_CREDENTIALS_MESSAGE, false);
        LoginHandler.issueChallenge(client);
    }

    static async handleLoginVersion(client: Client, data: Buffer): Promise<void> {
        // 0x11
        await client.resetForLoginCycle('login version');

        const br = new BitReader(data);
        const version = br.readMethod9();
        
        const challenge = LoginHandler.issueChallenge(client);

        console.log(`[Login] Version: ${version}, Challenge: ${challenge}`);
    }

    static async handleLoginCreate(client: Client, data: Buffer): Promise<void> {
        // 0x13
        await client.resetForLoginCycle('login create');

        const payload = LoginHandler.parseLoginPayload(data);
        if (!payload) {
            LoginHandler.rejectLogin(client, '', 'invalid registration payload');
            return;
        }

        const { email, password } = payload;
        if (!isValidRegistrationPassword(password)) {
            LoginHandler.clearFailedAuthState(client);
            console.warn(`[Login] Registration rejected for ${email}: password failed validation`);
            LoginHandler.sendPopup(client, "Password must be at least 6 characters", false);
            return;
        }

        console.log(`[Login] Create Account: ${email}`);
        
        let account;
        try {
            account = await LoginHandler.db.createAccount(email, await hashPassword(password));
        } catch (err) {
            LoginHandler.clearFailedAuthState(client);
            const message = (err as Error).message;
            console.warn(`[Login] Registration failed for ${email}: ${message}`);
            LoginHandler.sendPopup(client, message === 'Account already exists.' ? "Account already exists" : "Account creation failed", false);
            return;
        }

        client.userId = account.user_id;
        client.account = account;
        client.authenticated = true;
        client.characters = await LoginHandler.db.loadCharacters(account.user_id);

        LoginHandler.sendCharacterList(client);
    }

    static async handleLoginAuthenticate(client: Client, data: Buffer): Promise<void> {
        // 0x14
        const payload = LoginHandler.parseLoginPayload(data);
        if (!payload) {
            LoginHandler.rejectLogin(client, '', 'invalid login payload');
            return;
        }

        const { email, password } = payload;
        console.log(`[Login] Authenticate: ${email}`);

        const account = await LoginHandler.db.getAccount(email);
        if (!account) {
            LoginHandler.rejectLogin(client, email, 'account not found');
            return;
        }

        let passwordMatches = false;
        try {
            passwordMatches = await verifyPassword(password, account);
        } catch (err) {
            console.warn(`[Login] Password verification error for ${email}: ${(err as Error).message}`);
        }

        if (!passwordMatches) {
            const reason = account.passwordHash
                ? 'password mismatch'
                : 'Account exists but has no password hash; password reset required';
            LoginHandler.rejectLogin(client, email, reason);
            return;
        }

        await client.resetForLoginCycle('login authenticate');

        client.userId = account.user_id;
        client.account = account;
        client.authenticated = true;
        client.characters = await LoginHandler.db.loadCharacters(account.user_id);

        LoginHandler.sendCharacterList(client);
    }

    static sendCharacterList(client: Client): void {
        const bb = new BitBuffer();
        const maxChars = 8;
        const charCount = client.characters.length;

        if (client.userId === null) {
            console.error("[Login] Cannot send char list: User ID is null");
            return;
        }

        // method_4(user_id)
        bb.writeMethod4(client.userId);
        
        // method_393(max_chars)
        bb.writeMethod393(maxChars);
        
        // method_393(char_count)
        bb.writeMethod393(charCount);

        for (const char of client.characters) {
            bb.writeMethod13(char.name);
            bb.writeMethod13(char.class);
            // level is commonly just "level", but python said char["level"]
            // If new char, it might be undefined, so default to 1.
            const level = char.level || 1;
            bb.writeMethod6(level, 6);
        }

        client.sendBitBuffer(0x15, bb);
    }

    static sendPopup(client: Client, message: string, disconnect: boolean): void {
        const bb = new BitBuffer();
        bb.writeMethod13(message);
        bb.writeMethod6(disconnect ? 1 : 0, 1);
        client.sendBitBuffer(0x1B, bb);
    }
}
