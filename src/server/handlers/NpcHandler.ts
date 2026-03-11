import { Client } from '../core/Client';
import { GlobalState } from '../core/GlobalState';
import { Character } from '../database/Database';
import { JsonAdapter } from '../database/JsonAdapter';
import { MissionDef, MissionLoader } from '../data/MissionLoader';
import { NpcLoader } from '../data/NpcLoader';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { BitReader } from '../network/protocol/bitReader';

const db = new JsonAdapter();

type MissionEntry = Record<string, any>;
type ResolvedNpc = Record<string, any>;

export class NpcHandler {
    private static readonly MISSION_NOT_STARTED = 0;
    private static readonly MISSION_IN_PROGRESS = 1;
    private static readonly MISSION_READY_TO_TURN_IN = 2;
    private static readonly MISSION_CLAIMED = 3;

    static async handleTalkToNpc(client: Client, data: Buffer): Promise<void> {
        if (!client.character) {
            return;
        }

        const br = new BitReader(data);
        const npcId = br.readMethod9();
        const levelName = String(client.currentLevel || client.character.CurrentLevel?.name || '');
        const npc = NpcHandler.findNpc(client, levelName, npcId);

        let dialogueId = 0;
        let missionId = 0;
        let didMutate = false;
        let npcKey = '';

        if (npc) {
            npcKey = NpcHandler.normalizeNpcKey(
                String(
                    npc.characterName ??
                    npc.character_name ??
                    npc.entType ??
                    npc.name ??
                    ''
                )
            );

            const matched = NpcHandler.findBestMission(client.character, npcKey);
            if (matched) {
                dialogueId = matched.dialogueId;
                missionId = matched.missionId;

                if (dialogueId === 2 && matched.state === NpcHandler.MISSION_NOT_STARTED) {
                    NpcHandler.setMissionState(
                        client.character,
                        missionId,
                        NpcHandler.MISSION_IN_PROGRESS
                    );
                    NpcHandler.sendMissionAdded(client, missionId);
                    didMutate = true;
                } else if (
                    dialogueId === 4 &&
                    (matched.state === NpcHandler.MISSION_IN_PROGRESS ||
                        matched.state === NpcHandler.MISSION_READY_TO_TURN_IN)
                ) {
                    NpcHandler.setMissionState(
                        client.character,
                        missionId,
                        NpcHandler.MISSION_CLAIMED
                    );
                    NpcHandler.sendMissionComplete(client, missionId);

                    const followupMissionId = NpcHandler.autoAcceptFollowupMission(
                        client.character,
                        npcKey,
                        missionId
                    );
                    if (followupMissionId) {
                        NpcHandler.sendMissionAdded(client, followupMissionId);
                    }

                    didMutate = true;
                }
            }
        }

        if (!dialogueId || !missionId) {
            NpcHandler.sendNpcBubble(client, npcId, NpcHandler.getFallbackLine(npcKey));
            return;
        }

        if (didMutate && client.userId) {
            await db.saveCharacters(client.userId, client.characters);
        }

        NpcHandler.sendStartSkit(client, npcId, dialogueId, missionId);
    }

    private static findNpc(client: Client, levelName: string, npcId: number): ResolvedNpc | null {
        const local = client.entities.get(npcId);
        if (local) {
            return local;
        }

        const levelMap = GlobalState.levelEntities.get(levelName);
        const global = levelMap?.get(npcId);
        if (global) {
            return global;
        }

        const fromLoader = NpcLoader.getNpcsForLevel(levelName).find((npc) => npc.id === npcId);
        return fromLoader || null;
    }

    private static findBestMission(
        character: Character,
        npcKey: string
    ): { missionId: number; dialogueId: number; state: number } | null {
        if (!npcKey) {
            return null;
        }

        let best: { missionId: number; dialogueId: number; state: number; priority: number } | null = null;

        for (let missionId = 1; missionId <= MissionLoader.getTotalMissions(); missionId++) {
            const missionDef = MissionLoader.getMissionDef(missionId);
            if (!missionDef) {
                continue;
            }

            const state = NpcHandler.getMissionState(character, missionId);
            const contactKey = NpcHandler.normalizeNpcKey(missionDef.ContactName ?? '');
            const returnKey = NpcHandler.normalizeNpcKey(missionDef.ReturnName ?? '');
            const isDungeonMission = Boolean(String(missionDef.Dungeon ?? '').trim());

            let priority = 0;
            let dialogueId = 0;

            if (
                npcKey === returnKey &&
                (
                    state === NpcHandler.MISSION_READY_TO_TURN_IN ||
                    (state === NpcHandler.MISSION_IN_PROGRESS && !isDungeonMission)
                )
            ) {
                priority = 4;
                dialogueId = 4;
            } else if (npcKey === contactKey && state === NpcHandler.MISSION_IN_PROGRESS) {
                priority = 3;
                dialogueId = 3;
            } else if (
                npcKey === contactKey &&
                state === NpcHandler.MISSION_NOT_STARTED &&
                NpcHandler.canStartMission(character, missionDef)
            ) {
                priority = 2;
                dialogueId = 2;
            } else if (
                (npcKey === contactKey || npcKey === returnKey) &&
                state >= NpcHandler.MISSION_CLAIMED
            ) {
                priority = 1;
                dialogueId = 5;
            }

            if (!priority) {
                continue;
            }

            if (!best || priority > best.priority) {
                best = { missionId, dialogueId, state, priority };
            }
        }

        return best ? { missionId: best.missionId, dialogueId: best.dialogueId, state: best.state } : null;
    }

