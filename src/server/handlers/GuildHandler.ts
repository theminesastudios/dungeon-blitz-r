import { Character } from '../database/Database';
import { JsonAdapter } from '../database/JsonAdapter';
import { Client } from '../core/Client';
import { BitReader } from '../network/protocol/bitReader';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { GlobalState } from '../core/GlobalState';
import { isCharacterIgnoring, normalizeCharacterKey } from '../core/SocialState';

const db = new JsonAdapter();

interface LoadedCharacterRecord {
    userId: number;
    characters: Character[];
    character: Character;
}

interface OnlineGuildMember {
    name: string;
    classId: number;
    level: number;
    rank: number;
}

interface PendingGuildInvite {
    inviterName: string;
    inviteeName: string;
    guildName: string;
    expiresAt: number;
}

export class GuildHandler {
    private static readonly RANK_GUILD_MASTER = 0;
    private static readonly RANK_OFFICER = 1;
    private static readonly RANK_MEMBER = 2;
    private static readonly RANK_INITIATE = 3;
    private static readonly RANK_SILENCED = 4;
    private static readonly INVITE_TTL_MS = 60_000;
    private static readonly MAX_GUILD_NAME_LENGTH = 32;
    private static readonly pendingInvites: Map<number, PendingGuildInvite> = new Map();

    private static normalizeGuildName(value: unknown): string {
        return String(value ?? '')
            .trim()
            .replace(/\s+/g, ' ')
            .toLowerCase();
    }

    private static sanitizeGuildName(value: unknown): string {
        return String(value ?? '')
            .trim()
            .replace(/\s+/g, ' ');
    }

    private static getGuildName(character: Character | null | undefined): string {
        if (!character || !character.guild || typeof character.guild !== 'object') {
            return '';
        }

        return GuildHandler.sanitizeGuildName((character.guild as Record<string, unknown>).name);
    }

    private static getGuildRank(character: Character | null | undefined): number {
        if (!character || !character.guild || typeof character.guild !== 'object') {
            return GuildHandler.RANK_MEMBER;
        }

        const rank = Number((character.guild as Record<string, unknown>).rank ?? GuildHandler.RANK_MEMBER);
        return Number.isFinite(rank) ? Math.max(0, Math.min(rank, GuildHandler.RANK_SILENCED)) : GuildHandler.RANK_MEMBER;
    }

    private static hasGuild(character: Character | null | undefined): boolean {
        return GuildHandler.normalizeGuildName(GuildHandler.getGuildName(character)).length > 0;
    }

    private static setCharacterGuild(character: Character | null | undefined, guildName: string | null, rank: number | null): void {
        if (!character) {
            return;
        }

        if (!guildName || rank == null) {
            character.guild = {};
            return;
        }

        character.guild = {
            name: GuildHandler.sanitizeGuildName(guildName),
            rank: Math.max(0, Math.min(rank, GuildHandler.RANK_SILENCED))
        };
    }

    private static classIdFromName(className: unknown): number {
        switch (String(className ?? '').trim().toLowerCase()) {
            case 'rogue':
                return 1;
            case 'mage':
                return 2;
            case 'paladin':
            default:
                return 0;
        }
    }

    private static sendChatStatus(target: Client | null | undefined, text: string): void {
        if (!target) {
            return;
        }

        const bb = new BitBuffer(false);
        bb.writeMethod13(text);
        target.sendBitBuffer(0x44, bb);
    }

    private static sendQueryMessageQuestion(target: Client, token: number, name: string, message: string): void {
        const bb = new BitBuffer(false);
        bb.writeMethod9(Math.max(0, token));
        bb.writeMethod26(name);
        bb.writeMethod26(message);
        target.sendBitBuffer(0x58, bb);
    }

    private static isSessionOnline(session: Client | null | undefined): session is Client {
        return Boolean(
            session?.character &&
            !session.socket.destroyed &&
            session.socket.readyState === 'open'
        );
    }

    private static getOnlineSession(name: string): Client | null {
        const key = normalizeCharacterKey(name);
        if (!key) {
            return null;
        }

        const session = GlobalState.sessionsByCharacterName.get(key);
        return GuildHandler.isSessionOnline(session) ? session : null;
    }

