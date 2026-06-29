import { strict as assert } from 'assert';
import { Character } from '../database/Database';
import { WalletPersistenceAdapter } from '../database/MongoWalletAdapter';
import { WalletService } from '../database/WalletService';
import {
    applyWalletSnapshot,
    createWalletDocument,
    createWalletOwnerIdentity,
    getWalletDocumentId,
    normalizeWalletDocument,
    WalletDelta,
    WalletDocument,
    WalletOwnerIdentity
} from '../database/WalletTypes';

class MemoryWalletAdapter implements WalletPersistenceAdapter {
    private readonly wallets = new Map<string, WalletDocument>();

    async connect(): Promise<void> {}

    async close(): Promise<void> {}

    async getOrCreateWallet(identity: WalletOwnerIdentity, character: Character): Promise<WalletDocument> {
        const key = this.getKey(identity, character);
        const existing = this.wallets.get(key);
        if (existing) {
            return normalizeWalletDocument(existing);
        }

        const document = createWalletDocument(identity, character);
        this.wallets.set(key, document);
        return normalizeWalletDocument(document);
    }

    async applyDelta(identity: WalletOwnerIdentity, character: Character, delta: WalletDelta): Promise<WalletDocument | null> {
        const key = this.getKey(identity, character);
        const existing = this.wallets.get(key);
        if (!existing) {
            return null;
        }

        const next = normalizeWalletDocument(existing);
        for (const field of ['gold', 'mammothIdols', 'DragonKeys', 'dragonOre', 'SilverSigils', 'RoyalSigils'] as const) {
            const value = Number(delta[field] ?? 0);
            if (value < 0 && Number(next[field] ?? 0) < Math.abs(value)) {
                return null;
            }
            next[field] = Math.max(0, Number(next[field] ?? 0) + value);
        }

        for (const lockboxDelta of Array.isArray(delta.lockboxes) ? delta.lockboxes : []) {
            const lockboxID = Number(lockboxDelta.lockboxID ?? 0);
            const amount = Number(lockboxDelta.delta ?? 0);
            const entry = next.lockboxes.find((lockbox) => lockbox.lockboxID === lockboxID);
            if (amount < 0 && Number(entry?.count ?? 0) < Math.abs(amount)) {
                return null;
            }
            if (entry) {
                entry.count = Math.max(0, Number(entry.count ?? 0) + amount);
            } else if (amount > 0) {
                next.lockboxes.push({ lockboxID, count: amount });
            }
        }
        next.lockboxes = next.lockboxes.filter((entry) => entry.count > 0).sort((left, right) => left.lockboxID - right.lockboxID);
        next.updatedAt = new Date();
        this.wallets.set(key, next);
        return normalizeWalletDocument(next);
    }

    seed(identity: WalletOwnerIdentity, characterName: string, document: WalletDocument): void {
        this.wallets.set(getWalletDocumentId(identity, characterName), normalizeWalletDocument(document));
    }

    getDocument(identity: WalletOwnerIdentity, characterName: string): WalletDocument | null {
        const document = this.wallets.get(getWalletDocumentId(identity, characterName));
        return document ? normalizeWalletDocument(document) : null;
    }

    private getKey(identity: WalletOwnerIdentity, character: Character): string {
        return getWalletDocumentId(identity, character);
    }
}

function createCharacter(): Character {
    return {
        name: 'WalletHero',
        class: 'mage',
        gender: 'male',
        level: 10,
        gold: 100,
        mammothIdols: 25,
        DragonKeys: 3,
        DragonOre: 7,
        SilverSigils: 11,
        lockboxes: [{ lockboxID: 1, count: 2 }]
    };
}

async function testCreateWalletFromExistingCharacter(): Promise<void> {
    const adapter = new MemoryWalletAdapter();
    WalletService.configureForTests(adapter, true);
    const character = createCharacter();

    await WalletService.overlayWallet(44, character);

    assert.equal(character.gold, 100, 'new wallet should preserve JSON gold on first creation');
    assert.equal(character.DragonOre, 7, 'new wallet should preserve canonical DragonOre');
    assert.deepEqual(character.lockboxes, [{ lockboxID: 1, count: 2 }], 'new wallet should preserve lockbox counts');
}

