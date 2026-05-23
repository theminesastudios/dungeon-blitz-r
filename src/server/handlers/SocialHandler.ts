import { Character } from '../database/Database';
import { Client } from '../core/Client';
import { BitReader } from '../network/protocol/bitReader';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { GlobalState } from '../core/GlobalState';
import { EntityTeam } from '../core/Entity';
import { JsonAdapter } from '../database/JsonAdapter';
import { LevelConfig } from '../core/LevelConfig';
import { Config } from '../core/config';
import { GuildHandler } from './GuildHandler';
import { LevelHandler } from './LevelHandler';
import { MissionHandler } from './MissionHandler';
import { PetHandler } from './PetHandler';
import { DialogueTranslationLoader } from '../data/DialogueTranslationLoader';
import { discordSocialBridge } from '../integrations/DiscordSocialBridge';
import {
    ensureCharacterSocialState,
    FriendEntry,
    getCharacterIgnoredEntries,
    isCharacterIgnoring,
    normalizeCharacterKey,
    PartyGroup,
    PendingTeleport
} from '../core/SocialState';
import { areClientsInSameLevelScope, getClientLevelScope } from '../core/LevelScope';

const db = new JsonAdapter();

interface LoadedCharacterRecord {
    userId: number;
    characters: Character[];
    character: Character;
}

interface PendingFriendRequestPrompt {
    requesterName: string;
    targetName: string;
    expiresAt: number;
}

export interface DiscordPartyJoinResult {
    ok: boolean;
    reason:
        | 'ok'
        | 'requester-offline'
        | 'requester-in-party'
        | 'already-in-party'
        | 'party-not-found'
        | 'party-leader-mismatch'
        | 'party-locked'
        | 'party-full';
    message: string;
    partyId: number | null;
}

export class SocialHandler {
    private static readonly MAX_PARTY_SIZE = 4;
    private static readonly LOCALIZATION_RELOAD_PREFIX = 'DB_LOCALIZATION_RELOAD:';
    private static readonly FRIEND_REQUEST_PROMPT_TTL_MS = 5 * 60_000;
    private static readonly pendingFriendRequestPrompts: Map<number, PendingFriendRequestPrompt> = new Map();

    private static normalizeName(value: unknown): string {
        return normalizeCharacterKey(value);
    }

    private static getCharacterName(client: Client): string {
        return String(client.character?.name ?? '').trim();
    }

    private static getOnlineSession(name: string): Client | null {
        const key = SocialHandler.normalizeName(name);
        if (!key) {
            return null;
        }

        return GlobalState.getActiveSessionByCharacterName(key);
    }

    private static findSessionByEntityId(entityId: number): Client | null {
        for (const session of GlobalState.sessionsByToken.values()) {
            if (session.clientEntID === entityId && session.character) {
                return session;
            }
        }

        return null;
    }

    private static classIdFromName(className: string): number {
        switch (SocialHandler.normalizeName(className)) {
            case 'rogue':
                return 1;
            case 'mage':
                return 2;
            case 'paladin':
            default:
                return 0;
        }
    }

    private static appendBuffer(bb: BitBuffer, buffer: Buffer): void {
        for (const byte of buffer) {
            bb.writeMethod11(byte, 8);
        }
    }

    private static buildEmptyPartyPayload(): Buffer {
        const bb = new BitBuffer(false);
        bb.writeMethod15(false);
        return bb.toBuffer();
    }

    private static sendEmptyPartyUpdate(client: Client | null | undefined): void {
        if (!client) {
            return;
        }

        client.send(0x75, SocialHandler.buildEmptyPartyPayload());
    }

    private static buildGroupChatPayload(senderName: string, message: string): Buffer {
        const bb = new BitBuffer(false);
        bb.writeMethod13(senderName);
        bb.writeMethod13(message);
        return bb.toBuffer();
    }

    private static buildGroupmateMapPayload(senderName: string, mapX: number, mapY: number): Buffer {
        const bb = new BitBuffer(false);
        bb.writeMethod26(senderName);
        bb.writeMethod91(Math.max(0, mapX));
        bb.writeMethod91(Math.max(0, mapY));
        return bb.toBuffer();
    }

    private static sendChatStatus(target: Client | null | undefined, text: string): void {
        if (!target) {
            return;
        }

        const bb = new BitBuffer(false);
        bb.writeMethod13(text);
        target.sendBitBuffer(0x44, bb);
    }

    private static buildLocalizationReloadUrl(language: string): string {
        const portSuffix = Config.STATIC_PORT === 80 ? '' : `:${Config.STATIC_PORT}`;
        const url = new URL(`http://${Config.HOST}${portSuffix}/p/cbp/DungeonBlitz.swf`);
        url.searchParams.set('fv', 'cbw');
        url.searchParams.set('gv', 'cbv');
        url.searchParams.set('lang', language);
        return url.toString();
    }

    private static sendLocalizationReload(target: Client | null | undefined, language: string): void {
        SocialHandler.sendChatStatus(
            target,
            `${SocialHandler.LOCALIZATION_RELOAD_PREFIX}${SocialHandler.buildLocalizationReloadUrl(language)}`
        );
    }

    private static sendQueryMessageQuestion(target: Client, token: number, name: string, message: string): void {
        const bb = new BitBuffer(false);
        bb.writeMethod9(Math.max(0, token));
        bb.writeMethod26(name);
        bb.writeMethod26(message);
        target.sendBitBuffer(0x58, bb);
    }

    private static cleanupExpiredFriendRequestPrompts(): void {
        const now = Date.now();
        for (const [token, prompt] of SocialHandler.pendingFriendRequestPrompts.entries()) {
            if (prompt.expiresAt <= now) {
                SocialHandler.pendingFriendRequestPrompts.delete(token);
            }
        }
    }

    private static nextFriendRequestPromptToken(): number {
        SocialHandler.cleanupExpiredFriendRequestPrompts();

        let token = 0;
        do {
            token = 2_000_000 + Math.floor(Math.random() * 1_000_000);
        } while (SocialHandler.pendingFriendRequestPrompts.has(token));

        return token;
    }

    private static clearPendingFriendRequestPrompts(requesterName: string, targetName: string): void {
        const requesterKey = SocialHandler.normalizeName(requesterName);
        const targetKey = SocialHandler.normalizeName(targetName);
        if (!requesterKey || !targetKey) {
            return;
        }

        for (const [token, prompt] of SocialHandler.pendingFriendRequestPrompts.entries()) {
            if (
                SocialHandler.normalizeName(prompt.requesterName) === requesterKey &&
                SocialHandler.normalizeName(prompt.targetName) === targetKey
            ) {
                SocialHandler.pendingFriendRequestPrompts.delete(token);
            }
        }
    }

    private static sendFriendRequestPrompt(target: Client, requesterName: string): void {
        const targetName = SocialHandler.getCharacterName(target);
        if (!targetName || !requesterName) {
            return;
        }

        SocialHandler.clearPendingFriendRequestPrompts(requesterName, targetName);

        const token = SocialHandler.nextFriendRequestPromptToken();
        SocialHandler.pendingFriendRequestPrompts.set(token, {
            requesterName,
            targetName,
            expiresAt: Date.now() + SocialHandler.FRIEND_REQUEST_PROMPT_TTL_MS
        });
        SocialHandler.sendQueryMessageQuestion(
            target,
            token,
            requesterName,
            `${requesterName} wants to be your friend`
        );
    }

    private static getFriendEntries(character: Character | null | undefined): FriendEntry[] {
        ensureCharacterSocialState(character);
        return Array.isArray(character?.friends) ? (character.friends as FriendEntry[]) : [];
    }

    private static findFriendIndex(character: Character | null | undefined, friendName: string): number {
        const friendKey = SocialHandler.normalizeName(friendName);
        return SocialHandler.getFriendEntries(character).findIndex((entry) =>
            SocialHandler.normalizeName(entry.name) === friendKey
        );
    }