    private static upsertCharacter(characters: Character[], character: Character): Character[] {
        const key = normalizeCharacterKey(character?.name);
        const nextCharacters = Array.isArray(characters) ? [...characters] : [];
        const index = nextCharacters.findIndex((entry) => normalizeCharacterKey(entry?.name) === key);

        if (index >= 0) {
            nextCharacters[index] = character;
        } else {
            nextCharacters.push(character);
        }

        return nextCharacters;
    }

    private static syncOnlineClientCharacter(session: Client): void {
        if (!session.character) {
            return;
        }

        session.characters = GuildHandler.upsertCharacter(session.characters, session.character);
    }

    private static async loadCharacterRecordByName(name: string): Promise<LoadedCharacterRecord | null> {
        const userId = await db.getAccountIdByCharName(name);
        if (!userId) {
            return null;
        }

        const characters = await db.loadCharacters(userId);
        const key = normalizeCharacterKey(name);
        const character = characters.find((entry) => normalizeCharacterKey(entry?.name) === key);
        if (!character) {
            return null;
        }

        return { userId, characters, character };
    }

    private static async persistRecord(record: LoadedCharacterRecord): Promise<void> {
        record.characters = GuildHandler.upsertCharacter(record.characters, record.character);
        await db.saveCharacters(record.userId, record.characters);
    }

    private static async persistClient(client: Client): Promise<void> {
        if (!client.character) {
            return;
        }

        if (!client.userId) {
            client.userId = await db.getAccountIdByCharName(client.character.name);
        }
        if (!client.userId) {
            return;
        }

        GuildHandler.syncOnlineClientCharacter(client);
        await db.saveCharacters(client.userId, client.characters);
    }

    private static async loadGuildMembers(guildName: string): Promise<LoadedCharacterRecord[]> {
        const guildKey = GuildHandler.normalizeGuildName(guildName);
        if (!guildKey) {
            return [];
        }

        const saves = await db.loadAllCharacterRecords();
        const membersByName: Map<string, LoadedCharacterRecord> = new Map();

        for (const save of saves) {
            const characters = Array.isArray(save.characters) ? save.characters : [];
            for (const character of characters) {
                if (GuildHandler.normalizeGuildName(GuildHandler.getGuildName(character)) !== guildKey) {
                    continue;
                }

                const memberKey = normalizeCharacterKey(character.name);
                if (!memberKey) {
                    continue;
                }

                membersByName.set(memberKey, {
                    userId: save.user_id,
                    characters,
                    character
                });
            }
        }

        for (const session of Array.from(GlobalState.sessionsByCharacterName.values())) {
            if (!GuildHandler.isSessionOnline(session) || !session.character) {
                continue;
            }
            if (GuildHandler.normalizeGuildName(GuildHandler.getGuildName(session.character)) !== guildKey) {
                continue;
            }

            const memberKey = normalizeCharacterKey(session.character.name);
            if (!memberKey) {
                continue;
            }

            const existing = membersByName.get(memberKey);
            const sessionCharacters = GuildHandler.upsertCharacter(session.characters, session.character);

            if (existing) {
                existing.character = session.character;
                existing.characters = sessionCharacters;
                if (session.userId) {
                    existing.userId = session.userId;
                }
                continue;
            }

            if (!session.userId) {
                continue;
            }

            membersByName.set(memberKey, {
                userId: session.userId,
                characters: sessionCharacters,
                character: session.character
            });
        }

        const members = Array.from(membersByName.values());
        members.sort((left, right) => {
            const rankDiff = GuildHandler.getGuildRank(left.character) - GuildHandler.getGuildRank(right.character);
            if (rankDiff !== 0) {
                return rankDiff;
            }

            return String(left.character.name ?? '').localeCompare(String(right.character.name ?? ''));
        });

        return members;
    }

    private static buildOnlineMemberSummaries(members: LoadedCharacterRecord[]): OnlineGuildMember[] {
        const onlineMembers: OnlineGuildMember[] = [];

        for (const record of members) {
            const session = GuildHandler.getOnlineSession(record.character.name);
            if (!session?.character) {
                continue;
            }

            onlineMembers.push({
                name: session.character.name,
                classId: GuildHandler.classIdFromName(session.character.class),
                level: Math.max(1, Math.min(Number(session.character.level ?? 1), 63)),
                rank: GuildHandler.getGuildRank(session.character)
            });
        }

        onlineMembers.sort((left, right) => {
            const rankDiff = left.rank - right.rank;
            if (rankDiff !== 0) {
                return rankDiff;
            }

            return left.name.localeCompare(right.name);
        });

        return onlineMembers;
    }

