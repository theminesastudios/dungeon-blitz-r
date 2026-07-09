import { Client } from '../core/Client';
import { BitReader } from '../network/protocol/bitReader';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { Config } from '../core/config';
import * as crypto from 'crypto';
import { JsonAdapter } from '../database/JsonAdapter';
import { UserAccount } from '../database/Database';
import { GlobalState } from '../core/GlobalState';
import {
    DISCORD_SYNC_REQUIRED_MESSAGE,
    hasValidDiscordSync,
    hashClientPasswordInput,
    isValidPasswordInput,
    isValidRegistrationPassword,
    normalizeAccountIdentifier,
    unmaskChallengeXorClientPassword,
    verifyClientPasswordInput
} from '../auth/PasswordAuth';

const INVALID_CREDENTIALS_MESSAGE = "Invalid email or password";
const DISCORD_BOOTSTRAP_REQUIRED_MESSAGE = "Use Discord login first to create or sync this account.";
const PASSWORD_NOT_SET_MESSAGE = "Set a password before using password login.";

interface LoginPayload {
    email: string;
    password: string;
}

export class LoginHandler {
    public static db: JsonAdapter = new JsonAdapter();
    private static readonly discordOAuthAutoAuthenticatedClients = new WeakSet<Client>();
    private static readonly DISCORD_OAUTH_CHARACTER_LIST_RETRY_MS = 500;

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

    private static async completeAuthentication(
        client: Client,
        account: UserAccount,
        reason: string,
        resetForLoginCycle: boolean = false,
        sendCharacters: boolean = true
    ): Promise<void> {
        if (resetForLoginCycle) {
            await client.resetForLoginCycle(reason);
        }

        client.userId = account.user_id;
        client.account = account;
        client.authenticated = true;
        client.characters = await LoginHandler.db.loadCharacters(account.user_id);

        if (reason.startsWith('discord oauth')) {
            LoginHandler.discordOAuthAutoAuthenticatedClients.add(client);
        } else {
            LoginHandler.discordOAuthAutoAuthenticatedClients.delete(client);
        }

        console.log(`[Login] Authenticated ${account.email}: ${reason}`);
        if (sendCharacters) {
            LoginHandler.sendCharacterList(client);
        }
    }

    private static scheduleDiscordOAuthCharacterListRetry(client: Client, account: UserAccount): void {
        setTimeout(() => {
            if (
                client.socket.destroyed ||
                client.socket.readyState !== 'open' ||
                !client.authenticated ||
                client.userId !== account.user_id
            ) {
                return;
            }

            console.log(`[Login] Sending delayed Discord OAuth character list for ${account.email}`);
            LoginHandler.sendCharacterList(client);
        }, LoginHandler.DISCORD_OAUTH_CHARACTER_LIST_RETRY_MS);
    }

    private static rejectLogin(
        client: Client,
        email: string,
        reason: string,
        publicMessage: string = INVALID_CREDENTIALS_MESSAGE
    ): void {
        LoginHandler.clearFailedAuthState(client);
        console.warn(`[Login] Authentication failed for ${email || '(missing account id)'}: ${reason}`);
        LoginHandler.sendPopup(client, publicMessage, false);
        LoginHandler.issueChallenge(client);
    }