    private static getFriendEntry(character: Character | null | undefined, friendName: string): FriendEntry | null {
        const index = SocialHandler.findFriendIndex(character, friendName);
        if (index < 0) {
            return null;
        }

        return SocialHandler.getFriendEntries(character)[index] ?? null;
    }

    private static upsertFriendEntry(character: Character | null | undefined, entry: FriendEntry): boolean {
        if (!character) {
            return false;
        }

        const friends = SocialHandler.getFriendEntries(character);
        const index = SocialHandler.findFriendIndex(character, entry.name);
        if (index >= 0) {
            const current = friends[index];
            if (current.name === entry.name && current.isRequest === entry.isRequest) {
                return false;
            }

            friends[index] = { ...entry };
            character.friends = friends;
            return true;
        }

        character.friends = [...friends, { ...entry }];
        return true;
    }

    private static removeFriendEntry(character: Character | null | undefined, friendName: string): FriendEntry | null {
        if (!character) {
            return null;
        }

        const friends = SocialHandler.getFriendEntries(character);
        const index = SocialHandler.findFriendIndex(character, friendName);
        if (index < 0) {
            return null;
        }

        const removed = friends[index];
        const nextFriends = [...friends];
        nextFriends.splice(index, 1);
        character.friends = nextFriends;
        return removed ?? null;
    }

    private static buildFriendStatusPayload(friendName: string, isRequest: boolean, session: Client | null): Buffer {
        const bb = new BitBuffer(false);
        bb.writeMethod13(friendName);
        bb.writeMethod15(isRequest);

        const online = Boolean(session?.character);
        bb.writeMethod15(online);
        if (online && session?.character) {
            const displayName = session.character.name;
            const hasCustomCharacterName = displayName !== friendName;
            bb.writeMethod15(hasCustomCharacterName);
            if (hasCustomCharacterName) {
                bb.writeMethod13(displayName);
            }
            bb.writeMethod6(SocialHandler.classIdFromName(String(session.character.class ?? 'Paladin')), 2);
            bb.writeMethod6(Math.max(1, Math.min(Number(session.character.level ?? 1), 63)), 6);
        }

        return bb.toBuffer();
    }

    private static sendFriendUpdate(
        target: Client | null | undefined,
        friendName: string,
        isRequest: boolean,
        session: Client | null
    ): void {
        if (!target) {
            return;
        }

        target.send(0x92, SocialHandler.buildFriendStatusPayload(friendName, isRequest, session));
    }

    private static sendFriendRemoved(target: Client | null | undefined, friendName: string): void {
        if (!target) {
            return;
        }

        const bb = new BitBuffer(false);
        bb.writeMethod13(friendName);
        target.sendBitBuffer(0x93, bb);
    }

    private static sendFullFriendList(client: Client): void {
        if (!client.character) {
            return;
        }

        const bb = new BitBuffer(false);
        const friends = SocialHandler.getFriendEntries(client.character);
        bb.writeMethod4(friends.length);

        for (const friend of friends) {
            SocialHandler.appendBuffer(
                bb,
                SocialHandler.buildFriendStatusPayload(
                    friend.name,
                    friend.isRequest,
                    SocialHandler.getOnlineSession(friend.name)
                )
            );
        }

        client.sendBitBuffer(0xCA, bb);
    }

    private static getIgnoredEntries(character: Character | null | undefined): string[] {
        return getCharacterIgnoredEntries(character);
    }

    private static findIgnoredIndex(character: Character | null | undefined, targetName: string): number {
        const targetKey = SocialHandler.normalizeName(targetName);
        return SocialHandler.getIgnoredEntries(character).findIndex((entry) =>
            SocialHandler.normalizeName(entry) === targetKey
        );
    }

    private static addIgnoredEntry(character: Character | null | undefined, targetName: string): boolean {
        if (!character) {
            return false;
        }

        const ignored = SocialHandler.getIgnoredEntries(character);
        if (SocialHandler.findIgnoredIndex(character, targetName) >= 0) {
            return false;
        }

        character.ignored = [...ignored, String(targetName ?? '').trim()];
        return true;
    }

    private static removeIgnoredEntry(character: Character | null | undefined, targetName: string): boolean {
        if (!character) {
            return false;
        }

        const ignored = SocialHandler.getIgnoredEntries(character);
        const index = SocialHandler.findIgnoredIndex(character, targetName);
        if (index < 0) {
            return false;
        }

        const nextIgnored = [...ignored];
        nextIgnored.splice(index, 1);
        character.ignored = nextIgnored;
        return true;
    }

    private static buildIgnoreNamePayload(targetName: string): Buffer {
        const bb = new BitBuffer(false);
        bb.writeMethod13(targetName);
        return bb.toBuffer();
    }

    private static sendIgnoreAdded(target: Client | null | undefined, targetName: string): void {
        if (!target) {
            return;
        }

        target.send(0x9d, SocialHandler.buildIgnoreNamePayload(targetName));
    }

    private static sendIgnoreRemoved(target: Client | null | undefined, targetName: string): void {
        if (!target) {
            return;
        }

        target.send(0x9c, SocialHandler.buildIgnoreNamePayload(targetName));
    }

    private static sendFullIgnoreList(client: Client): void {
        if (!client.character) {
            return;
        }

        const ignored = SocialHandler.getIgnoredEntries(client.character);
        const bb = new BitBuffer(false);
        bb.writeMethod4(ignored.length);
        for (const entry of ignored) {
            bb.writeMethod13(entry);
        }

        client.sendBitBuffer(0x9f, bb);
    }

    private static canReceiveChatFrom(recipient: Client | null | undefined, senderName: string): boolean {
        if (!recipient?.character) {
            return false;
        }

        return !isCharacterIgnoring(recipient.character, senderName);
    }
    private static upsertCharacter(characters: Character[], character: Character): Character[] {
        const normalizedName = SocialHandler.normalizeName(character.name);
        const nextCharacters = Array.isArray(characters) ? [...characters] : [];
        const index = nextCharacters.findIndex((entry) => SocialHandler.normalizeName(entry?.name) === normalizedName);

        if (index >= 0) {
            nextCharacters[index] = character;
        } else {
            nextCharacters.push(character);
        }

        return nextCharacters;
    }

    private static async persistClientCharacter(client: Client): Promise<void> {
        if (!client.userId || !client.character) {
            return;
        }

        ensureCharacterSocialState(client.character);
        client.characters = SocialHandler.upsertCharacter(client.characters, client.character);
        await db.saveCharacters(client.userId, client.characters);
    }

    private static async loadCharacterRecordByName(name: string): Promise<LoadedCharacterRecord | null> {
        const userId = await db.getAccountIdByCharName(name);
        if (!userId) {
            return null;
        }

        const characters = await db.loadCharacters(userId);
        const normalizedName = SocialHandler.normalizeName(name);
        const character = characters.find((entry) => SocialHandler.normalizeName(entry?.name) === normalizedName);
        if (!character) {
            return null;
        }

        ensureCharacterSocialState(character);
        return { userId, characters, character };
    }

    private static async persistLoadedCharacter(record: LoadedCharacterRecord): Promise<void> {
        ensureCharacterSocialState(record.character);
        record.characters = SocialHandler.upsertCharacter(record.characters, record.character);
        await db.saveCharacters(record.userId, record.characters);
    }

    private static notifyFriendsAboutStatus(client: Client, online: boolean): void {
        if (!client.character) {
            return;
        }

        const senderName = client.character.name;
        const senderKey = SocialHandler.normalizeName(senderName);
        const friends = SocialHandler.getFriendEntries(client.character).filter((entry) => !entry.isRequest);

        for (const friend of friends) {
            const session = SocialHandler.getOnlineSession(friend.name);
            if (!session?.character) {
                continue;
            }

            const reverseEntries = SocialHandler.getFriendEntries(session.character);
            const hasAcceptedReverseEntry = reverseEntries.some((entry) =>
                SocialHandler.normalizeName(entry.name) === senderKey && !entry.isRequest
            );
            if (!hasAcceptedReverseEntry) {
                continue;
            }

            SocialHandler.sendFriendUpdate(session, senderName, false, online ? client : null);
        }
    }