    private static buildGuildUpdatePayload(guildName: string, ownRank: number, onlineMembers: OnlineGuildMember[], selfName: string): Buffer {
        const bb = new BitBuffer(false);

        bb.writeMethod15(true);
        bb.writeMethod13(guildName);
        bb.writeMethod6(ownRank, 3);

        const others = onlineMembers.filter((member) => normalizeCharacterKey(member.name) !== normalizeCharacterKey(selfName));
        bb.writeMethod4(others.length);
        for (const member of others) {
            bb.writeMethod13(member.name);
            bb.writeMethod6(member.classId, 2);
            bb.writeMethod6(member.level, 6);
            bb.writeMethod6(member.rank, 3);
        }

        return bb.toBuffer();
    }

    private static buildNoGuildPayload(): Buffer {
        const bb = new BitBuffer(false);
        bb.writeMethod15(false);
        return bb.toBuffer();
    }

    private static sendGuildMessage(targets: Client[], packetId: number, senderName: string, message: string): void {
        const bb = new BitBuffer(false);
        bb.writeMethod13(senderName);
        bb.writeMethod13(message);
        const payload = bb.toBuffer();

        for (const target of targets) {
            if (!target.character || isCharacterIgnoring(target.character, senderName)) {
                continue;
            }

            target.send(packetId, payload);
        }
    }

    private static sendGuildMemberOnline(target: Client, member: Character): void {
        const bb = new BitBuffer(false);
        bb.writeMethod13(String(member.name ?? ''));
        bb.writeMethod6(GuildHandler.classIdFromName(member.class), 2);
        bb.writeMethod6(Math.max(1, Math.min(Number(member.level ?? 1), 63)), 6);
        bb.writeMethod6(GuildHandler.getGuildRank(member), 3);
        target.sendBitBuffer(0x97, bb);
    }

    private static sendGuildMemberOffline(target: Client, memberName: string): void {
        const bb = new BitBuffer(false);
        bb.writeMethod13(memberName);
        target.sendBitBuffer(0x98, bb);
    }

    private static sendGuildRankChange(target: Client, actorName: string, targetName: string, oldRank: number, newRank: number): void {
        const bb = new BitBuffer(false);
        bb.writeMethod13(actorName);
        bb.writeMethod13(targetName);
        bb.writeMethod6(oldRank, 3);
        bb.writeMethod6(newRank, 3);
        target.sendBitBuffer(0x99, bb);
    }

    private static sendGuildMemberJoined(target: Client, member: Character): void {
        const bb = new BitBuffer(false);
        bb.writeMethod13(String(member.name ?? ''));
        bb.writeMethod6(GuildHandler.classIdFromName(member.class), 2);
        bb.writeMethod6(Math.max(1, Math.min(Number(member.level ?? 1), 63)), 6);
        bb.writeMethod6(GuildHandler.getGuildRank(member), 3);
        target.sendBitBuffer(0x9A, bb);
    }

    private static sendGuildMemberLeft(target: Client, actorName: string, targetName: string): void {
        const bb = new BitBuffer(false);
        bb.writeMethod13(actorName);
        bb.writeMethod13(targetName);
        target.sendBitBuffer(0x9B, bb);
    }

    private static cleanupExpiredInvites(): void {
        const now = Date.now();
        for (const [token, invite] of Array.from(GuildHandler.pendingInvites.entries())) {
            if (invite.expiresAt <= now) {
                GuildHandler.pendingInvites.delete(token);
            }
        }
    }

    private static nextInviteToken(): number {
        GuildHandler.cleanupExpiredInvites();

        let token = 0;
        do {
            token = 1_000_000 + Math.floor(Math.random() * 1_000_000);
        } while (GuildHandler.pendingInvites.has(token));

        return token;
    }

    private static async isGuildNameTaken(guildName: string): Promise<boolean> {
        const guildKey = GuildHandler.normalizeGuildName(guildName);
        if (!guildKey) {
            return false;
        }

        const records = await db.loadAllCharacterRecords();
        for (const save of records) {
            for (const character of save.characters ?? []) {
                if (GuildHandler.normalizeGuildName(GuildHandler.getGuildName(character)) === guildKey) {
                    return true;
                }
            }
        }

        return false;
    }

