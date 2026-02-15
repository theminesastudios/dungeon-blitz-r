import * as fs from 'fs';
import * as path from 'path';

export class PetConfig {
    static PET_TYPES: any[] = [];
    static EGG_TYPES: any[] = [];
    
    // Constants from class_16 (pets.py)
    static NEW_EGG_SET_TIME = 72000; // 20 hours
    static EGG_HATCH_TIMES = {
        0: 259200, // 3 days
        1: 518400, // 6 days
        2: 864000  // 10 days (fallback)
    };
    static MAX_EGG_SLOTS = 8;
    static EGG_GOLD_COST = [0, 5000, 25000, 50000, 75000, 250000, 500000, 750000];
    static EGG_IDOL_COST = [0, 3, 13, 25, 37, 60, 94, 119];

    // Constants from class_7 (pets.py)
    static TRAINING_TIME = [0, 0, 180, 1800, 7200, 14400, 28800, 57600, 86400, 115200, 144000, 172800, 201600, 230400,259200, 345600, 432000, 518400, 604800, 691200, 777600];
    static TRAINING_GOLD_COST = [0, 0, 2000, 4000, 6000, 8000, 10000, 20000, 30000, 40000, 50000, 60000, 70000, 80000, 90000,100000, 200000, 300000, 400000, 500000, 600000];
    static TRAINING_IDOL_COST = [0, 0, 1, 2, 3, 4, 5, 10, 15, 20, 25, 30, 35, 38, 39, 40, 54, 67, 80, 94, 107];
    
    // XP Thresholds
    static PET_XP_THRESHOLDS = [
        0, 4000, 12500, 24200, 39400, 57300, 78800, 103200, 130100, 158800, 
        192100, 229000, 272100, 320300, 375500, 434600, 501100, 573800, 605300, 744100
    ];

    static load(dataDir: string) {
        try {
            const petsPath = path.join(dataDir, 'pet_types.json');
            PetConfig.PET_TYPES = JSON.parse(fs.readFileSync(petsPath, 'utf-8'));
            console.log(`[PetConfig] Loaded ${PetConfig.PET_TYPES.length} pets.`);
        } catch (err) {
            console.error(`[PetConfig] Failed to load pet_types.json:`, err);
        }

        try {
            const eggsPath = path.join(dataDir, 'egg_types.json');
            PetConfig.EGG_TYPES = JSON.parse(fs.readFileSync(eggsPath, 'utf-8'));
            console.log(`[PetConfig] Loaded ${PetConfig.EGG_TYPES.length} eggs.`);
        } catch (err) {
            console.error(`[PetConfig] Failed to load egg_types.json:`, err);
        }
    }

    static getPetDef(petId: number) {
        return PetConfig.PET_TYPES.find(p => p.PetID === petId);
    }

    static getEggDef(eggId: number) {
         return PetConfig.EGG_TYPES.find(e => e.EggID === eggId);
    }
}
