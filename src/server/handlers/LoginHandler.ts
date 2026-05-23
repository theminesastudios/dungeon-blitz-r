import { Client } from '../core/Client';
import { BitReader } from '../network/protocol/bitReader';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { Config } from '../core/config';
import * as crypto from 'crypto';
import { JsonAdapter } from '../database/JsonAdapter';

const db = new JsonAdapter();

export class LoginHandler {
    static async handleLoginVersion(client: Client, data: Buffer): Promise<void> {
        // 0x11
        await client.resetForLoginCycle('login version');

        const br = new BitReader(data);
        const version = br.readMethod9();
        
        // Generate Challenge
        const sid = crypto.randomInt(0, 65536);
        const secret = Buffer.from(Config.SECRET, 'hex');
        const sidBytes = Buffer.alloc(2);
        sidBytes.writeUInt16BE(sid);

        const digest = crypto.createHash('md5').update(Buffer.concat([sidBytes, secret])).digest('hex').substring(0, 12);
        const challenge = `${sid.toString(16).padStart(4, '0')}${digest}`;
        client.challengeStr = challenge;

        console.log(`[Login] Version: ${version}, Challenge: ${challenge}`);

        // Send 0x12
        // payload = len(utf_bytes) + utf_bytes
        // packet = 0x12 + len(payload) + payload
        // But logic says: "payload = struct.pack('>H', len(utf_bytes)) + utf_bytes"
        
        const challengeBuf = Buffer.from(challenge, 'utf-8');
        const payload = Buffer.alloc(2 + challengeBuf.length);
        payload.writeUInt16BE(challengeBuf.length, 0);
        challengeBuf.copy(payload, 2);

        client.send(0x12, payload);
    }

    static async handleLoginCreate(client: Client, data: Buffer): Promise<void> {
        // 0x13
        await client.resetForLoginCycle('login create');

        const br = new BitReader(data);
        const fbId = br.readMethod26();
        const kongId = br.readMethod26();
        const email = br.readMethod26().trim().toLowerCase();
        const password = br.readMethod26();
        const legacyKey = br.readMethod26();

        console.log(`[Login] Create Account: ${email}`);
        
        // Create or Get User
        // Note: Python logic just gets or creates. We should ideally verify logic.
        // Assuming "Create" packet implies registration.
        
        // We'll mimic Python `get_or_create_user_id`
        // Wait, `get_or_create_user_id` is used in `handle_login_create`.
        
        // NOTE: In a real app we'd hash passwords. Here we are following the Python "no-auth" logic mostly?
        // Actually Python didn't check password in `handle_login_create`. It just creates.
        
        // TODO: We need to properly implement `get_or_create_user_id` logic inside DB adapter
        // Currently `JsonAdapter.createAccount` does it.
        
        // However, `get_or_create_user_id` in Python:
        // checks `Accounts.json`. If email exists -> return ID. Else -> Create.
        // So it's idempotent.

        // Is there a strict "Register" vs "Login"? 
        // 0x13 is handle_login_create.
        // 0x14 is handle_login_authenticate.
        
        let userId = await db.getAccountId(email);
        if (!userId) {
            userId = await db.createAccount(email);
        }
        
        client.userId = userId;
        client.account = { email, user_id: userId };
        client.authenticated = true;
        client.dialogueLanguage = await db.getDialogueLanguage(userId);
        client.characters = await db.loadCharacters(userId);
        for (const character of client.characters) {
            character.dialogueLanguage = client.dialogueLanguage;
        }

        LoginHandler.sendCharacterList(client);
    }

    static async handleLoginAuthenticate(client: Client, data: Buffer): Promise<void> {
        // 0x14
        await client.resetForLoginCycle('login authenticate');

        const br = new BitReader(data);
        const fbId = br.readMethod26();
        const kongId = br.readMethod26();
        const email = br.readMethod26().trim().toLowerCase();
        const encPassword = br.readMethod26();
        const legacyKey = br.readMethod26();

        console.log(`[Login] Authenticate: ${email}`);

        const userId = await db.getAccountId(email);

        if (!userId) {
            // Send Popup "Account not found"
            LoginHandler.sendPopup(client, "Account not found", true);
            return;
        }

        // Validate password? Python `handle_login_authenticate` DOES NOT validate password!
        // It just `load_accounts()` and checks if email exists.
        
        client.userId = userId;
        client.account = { email, user_id: userId };
        client.authenticated = true;
        client.dialogueLanguage = await db.getDialogueLanguage(userId);
        client.characters = await db.loadCharacters(userId);
        for (const character of client.characters) {
            character.dialogueLanguage = client.dialogueLanguage;
        }

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