    private static async broadcastGuildUpdate(guildName: string): Promise<void> {
        const members = await GuildHandler.loadGuildMembers(guildName);
        if (members.length === 0) {
            return;
        }

        const onlineMembers = GuildHandler.buildOnlineMemberSummaries(members);
        for (const record of members) {
            const session = GuildHandler.getOnlineSession(record.character.name);
            if (!session?.character) {
                continue;
            }

            session.character.guild = {
                name: GuildHandler.getGuildName(record.character),
                rank: GuildHandler.getGuildRank(record.character),
                onlineMembers
            };
            GuildHandler.syncOnlineClientCharacter(session);
            session.send(0x56, GuildHandler.buildGuildUpdatePayload(
                GuildHandler.getGuildName(record.character),
                GuildHandler.getGuildRank(record.character),
                onlineMembers,
                session.character.name
            ));
        }
    }

    static async refreshClientGuildState(client: Client): Promise<void> {
        if (!client.character) {
            return;
        }

        const guildName = GuildHandler.getGuildName(client.character);
        if (!guildName) {
            client.character.guild = {};
            GuildHandler.syncOnlineClientCharacter(client);
            return;
        }

        const members = await GuildHandler.loadGuildMembers(guildName);
        const ownRecord = members.find((record) =>
            normalizeCharacterKey(record.character.name) === normalizeCharacterKey(client.character?.name)
        );

        if (!ownRecord) {
            client.character.guild = {};
            GuildHandler.syncOnlineClientCharacter(client);
            return;
        }

        client.character.guild = {
            name: GuildHandler.getGuildName(ownRecord.character),
            rank: GuildHandler.getGuildRank(ownRecord.character),
            onlineMembers: GuildHandler.buildOnlineMemberSummaries(members)
        };
        GuildHandler.syncOnlineClientCharacter(client);
    }

    static handleSessionReady(client: Client): void {
        if (!client.character || !GuildHandler.hasGuild(client.character)) {
            return;
        }

        const guildName = GuildHandler.getGuildName(client.character);
        void GuildHandler.refreshClientGuildState(client).then(async () => {
            const members = await GuildHandler.loadGuildMembers(guildName);
            for (const record of members) {
                const other = GuildHandler.getOnlineSession(record.character.name);
                if (!other || other === client) {
                    continue;
                }

                GuildHandler.sendGuildMemberOnline(other, client.character!);
            }

            await GuildHandler.broadcastGuildUpdate(guildName);
        });
    }

    static handleSessionClose(client: Client): void {
        if (!client.character || !GuildHandler.hasGuild(client.character)) {
            return;
        }

        const guildName = GuildHandler.getGuildName(client.character);
        const closingName = client.character.name;
        void GuildHandler.loadGuildMembers(guildName).then(async (members) => {
            for (const record of members) {
                const other = GuildHandler.getOnlineSession(record.character.name);
                if (!other || normalizeCharacterKey(other.character?.name) === normalizeCharacterKey(closingName)) {
                    continue;
                }

                GuildHandler.sendGuildMemberOffline(other, closingName);
            }

            await GuildHandler.broadcastGuildUpdate(guildName);
        });
    }

