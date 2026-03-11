import { Client } from '../core/Client';
import { CharacterTemplates } from '../core/CharacterTemplates';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { BitReader } from '../network/protocol/bitReader';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';
import { LevelHandler } from './LevelHandler';
import { WorldEnter } from '../utils/WorldEnter';
import { Config } from '../core/config';
import { JsonAdapter } from '../database/JsonAdapter';
import { Character } from '../database/Database';

const db = new JsonAdapter();

export class CharacterHandler {
    static async handleLoginCharacterCreate(client: Client, data: Buffer): Promise<void> {
        const br = new BitReader(data);
        const name = br.readMethod26();
        const className = br.readMethod26();
        const gender = br.readMethod26();
        const head = br.readMethod26();
        const hair = br.readMethod26();
        const mouth = br.readMethod26();
        const face = br.readMethod26();
        const hairColor = br.readMethod20(24);
        const skinColor = br.readMethod20(24);
        const shirtColor = br.readMethod20(24);
        const pantColor = br.readMethod20(24);

        if (!client.userId) {
            console.log(`[CharCreate] No userId for client`);
            return;
        }

        // Check if name taken
        const isTaken = await db.isCharacterNameTaken(name);
        if (isTaken) {
             // Send Popup
             const bb = new BitBuffer();
             bb.writeMethod13("Character name is unavailable.");
             bb.writeMethod6(0, 1); // Disconnect = false
             client.sendBitBuffer(0x1B, bb);
             return;
        }

        // Create Character Object from Template
        let newChar = CharacterTemplates.get(className);
        
        if (!newChar) {
             console.error(`[CharCreate] No template found for class ${className}, using fallback.`);
             newChar = {
                class: className,
                level: 1,
                xp: 0,
                gold: 0,
                // ... minimal defaults ...
             };
        }

        // Apply Customization
        newChar.name = name;
        newChar.gender = gender;
        newChar.headSet = head;
        newChar.hairSet = hair;
        newChar.mouthSet = mouth;
        newChar.faceSet = face;
        newChar.hairColor = hairColor;
        newChar.skinColor = skinColor;
        newChar.shirtColor = shirtColor;
        newChar.pantColor = pantColor;

        // Ensure critical fields are set if template missing them
        if (!newChar.CurrentLevel) newChar.CurrentLevel = { name: "NewbieRoad", x: 1422, y: 827 };
        if (!newChar.PreviousLevel) newChar.PreviousLevel = { name: "NewbieRoad", x: 1422, y: 827 };
        
        // Initialize arrays if missing
        if (!newChar.equippedGears) newChar.equippedGears = [];
        if (!newChar.inventoryGears) newChar.inventoryGears = [];
        if (!newChar.friends) newChar.friends = [];

        client.characters.push(newChar);
        await db.saveCharacters(client.userId, client.characters);
        client.character = newChar;

        console.log(`[CharCreate] Created char ${name} for user ${client.userId}`);

        // Enter World
        CharacterHandler.sendEnterWorld(client, newChar);
    }

    static handleCharacterSelect(client: Client, data: Buffer): void {
        const br = new BitReader(data);
        const charName = br.readMethod26();

        if (!client.userId) {
            console.log(`[CharacterSelect] No userId for client`);
            return;
        }

        const char = client.characters.find(c => c.name === charName);
        if (!char) {
            console.log(`[CharacterSelect] Character ${charName} not found for user ${client.userId}`);
            return;
        }

        client.character = char;
        console.log(`[CharacterSelect] Selected ${charName}`);
        
        CharacterHandler.sendEnterWorld(client, char);
    }

    private static sendEnterWorld(client: Client, char: Character): void {
        // Determine Level
        const currentLevelName = char.CurrentLevel?.name || "NewbieRoad";

        // Generate Transfer Token
        const token = Math.floor(Math.random() * 0xFFFF); 
        
        // Store Pending State
        if (client.userId) {
             GlobalState.pendingWorld.set(token, {
                character: char,
                targetLevel: currentLevelName,
                previousLevel: char.PreviousLevel?.name || "NewbieRoad", 
                userId: client.userId
            });
        }

        // Get Level Config
        const levelSpec = LevelConfig.get(currentLevelName);
        const isHard = currentLevelName.endsWith("Hard");

        const pkt = WorldEnter.buildEnterWorldPacket(
            token,
            0, "", false, 0, 0,
            Config.HOST,
            Config.PORTS[0],
            levelSpec.swf,
            levelSpec.mapId,
            levelSpec.baseId,
            currentLevelName,
            isHard ? "Hard" : "",
            isHard ? "Hard" : "",
            levelSpec.isDungeon,
            false, 0, 0,
            char
        );

        // Store token mapping for persistence
        if (client.userId) {
            GlobalState.tokenChar.set(token, { character: char, userId: client.userId });
        }

        client.sendBitBuffer(0x21, pkt);
        console.log(`[EnterWorld] Sent 0x21 to client for char ${char.name}, token=${token}`);
    }

    static handleGameServerLogin(client: Client, data: Buffer): void {
        const br = new BitReader(data);
        const token = br.readMethod9();
        const levelSwf = br.readMethod26(); 
        const firstLogin = br.readMethod15();
        const isDev = br.readMethod15();

        const entry = GlobalState.pendingWorld.get(token);
        if (!entry) {
            console.log(`[GameLogin] Invalid token ${token}`);
            return;
        }

        client.character = entry.character;
        client.userId = entry.userId;
        client.token = token;
        client.clientEntID = token; // Client uses token as Entity ID
        
        GlobalState.sessionsByToken.set(token, client);
        if (client.userId) {
            GlobalState.sessionsByUserId.set(client.userId, client);
            // Ensure persistence mapping exists
            GlobalState.tokenChar.set(token, { character: entry.character, userId: client.userId });
        }
        
        console.log(`[GameLogin] Client logged in with token ${token} as ${client.character.name}`);

        // Calculate Spawn
        // For now, simple spawn based on level config
        const spawn = LevelConfig.getSpawn(entry.targetLevel);

        // Send Player Data (0x10)
        const pdPkt = WorldEnter.buildPlayerDataPacket(
            client.character,
            token,
            0, 
            0,
            entry.targetLevel,
            spawn.x,
            spawn.y,
            true, // newHasCoord
            firstLogin // sendExtended
        );
        
        client.sendBitBuffer(0x10, pdPkt);
        console.log(`[GameLogin] Sent 0x10 (Player Data)`);
        
        // Spawn NPCs
        LevelHandler.spawnLevelNpcs(client, entry.targetLevel);

        // Spawn Pet
        // We need to import PetHandler but circular dependency might be issue if top-level. 
        // CharacterHandler imports PetHandler? Let's check imports.
        // It's not imported at top.
        const { PetHandler } = require('./PetHandler');
        PetHandler.spawnPet(client);
    }
}