    static async handleLoginVersion(client: Client, data: Buffer): Promise<void> {
        // 0x11
        await client.resetForLoginCycle('login version');

        const br = new BitReader(data);
        const version = br.readMethod9();
        
        const challenge = LoginHandler.issueChallenge(client);

        console.log(`[Login] Version: ${version}, Challenge: ${challenge}`);

        const pending = GlobalState.peekDiscordOAuthLogin(client.socket.remoteAddress);
        if (pending) {
            await LoginHandler.completeAuthentication(
                client,
                pending.account,
                'discord oauth pending version',
                false,
                false
            );
            LoginHandler.scheduleDiscordOAuthCharacterListRetry(client, pending.account);
            console.log(`[Login] Discord OAuth pending for ${pending.account.email}; delayed character list scheduled`);
        }
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
        const pending = GlobalState.consumeDiscordOAuthLogin(client.socket.remoteAddress, email);
        if (pending) {
            await LoginHandler.completeAuthentication(
                client,
                pending.account,
                'discord oauth pending create',
                true
            );
            return;
        }

        if (!isValidRegistrationPassword(password)) {
            LoginHandler.clearFailedAuthState(client);
            console.warn(`[Login] Registration rejected for ${email}: password failed validation`);
            LoginHandler.sendPopup(client, "Password must be at least 6 characters", false);
            return;
        }

        console.log(`[Login] Set Password: ${email}`);

        const existingAccount = await LoginHandler.db.getAccount(email);
        if (!existingAccount) {
            LoginHandler.rejectLogin(
                client,
                email,
                'password registration attempted before Discord OAuth account bootstrap',
                DISCORD_BOOTSTRAP_REQUIRED_MESSAGE
            );
            return;
        }

        if (!hasValidDiscordSync(existingAccount)) {
            LoginHandler.rejectLogin(
                client,
                email,
                'password registration attempted before valid Discord sync/link',
                DISCORD_SYNC_REQUIRED_MESSAGE
            );
            return;
        }

        if (existingAccount.passwordHash) {
            LoginHandler.clearFailedAuthState(client);
            console.warn(`[Login] Password setup rejected for ${email}: account already has a password`);
            LoginHandler.sendPopup(client, "Account already exists", false);
            return;
        }

        let account;
        try {
            // The create packet masks the digest with the challenge exactly like
            // the authenticate packet; store the unmasked digest so later logins
            // (which arrive under different challenges) can verify it.
            account = await LoginHandler.db.updateAccountPassword(
                email,
                await hashClientPasswordInput(unmaskChallengeXorClientPassword(password, client.challengeStr))
            );
            if (!account) {
                throw new Error('Account not found.');
            }
        } catch (err) {
            LoginHandler.clearFailedAuthState(client);
            const message = (err as Error).message;
            console.warn(`[Login] Password setup failed for ${email}: ${message}`);
            LoginHandler.sendPopup(client, "Password setup failed", false);
            return;
        }

        await LoginHandler.completeAuthentication(client, account, 'password setup');
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

        if (
            client.authenticated &&
            client.userId === account.user_id &&
            LoginHandler.discordOAuthAutoAuthenticatedClients.has(client)
        ) {
            LoginHandler.discordOAuthAutoAuthenticatedClients.delete(client);
            GlobalState.consumeDiscordOAuthLogin(client.socket.remoteAddress, email);
            console.log(`[Login] Duplicate authenticate ignored for already-authenticated account ${account.email}`);
            LoginHandler.sendCharacterList(client);
            return;
        }

        const pending = GlobalState.consumeDiscordOAuthLogin(client.socket.remoteAddress, email);
        if (pending && pending.account.user_id === account.user_id) {
            await LoginHandler.completeAuthentication(
                client,
                pending.account,
                'discord oauth pending authenticate',
                true
            );
            return;
        }

        // The Flash client XORs the password digest with the login challenge
        // before sending; try the unmasked digest first, then the raw input so
        // plain-digest/plaintext flows (tests, non-Flash tools) keep working.
        const unmaskedPassword = unmaskChallengeXorClientPassword(password, client.challengeStr);
        let passwordMatches = false;
        try {
            passwordMatches = await verifyClientPasswordInput(unmaskedPassword, account);
            if (!passwordMatches && unmaskedPassword !== password) {
                passwordMatches = await verifyClientPasswordInput(password, account);
            }
        } catch (err) {
            console.warn(`[Login] Password verification error for ${email}: ${(err as Error).message}`);
        }

        if (!passwordMatches) {
            const reason = account.passwordHash
                ? 'password mismatch'
                : 'Account exists but has no password hash; password setup required';
            LoginHandler.rejectLogin(
                client,
                email,
                reason,
                account.passwordHash ? INVALID_CREDENTIALS_MESSAGE : PASSWORD_NOT_SET_MESSAGE
            );
            return;
        }

        await LoginHandler.completeAuthentication(client, account, 'login authenticate', true);
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