    static async tryHandleInviteAnswer(client: Client, token: number, accepted: boolean): Promise<boolean> {
        if (!client.character) {
            return false;
        }

        GuildHandler.cleanupExpiredInvites();
        const invite = GuildHandler.pendingInvites.get(token);
        if (!invite || normalizeCharacterKey(invite.inviteeName) !== normalizeCharacterKey(client.character.name)) {
            return false;
        }

        GuildHandler.pendingInvites.delete(token);

        const inviter = GuildHandler.getOnlineSession(invite.inviterName);
        if (!inviter?.character) {
            GuildHandler.sendChatStatus(client, 'Guild invite has expired.');
            return true;
        }

        if (!accepted) {
            GuildHandler.sendChatStatus(inviter, `${client.character.name} declined your guild invite.`);
            return true;
        }

        if (GuildHandler.hasGuild(client.character)) {
            GuildHandler.sendChatStatus(inviter, `${client.character.name} is already in a guild.`);
            GuildHandler.sendChatStatus(client, 'You are already in a guild.');
            return true;
        }

        const guildName = GuildHandler.getGuildName(inviter.character);
        const inviterRank = GuildHandler.getGuildRank(inviter.character);
        if (!guildName || inviterRank > GuildHandler.RANK_OFFICER) {
            GuildHandler.sendChatStatus(client, 'That guild invite is no longer valid.');
            return true;
        }

        GuildHandler.setCharacterGuild(client.character, guildName, GuildHandler.RANK_MEMBER);
        await GuildHandler.persistClient(client);

        const members = await GuildHandler.loadGuildMembers(guildName);
        for (const record of members) {
            const session = GuildHandler.getOnlineSession(record.character.name);
            if (!session || normalizeCharacterKey(session.character?.name) === normalizeCharacterKey(client.character.name)) {
                continue;
            }

            GuildHandler.sendGuildMemberJoined(session, client.character);
        }

        GuildHandler.sendChatStatus(client, `You joined ${guildName}.`);
        await GuildHandler.broadcastGuildUpdate(guildName);
        return true;
    }

    static async handleCreateGuild(client: Client, data: Buffer): Promise<void> {
        if (!client.character) {
            return;
        }

        const br = new BitReader(data);
        const guildName = GuildHandler.sanitizeGuildName(br.readMethod26());

        if (GuildHandler.hasGuild(client.character)) {
            GuildHandler.sendChatStatus(client, 'You are already in a guild.');
            return;
        }
        if (!guildName || guildName.length > GuildHandler.MAX_GUILD_NAME_LENGTH) {
            GuildHandler.sendChatStatus(client, 'Invalid guild name.');
            return;
        }
        if (!/^[A-Za-z ]+$/.test(guildName)) {
            GuildHandler.sendChatStatus(client, 'Guild names can only contain A-Z and spaces.');
            return;
        }
        if (await GuildHandler.isGuildNameTaken(guildName)) {
            GuildHandler.sendChatStatus(client, 'That guild name is already taken.');
            return;
        }

        GuildHandler.setCharacterGuild(client.character, guildName, GuildHandler.RANK_GUILD_MASTER);
        await GuildHandler.persistClient(client);
        await GuildHandler.broadcastGuildUpdate(guildName);
    }

    static async handleInviteGuildMember(client: Client, data: Buffer): Promise<void> {
        if (!client.character) {
            return;
        }

        const guildName = GuildHandler.getGuildName(client.character);
        const rank = GuildHandler.getGuildRank(client.character);
        if (!guildName) {
            GuildHandler.sendChatStatus(client, 'You are not in a guild.');
            return;
        }
        if (rank > GuildHandler.RANK_OFFICER) {
            GuildHandler.sendChatStatus(client, 'Only guild leaders and officers can invite members.');
            return;
        }

        const br = new BitReader(data);
        const inviteeName = GuildHandler.sanitizeGuildName(br.readMethod26());
        const invitee = GuildHandler.getOnlineSession(inviteeName);
        if (!invitee?.character) {
            GuildHandler.sendChatStatus(client, `Player ${inviteeName} not found.`);
            return;
        }
        if (normalizeCharacterKey(invitee.character.name) === normalizeCharacterKey(client.character.name)) {
            GuildHandler.sendChatStatus(client, 'You cannot invite yourself.');
            return;
        }
        if (GuildHandler.hasGuild(invitee.character)) {
            GuildHandler.sendChatStatus(client, `${invitee.character.name} is already in a guild.`);
            return;
        }

        const token = GuildHandler.nextInviteToken();
        GuildHandler.pendingInvites.set(token, {
            inviterName: client.character.name,
            inviteeName: invitee.character.name,
            guildName,
            expiresAt: Date.now() + GuildHandler.INVITE_TTL_MS
        });

        GuildHandler.sendQueryMessageQuestion(
            invitee,
            token,
            client.character.name,
            `${client.character.name} has invited you to join guild ${guildName}`
        );
    }

