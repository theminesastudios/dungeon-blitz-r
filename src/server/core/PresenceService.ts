import { Client } from './Client';
import * as crypto from 'crypto';
import { MasterClassID } from './Enums';
import { LevelConfig } from './LevelConfig';
import { GlobalState } from './GlobalState';
import { normalizeCharacterKey } from './SocialState';
import { Config } from './config';
import { MissionLoader } from '../data/MissionLoader';

export interface PresenceSnapshot {
    characterName: string;
    characterClass: string;
    levelKey: string;
    levelName: string;
    areaKey: string;
    disciplineKey: string;
    activityKind: 'zone' | 'dungeon';
    playerStatus: string;
    hardMode: boolean;
    playerSpawned: boolean;
    roomId: number | null;
    roomLabel: string | null;
    partyId: number | null;
    partySize: number;
    partyLeader: string | null;
    partyLocked: boolean;
    partyMax: number;
    joinSecret: string | null;
    details: string;
    state: string;
    startedAt: string;
    startedAtMs: number;
}

export interface DiscordTargetSelection {
    snapshot: PresenceSnapshot | null;
    reason: 'ok' | 'no-sessions' | 'not-found' | 'ambiguous';
    availableCharacters: string[];
}

export interface RequesterPresenceSelection {
    snapshot: PresenceSnapshot | null;
    reason: 'ok' | 'no-sessions' | 'not-found' | 'ambiguous';
    availableCharacters: string[];
    remoteAddress: string;
}

interface PartySnapshot {
    partyId: number | null;
    partySize: number;
    partyLeader: string | null;
    locked: boolean;
}

const PARTY_MAX_MEMBERS = 4;

export class PresenceService {
    private static readonly LEVEL_DISPLAY_NAMES: Record<string, string> = {
        NewbieRoad: "Wolf's End",
        CraftTown: 'Home',
        CraftTownTutorial: 'Home',
        SwampRoadNorth: 'Black Rose Mire',
        BridgeTown: 'Felbridge',
        Castle: 'Castle Hocke',
        EmeraldGlades: 'Emerald Glades',
        ShazariDesert: 'Shazari Desert',
        OldMineMountain: 'Stormshard Mountain'
    };
    private static readonly LEVEL_IMAGE_KEYS: Record<string, string> = {
        CraftTown: 'home',
        CraftTownTutorial: 'home',
        NewbieRoad: 'newbieroad',
        SwampRoadNorth: 'blackrosemire',
        BridgeTown: 'fellbridge',
        Castle: 'castlehocke',
        EmeraldGlades: 'emeraldglades',
        ShazariDesert: 'shazaridesert',
        OldMineMountain: 'stormshardmountain'
    };
    private static readonly DISCIPLINE_IMAGE_KEYS: Record<string, string> = {
        Executioner: 'viperblade',
        Shadowwalker: 'shadowbringer',
        Soulthief: 'soulthieft',
        Sentinel: 'sentinel',
        Justicar: 'justicar',
        Templar: 'templar',
        Frostwarden: 'frostbringer',
        Flameseer: 'flameseer',
        Necromancer: 'necromancer',
        Paladin: 'paladin',
        Rogue: 'rogue',
        Mage: 'mage'
    };
    private static readonly LEVEL_PREFIX_LABELS: Record<string, string> = {
        AC: 'Castle',
        BT: 'Bridge Town',
        CH: 'Cemetery Hill',
        EG: 'Emerald Glades',
        JC: 'Jade City',
        OMM: 'Old Mine Mountain',
        SD: 'Shazari Desert',
        SRN: 'Swamp Road North'
    };

    static listSessions(): PresenceSnapshot[] {
        const snapshots = Array.from(GlobalState.sessionsByToken.values())
            .map((client) => PresenceService.toSnapshot(client))
            .filter((snapshot): snapshot is PresenceSnapshot => snapshot !== null);

        snapshots.sort((left, right) => left.characterName.localeCompare(right.characterName));
        return snapshots;
    }

