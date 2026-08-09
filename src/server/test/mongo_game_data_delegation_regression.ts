/// <reference types="node" />

import './helpers/disable_production_mongo';
import { strict as assert } from 'assert';
import { PasswordRecord } from '../auth/PasswordAuth';
import {
    Character,
    DiscordAccountProfile,
    SponsorAccountMetadata,
    UserAccount,
    UserSaveData
} from '../database/Database';
import { JsonAdapter } from '../database/JsonAdapter';
import { GameDataPersistenceAdapter } from '../database/MongoGameDataAdapter';

class MemoryGameDataAdapter implements GameDataPersistenceAdapter {
    public account: UserAccount = { email: 'player@example.com', user_id: 77 };
    public saves = new Map<number, Character[]>();

    async connect(): Promise<void> {}
    async close(): Promise<void> {}
    async getAccount(): Promise<UserAccount | null> { return this.account; }
    async getAccountById(): Promise<UserAccount | null> { return this.account; }
    async getAccountId(): Promise<number | null> { return this.account.user_id; }
    async findAccountByDiscordId(): Promise<UserAccount | null> { return this.account; }
    async linkDiscordToAccount(
        _userId: number,
        _discordUser: DiscordAccountProfile,
        _sponsor?: SponsorAccountMetadata
    ): Promise<UserAccount> { return this.account; }
    async createDiscordAccount(
        _email: string,
        _discordUser: DiscordAccountProfile,
        _sponsor?: SponsorAccountMetadata
    ): Promise<UserAccount> { return this.account; }
    async createAccount(_email: string, _password: PasswordRecord): Promise<UserAccount> { return this.account; }
    async updateAccountPassword(_email: string, _password: PasswordRecord): Promise<UserAccount | null> {
        return this.account;
    }
    async loadCharacters(userId: number): Promise<Character[]> { return this.saves.get(userId) ?? []; }
    async loadAllCharacterRecords(): Promise<UserSaveData[]> {
        return Array.from(this.saves, ([user_id, characters]) => ({ user_id, characters }));
    }
    async loadCharacterRecordsByGuild(guildName: string): Promise<UserSaveData[]> {
        const wanted = guildName.trim().replace(/\s+/g, ' ').toLowerCase();
        const records = await this.loadAllCharacterRecords();
        return records.filter((save) => save.characters.some((character) =>
            String((character.guild as Record<string, unknown> | undefined)?.name ?? '')
                .trim()
                .replace(/\s+/g, ' ')
                .toLowerCase() === wanted
        ));
    }
    async saveCharacters(userId: number, characters: Character[]): Promise<void> {
        this.saves.set(userId, structuredClone(characters));
    }
    async isCharacterNameTaken(name: string): Promise<boolean> {
        return Array.from(this.saves.values()).flat().some((character) => character.name === name);
    }
    async getAccountIdByCharName(name: string): Promise<number | null> {
        for (const [userId, characters] of this.saves) {
            if (characters.some((character) => character.name === name)) return userId;
        }
        return null;
    }
}

async function main(): Promise<void> {
    const mongo = new MemoryGameDataAdapter();
    JsonAdapter.configureMongoGameDataForTests(mongo);
    const db = new JsonAdapter();
    const fullCharacter = {
        name: 'MongoHero',
        class: 'mage',
        gender: 'female',
        level: 11,
        gold: 1234,
        DragonKeys: 8,
        CurrentLevel: { name: 'GoblinRiverDungeon', x: 321, y: 654 },
        missions: { 42: { progress: 7, completed: false } },
        inventory: [{ id: 'weapon_1', level: 3 }],
        dungeonSnapshots: { test: { progress: 55, deadSpawnKeys: ['boss:1'] } }
    } as Character;

    try {
        await db.saveCharacters(77, [fullCharacter]);
        assert.deepStrictEqual(mongo.saves.get(77), [fullCharacter], 'the entire character object must reach Mongo');
        assert.deepStrictEqual(await db.loadCharacters(77), [fullCharacter], 'Mongo save must load without field loss');
        assert.strictEqual(await db.isCharacterNameTaken('MongoHero'), true);
        assert.strictEqual(await db.getAccountIdByCharName('MongoHero'), 77);

        await db.saveCharacters(77, []);
        assert.deepStrictEqual(
            mongo.saves.get(77),
            [fullCharacter],
            'an empty write must not erase an existing non-empty Mongo save'
        );
    } finally {
        JsonAdapter.configureMongoGameDataForTests(null);
    }

    console.log('Mongo game-data delegation regression checks passed.');
}

void main();