    static async handleQuitGuild(client: Client, _data: Buffer): Promise<void> {
        if (!client.character) {
            return;
        }

        const guildName = GuildHandler.getGuildName(client.character);
        if (!guildName) {
            GuildHandler.sendChatStatus(client, 'You are not in a guild.');
            return;
        }

        const ownRank = GuildHandler.getGuildRank(client.character);
        const members = await GuildHandler.loadGuildMembers(guildName);
        if (ownRank === GuildHandler.RANK_GUILD_MASTER && members.length > 1) {
            GuildHandler.sendChatStatus(client, 'Transfer leadership or disband the guild before leaving.');
            return;
        }

        if (members.length <= 1) {
            await GuildHandler.handleDisbandGuild(client, Buffer.alloc(0));
            return;
        }

        GuildHandler.setCharacterGuild(client.character, null, null);
        await GuildHandler.persistClient(client);

        for (const record of members) {
            const other = GuildHandler.getOnlineSession(record.character.name);
            if (!other || normalizeCharacterKey(other.character?.name) === normalizeCharacterKey(client.character.name)) {
                continue;
            }

            GuildHandler.sendGuildMemberLeft(other, client.character.name, client.character.name);
        }

        client.send(0x56, GuildHandler.buildNoGuildPayload());
        GuildHandler.sendChatStatus(client, `You left ${guildName}.`);
        await GuildHandler.broadcastGuildUpdate(guildName);
    }

    static async handleDisbandGuild(client: Client, _data: Buffer): Promise<void> {
        if (!client.character) {
            return;
        }

        const guildName = GuildHandler.getGuildName(client.character);
        if (!guildName) {
            GuildHandler.sendChatStatus(client, 'You are not in a guild.');
            return;
        }
        if (GuildHandler.getGuildRank(client.character) !== GuildHandler.RANK_GUILD_MASTER) {
            GuildHandler.sendChatStatus(client, 'Only the guild leader can disband the guild.');
            return;
        }

        const members = await GuildHandler.loadGuildMembers(guildName);
        const onlineTargets: Client[] = [];
        for (const record of members) {
            const session = GuildHandler.getOnlineSession(record.character.name);
            GuildHandler.setCharacterGuild(record.character, null, null);
            await GuildHandler.persistRecord(record);

            if (session?.character) {
                GuildHandler.setCharacterGuild(session.character, null, null);
                GuildHandler.syncOnlineClientCharacter(session);
                onlineTargets.push(session);
            }
        }

        for (const target of onlineTargets) {
            target.send(0x56, GuildHandler.buildNoGuildPayload());
            GuildHandler.sendChatStatus(target, `${guildName} was disbanded.`);
        }
    }

    static async handleKickGuildMember(client: Client, data: Buffer): Promise<void> {
        if (!client.character) {
            return;
        }

        const guildName = GuildHandler.getGuildName(client.character);
        const actorRank = GuildHandler.getGuildRank(client.character);
        if (!guildName) {
            GuildHandler.sendChatStatus(client, 'You are not in a guild.');
            return;
        }
        if (actorRank > GuildHandler.RANK_OFFICER) {
            GuildHandler.sendChatStatus(client, 'You do not have permission to remove guild members.');
            return;
        }

        const br = new BitReader(data);
        const targetName = GuildHandler.sanitizeGuildName(br.readMethod26());
        if (normalizeCharacterKey(targetName) === normalizeCharacterKey(client.character.name)) {
            GuildHandler.sendChatStatus(client, 'Use /gquit to leave your guild.');
            return;
        }

        const targetSession = GuildHandler.getOnlineSession(targetName);
        const targetRecord = targetSession?.character
            ? null
            : await GuildHandler.loadCharacterRecordByName(targetName);
        const targetCharacter = targetSession?.character ?? targetRecord?.character ?? null;
        if (!targetCharacter || GuildHandler.normalizeGuildName(GuildHandler.getGuildName(targetCharacter)) !== GuildHandler.normalizeGuildName(guildName)) {
            GuildHandler.sendChatStatus(client, `${targetName} is not in your guild.`);
            return;
        }

        const targetRank = GuildHandler.getGuildRank(targetCharacter);
        if (actorRank >= targetRank) {
            GuildHandler.sendChatStatus(client, 'You cannot remove a guild member of equal or higher rank.');
            return;
        }

        GuildHandler.setCharacterGuild(targetCharacter, null, null);
        if (targetSession) {
            await GuildHandler.persistClient(targetSession);
            targetSession.send(0x56, GuildHandler.buildNoGuildPayload());
            GuildHandler.sendChatStatus(targetSession, `You were removed from ${guildName}.`);
        } else if (targetRecord) {
            await GuildHandler.persistRecord(targetRecord);
        }

        const members = await GuildHandler.loadGuildMembers(guildName);
        for (const record of members) {
            const other = GuildHandler.getOnlineSession(record.character.name);
            if (!other) {
                continue;
            }

            GuildHandler.sendGuildMemberLeft(other, client.character.name, targetCharacter.name);
        }

        await GuildHandler.broadcastGuildUpdate(guildName);
    }