    static buildDiscordJoinSecret(partyId: number | null | undefined, partyLeader: string | null | undefined): string | null {
        const normalizedLeader = normalizeCharacterKey(partyLeader);
        if (!Number.isFinite(Number(partyId)) || Number(partyId) <= 0 || !normalizedLeader) {
            return null;
        }

        const payload = `db-party:${Math.round(Number(partyId))}:${normalizedLeader}`;
        const signature = crypto.createHmac('sha256', Config.SECRET).update(payload).digest('hex').slice(0, 32);
        return PresenceService.encodeSecret(`${payload}:${signature}`);
    }

    static resolveDiscordJoinSecret(secret: string | null | undefined): { partyId: number; partyLeader: string } | null {
        const normalizedSecret = String(secret ?? '').trim();
        if (!normalizedSecret) {
            return null;
        }

        let decoded = '';
        try {
            decoded = PresenceService.decodeSecret(normalizedSecret);
        } catch (_error) {
            return null;
        }

        const parts = decoded.split(':');
        if (parts.length !== 4 || parts[0] !== 'db-party') {
            return null;
        }

        const partyId = Math.round(Number(parts[1]));
        const partyLeader = normalizeCharacterKey(parts[2]);
        const signature = parts[3] ?? '';
        if (!Number.isFinite(partyId) || partyId <= 0 || !partyLeader || !signature) {
            return null;
        }

        const payload = `db-party:${partyId}:${partyLeader}`;
        const expectedSignature = crypto.createHmac('sha256', Config.SECRET).update(payload).digest('hex').slice(0, 32);
        if (signature !== expectedSignature) {
            return null;
        }

        return { partyId, partyLeader };
    }

    static selectDiscordTarget(preferredCharacterName: string | null | undefined): DiscordTargetSelection {
        const sessions = PresenceService.listSessions();
        const availableCharacters = sessions.map((entry) => entry.characterName);
        const preferredKey = normalizeCharacterKey(preferredCharacterName);

        if (preferredKey) {
            const selected = sessions.find((entry) => normalizeCharacterKey(entry.characterName) === preferredKey) ?? null;
            return {
                snapshot: selected,
                reason: selected ? 'ok' : 'not-found',
                availableCharacters
            };
        }

        if (sessions.length === 0) {
            return { snapshot: null, reason: 'no-sessions', availableCharacters };
        }

        const spawnedSessions = sessions.filter((entry) => entry.playerSpawned);
        const candidates = spawnedSessions.length > 0 ? spawnedSessions : sessions;

        if (candidates.length === 1) {
            return { snapshot: candidates[0] ?? null, reason: 'ok', availableCharacters };
        }

        return { snapshot: null, reason: 'ambiguous', availableCharacters };
    }

    static selectRequesterSession(remoteAddress: string | null | undefined): RequesterPresenceSelection {
        const normalizedAddress = PresenceService.normalizeRemoteAddress(remoteAddress);
        const sessions = Array.from(GlobalState.sessionsByToken.values()).filter((client) => {
            return PresenceService.normalizeRemoteAddress(client.socket.remoteAddress) === normalizedAddress;
        });
        const snapshots = sessions
            .map((client) => PresenceService.toSnapshot(client))
            .filter((snapshot): snapshot is PresenceSnapshot => snapshot !== null);
        const availableCharacters = snapshots.map((entry) => entry.characterName);

        if (!normalizedAddress) {
            return {
                snapshot: null,
                reason: 'not-found',
                availableCharacters,
                remoteAddress: ''
            };
        }

        if (snapshots.length === 0) {
            return {
                snapshot: null,
                reason: 'no-sessions',
                availableCharacters,
                remoteAddress: normalizedAddress
            };
        }

        const spawnedSessions = snapshots.filter((entry) => entry.playerSpawned);
        const candidates = spawnedSessions.length > 0 ? spawnedSessions : snapshots;

        if (candidates.length === 1) {
            return {
                snapshot: candidates[0] ?? null,
                reason: 'ok',
                availableCharacters,
                remoteAddress: normalizedAddress
            };
        }

        return {
            snapshot: null,
            reason: 'ambiguous',
            availableCharacters,
            remoteAddress: normalizedAddress
        };
    }