async function testLoadWalletOverlay(): Promise<void> {
    const adapter = new MemoryWalletAdapter();
    WalletService.configureForTests(adapter, true);
    const character = createCharacter();
    const identity = createWalletOwnerIdentity(44);
    const document = createWalletDocument(identity, character);
    applyWalletSnapshot(document as unknown as Character, {
        gold: 999,
        mammothIdols: 88,
        DragonKeys: 77,
        dragonOre: 66,
        SilverSigils: 55,
        RoyalSigils: 44,
        lockboxes: [{ lockboxID: 1, count: 9 }]
    });
    adapter.seed(identity, character.name, document);

    character.gold = 1;
    character.mammothIdols = 1;
    await WalletService.overlayWallet(44, character);

    assert.equal(character.gold, 999, 'Mongo wallet gold should overlay stale JSON gold');
    assert.equal(character.mammothIdols, 88, 'Mongo wallet idols should overlay stale JSON idols');
    assert.equal(character.DragonOre, 66, 'Mongo wallet dragon ore should overlay stale JSON ore');
    assert.deepEqual(character.lockboxes, [{ lockboxID: 1, count: 9 }], 'Mongo lockbox counts should overlay stale JSON lockboxes');
}

async function testDiscordStyleWalletIdentity(): Promise<void> {
    const adapter = new MemoryWalletAdapter();
    const discordUserId = '285118390031351809';
    WalletService.configureForTests(
        adapter,
        true,
        async (gameUserId) => createWalletOwnerIdentity(gameUserId, discordUserId)
    );
    const character = createCharacter();

    await WalletService.overlayWallet(44, character);
    const document = adapter.getDocument(createWalletOwnerIdentity(44, discordUserId), character.name);

    assert.ok(document, 'wallet document should be created');
    assert.equal(document?._id, '44:wallethero', 'wallet _id should be deterministic per game account and character');
    assert.equal(document?.userId, discordUserId, 'wallet userId should mirror the Discord bot string user id when linked');
    assert.equal(document?.gameUserId, 44, 'wallet should retain the game account id for JSON save compatibility');
    assert.equal(document?.discordUserId, discordUserId, 'wallet should store the Discord id only, not OAuth token data');
    assert.equal(document?.identityProvider, 'discord', 'wallet should mark Discord-backed identity');
}

async function testAtomicSpendSucceedsAndFails(): Promise<void> {
    const adapter = new MemoryWalletAdapter();
    WalletService.configureForTests(adapter, true);
    const character = createCharacter();
    await WalletService.overlayWallet(44, character);

    assert.equal(await WalletService.spend({ userId: 44, character }, 'gold', 70), true, 'spend should succeed when balance is enough');
    assert.equal(character.gold, 30, 'successful spend should update in-memory character from wallet');

    assert.equal(await WalletService.spend({ userId: 44, character }, 'gold', 31), false, 'spend should fail when balance is insufficient');
    assert.equal(character.gold, 30, 'failed spend must leave authoritative balance unchanged');
}

async function testJsonFallbackWhenDisabled(): Promise<void> {
    const adapter = new MemoryWalletAdapter();
    WalletService.configureForTests(adapter, false);
    const character = createCharacter();

    assert.equal(await WalletService.spend({ userId: 44, character }, 'mammothIdols', 5), true, 'disabled Mongo wallet should use JSON fallback');
    assert.equal(character.mammothIdols, 20, 'JSON fallback should mutate the character like the old path');
    assert.equal(await WalletService.spend({ userId: 44, character }, 'mammothIdols', 21), false, 'JSON fallback should still enforce balance');
    assert.equal(character.mammothIdols, 20, 'failed JSON fallback spend should not mutate');
}

async function main(): Promise<void> {
    await testCreateWalletFromExistingCharacter();
    await testLoadWalletOverlay();
    await testDiscordStyleWalletIdentity();
    await testAtomicSpendSucceedsAndFails();
    await testJsonFallbackWhenDisabled();
    console.log('wallet_service_regression: ok');
}

void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