    private static async tryHandleFriendRequestPromptAnswer(
        client: Client,
        token: number,
        accepted: boolean
    ): Promise<boolean> {
        if (!client.character) {
            return false;
        }

        SocialHandler.cleanupExpiredFriendRequestPrompts();
        const prompt = SocialHandler.pendingFriendRequestPrompts.get(token);
        if (!prompt || SocialHandler.normalizeName(prompt.targetName) !== SocialHandler.normalizeName(client.character.name)) {
            return false;
        }

        SocialHandler.pendingFriendRequestPrompts.delete(token);

        const requesterSession = SocialHandler.getOnlineSession(prompt.requesterName);
        const requesterRecord = requesterSession ? null : await SocialHandler.loadCharacterRecordByName(prompt.requesterName);
        const requesterCharacter = requesterSession?.character ?? requesterRecord?.character ?? null;
        if (!requesterCharacter) {
            SocialHandler.sendChatStatus(client, 'Friend request has expired.');
            return true;
        }

        ensureCharacterSocialState(client.character);
        ensureCharacterSocialState(requesterCharacter);

        const requesterDisplayName = requesterCharacter.name;
        const targetDisplayName = client.character.name;
        const targetEntry = SocialHandler.getFriendEntry(client.character, requesterDisplayName);

        if (!accepted) {
            if (targetEntry?.isRequest) {
                const removedEntry = SocialHandler.removeFriendEntry(client.character, targetEntry.name);
                await SocialHandler.persistClientCharacter(client);
                if (removedEntry) {
                    SocialHandler.sendFriendRemoved(client, removedEntry.name);
                }
            }

            if (requesterSession) {
                SocialHandler.sendChatStatus(requesterSession, `${targetDisplayName} declined your friend request.`);
            }
            return true;
        }

        const targetEntryName = targetEntry?.name ?? requesterDisplayName;
        const requesterEntry = SocialHandler.getFriendEntry(requesterCharacter, targetDisplayName);
        const requesterEntryName = requesterEntry?.name ?? targetDisplayName;

        const targetChanged = SocialHandler.upsertFriendEntry(client.character, {
            name: targetEntryName,
            isRequest: false
        });
        const requesterChanged = SocialHandler.upsertFriendEntry(requesterCharacter, {
            name: requesterEntryName,
            isRequest: false
        });

        if (targetChanged) {
            await SocialHandler.persistClientCharacter(client);
        }

        if (requesterChanged) {
            if (requesterSession) {
                await SocialHandler.persistClientCharacter(requesterSession);
            } else if (requesterRecord) {
                await SocialHandler.persistLoadedCharacter(requesterRecord);
            }
        }

        SocialHandler.sendFriendUpdate(client, targetEntryName, false, requesterSession);
        if (requesterSession) {
            SocialHandler.sendFriendUpdate(requesterSession, requesterEntryName, false, client);
        }
        return true;
    }

    private static buildZonePlayersPayload(client: Client): Buffer {
        const bb = new BitBuffer(false);
        const selfName = SocialHandler.normalizeName(client.character?.name);

        for (const other of GlobalState.sessionsByToken.values()) {
            if (!other.playerSpawned || !areClientsInSameLevelScope(client, other) || !other.character) {
                continue;
            }
            if (SocialHandler.normalizeName(other.character.name) === selfName) {
                continue;
            }

            bb.writeMethod15(true);
            bb.writeMethod13(other.character.name);
            bb.writeMethod6(SocialHandler.classIdFromName(String(other.character.class ?? 'Paladin')), 2);
            bb.writeMethod6(Math.max(1, Math.min(Number(other.character.level ?? 1), 63)), 6);
        }

        bb.writeMethod15(false);
        return bb.toBuffer();
    }

    private static forLevelRecipients(client: Client, includeSender: boolean = false): Client[] {
        const levelName = client.currentLevel;
        if (!levelName) {
            return [];
        }

        const recipients: Client[] = [];
        for (const other of GlobalState.sessionsByToken.values()) {
            if (!other.playerSpawned || !areClientsInSameLevelScope(client, other)) {
                continue;
            }
            if (!includeSender && other === client) {
                continue;
            }
            recipients.push(other);
        }

        return recipients;
    }

    private static relayToLevel(
        client: Client,
        packetId: number,
        data: Buffer,
        includeSender: boolean = false,
        filterIgnored: boolean = false
    ): void {
        for (const other of SocialHandler.forLevelRecipients(client, includeSender)) {
            if (filterIgnored && !SocialHandler.canReceiveChatFrom(other, SocialHandler.getCharacterName(client))) {
                continue;
            }

            other.send(packetId, data);
        }
    }

    private static buildRoomThoughtPayload(entityId: number, text: string): Buffer {
        const bb = new BitBuffer(false);
        bb.writeMethod4(entityId);
        bb.writeMethod13(text);
        return bb.toBuffer();
    }

    private static getDialogueLanguage(character: Character | null | undefined): string {
        return String(character?.dialogueLanguage ?? '').trim().toLowerCase() || 'en';
    }

    private static isEnemyRoomThought(client: Client, entityId: number): boolean {
        const entity = client.entities?.get?.(entityId);
        return Number(entity?.team ?? 0) === EntityTeam.ENEMY;
    }

    private static translateRoomThought(client: Client, entityId: number, text: string): string {
        return DialogueTranslationLoader.translateText(
            text,
            SocialHandler.getDialogueLanguage(client.character),
            { fallbackToGeneric: SocialHandler.isEnemyRoomThought(client, entityId) }
        );
    }

    private static getPartyForName(name: string): { partyId: number; group: PartyGroup } | null {
        const key = SocialHandler.normalizeName(name);
        if (!key) {
            return null;
        }

        const partyId = GlobalState.partyByMember.get(key);
        if (partyId === undefined) {
            return null;
        }

        const group = GlobalState.partyGroups.get(partyId);
        if (!group) {
            GlobalState.partyByMember.delete(key);
            return null;
        }

        return { partyId, group };
    }

    private static isPartyLeader(name: string): boolean {
        const party = SocialHandler.getPartyForName(name);
        return Boolean(party && SocialHandler.normalizeName(party.group.leader) === SocialHandler.normalizeName(name));
    }

    private static createParty(leaderName: string): PartyGroup {
        let partyId = 0;
        do {
            partyId = Math.floor(Math.random() * 0xffff);
        } while (partyId <= 0 || GlobalState.partyGroups.has(partyId));

        const displayName = String(leaderName ?? '').trim();
        const group: PartyGroup = {
            id: partyId,
            leader: displayName,
            members: [displayName],
            locked: false
        };

        GlobalState.partyGroups.set(partyId, group);
        GlobalState.partyByMember.set(SocialHandler.normalizeName(displayName), partyId);
        return group;
    }

    private static addPartyMember(group: PartyGroup, memberName: string): PartyGroup {
        const displayName = String(memberName ?? '').trim();
        const memberKey = SocialHandler.normalizeName(displayName);
        const index = group.members.findIndex((entry) => SocialHandler.normalizeName(entry) === memberKey);

        if (index >= 0) {
            group.members[index] = displayName;
        } else {
            group.members.push(displayName);
        }

        GlobalState.partyGroups.set(group.id, group);
        GlobalState.partyByMember.set(memberKey, group.id);
        return group;
    }