    private static toSnapshot(client: Client): PresenceSnapshot | null {
        const characterName = String(client.character?.name ?? '').trim();
        if (!characterName) {
            return null;
        }

        const levelKey = LevelConfig.normalizeLevelName(client.currentLevel || client.character?.CurrentLevel?.name || '');
        const levelName = PresenceService.formatLevelLabel(levelKey);
        const levelSpec = levelKey ? LevelConfig.get(levelKey) : null;
        const activityKind = levelKey === 'CraftTown'
            ? 'zone'
            : levelSpec?.isDungeon
                ? 'dungeon'
                : 'zone';
        const party = PresenceService.getPartySnapshot(characterName);
        const startedAtMs = Number.isFinite(client.worldEnteredAt) ? client.worldEnteredAt : Date.now();
        const className = PresenceService.formatClassName(client.character?.class);
        const disciplineName = PresenceService.formatDisciplineName(
            Number(client.character?.MasterClass ?? 0),
            className
        );
        const characterLevel = PresenceService.formatCharacterLevel(client.character?.level);

        const details = client.playerSpawned ? levelName : 'Loading';
        const joinSecret = PresenceService.buildDiscordJoinSecret(party.partyId, party.partyLeader);

        const areaKey = PresenceService.LEVEL_IMAGE_KEYS[levelKey] || 
                        (activityKind === 'dungeon' ? 'indungeon' : 'dungeon_blitz');
        
        const disciplineKey = PresenceService.DISCIPLINE_IMAGE_KEYS[disciplineName] || 
                             PresenceService.DISCIPLINE_IMAGE_KEYS[className] || 
                             'dungeon_blitz';

        let playerStatus = 'In game';
        if (activityKind === 'dungeon') {
            playerStatus = 'In dungeon';
            if (client.authoritativeCurrentHp < client.authoritativeMaxHp) {
                playerStatus = 'In fight';
            }
        } else if (client.authoritativeCurrentHp < client.authoritativeMaxHp) {
            playerStatus = 'In fight';
        }

        const state = playerStatus;

        return {
            characterName,
            characterClass: className,
            levelKey,
            levelName,
            areaKey,
            disciplineKey,
            activityKind,
            playerStatus,
            hardMode: Boolean(levelSpec?.isHard),
            playerSpawned: client.playerSpawned,
            roomId: null,
            roomLabel: null,
            partyId: party.partyId,
            partySize: party.partySize,
            partyLeader: party.partyLeader,
            partyLocked: party.locked,
            partyMax: PARTY_MAX_MEMBERS,
            joinSecret: joinSecret && !party.locked && party.partySize < PARTY_MAX_MEMBERS ? joinSecret : null,
            details: levelName,
            state: playerStatus,
            startedAt: new Date(startedAtMs).toISOString(),
            startedAtMs
        };
    }

    private static getPartySnapshot(characterName: string): PartySnapshot {
        const characterKey = normalizeCharacterKey(characterName);
        if (!characterKey) {
            return { partyId: null, partySize: 1, partyLeader: null, locked: false };
        }

        const partyId = GlobalState.partyByMember.get(characterKey);
        if (!partyId) {
            return { partyId: null, partySize: 1, partyLeader: null, locked: false };
        }

        const group = GlobalState.partyGroups.get(partyId);
        if (!group) {
            return { partyId: null, partySize: 1, partyLeader: null, locked: false };
        }

        return {
            partyId,
            partySize: Math.max(1, group.members.length),
            partyLeader: String(group.leader || '').trim() || null,
            locked: Boolean(group.locked)
        };
    }

