export interface UserAccount {
    email: string;
    user_id: number;
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
    dialogueLanguage?: string;
    characters: Character[];
}

export interface IDatabase {
    getAccountId(email: string): Promise<number | null>;
    createAccount(email: string): Promise<number>;
    getDialogueLanguage(userId: number): Promise<string>;
    setDialogueLanguage(userId: number, language: string): Promise<void>;
    loadCharacters(userId: number): Promise<Character[]>;
    saveCharacters(userId: number, characters: Character[]): Promise<void>;
    isCharacterNameTaken(name: string): Promise<boolean>;
}