    private static autoAcceptFollowupMission(
        character: Character,
        npcKey: string,
        excludeMissionId: number
    ): number {
        for (let missionId = 1; missionId <= MissionLoader.getTotalMissions(); missionId++) {
            if (missionId === excludeMissionId) {
                continue;
            }

            const missionDef = MissionLoader.getMissionDef(missionId);
            if (!missionDef) {
                continue;
            }

            if (NpcHandler.getMissionState(character, missionId) !== NpcHandler.MISSION_NOT_STARTED) {
                continue;
            }

            if (NpcHandler.normalizeNpcKey(missionDef.ContactName ?? '') !== npcKey) {
                continue;
            }

            if (!NpcHandler.canStartMission(character, missionDef)) {
                continue;
            }

            NpcHandler.setMissionState(character, missionId, NpcHandler.MISSION_IN_PROGRESS);
            return missionId;
        }

        return 0;
    }

    private static canStartMission(character: Character, missionDef: MissionDef): boolean {
        for (const prereqName of missionDef.PreReqMissions ?? []) {
            const prereqId = MissionLoader.getMissionIdByName(prereqName);
            if (!prereqId) {
                continue;
            }

            if (NpcHandler.getMissionState(character, prereqId) < NpcHandler.MISSION_CLAIMED) {
                return false;
            }
        }

        return true;
    }

    private static getMissionStateMap(character: Character): Record<string, MissionEntry> {
        const raw = character.missions;
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            character.missions = {};
            return character.missions;
        }
        return raw as Record<string, MissionEntry>;
    }

    private static getMissionState(character: Character, missionId: number): number {
        const missions = NpcHandler.getMissionStateMap(character);
        const entry = missions[String(missionId)];
        return Number((entry && typeof entry === 'object' ? entry.state : undefined) ?? NpcHandler.MISSION_NOT_STARTED);
    }

    private static setMissionState(character: Character, missionId: number, state: number): void {
        const missions = NpcHandler.getMissionStateMap(character);
        const key = String(missionId);
        const next: MissionEntry = {
            ...(missions[key] && typeof missions[key] === 'object' ? missions[key] : {})
        };

        next.state = state;
        if (state >= NpcHandler.MISSION_CLAIMED) {
            next.claimed = 1;
            next.complete = 1;
        } else {
            delete next.claimed;
            delete next.complete;
        }

        if (state === NpcHandler.MISSION_IN_PROGRESS && next.currCount === undefined) {
            next.currCount = 0;
        }

        missions[key] = next;
    }

    private static sendMissionAdded(client: Client, missionId: number): void {
        const bb = new BitBuffer(false);
        bb.writeMethod4(missionId);
        bb.writeMethod11(1, 1);
        client.sendBitBuffer(0x85, bb);
    }

    private static sendMissionComplete(client: Client, missionId: number): void {
        const bb = new BitBuffer(false);
        bb.writeMethod4(missionId);
        client.sendBitBuffer(0x86, bb);
    }

    private static sendStartSkit(client: Client, npcId: number, dialogueId: number, missionId: number): void {
        const bb = new BitBuffer();
        bb.writeMethod4(npcId);
        bb.writeMethod6(dialogueId, 3);
        bb.writeMethod4(missionId);
        client.sendBitBuffer(0x7B, bb);
    }

    private static sendNpcBubble(client: Client, npcId: number, text: string): void {
        const bb = new BitBuffer();
        bb.writeMethod4(npcId);
        bb.writeMethod13(text);
        client.sendBitBuffer(0x76, bb);
    }

    private static getFallbackLine(npcKey: string): string {
        const lines: Record<string, string[]> = {
            nrcaptfink: [
                'We made it to shore alive, at least.',
                'I must get word to the king!'
            ],
            captainfink: [
                'We made it to shore alive, at least.',
                'I must get word to the king!'
            ],
            nrmayor01: [
                'Thank the heavens you have arrived!',
                'Our fighters need their leader.'
            ],
            anna: [
                'Our fighters need their leader.',
                'Someone named Nephit is trying to control the goblins.'
            ],
            nranna03: [
                'Our fighters need their leader.',
                'Someone named Nephit is trying to control the goblins.'
            ],
            nrquestanna01: [
                'Someone named Nephit is trying to control the goblins.'
            ],
            nrpecky: [
                'Squawk! This way!',
                'Squawk! Follow Pecky!'
            ]
        };

        const pool = lines[npcKey] || ['...'];
        return pool[Math.floor(Math.random() * pool.length)];
    }

    private static normalizeNpcKey(value: string): string {
        const normalized = String(value ?? '')
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]/g, '');

        if (!normalized) {
            return '';
        }

        const aliases: Record<string, string> = {
            mayorristas: 'nrmayor01',
            mayor: 'nrmayor01',
            anna: 'nranna03',
            pecky: 'nrpecky',
            captainfink: 'nrcaptfink',
            fink: 'nrcaptfink'
        };

        return aliases[normalized] ?? normalized;
    }
}