    private static removePartyMember(memberName: string): PartyGroup | null {
        const party = SocialHandler.getPartyForName(memberName);
        if (!party) {
            return null;
        }

        const memberKey = SocialHandler.normalizeName(memberName);
        party.group.members = party.group.members.filter((entry) => SocialHandler.normalizeName(entry) !== memberKey);
        GlobalState.partyByMember.delete(memberKey);

        if (SocialHandler.normalizeName(party.group.leader) === memberKey) {
            party.group.leader = party.group.members[0] ?? '';
        }

        if (party.group.members.length === 0) {
            GlobalState.partyGroups.delete(party.partyId);
            return null;
        }

        GlobalState.partyGroups.set(party.partyId, party.group);
        return party.group;
    }

    private static setPartyLeader(group: PartyGroup, leaderName: string): PartyGroup {
        const leaderKey = SocialHandler.normalizeName(leaderName);
        const currentName = group.members.find((entry) => SocialHandler.normalizeName(entry) === leaderKey);
        if (!currentName) {
            return group;
        }

        group.members = [currentName, ...group.members.filter((entry) => SocialHandler.normalizeName(entry) !== leaderKey)];
        group.leader = currentName;
        GlobalState.partyGroups.set(group.id, group);
        return group;
    }

    private static disbandParty(partyId: number): string[] {
        const group = GlobalState.partyGroups.get(partyId);
        if (!group) {
            return [];
        }

        GlobalState.partyGroups.delete(partyId);
        for (const member of group.members) {
            GlobalState.partyByMember.delete(SocialHandler.normalizeName(member));
        }

        return [...group.members];
    }

    private static getPartyMapPosition(client: Client): { x: number; y: number } {
        return {
            x: Math.max(0, Math.round(Number(client.partyMapX ?? 0))),
            y: Math.max(0, Math.round(Number(client.partyMapY ?? 0)))
        };
    }

    private static buildPartyUpdatePayload(group: PartyGroup, viewer: Client): Buffer {
        const bb = new BitBuffer(false);
        const viewerLevel = viewer.currentLevel;
        const viewerScope = getClientLevelScope(viewer);

        bb.writeMethod15(true);
        bb.writeMethod15(Boolean(group.locked));
        bb.writeMethod4(group.members.length);

        for (const member of group.members) {
            const memberKey = SocialHandler.normalizeName(member);
            const session = SocialHandler.getOnlineSession(member);
            const displayName = session?.character?.name ?? member;
            const isLeader = memberKey === SocialHandler.normalizeName(group.leader);
            const isOnline = Boolean(session?.character);

            bb.writeMethod15(isLeader);
            bb.writeMethod15(isOnline);
            bb.writeMethod13(displayName);

            if (isOnline && session) {
                const position = SocialHandler.getPartyMapPosition(session);
                const sameLevel = Boolean(viewerLevel) && getClientLevelScope(session) === viewerScope;
                bb.writeMethod91(position.x);
                bb.writeMethod91(position.y);
                bb.writeMethod15(sameLevel);
                if (!sameLevel) {
                    bb.writeMethod13(session.currentLevel || '');
                }
            }
        }

        return bb.toBuffer();
    }

    private static broadcastPartyUpdateById(partyId: number): void {
        const group = GlobalState.partyGroups.get(partyId);
        if (!group) {
            return;
        }

        for (const member of group.members) {
            const session = SocialHandler.getOnlineSession(member);
            if (!session) {
                continue;
            }

            session.send(0x75, SocialHandler.buildPartyUpdatePayload(group, session));
        }
    }

    private static broadcastPartyUpdateForMember(name: string): void {
        const party = SocialHandler.getPartyForName(name);
        if (!party) {
            SocialHandler.sendEmptyPartyUpdate(SocialHandler.getOnlineSession(name));
            return;
        }

        SocialHandler.broadcastPartyUpdateById(party.partyId);
    }

    private static getStartedRoomIdsForLevel(target: Client, levelName: string): number[] {
        const normalizedLevel = LevelConfig.normalizeLevelName(levelName);
        if (!normalizedLevel) {
            return [];
        }

        const startedRoomIds = new Set<number>();
        for (const key of target.startedRoomEvents) {
            const separatorIndex = key.lastIndexOf(':');
            if (separatorIndex <= 0) {
                continue;
            }

            const eventLevel = LevelConfig.normalizeLevelName(key.substring(0, separatorIndex));
            if (eventLevel !== normalizedLevel) {
                continue;
            }

            const roomId = Number(key.substring(separatorIndex + 1));
            if (Number.isFinite(roomId) && roomId >= 0) {
                startedRoomIds.add(Math.round(roomId));
            }
        }

        return Array.from(startedRoomIds.values()).sort((left, right) => left - right);
    }

    private static getTeleportTargetPosition(target: Client): PendingTeleport | null {
        const targetLevel = LevelConfig.normalizeLevelName(target.currentLevel || target.character?.CurrentLevel?.name);
        if (!targetLevel || !LevelConfig.has(targetLevel)) {
            return null;
        }

        let x = 0;
        let y = 0;
        let hasCoord = false;

        const entity = target.entities.get(target.clientEntID);
        if (entity && Number.isFinite(entity.x) && Number.isFinite(entity.y)) {
            x = Math.round(Number(entity.x));
            y = Math.round(Number(entity.y));
            hasCoord = true;
        } else {
            const savedLevel = target.character?.CurrentLevel;
            if (
                LevelConfig.normalizeLevelName(savedLevel?.name) === targetLevel &&
                Number.isFinite(savedLevel?.x) &&
                Number.isFinite(savedLevel?.y)
            ) {
                x = Math.round(Number(savedLevel.x));
                y = Math.round(Number(savedLevel.y));
                hasCoord = true;
            } else {
                const spawn = LevelConfig.getSpawnCoordinates(target.character, targetLevel, targetLevel);
                x = spawn.x;
                y = spawn.y;
                hasCoord = spawn.hasCoord;
            }
        }

        const shouldSyncDungeonProgress = LevelConfig.isDungeonLevel(targetLevel);
        const shouldCarryHomeScope = targetLevel === 'CraftTown';
        const syncRoomId = shouldSyncDungeonProgress &&
            Number.isFinite(Number(target.currentRoomId)) &&
            target.currentRoomId >= 0
            ? Math.round(Number(target.currentRoomId))
            : undefined;
        const syncStartedRoomIds = shouldSyncDungeonProgress
            ? SocialHandler.getStartedRoomIdsForLevel(target, targetLevel)
            : undefined;
        const syncQuestProgress = shouldSyncDungeonProgress && Number.isFinite(Number(target.character?.questTrackerState))
            ? Math.max(0, Math.min(100, Math.round(Number(target.character?.questTrackerState))))
            : undefined;

        return {
            targetLevel,
            levelInstanceId: shouldSyncDungeonProgress || shouldCarryHomeScope ? target.levelInstanceId : undefined,
            craftTownHostCharacter: shouldCarryHomeScope
                ? target.craftTownHostCharacter ?? target.character ?? undefined
                : undefined,
            x,
            y,
            hasCoord,
            syncAnchorToken: target.token > 0 ? target.token : undefined,
            syncAnchorCharacterName: target.character?.name,
            syncRoomId,
            syncStartedRoomIds,
            syncQuestProgress
        };
    }

    static handleSessionReady(client: Client): void {
        if (!client.character) {
            return;
        }

        SocialHandler.notifyFriendsAboutStatus(client, true);
        SocialHandler.broadcastPartyUpdateForMember(client.character.name);
        GuildHandler.handleSessionReady(client);
    }

    static handleSessionClose(client: Client, transferInProgress: boolean): void {
        if (!client.character || transferInProgress) {
            return;
        }

        SocialHandler.notifyFriendsAboutStatus(client, false);
        SocialHandler.broadcastPartyUpdateForMember(client.character.name);
        GuildHandler.handleSessionClose(client);
    }

