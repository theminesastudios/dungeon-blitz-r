
export enum BuildingID {
    None = 0,
    Tome = 1,
    Forge = 2,
    
    // Paladin Towers
    JusticarTower = 3,
    SentinelTower = 4,
    TemplarTower = 5,

    // Mage Towers
    FrostwardenTower = 6,
    FlameseerTower = 7,
    NecromancerTower = 8,

    // Rogue Towers
    ExecutionerTower = 9,
    ShadowwalkerTower = 10,
    SoulthiefTower = 11,

    Keep = 12,
    Barn = 13 
}

export enum MasterClassID {
    None = 0,
    
    // Rogue
    Executioner = 1,
    Shadowwalker = 2,
    Soulthief = 3,

    // Paladin
    Sentinel = 4,
    Justicar = 5,
    Templar = 6,

    // Mage
    Frostwarden = 7,
    Flameseer = 8,
    Necromancer = 9
}

export enum ClassID {
    Paladin = 0,
    Rogue = 1,
    Mage = 2
}

export enum Game {
    const_209 = 4,   // MasterClass bit count
    const_813 = 2,   // HP Scaling bits
    const_646 = 4,   // Alert State bits
    const_526 = 0    // Default/None MasterClass
}