    private static formatLevelLabel(rawLevelName: string): string {
        const normalized = LevelConfig.normalizeLevelName(rawLevelName);
        if (!normalized) {
            return 'Unknown Area';
        }

        const hardMode = normalized.endsWith('Hard');
        const baseName = hardMode ? normalized.slice(0, -4) : normalized;
        const directLabel = PresenceService.LEVEL_DISPLAY_NAMES[baseName];
        if (directLabel) {
            return `${directLabel}${hardMode ? ' (Hard)' : ''}`;
        }

        const missionLabel = PresenceService.getDungeonDisplayName(baseName);
        if (missionLabel) {
            return `${missionLabel}${hardMode ? ' (Hard)' : ''}`;
        }

        const missionMatch = baseName.match(/^([A-Z]+)_Mission(\d+)$/);
        if (missionMatch) {
            const prefix = PresenceService.LEVEL_PREFIX_LABELS[missionMatch[1]] ?? missionMatch[1];
            return `${prefix} Mission ${missionMatch[2]}${hardMode ? ' (Hard)' : ''}`;
        }

        const miniMissionMatch = baseName.match(/^([A-Z]+)_MiniMission(\d+)$/);
        if (miniMissionMatch) {
            const prefix = PresenceService.LEVEL_PREFIX_LABELS[miniMissionMatch[1]] ?? miniMissionMatch[1];
            return `${prefix} Mini Mission ${miniMissionMatch[2]}${hardMode ? ' (Hard)' : ''}`;
        }

        const miniMatch = baseName.match(/^([A-Z]+)_Mini(\d+)$/);
        if (miniMatch) {
            const prefix = PresenceService.LEVEL_PREFIX_LABELS[miniMatch[1]] ?? miniMatch[1];
            return `${prefix} Mini ${miniMatch[2]}${hardMode ? ' (Hard)' : ''}`;
        }

        const cleaned = baseName
            .replace(/_/g, ' ')
            .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
            .replace(/\s+/g, ' ')
            .trim();

        return `${cleaned}${hardMode ? ' (Hard)' : ''}`;
    }

    private static formatClassName(rawClassName: unknown): string {
        const className = String(rawClassName ?? '').trim();
        if (!className) {
            return 'Unknown Class';
        }

        return className.charAt(0).toUpperCase() + className.slice(1).toLowerCase();
    }

    private static getDungeonDisplayName(levelName: string): string | null {
        const mission = MissionLoader.findPrimaryMissionByDungeon(levelName);
        const displayName = String(mission?.DisplayName ?? '').trim();
        return displayName || null;
    }

    private static formatCharacterLevel(rawLevel: unknown): number {
        const level = Math.max(1, Math.floor(Number(rawLevel) || 1));
        return Number.isFinite(level) ? level : 1;
    }

    private static formatDisciplineName(masterClassId: number, className: string): string {
        switch (masterClassId) {
            case MasterClassID.Executioner:
                return 'Executioner';
            case MasterClassID.Shadowwalker:
                return 'Shadowwalker';
            case MasterClassID.Soulthief:
                return 'Soulthief';
            case MasterClassID.Sentinel:
                return 'Sentinel';
            case MasterClassID.Justicar:
                return 'Justicar';
            case MasterClassID.Templar:
                return 'Templar';
            case MasterClassID.Frostwarden:
                return 'Frostwarden';
            case MasterClassID.Flameseer:
                return 'Flameseer';
            case MasterClassID.Necromancer:
                return 'Necromancer';
            default:
                return className;
        }
    }

    private static normalizeRemoteAddress(value: string | null | undefined): string {
        const address = String(value ?? '').trim();
        if (!address) {
            return '';
        }

        if (address.startsWith('::ffff:')) {
            return address.slice('::ffff:'.length);
        }

        if (address === '::1') {
            return '127.0.0.1';
        }

        return address;
    }

    private static encodeSecret(value: string): string {
        return Buffer.from(value, 'utf8')
            .toString('base64')
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/g, '');
    }

    private static decodeSecret(value: string): string {
        const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
        const padLength = (4 - (normalized.length % 4)) % 4;
        const padded = normalized + '='.repeat(padLength);
        return Buffer.from(padded, 'base64').toString('utf8');
    }
}