    static joinPartyFromDiscord(
        requesterName: string,
        targetPartyId: number,
        expectedLeaderName: string | null | undefined = null
    ): DiscordPartyJoinResult {
        const requester = SocialHandler.getOnlineSession(requesterName);
        if (!requester?.character) {
            return {
                ok: false,
                reason: 'requester-offline',
                message: `Character ${requesterName} is not online.`,
                partyId: null
            };
        }

        const requesterDisplayName = requester.character.name;
        const requesterParty = SocialHandler.getPartyForName(requesterDisplayName);
        if (requesterParty && requesterParty.partyId === targetPartyId) {
            return {
                ok: false,
                reason: 'already-in-party',
                message: `${requesterDisplayName} is already in that party.`,
                partyId: targetPartyId
            };
        }

        if (requesterParty) {
            return {
                ok: false,
                reason: 'requester-in-party',
                message: `${requesterDisplayName} is already in a party.`,
                partyId: requesterParty.partyId
            };
        }

        const group = GlobalState.partyGroups.get(targetPartyId);
        if (!group) {
            return {
                ok: false,
                reason: 'party-not-found',
                message: 'That Discord party is no longer active.',
                partyId: null
            };
        }

        const expectedLeaderKey = SocialHandler.normalizeName(expectedLeaderName);
        if (expectedLeaderKey && SocialHandler.normalizeName(group.leader) !== expectedLeaderKey) {
            return {
                ok: false,
                reason: 'party-leader-mismatch',
                message: 'That Discord party invite is no longer valid.',
                partyId: targetPartyId
            };
        }

        if (group.locked) {
            return {
                ok: false,
                reason: 'party-locked',
                message: `${group.leader}'s party is locked.`,
                partyId: targetPartyId
            };
        }

        if (group.members.length >= SocialHandler.MAX_PARTY_SIZE) {
            return {
                ok: false,
                reason: 'party-full',
                message: `${group.leader}'s party is already full.`,
                partyId: targetPartyId
            };
        }

        SocialHandler.addPartyMember(group, requesterDisplayName);
        SocialHandler.broadcastPartyUpdateById(targetPartyId);

        return {
            ok: true,
            reason: 'ok',
            message: `${requesterDisplayName} joined ${group.leader}'s party.`,
            partyId: targetPartyId
        };
    }

    static handleZonePanelRequest(client: Client, _data: Buffer): void {
        client.send(0x96, SocialHandler.buildZonePlayersPayload(client));
    }

    static async handlePublicChat(client: Client, data: Buffer): Promise<void> {
        const br = new BitReader(data);
        br.readMethod9();
        const message = String(br.readMethod13() ?? '').trim();

        if (client.character) {
            const match = /^\/lang:\s*(tr|en|br|ptbr)\s*$/i.exec(message);
            if (match) {
                const requestedLanguage = match[1].toLowerCase();
                const nextLanguage = /^(?:br|ptbr)$/.test(requestedLanguage) ? 'pt-br' : requestedLanguage;
                client.character.dialogueLanguage = nextLanguage;

                if (client.userId) {
                    for (const session of GlobalState.getActiveSessionsByUserId(client.userId)) {
                        session.dialogueLanguage = nextLanguage;
                        if (session.character) {
                            session.character.dialogueLanguage = nextLanguage;
                        }
                        for (const character of session.characters) {
                            character.dialogueLanguage = nextLanguage;
                        }
                        const currentName = SocialHandler.normalizeName(session.character?.name);
                        const characterIndex = session.characters.findIndex((character) =>
                            SocialHandler.normalizeName(character.name) === currentName
                        );
                        if (session.character && characterIndex >= 0) {
                            session.characters[characterIndex] = session.character;
                        }
                    }
                    await db.setDialogueLanguage(client.userId, nextLanguage);
                    await db.saveCharacters(client.userId, client.characters);
                }

                SocialHandler.sendChatStatus(
                    client,
                    nextLanguage === 'tr'
                        ? 'NPC dialog dili Turkce olarak ayarlandi.'
                        : nextLanguage === 'pt-br'
                            ? 'Dialogos de NPC definidos para Portugues do Brasil.'
                        : 'NPC dialog language set to English.'
                );
                SocialHandler.sendChatStatus(
                    client,
                    nextLanguage === 'pt-br'
                        ? 'Idioma salvo. No Adobe Flash Player, reinicie o jogo para aplicar tudo.'
                        : 'Language saved. In Adobe Flash Player, restart the game to apply everything.'
                );
                SocialHandler.sendLocalizationReload(client, nextLanguage);
                return;
            }
        }

        if (client.character && message) {
            discordSocialBridge.relay({
                scope: 'public',
                senderName: client.character.name,
                message,
                accountEmail: client.account?.email,
                userId: client.userId,
                levelName: client.currentLevel || undefined
            });
        }

        SocialHandler.relayToLevel(client, 0x2c, data, false, true);
    }

    static handlePrivateMessage(client: Client, data: Buffer): void {
        const br = new BitReader(data);
        const recipientName = br.readMethod26();
        const message = br.readMethod26();
        const senderName = SocialHandler.getCharacterName(client);
        const recipient = SocialHandler.getOnlineSession(recipientName);

        if (!recipient?.character) {
            SocialHandler.sendChatStatus(client, `Player ${recipientName} not found`);
            return;
        }

        const received = new BitBuffer(false);
        received.writeMethod13(senderName);
        received.writeMethod13(message);
        if (SocialHandler.canReceiveChatFrom(recipient, senderName)) {
            recipient.sendBitBuffer(0x47, received);
        }

        const echoed = new BitBuffer(false);
        echoed.writeMethod13(recipient.character.name);
        echoed.writeMethod13(message);
        client.sendBitBuffer(0x48, echoed);
    }

    static async handleFriendRequest(client: Client, data: Buffer): Promise<void> {
        if (!client.character) {
            return;
        }

        const br = new BitReader(data);
        const targetNameRaw = br.readMethod26();
        const targetName = String(targetNameRaw ?? '').trim();
        const senderName = client.character.name;

        if (!targetName) {
            return;
        }

        if (SocialHandler.normalizeName(targetName) === SocialHandler.normalizeName(senderName)) {
            SocialHandler.sendChatStatus(client, 'You cannot be friends with yourself.');
            return;
        }

        const targetSession = SocialHandler.getOnlineSession(targetName);
        const targetRecord = targetSession ? null : await SocialHandler.loadCharacterRecordByName(targetName);
        const targetCharacter = targetSession?.character ?? targetRecord?.character ?? null;

        if (!targetCharacter) {
            SocialHandler.sendChatStatus(client, `Could not find player ${targetName}.`);
            return;
        }

        ensureCharacterSocialState(client.character);
        ensureCharacterSocialState(targetCharacter);

        const targetDisplayName = targetCharacter.name;
        const senderEntry = SocialHandler.getFriendEntry(client.character, targetDisplayName);
        const targetEntry = SocialHandler.getFriendEntry(targetCharacter, senderName);
        const senderEntryName = senderEntry?.name ?? targetDisplayName;
        const targetEntryName = targetEntry?.name ?? senderName;

        if (senderEntry && !senderEntry.isRequest) {
            if (!targetEntry || targetEntry.isRequest) {
                const repaired = SocialHandler.upsertFriendEntry(targetCharacter, {
                    name: targetEntryName,
                    isRequest: false
                });
                if (repaired) {
                    if (targetSession) {
                        await SocialHandler.persistClientCharacter(targetSession);
                    } else if (targetRecord) {
                        await SocialHandler.persistLoadedCharacter(targetRecord);
                    }
                }
            }

            SocialHandler.sendChatStatus(client, `${targetDisplayName} is already on your friends list.`);
            SocialHandler.clearPendingFriendRequestPrompts(senderName, targetDisplayName);
            return;
        }

        if (senderEntry?.isRequest) {
            const senderChanged = SocialHandler.upsertFriendEntry(client.character, {
                name: senderEntryName,
                isRequest: false
            });
            const targetChanged = SocialHandler.upsertFriendEntry(targetCharacter, {
                name: targetEntryName,
                isRequest: false
            });

            if (senderChanged) {
                await SocialHandler.persistClientCharacter(client);
            }

            if (targetChanged) {
                if (targetSession) {
                    await SocialHandler.persistClientCharacter(targetSession);
                } else if (targetRecord) {
                    await SocialHandler.persistLoadedCharacter(targetRecord);
                }
            }

            SocialHandler.sendFriendUpdate(client, senderEntryName, false, targetSession);
            if (targetSession) {
                SocialHandler.sendFriendUpdate(targetSession, targetEntryName, false, client);
            }
            SocialHandler.clearPendingFriendRequestPrompts(targetDisplayName, senderName);
            return;
        }

        if (targetEntry && !targetEntry.isRequest) {
            const senderChanged = SocialHandler.upsertFriendEntry(client.character, {
                name: senderEntryName,
                isRequest: false
            });
            if (senderChanged) {
                await SocialHandler.persistClientCharacter(client);
            }

            SocialHandler.sendFriendUpdate(client, senderEntryName, false, targetSession);
            if (targetSession) {
                SocialHandler.sendFriendUpdate(targetSession, targetEntryName, false, client);
            }
            SocialHandler.clearPendingFriendRequestPrompts(senderName, targetDisplayName);
            return;
        }

        if (targetEntry?.isRequest) {
            if (targetSession) {
                SocialHandler.sendFriendUpdate(targetSession, targetEntryName, true, client);
                SocialHandler.sendFriendRequestPrompt(targetSession, senderName);
            }
            SocialHandler.sendChatStatus(client, `Friend request already sent to ${targetDisplayName}.`);
            return;
        }

        const changed = SocialHandler.upsertFriendEntry(targetCharacter, {
            name: senderName,
            isRequest: true
        });
        if (changed) {
            if (targetSession) {
                await SocialHandler.persistClientCharacter(targetSession);
            } else if (targetRecord) {
                await SocialHandler.persistLoadedCharacter(targetRecord);
            }
        }

        if (targetSession) {
            SocialHandler.sendFriendUpdate(targetSession, senderName, true, client);
            SocialHandler.sendFriendRequestPrompt(targetSession, senderName);
        }

        SocialHandler.sendChatStatus(client, `Friend request sent to ${targetDisplayName}.`);
    }

