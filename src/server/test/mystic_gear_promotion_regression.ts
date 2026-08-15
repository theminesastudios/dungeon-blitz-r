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

/**
 * Regression: the automatic Mystic promotion on character load/save must cover all three class
 * lockbox sets — Mage 1165-1170, Rogue 1171-1176, Paladin 1177-1182 — not just Rogue. Owned
 * Legendary (tier 2) copies of these uniques become Mystic (tier 3); every other item is untouched.
 */

const MAGE_IDS = [1165, 1166, 1167, 1168, 1169, 1170];
const ROGUE_IDS = [1171, 1172, 1173, 1174, 1175, 1176];
const PALADIN_IDS = [1177, 1178, 1179, 1180, 1181, 1182];
const MYSTIC_IDS = [...MAGE_IDS, ...ROGUE_IDS, ...PALADIN_IDS];

const LEGENDARY_TIER = 2;
const MYSTIC_TIER = 3;

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

function gear(gearID: number, tier: number): { gearID: number; tier: number; runes: number[]; colors: number[] } {
    return { gearID, tier, runes: [0, 0, 0], colors: [0, 0] };
}

/** One character per class: lockbox uniques at Legendary, plus controls that must not move. */
function buildCharacters(): Character[] {
    const classSets: Array<{ name: string; ids: number[] }> = [
        { name: 'MaxMage', ids: MAGE_IDS },
        { name: 'MaxRogue', ids: ROGUE_IDS },
        { name: 'MaxPaladin', ids: PALADIN_IDS }
    ];

    return classSets.map(({ name, ids }) => {
        const equippedGears = ids.map((gearID) => gear(gearID, LEGENDARY_TIER));
        const inventoryGears = [
            // A second Legendary copy of every lockbox unique (promoted too).
            ...ids.map((gearID) => gear(gearID, LEGENDARY_TIER)),
            // Lesser copies must never jump two grades.
            gear(ids[0], 0),
            gear(ids[1], 1),
            // Non-lockbox neighbours of the sets must not be promoted.
            gear(1164, LEGENDARY_TIER),
            gear(1183, LEGENDARY_TIER)
        ];
        return {
            name,
            class: name.replace('Max', '').toLowerCase(),
            gender: 'female',
            level: 1,
            xp: 0,
            equippedGears,
            inventoryGears
        } as Character;
    });
}

type GearLike = { gearID?: number; tier?: number };

function findTier(character: Character, gearID: number, equipped: boolean): number[] {
    const gears = (equipped
        ? character.equippedGears as GearLike[] | undefined
        : character.inventoryGears as GearLike[] | undefined) ?? [];
    return gears
        .filter((entry: GearLike) => Number(entry?.gearID ?? 0) === gearID)
        .map((entry: GearLike) => Number(entry?.tier ?? 0));
}

async function main(): Promise<void> {
    const mongo = new MemoryGameDataAdapter();
    JsonAdapter.configureMongoGameDataForTests(mongo);
    const db = new JsonAdapter();

    try {
        // Load path: a save that already holds Legendary copies promotes on read.
        mongo.saves.set(77, buildCharacters());
        const loaded = await db.loadCharacters(77);
        assert.strictEqual(loaded.length, 3, 'one character per class');

        for (const character of loaded) {
            const firstEquipped = Number((character.equippedGears as Array<{ gearID?: number }> | undefined)?.[0]?.gearID ?? -1);
            const ids = MAGE_IDS.includes(firstEquipped) ? MAGE_IDS
                : ROGUE_IDS.includes(firstEquipped) ? ROGUE_IDS
                : PALADIN_IDS;
            for (const gearID of ids) {
                assert.deepStrictEqual(
                    findTier(character, gearID, true),
                    [MYSTIC_TIER],
                    `${character.name} ${gearID} equipped must be Mystic tier ${MYSTIC_TIER}`
                );
                const inventoryTiers = findTier(character, gearID, false);
                // ids[0]/ids[1] additionally carry the tier 0 / tier 1 control copies.
                const expectedInventory = gearID === ids[0]
                    ? [MYSTIC_TIER, 0]
                    : gearID === ids[1]
                        ? [MYSTIC_TIER, 1]
                        : [MYSTIC_TIER];
                assert.deepStrictEqual(
                    inventoryTiers,
                    expectedInventory,
                    `${character.name} ${gearID} inventory must promote only the Legendary copy`
                );
            }
            // Only Legendary copies of the lockbox sets are promoted.
            assert.deepStrictEqual(findTier(character, ids[0], false).filter((tier) => tier === 0), [0]);
            assert.deepStrictEqual(findTier(character, ids[1], false).filter((tier) => tier === 1), [1]);
            assert.deepStrictEqual(findTier(character, 1164, false), [LEGENDARY_TIER], 'non-lockbox gear must stay Legendary');
            assert.deepStrictEqual(findTier(character, 1183, false), [LEGENDARY_TIER], 'non-lockbox gear must stay Legendary');
        }

        // Save path: writing Legendary copies persists them as Mystic, and a reload is idempotent.
        mongo.saves.set(77, []);
        await db.saveCharacters(77, buildCharacters());
        const saved = mongo.saves.get(77) ?? [];
        assert.strictEqual(saved.length, 3, 'save must persist all three characters');
        for (const character of saved) {
            const firstEquipped = Number((character.equippedGears as Array<{ gearID?: number }> | undefined)?.[0]?.gearID ?? -1);
            const ids = MAGE_IDS.includes(firstEquipped) ? MAGE_IDS
                : ROGUE_IDS.includes(firstEquipped) ? ROGUE_IDS
                : PALADIN_IDS;
            for (const gearID of ids) {
                assert.deepStrictEqual(
                    findTier(character, gearID, true),
                    [MYSTIC_TIER],
                    `${character.name} ${gearID} must persist as Mystic tier ${MYSTIC_TIER}`
                );
            }
            assert.deepStrictEqual(findTier(character, 1164, false), [LEGENDARY_TIER], 'non-lockbox gear must stay Legendary');
            assert.deepStrictEqual(findTier(character, 1183, false), [LEGENDARY_TIER], 'non-lockbox gear must stay Legendary');
        }

        const reloaded = await db.loadCharacters(77);
        assert.strictEqual(
            reloaded.every((character) => ((character.equippedGears as Array<{ gearID?: number; tier?: number }> | undefined) ?? [])
                .every((entry) =>
                    MYSTIC_IDS.includes(Number(entry?.gearID ?? 0)) ? Number(entry?.tier ?? 0) === MYSTIC_TIER : true
                )),
            true,
            'reload must not downgrade Mystic copies'
        );
    } finally {
        JsonAdapter.configureMongoGameDataForTests(null);
    }

    console.log('Mystic gear promotion regression checks passed.');
}

void main();
