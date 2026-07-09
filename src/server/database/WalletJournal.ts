import * as fs from 'fs/promises';
import * as path from 'path';

import { Config } from '../core/config';
import { WalletDelta } from './WalletTypes';

export interface WalletJournalDeltaEntry {
    id: string;
    gameUserId: number;
    characterNameKey: string;
    characterName: string;
    delta: WalletDelta;
    createdAt: string;
}

export interface WalletJournalStore {
    appendDelta(entry: WalletJournalDeltaEntry): Promise<void>;
    markFlushed(ids: string[]): Promise<void>;
    loadPending(): Promise<WalletJournalDeltaEntry[]>;
}

type WalletJournalRecord =
    | ({ type: 'delta' } & WalletJournalDeltaEntry)
    | { type: 'flushed'; id: string; flushedAt: string };

export class WalletJournal implements WalletJournalStore {
    private readonly journalPath: string;

    constructor(journalPath: string = path.resolve(Config.DATA_DIR, 'data', 'wallet_journal.jsonl')) {
        this.journalPath = journalPath;
    }

    async appendDelta(entry: WalletJournalDeltaEntry): Promise<void> {
        await this.appendRecord({
            type: 'delta',
            ...entry
        });
    }

    async markFlushed(ids: string[]): Promise<void> {
        const uniqueIds = Array.from(new Set(ids.map((id) => String(id ?? '').trim()).filter(Boolean)));
        if (uniqueIds.length === 0) {
            return;
        }

        const flushedAt = new Date().toISOString();
        await this.appendLines(uniqueIds.map((id) => JSON.stringify({ type: 'flushed', id, flushedAt })));
    }

    async loadPending(): Promise<WalletJournalDeltaEntry[]> {
        const records = await this.readRecords();
        const pending = new Map<string, WalletJournalDeltaEntry>();

        for (const record of records) {
            if (record.type === 'delta') {
                pending.set(record.id, {
                    id: record.id,
                    gameUserId: record.gameUserId,
                    characterNameKey: record.characterNameKey,
                    characterName: record.characterName,
                    delta: record.delta,
                    createdAt: record.createdAt
                });
            } else if (record.type === 'flushed') {
                pending.delete(record.id);
            }
        }

        return Array.from(pending.values());
    }

    private async appendRecord(record: WalletJournalRecord): Promise<void> {
        await this.appendLines([JSON.stringify(record)]);
    }

    private async appendLines(lines: string[]): Promise<void> {
        await fs.mkdir(path.dirname(this.journalPath), { recursive: true });
        await fs.appendFile(this.journalPath, `${lines.join('\n')}\n`, 'utf8');
    }

    private async readRecords(): Promise<WalletJournalRecord[]> {
        let raw = '';
        try {
            raw = await fs.readFile(this.journalPath, 'utf8');
        } catch (error: any) {
            if (error?.code === 'ENOENT') {
                return [];
            }
            throw error;
        }

        const records: WalletJournalRecord[] = [];
        for (const line of raw.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed) {
                continue;
            }

            try {
                const parsed = JSON.parse(trimmed) as WalletJournalRecord;
                if (parsed.type === 'delta' && parsed.id) {
                    records.push(parsed);
                } else if (parsed.type === 'flushed' && parsed.id) {
                    records.push(parsed);
                }
            } catch (error) {
                console.warn('[WalletJournal] Ignoring invalid journal line:', error);
            }
        }

        return records;
    }
}