    static async handleUnfriend(client: Client, data: Buffer): Promise<void> {
        if (!client.character) {
            return;
        }

        const br = new BitReader(data);
        const targetNameRaw = br.readMethod26();
        const targetName = String(targetNameRaw ?? '').trim();
        const senderName = client.character.name;

        if (!targetName) {
            return;
        }

        const friendIndex = SocialHandler.findFriendIndex(client.character, targetName);
        if (friendIndex < 0) {
            SocialHandler.sendChatStatus(client, `${targetName} is not on your friends list.`);
            return;
        }

        const friendEntry = SocialHandler.getFriendEntries(client.character)[friendIndex];
        const targetSession = SocialHandler.getOnlineSession(friendEntry.name);
        const targetRecord = targetSession ? null : await SocialHandler.loadCharacterRecordByName(friendEntry.name);
        const targetCharacter = targetSession?.character ?? targetRecord?.character ?? null;

        const removedSenderEntry = SocialHandler.removeFriendEntry(client.character, friendEntry.name);
        if (removedSenderEntry) {
            await SocialHandler.persistClientCharacter(client);
        }
        SocialHandler.sendFriendRemoved(client, removedSenderEntry?.name ?? friendEntry.name);
        SocialHandler.clearPendingFriendRequestPrompts(senderName, friendEntry.name);
        SocialHandler.clearPendingFriendRequestPrompts(friendEntry.name, senderName);

        if (!targetCharacter) {
            return;
        }

        const removedTargetEntry = SocialHandler.removeFriendEntry(targetCharacter, senderName);
        if (!removedTargetEntry) {
            return;
        }

        if (targetSession) {
            await SocialHandler.persistClientCharacter(targetSession);
            SocialHandler.sendFriendRemoved(targetSession, removedTargetEntry.name);
        } else if (targetRecord) {
            await SocialHandler.persistLoadedCharacter(targetRecord);
        }
    }

    static handleRequestFriendList(client: Client, _data: Buffer): void {
        SocialHandler.sendFullFriendList(client);
    }

    static async handleToggleIgnore(client: Client, data: Buffer): Promise<void> {
        if (!client.character) {
            return;
        }

        const br = new BitReader(data);
        const targetNameRaw = br.readMethod26();
        const targetName = String(targetNameRaw ?? '').trim();
        const senderName = client.character.name;

        if (!targetName) {
            return;
        }
        if (SocialHandler.normalizeName(targetName) === SocialHandler.normalizeName(senderName)) {
            SocialHandler.sendChatStatus(client, 'You cannot ignore yourself.');
            return;
        }

        const targetSession = SocialHandler.getOnlineSession(targetName);
        const targetRecord = targetSession ? null : await SocialHandler.loadCharacterRecordByName(targetName);
        const displayName = targetSession?.character?.name ?? targetRecord?.character?.name ?? targetName;

        if (!targetSession && !targetRecord) {
            SocialHandler.sendChatStatus(client, `Player ${targetName} not found.`);
            return;
        }

        if (SocialHandler.findIgnoredIndex(client.character, displayName) >= 0) {
            if (SocialHandler.removeIgnoredEntry(client.character, displayName)) {
                await SocialHandler.persistClientCharacter(client);
            }
            SocialHandler.sendIgnoreRemoved(client, displayName);
            return;
        }

        if (SocialHandler.addIgnoredEntry(client.character, displayName)) {
            await SocialHandler.persistClientCharacter(client);
        }
        SocialHandler.sendIgnoreAdded(client, displayName);
    }

    static handleRequestIgnoreList(client: Client, _data: Buffer): void {
        SocialHandler.sendFullIgnoreList(client);
    }

    static handleGroupInvite(client: Client, data: Buffer): void {
        if (!client.character) {
            return;
        }

        const br = new BitReader(data);
        const inviteeNameRaw = br.readMethod26();
        const inviteeName = String(inviteeNameRaw ?? '').trim();
        const inviterName = client.character.name;

        if (!inviteeName) {
            return;
        }

        const invitee = SocialHandler.getOnlineSession(inviteeName);
        if (!invitee?.character) {
            SocialHandler.sendChatStatus(client, `Player ${inviteeName} not found`);
            return;
        }

        if (invitee === client) {
            SocialHandler.sendChatStatus(client, 'You cannot invite yourself.');
            return;
        }

        if (SocialHandler.getPartyForName(invitee.character.name)) {
            SocialHandler.sendChatStatus(client, `${invitee.character.name} is already in a party.`);
            return;
        }

        const inviterParty = SocialHandler.getPartyForName(inviterName);
        if (inviterParty && inviterParty.group.members.length >= SocialHandler.MAX_PARTY_SIZE) {
            SocialHandler.sendChatStatus(client, 'Your party is already full.');
            return;
        }

        SocialHandler.sendQueryMessageQuestion(
            invitee,
            client.clientEntID || 0,
            inviterName,
            `${inviterName} has invited you to join a party`
        );
    }

    static async handleQueryMessageAnswer(client: Client, data: Buffer): Promise<void> {
        if (!client.character) {
            return;
        }

        const br = new BitReader(data);
        const inviterEntityId = br.readMethod9();
        br.readMethod26();
        const accepted = br.readMethod15();

        if (await GuildHandler.tryHandleInviteAnswer(client, inviterEntityId, accepted)) {
            return;
        }

        if (await SocialHandler.tryHandleFriendRequestPromptAnswer(client, inviterEntityId, accepted)) {
            return;
        }

        const inviter = SocialHandler.findSessionByEntityId(inviterEntityId);
        if (!inviter?.character) {
            return;
        }

        const inviteeName = client.character.name;
        if (!accepted) {
            SocialHandler.sendChatStatus(inviter, `${inviteeName} declined your invite.`);
            return;
        }

        if (SocialHandler.getPartyForName(inviteeName)) {
            SocialHandler.sendChatStatus(inviter, `${inviteeName} is already in a party.`);
            return;
        }

        const inviterExistingParty = SocialHandler.getPartyForName(inviter.character.name);
        const group = inviterExistingParty?.group ?? SocialHandler.createParty(inviter.character.name);
        const partyId = inviterExistingParty?.partyId ?? group.id;

        if (group.members.length >= SocialHandler.MAX_PARTY_SIZE) {
            SocialHandler.sendChatStatus(client, `${inviter.character.name}'s party is already full.`);
            SocialHandler.sendChatStatus(inviter, 'Your party is already full.');
            return;
        }

        SocialHandler.addPartyMember(group, inviteeName);
        SocialHandler.broadcastPartyUpdateById(partyId);
    }