    static async handlePromoteGuildMember(client: Client, data: Buffer): Promise<void> {
        await GuildHandler.handleRankChange(client, data, true);
    }

    static async handleDemoteGuildMember(client: Client, data: Buffer): Promise<void> {
        await GuildHandler.handleRankChange(client, data, false);
    }

    private static async handleRankChange(client: Client, data: Buffer, promote: boolean): Promise<void> {
        if (!client.character) {
            return;
        }

        const guildName = GuildHandler.getGuildName(client.character);
        if (!guildName) {
            GuildHandler.sendChatStatus(client, 'You are not in a guild.');
            return;
        }
        if (GuildHandler.getGuildRank(client.character) !== GuildHandler.RANK_GUILD_MASTER) {
            GuildHandler.sendChatStatus(client, 'Only the guild leader can change guild ranks.');
            return;
        }

        const br = new BitReader(data);
        const targetName = GuildHandler.sanitizeGuildName(br.readMethod26());
        const targetSession = GuildHandler.getOnlineSession(targetName);
        const targetRecord = targetSession?.character
            ? null
            : await GuildHandler.loadCharacterRecordByName(targetName);
        const targetCharacter = targetSession?.character ?? targetRecord?.character ?? null;
        if (!targetCharacter || GuildHandler.normalizeGuildName(GuildHandler.getGuildName(targetCharacter)) !== GuildHandler.normalizeGuildName(guildName)) {
            GuildHandler.sendChatStatus(client, `${targetName} is not in your guild.`);
            return;
        }
        if (normalizeCharacterKey(targetCharacter.name) === normalizeCharacterKey(client.character.name)) {
            GuildHandler.sendChatStatus(client, 'You cannot change your own guild rank here.');
            return;
        }

        const oldRank = GuildHandler.getGuildRank(targetCharacter);
        let newRank = oldRank;
        if (promote) {
            if (oldRank === GuildHandler.RANK_SILENCED) {
                newRank = GuildHandler.RANK_INITIATE;
            } else if (oldRank === GuildHandler.RANK_INITIATE) {
                newRank = GuildHandler.RANK_MEMBER;
            } else if (oldRank === GuildHandler.RANK_MEMBER) {
                newRank = GuildHandler.RANK_OFFICER;
            }
        } else if (oldRank === GuildHandler.RANK_OFFICER) {
            newRank = GuildHandler.RANK_MEMBER;
        } else if (oldRank === GuildHandler.RANK_MEMBER) {
            newRank = GuildHandler.RANK_INITIATE;
        } else if (oldRank === GuildHandler.RANK_INITIATE) {
            newRank = GuildHandler.RANK_SILENCED;
        }

        if (newRank === oldRank) {
            GuildHandler.sendChatStatus(
                client,
                promote
                    ? 'That member cannot be promoted any further here. Use /gleader to transfer leadership.'
                    : 'That member cannot be demoted any further.'
            );
            return;
        }

        GuildHandler.setCharacterGuild(targetCharacter, guildName, newRank);
        if (targetSession) {
            await GuildHandler.persistClient(targetSession);
        } else if (targetRecord) {
            await GuildHandler.persistRecord(targetRecord);
        }

        const members = await GuildHandler.loadGuildMembers(guildName);
        for (const record of members) {
            const other = GuildHandler.getOnlineSession(record.character.name);
            if (!other) {
                continue;
            }

            GuildHandler.sendGuildRankChange(other, client.character.name, targetCharacter.name, oldRank, newRank);
        }

        await GuildHandler.broadcastGuildUpdate(guildName);
    }

