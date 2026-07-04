import { PasswordRecord } from '../auth/PasswordAuth';

export interface UserAccount {
    email: string;
    emailAliases?: string[];
    user_id: number;
    passwordKdf?: string;
    passwordSalt?: string;
    passwordHash?: string;
    passwordParams?: {
        N?: number;
        r?: number;
        p?: number;
        keylen?: number;
    };
    discordId?: string;
    discordUsername?: string;
    discordGlobalName?: string;
    discordDisplayName?: string;
    discordEmail?: string;
    discordEmailVerified?: boolean;
    discordAvatar?: string;
    discordLinkedAt?: string;
    discordSyncRequired?: boolean;
    accountSource?: 'discord_oauth' | 'password' | string;
    isSponsor?: boolean;
    sponsorStatus?: 'unknown' | 'none' | 'eligible' | 'active' | string;
    sponsorEligible?: boolean;
    sponsorSource?: string;
    sponsorCheckedAt?: string;
    sponsorRecordId?: string;
}

export interface DiscordAccountProfile {
    id: string;
    username?: string;
    globalName?: string;
    displayName?: string;
    email?: string;
    emailVerified?: boolean;
    avatar?: string;
}

export interface SponsorAccountMetadata {
    sponsorEligible: boolean;
    sponsorStatus: 'unknown' | 'none' | 'eligible' | 'active' | string;
    sponsorSource?: string;
    sponsorCheckedAt?: string;
    sponsorRecordId?: string;
}

export interface Character {
    name: string;
    class: string;
    gender: string;
    level: number;
    dialogueLanguage?: string;
    // Expanded fields for building/upgrade logic
    gold?: number;
    mammothIdols?: number;
    magicForge?: MagicForge;
    forgeMilestones?: { [key: string]: boolean };
    buildingUpgrade?: BuildingUpgrade;
    [key: string]: any; 
}

export interface MagicForge {
    stats_by_building: { [key: string]: number };
    primary?: number;
    secondary?: number;
    secondary_tier?: number;
    usedlist?: number;
    ReadyTime?: number;
    forge_roll_a?: number;
    forge_roll_b?: number;
    is_extended_forge?: boolean;
}


export interface BuildingUpgrade {
    buildingID: number;
    rank: number;
    ReadyTime: number;
}

export interface UserSaveData {
    user_id: number;
    characters: Character[];
}

export interface IDatabase {
    getAccount(email: string): Promise<UserAccount | null>;
    getAccountById(userId: number): Promise<UserAccount | null>;
    getAccountId(email: string): Promise<number | null>;
    findAccountByDiscordId(discordId: string): Promise<UserAccount | null>;
    linkDiscordToAccount(userId: number, discordUser: DiscordAccountProfile, sponsor?: SponsorAccountMetadata): Promise<UserAccount>;
    createDiscordAccount(email: string, discordUser: DiscordAccountProfile, sponsor?: SponsorAccountMetadata): Promise<UserAccount>;
    createAccount(email: string, passwordRecord: PasswordRecord): Promise<UserAccount>;
    updateAccountPassword(email: string, passwordRecord: PasswordRecord): Promise<UserAccount | null>;
    loadCharacters(userId: number): Promise<Character[]>;
    saveCharacters(userId: number, characters: Character[]): Promise<void>;
    isCharacterNameTaken(name: string): Promise<boolean>;
}