    static handleJoinPartyRequest(client: Client, data: Buffer): void {
        if (!client.character) {
            return;
        }

        const br = new BitReader(data);
        const targetNameRaw = br.readMethod26();
        const targetName = String(targetNameRaw ?? '').trim();
        const requesterName = client.character.name;

        if (!targetName) {
            return;
        }

        if (SocialHandler.normalizeName(targetName) === SocialHandler.normalizeName(requesterName)) {
            SocialHandler.sendChatStatus(client, 'You cannot join your own party.');
            return;
        }

        if (SocialHandler.getPartyForName(requesterName)) {
            SocialHandler.sendChatStatus(client, 'You are already in a party.');
            return;
        }

        const targetSession = SocialHandler.getOnlineSession(targetName);
        if (!targetSession?.character) {
            SocialHandler.sendChatStatus(client, `Player ${targetName} not found`);
            return;
        }

        const targetParty = SocialHandler.getPartyForName(targetSession.character.name);
        if (!targetParty) {
            SocialHandler.sendChatStatus(client, `${targetSession.character.name} is not in a party.`);
            return;
        }

        if (targetParty.group.locked) {
            SocialHandler.sendChatStatus(client, `${targetSession.character.name}'s party is locked.`);
            return;
        }

        if (targetParty.group.members.length >= SocialHandler.MAX_PARTY_SIZE) {
            SocialHandler.sendChatStatus(client, `${targetSession.character.name}'s party is already full.`);
            return;
        }

        SocialHandler.addPartyMember(targetParty.group, requesterName);
        SocialHandler.broadcastPartyUpdateById(targetParty.partyId);
    }

    static handleGroupLeave(client: Client, _data: Buffer): void {
        if (!client.character) {
            return;
        }

        const leavingName = client.character.name;
        const party = SocialHandler.getPartyForName(client.character.name);
        if (!party) {
            SocialHandler.sendChatStatus(client, 'You are not in a party.');
            return;
        }

        const oldMembers = [...party.group.members];
        SocialHandler.removePartyMember(leavingName);
        SocialHandler.sendEmptyPartyUpdate(client);
        SocialHandler.sendChatStatus(client, 'You left the party.');

        const notifiedMembers = new Set<string>();
        for (const member of oldMembers) {
            const memberKey = SocialHandler.normalizeName(member);
            if (!memberKey || memberKey === SocialHandler.normalizeName(leavingName) || notifiedMembers.has(memberKey)) {
                continue;
            }

            notifiedMembers.add(memberKey);
            SocialHandler.sendChatStatus(SocialHandler.getOnlineSession(member), `${leavingName} has left the party.`);
        }

        const refreshed = GlobalState.partyGroups.get(party.partyId);
        if (!refreshed || refreshed.members.length <= 1) {
            const finalMembers = refreshed ? SocialHandler.disbandParty(party.partyId) : [];
            const everyoneToClear = new Set<string>([...oldMembers, ...finalMembers]);
            everyoneToClear.delete(leavingName);
            for (const member of everyoneToClear) {
                SocialHandler.sendEmptyPartyUpdate(SocialHandler.getOnlineSession(member));
            }
            return;
        }

        SocialHandler.broadcastPartyUpdateById(party.partyId);
    }

    static handleGroupKick(client: Client, data: Buffer): void {
        if (!client.character) {
            return;
        }

        const actorName = client.character.name;
        const br = new BitReader(data);
        const targetNameRaw = br.readMethod26();
        const targetName = String(targetNameRaw ?? '').trim();
        if (!targetName) {
            return;
        }

        const party = SocialHandler.getPartyForName(client.character.name);
        if (!party) {
            SocialHandler.sendChatStatus(client, 'You are not in a party.');
            return;
        }

        if (!SocialHandler.isPartyLeader(client.character.name)) {
            SocialHandler.sendChatStatus(client, 'Only the party leader can remove members.');
            return;
        }

        if (SocialHandler.normalizeName(targetName) === SocialHandler.normalizeName(client.character.name)) {
            SocialHandler.sendChatStatus(client, 'Use /leave to leave your party.');
            return;
        }

        const targetMember = party.group.members.find(
            (member) => SocialHandler.normalizeName(member) === SocialHandler.normalizeName(targetName)
        );
        if (!targetMember) {
            SocialHandler.sendChatStatus(client, `${targetName} is not in your party.`);
            return;
        }

        const oldMembers = [...party.group.members];
        const targetSession = SocialHandler.getOnlineSession(targetMember);
        SocialHandler.removePartyMember(targetMember);
        SocialHandler.sendEmptyPartyUpdate(targetSession);
        SocialHandler.sendChatStatus(targetSession, `You were kicked from ${actorName}'s party.`);

        const notifiedMembers = new Set<string>();
        for (const member of oldMembers) {
            const memberKey = SocialHandler.normalizeName(member);
            if (!memberKey || memberKey === SocialHandler.normalizeName(targetMember) || notifiedMembers.has(memberKey)) {
                continue;
            }

            notifiedMembers.add(memberKey);
            SocialHandler.sendChatStatus(
                SocialHandler.getOnlineSession(member),
                `${targetMember} was kicked from the party.`
            );
        }

        const refreshed = GlobalState.partyGroups.get(party.partyId);
        if (!refreshed || refreshed.members.length <= 1) {
            const finalMembers = refreshed ? SocialHandler.disbandParty(party.partyId) : [];
            const everyoneToClear = new Set<string>([...oldMembers, ...finalMembers]);
            everyoneToClear.delete(targetMember);
            for (const member of everyoneToClear) {
                SocialHandler.sendEmptyPartyUpdate(SocialHandler.getOnlineSession(member));
            }
            return;
        }

        SocialHandler.broadcastPartyUpdateById(party.partyId);
    }

    static handleGroupLeader(client: Client, data: Buffer): void {
        if (!client.character) {
            return;
        }

        const br = new BitReader(data);
        const targetNameRaw = br.readMethod26();
        const targetName = String(targetNameRaw ?? '').trim();
        if (!targetName) {
            return;
        }

        const party = SocialHandler.getPartyForName(client.character.name);
        if (!party) {
            SocialHandler.sendChatStatus(client, 'You are not in a party.');
            return;
        }

        if (!SocialHandler.isPartyLeader(client.character.name)) {
            SocialHandler.sendChatStatus(client, 'Only the party leader can promote another leader.');
            return;
        }

        const targetMember = party.group.members.find(
            (member) => SocialHandler.normalizeName(member) === SocialHandler.normalizeName(targetName)
        );
        if (!targetMember) {
            SocialHandler.sendChatStatus(client, `${targetName} is not in your party.`);
            return;
        }

        SocialHandler.setPartyLeader(party.group, targetMember);
        SocialHandler.broadcastPartyUpdateById(party.partyId);
    }

