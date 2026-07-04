import type { Character } from '../../database/Database';
import type { WalletPersistenceAdapter } from '../../database/MongoWalletAdapter';
import type { WalletDelta, WalletDocument, WalletOwnerIdentity } from '../../database/WalletTypes';

// This module must be the first import of every regression test. Config and
// WalletService capture Mongo settings when their modules load, so the env
// overrides below have to run before any other server module is evaluated.
// Regression tests must never reach a real Mongo cluster, no matter what
// src/server/.env or the shell environment contains.
process.env.ENABLE_MONGO_WALLET = 'false';
process.env.MONGODB_URI = '';
process.env.SPONSOR_MONGODB_URI = '';

// Loaded via require so the env overrides above are applied before Config
// (a transitive import of WalletService) reads process.env.
const { WalletService } = require('../../database/WalletService') as typeof import('../../database/WalletService');

class BlockedWalletAdapter implements WalletPersistenceAdapter {
    async connect(): Promise<void> {
        throw new Error('Regression tests must not connect to Mongo');
    }

    async close(): Promise<void> {}

    async getOrCreateWallet(_identity: WalletOwnerIdentity, _character: Character): Promise<WalletDocument> {
        throw new Error('Regression tests must not read Mongo wallets');
    }

    async applyDelta(
        _identity: WalletOwnerIdentity,
        _character: Character,
        _delta: WalletDelta
    ): Promise<WalletDocument | null> {
        throw new Error('Regression tests must not write Mongo wallets');
    }
}

WalletService.configureForTests(new BlockedWalletAdapter(), false);
