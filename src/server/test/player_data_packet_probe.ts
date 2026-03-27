import fs from 'fs';
import path from 'path';
import { MissionLoader } from '../data/MissionLoader';
import { LevelConfig } from '../core/LevelConfig';
import { WorldEnter } from '../utils/WorldEnter';

type SaveFile = {
    characters?: Array<Record<string, any>>;
};

function main(): void {
    MissionLoader.load(path.resolve(__dirname, '../data'));
    LevelConfig.load(path.resolve(__dirname, '../data'));

    const save = JSON.parse(
        fs.readFileSync(path.resolve(__dirname, '../saves/1.json'), 'utf8')
    ) as SaveFile;
    const character = save.characters?.find((entry) => String(entry.name) === 'Graalhob');
    if (!character) {
        throw new Error('Character Graalhob not found in save 1');
    }

    const compact = WorldEnter.buildPlayerDataPacket(
        character as never,
        37633,
        0,
        0,
        'NewbieRoad',
        0,
        0,
        false,
        false
    ).toBuffer();
    const full = WorldEnter.buildPlayerDataPacket(
        character as never,
        37633,
        0,
        0,
        'NewbieRoad',
        0,
        0,
        false,
        true
    ).toBuffer();

    console.log(JSON.stringify({
        compact: compact.length,
        full: full.length
    }));
}

main();