    static handleGroupLock(client: Client, data: Buffer): void {
        if (!client.character) {
            return;
        }

        const br = new BitReader(data);
        const locked = br.readMethod15();
        const party = SocialHandler.getPartyForName(client.character.name);

        if (!party) {
            SocialHandler.sendChatStatus(client, 'You are not in a party.');
            return;
        }

        if (!SocialHandler.isPartyLeader(client.character.name)) {
            SocialHandler.sendChatStatus(client, 'Only the party leader can lock the party.');
            return;
        }

        const wasLocked = Boolean(party.group.locked);
        party.group.locked = locked;
        GlobalState.partyGroups.set(party.partyId, party.group);
        if (locked && !wasLocked) {
            for (const member of party.group.members) {
                SocialHandler.sendChatStatus(SocialHandler.getOnlineSession(member), 'Party is locked.');
            }
        }
        SocialHandler.broadcastPartyUpdateById(party.partyId);
    }

    static handleSendGroupChat(client: Client, data: Buffer): void {
        if (!client.character) {
            return;
        }

        const br = new BitReader(data);
        const message = br.readMethod26().trim();
        if (!message) {
            return;
        }

        const party = SocialHandler.getPartyForName(client.character.name);
        if (!party) {
            SocialHandler.sendChatStatus(client, 'You are not in a party.');
            return;
        }

        discordSocialBridge.relay({
            scope: 'party',
            senderName: client.character.name,
            message,
            accountEmail: client.account?.email,
            userId: client.userId,
            levelName: client.currentLevel || undefined,
            partyId: party.partyId
        });

        const payload = SocialHandler.buildGroupChatPayload(client.character.name, message);
        for (const member of party.group.members) {
            const session = SocialHandler.getOnlineSession(member);
            if (!session || !SocialHandler.canReceiveChatFrom(session, client.character.name)) {
                continue;
            }

            session.send(0x64, payload);
        }
    }

    static handleMapLocationUpdate(client: Client, data: Buffer): void {
        if (!client.character) {
            return;
        }

        const br = new BitReader(data);
        const mapX = br.readMethod236();
        const mapY = br.readMethod236();
        client.partyMapX = mapX;
        client.partyMapY = mapY;

        const party = SocialHandler.getPartyForName(client.character.name);
        if (!party) {
            return;
        }

        const payload = SocialHandler.buildGroupmateMapPayload(client.character.name, mapX, mapY);
        for (const member of party.group.members) {
            const session = SocialHandler.getOnlineSession(member);
            if (!session || session === client) {
                continue;
            }

            session.send(0x8c, payload);
        }
    }

    static handleTeleportToPlayer(client: Client, data: Buffer): void {
        if (!client.character || !client.token) {
            return;
        }

        const br = new BitReader(data);
        const targetNameRaw = br.readMethod26();
        const targetName = String(targetNameRaw ?? '').trim();
        if (!targetName) {
            SocialHandler.sendChatStatus(client, 'Teleport target not found.');
            return;
        }

        const clientParty = SocialHandler.getPartyForName(client.character.name);
        if (!clientParty) {
            SocialHandler.sendChatStatus(client, 'You are not in a party.');
            return;
        }

        const targetSession = SocialHandler.getOnlineSession(targetName);
        if (!targetSession?.character) {
            SocialHandler.sendChatStatus(client, `Player ${targetName} not found`);
            return;
        }

        const targetParty = SocialHandler.getPartyForName(targetSession.character.name);
        if (!targetParty || targetParty.partyId !== clientParty.partyId) {
            SocialHandler.sendChatStatus(client, `${targetSession.character.name} is not in your party.`);
            return;
        }

        if (targetSession === client) {
            SocialHandler.sendChatStatus(client, 'You are already there.');
            return;
        }

        const targetTeleport = SocialHandler.getTeleportTargetPosition(targetSession);
        if (!targetTeleport) {
            SocialHandler.sendChatStatus(client, `Cannot teleport to ${targetSession.character.name} right now.`);
            return;
        }

        client.craftTownHostCharacter = targetTeleport.targetLevel === 'CraftTown'
            ? targetTeleport.craftTownHostCharacter ?? null
            : null;
        GlobalState.pendingTeleports.set(client.token, targetTeleport);
        client.lastDoorId = 0;
        client.lastDoorTargetLevel = targetTeleport.targetLevel;
        client.armPendingTransferGrace();
        PetHandler.armMountTravelProtection(client, 5000, false);

        const bb = new BitBuffer(false);
        bb.writeMethod4(0);
        bb.writeMethod13(targetTeleport.targetLevel);
        client.sendBitBuffer(0x2e, bb);
    }

    static async handleRequestVisitPlayerHouse(client: Client, data: Buffer): Promise<void> {
        const br = new BitReader(data);
        const targetName = br.readMethod13();

        const targetId = await db.getAccountIdByCharName(targetName);
        if (!targetId) {
            SocialHandler.sendChatStatus(client, `Cannot find house for player ${targetName}.`);
            return;
        }

        const characters = await db.loadCharacters(targetId);
        const liveTarget = SocialHandler.getOnlineSession(targetName);
        const liveTargetChar = liveTarget?.character &&
            SocialHandler.normalizeName(liveTarget.character.name) === SocialHandler.normalizeName(targetName)
            ? liveTarget.character
            : null;
        const targetChar = liveTargetChar ?? characters.find((entry) =>
            SocialHandler.normalizeName(entry?.name) === SocialHandler.normalizeName(targetName)
        );

        if (!targetChar) {
            SocialHandler.sendChatStatus(client, `Cannot find house for player ${targetName}.`);
            return;
        }

        if (client.token) {
            GlobalState.houseVisits.set(client.token, targetChar);
        }
        client.craftTownHostCharacter = targetChar;

        const bb = new BitBuffer(false);
        bb.writeMethod4(999);
        bb.writeMethod13('CraftTown');
        client.lastDoorId = 999;
        client.lastDoorTargetLevel = 'CraftTown';
        client.armPendingTransferGrace();
        PetHandler.armMountTravelProtection(client, 5000, false);
        client.sendBitBuffer(0x2e, bb);
        SocialHandler.sendChatStatus(client, `Visiting ${targetChar.name}'s house...`);
    }

    static handleRoomThought(client: Client, data: Buffer): void {
        const br = new BitReader(data);
        const entityId = br.readMethod4();
        const text = br.readMethod13();
        const payload = SocialHandler.buildRoomThoughtPayload(
            entityId,
            SocialHandler.translateRoomThought(client, entityId, text)
        );
        LevelHandler.maybeStartGoblinRiverBossIntroLock(client, entityId, text);
        MissionHandler.noteDungeonSkitActivity(client);

        SocialHandler.relayToLevel(client, 0x76, payload, true);
    }

    static handleStartSkit(client: Client, data: Buffer): void {
        const br = new BitReader(data);
        const entityId = br.readMethod9();
        br.readMethod15();
        const text = br.readMethod26();
        const payload = SocialHandler.buildRoomThoughtPayload(
            entityId,
            SocialHandler.translateRoomThought(client, entityId, text)
        );
        LevelHandler.maybeStartGoblinRiverBossIntroLock(client, entityId, text);
        MissionHandler.noteDungeonSkitActivity(client);

        SocialHandler.relayToLevel(client, 0x76, payload, true);
    }

    static handleEmoteBegin(client: Client, data: Buffer): void {
        const br = new BitReader(data);
        br.readMethod4();
        br.readMethod13();

        SocialHandler.relayToLevel(client, 0x7e, data);
    }

    static handleEmote(client: Client, data: Buffer): void {
        const br = new BitReader(data);
        br.readMethod9();
        br.readMethod26();
        br.readMethod26();
        br.readMethod15();

        SocialHandler.relayToLevel(client, 0xa7, data);
    }

    static handleLevelState(client: Client, data: Buffer): void {
        const br = new BitReader(data);
        br.readMethod26();
        br.readMethod26();

        SocialHandler.relayToLevel(client, 0x40, data);
    }

    static handleEmoteEnd(client: Client, data: Buffer): void {
        const br = new BitReader(data);
        br.readMethod4();

        SocialHandler.relayToLevel(client, 0x7f, data);
    }
}