    static async handleTransferGuildLeadership(client: Client, data: Buffer): Promise<void> {
        if (!client.character) {
            return;
        }

        const guildName = GuildHandler.getGuildName(client.character);
        if (!guildName) {
            GuildHandler.sendChatStatus(client, 'You are not in a guild.');
            return;
        }
        if (GuildHandler.getGuildRank(client.character) !== GuildHandler.RANK_GUILD_MASTER) {
            GuildHandler.sendChatStatus(client, 'Only the guild leader can transfer leadership.');
            return;
        }

        const br = new BitReader(data);
        const targetName = GuildHandler.sanitizeGuildName(br.readMethod26());
        if (normalizeCharacterKey(targetName) === normalizeCharacterKey(client.character.name)) {
            GuildHandler.sendChatStatus(client, 'You are already the guild leader.');
            return;
        }

        const targetSession = GuildHandler.getOnlineSession(targetName);
        const targetRecord = targetSession?.character
            ? null
            : await GuildHandler.loadCharacterRecordByName(targetName);
        const targetCharacter = targetSession?.character ?? targetRecord?.character ?? null;
        if (!targetCharacter || GuildHandler.normalizeGuildName(GuildHandler.getGuildName(targetCharacter)) !== GuildHandler.normalizeGuildName(guildName)) {
            GuildHandler.sendChatStatus(client, `${targetName} is not in your guild.`);
            return;
        }

        const oldTargetRank = GuildHandler.getGuildRank(targetCharacter);
        GuildHandler.setCharacterGuild(client.character, guildName, GuildHandler.RANK_OFFICER);
        GuildHandler.setCharacterGuild(targetCharacter, guildName, GuildHandler.RANK_GUILD_MASTER);

        await GuildHandler.persistClient(client);
        if (targetSession) {
            await GuildHandler.persistClient(targetSession);
        } else if (targetRecord) {
            await GuildHandler.persistRecord(targetRecord);
        }

        const members = await GuildHandler.loadGuildMembers(guildName);
        for (const record of members) {
            const other = GuildHandler.getOnlineSession(record.character.name);
            if (!other) {
                continue;
            }

            GuildHandler.sendGuildRankChange(other, client.character.name, targetCharacter.name, oldTargetRank, GuildHandler.RANK_GUILD_MASTER);
        }

        await GuildHandler.broadcastGuildUpdate(guildName);
    }

    static async handleGuildChat(client: Client, data: Buffer): Promise<void> {
        if (!client.character) {
            return;
        }

        const guildName = GuildHandler.getGuildName(client.character);
        if (!guildName) {
            GuildHandler.sendChatStatus(client, 'You are not in a guild.');
            return;
        }
        if (GuildHandler.getGuildRank(client.character) === GuildHandler.RANK_SILENCED) {
            GuildHandler.sendChatStatus(client, 'You are silenced in guild chat.');
            return;
        }

        const br = new BitReader(data);
        const message = br.readMethod26().trim();
        if (!message) {
            return;
        }

        const members = await GuildHandler.loadGuildMembers(guildName);
        const targets = members
            .map((record) => GuildHandler.getOnlineSession(record.character.name))
            .filter((session): session is Client => Boolean(session?.character));
        GuildHandler.sendGuildMessage(targets, 0x60, client.character.name, message);
    }

    static async handleOfficerChat(client: Client, data: Buffer): Promise<void> {
        if (!client.character) {
            return;
        }

        const guildName = GuildHandler.getGuildName(client.character);
        const rank = GuildHandler.getGuildRank(client.character);
        if (!guildName) {
            GuildHandler.sendChatStatus(client, 'You are not in a guild.');
            return;
        }
        if (rank > GuildHandler.RANK_OFFICER) {
            GuildHandler.sendChatStatus(client, 'Only guild leaders and officers can use officer chat.');
            return;
        }

        const br = new BitReader(data);
        const message = br.readMethod26().trim();
        if (!message) {
            return;
        }

        const members = await GuildHandler.loadGuildMembers(guildName);
        const targets = members
            .map((record) => GuildHandler.getOnlineSession(record.character.name))
            .filter((session): session is Client => Boolean(session?.character))
            .filter((session) => GuildHandler.getGuildRank(session.character) <= GuildHandler.RANK_OFFICER);
        GuildHandler.sendGuildMessage(targets, 0x62, client.character.name, message);
    }
}
