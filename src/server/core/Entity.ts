
import { BitBuffer } from '../network/protocol/bitBuffer';
import { Game } from './Enums'; // We might need to create this or import from a centralized place
import { Character } from '../database/Database';

// Assuming these enums exist or need to be defined
export enum EntityTeam {
    UNKNOWN = 0,
    PLAYER = 1,
    ENEMY = 2,
    NPC = 3
}

export enum EntityState {
    ACTIVE = 0,
    SLEEP = 1,
    DRAMA = 2,
    DEAD = 3 // "Entity Dies when the game loads"
}

export interface EntityProps {
    id: number;
    name: string;
    isPlayer: boolean;
    x: number;
    y: number;
    v: number; // velocity
    team: number;
    renderDepthOffset?: number;
    
    // Cue Data
    characterName?: string;
    dramaAnim?: string;
    sleepAnim?: string;
    
    summonerId?: number;
    powerId?: number;
    entState?: number;
    
    facingLeft?: boolean;
    noJumpAttack?: boolean;
    untargetable?: boolean;
    behaviorSpeed?: number;
    
    // Player specific
    class?: string;
    gender?: string;
    headSet?: string;
    hairSet?: string;
    mouthSet?: string;
    faceSet?: string;
    hairColor?: number;
    skinColor?: number;
    shirtColor?: number;
    pantColor?: number;
    
    equippedGears?: any[];
    abilities?: any[];
    level?: number;
    masterClass?: number;
    talents?: any[]; // Talent slots
    equippedMount?: number;
    activeConsumableId?: number;
    
    activePet?: {
        petID?: number; // typeID
        typeID?: number;
        special_id?: number;
        // ...
    };
    
    healthDelta?: number;
    buffs?: any[];
    
    // Flags
    idleReset?: boolean;
    spawnFx?: boolean; // appearance_flag
}

export class Entity {
    // Constants from Python
    static readonly TEAM_BITS = 2;
    static readonly STATE_BITS = 2; // const_316
    static readonly MAX_CHAR_LEVEL_BITS = 6;
    
    // Helper to build entity dict from Character (mirroring `build_entity_dict`)
    static fromCharacter(eid: number, char: Character, props: any = {}): EntityProps {
        const ent: EntityProps = {
            id: eid,
            name: char.name || props.ent_name || "",
            isPlayer: true,
            x: Number(props.x ?? props.pos_x ?? char.CurrentLevel?.x ?? 0),
            y: Number(props.y ?? props.pos_y ?? char.CurrentLevel?.y ?? 0),
            v: Number(props.v ?? props.velocity_x ?? 0),
            team: Number(props.team ?? EntityTeam.PLAYER),
            entState: Number(props.entState ?? props.ent_state ?? EntityState.ACTIVE),
            facingLeft: Boolean(props.facingLeft ?? props.b_left),
            renderDepthOffset: Number(props.renderDepthOffset ?? props.render_depth_offset ?? 0),
            buffs: props.buffs || [],
        } as any;

        // Player specific fields
        ent.class = char.class || "";
        ent.gender = char.gender || "";
        ent.headSet = char.headSet || "";
        ent.hairSet = char.hairSet || "";
        ent.mouthSet = char.mouthSet || "";
        ent.faceSet = char.faceSet || "";
        ent.hairColor = char.hairColor || 0;
        ent.skinColor = char.skinColor || 0;
        ent.shirtColor = char.shirtColor || 0;
        ent.pantColor = char.pantColor || 0;
        
        ent.equippedGears = char.equippedGears || [];
        ent.abilities = char.learnedAbilities || [];
        ent.level = char.level || 1;
        ent.masterClass = char.MasterClass || 0;
        ent.talents = Array.isArray((char as any).talents) ? (char as any).talents : [];
        ent.equippedMount = char.equippedMount || 0;
        ent.activeConsumableId = Number((char as any).activeConsumableID ?? (char as any).activeConsumableId ?? 0);
        ent.activePet = char.activePet || {};
        
        return ent;
    }

    static fromNpc(npc: any): EntityProps {
        const cueData = (npc && typeof npc.cue_data === 'object') ? npc.cue_data : {};
        const isPlayer = Boolean(npc?.is_player);
        return {
            id: Number(npc?.id ?? 0),
            name: String(npc?.name ?? ''),
            isPlayer,
            x: Number(npc?.x ?? npc?.pos_x ?? 0),
            y: Number(npc?.y ?? npc?.pos_y ?? 0),
            v: Number(npc?.v ?? npc?.velocity_x ?? 0),
            team: Number(npc?.team ?? 0),
            renderDepthOffset: Number(npc?.render_depth_offset ?? 0),
            characterName: String(npc?.character_name ?? cueData.character_name ?? ''),
            dramaAnim: String(npc?.DramaAnim ?? cueData.DramaAnim ?? ''),
            sleepAnim: String(npc?.SleepAnim ?? cueData.SleepAnim ?? ''),
            summonerId: Number(npc?.summonerId ?? 0),
            powerId: Number(npc?.power_id ?? 0),
            entState: Number(npc?.entState ?? 0),
            facingLeft: Boolean(npc?.facing_left),
            noJumpAttack: Boolean(npc?.noJumpAttack),
            untargetable: Boolean(npc?.untargetable),
            behaviorSpeed: Number(npc?.behavior_speed ?? 0),
            healthDelta: Number(npc?.health_delta ?? 0),
            buffs: Array.isArray(npc?.buffs) ? npc.buffs : [],
            idleReset: Boolean(npc?.idle_reset),
            spawnFx: Boolean(npc?.spawn_fx),
            class: String(npc?.class ?? ''),
            gender: String(npc?.gender ?? ''),
            headSet: String(npc?.headSet ?? ''),
            hairSet: String(npc?.hairSet ?? ''),
            mouthSet: String(npc?.mouthSet ?? ''),
            faceSet: String(npc?.faceSet ?? ''),
            hairColor: Number(npc?.hairColor ?? 0),
            skinColor: Number(npc?.skinColor ?? 0),
            shirtColor: Number(npc?.shirtColor ?? 0),
            pantColor: Number(npc?.pantColor ?? 0),
            equippedGears: Array.isArray(npc?.equippedGears) ? npc.equippedGears : [],
            abilities: Array.isArray(npc?.abilities) ? npc.abilities : [],
            level: Number(npc?.level ?? 1),
            masterClass: Number(npc?.MasterClass ?? 0),
            talents: Array.isArray(npc?.talents) ? npc.talents : [],
            equippedMount: Number(npc?.equippedMount ?? npc?.MountID ?? 0),
            activeConsumableId: Number(npc?.activeConsumableID ?? 0),
            activePet: {
                petID: 0,
                special_id: 0
            }
        };
    }

    // Mirrors Send_Entity_Data (0x0F payload usually)
    static serialize(entity: EntityProps): Buffer {
        const bb = new BitBuffer();
        const MAX_GEAR_SLOTS = 6;
        const TALENT_SLOT_COUNT = 27;
        const PLAYER_FIELD_BITS = {
            petId: 7,
            petSpecialId: 6,
            mountId: 7,
            consumableId: 5,
            abilityId: 7,
            abilityRank: 6,
            masterClass: 4,
            talentNodeId: 6
        } as const;

        const getTalentPointBits = (slotIndex: number): number => {
            const talentCaps = [5, 2, 3, 5, 5, 3, 2, 3, 2, 5, 2, 3, 5, 5, 3, 2, 3, 2, 5, 2, 3, 5, 5, 3, 2, 3, 2];
            const maxPoints = talentCaps[slotIndex] ?? 0;
            if (maxPoints <= 2) {
                return 1;
            }
            if (maxPoints <= 4) {
                return 2;
            }
            return 3;
        };
        
        bb.writeMethod4(entity.id);
        bb.writeMethod13(entity.name);

        if (entity.isPlayer) {
            bb.writeMethod6(1, 1);
            bb.writeMethod13(entity.class || "");
            bb.writeMethod13(entity.gender || "");
            bb.writeMethod13(entity.headSet || "");
            bb.writeMethod13(entity.hairSet || "");
            bb.writeMethod13(entity.mouthSet || "");
            bb.writeMethod13(entity.faceSet || "");
            
            bb.writeMethod6(entity.hairColor || 0, 24);
            bb.writeMethod6(entity.skinColor || 0, 24);
            bb.writeMethod6(entity.shirtColor || 0, 24);
            bb.writeMethod6(entity.pantColor || 0, 24);
            
            const equipped = entity.equippedGears || [];
            for (let i = 0; i < MAX_GEAR_SLOTS; i++) {
                if (i < equipped.length && equipped[i]) {
                    const gear = equipped[i];
                    bb.writeMethod6(1, 1);
                    bb.writeMethod6(gear.gearID || 0, 11);
                    bb.writeMethod6(gear.tier || 0, 2);
                    
                    const runes = gear.runes || [0, 0, 0];
                    bb.writeMethod6(runes[0], 16);
                    bb.writeMethod6(runes[1], 16);
                    bb.writeMethod6(runes[2], 16);
                    
                    const colors = gear.colors || [0, 0];
                    bb.writeMethod6(colors[0], 8);
                    bb.writeMethod6(colors[1], 8);
                } else {
                    bb.writeMethod6(0, 1);
                }
            }
        } else {
            bb.writeMethod6(0, 1);
        }
        
        bb.writeMethod45(Math.floor(entity.x));
        bb.writeMethod45(Math.floor(entity.y));
        bb.writeMethod45(Math.floor(entity.v || 0));
        bb.writeMethod6(entity.team || 0, Entity.TEAM_BITS);
        
        if (entity.isPlayer) {
            bb.writeMethod6(1, 1);
            bb.writeMethod6(entity.idleReset ? 1 : 0, 1);
            bb.writeMethod6(entity.spawnFx ? 1 : 0, 1);
            
            const activePet = entity.activePet || {};
            bb.writeMethod6(
                Number(activePet.petID ?? activePet.typeID ?? 0),
                PLAYER_FIELD_BITS.petId
            );
            bb.writeMethod6(Number(activePet.special_id ?? 0), PLAYER_FIELD_BITS.petSpecialId);
            bb.writeMethod6(Number(entity.equippedMount || 0), PLAYER_FIELD_BITS.mountId);
            bb.writeMethod6(Number(entity.activeConsumableId || 0), PLAYER_FIELD_BITS.consumableId);
             
             const abilities = entity.abilities || [];
             const hasAbilities = abilities.length > 0;
             bb.writeMethod6(hasAbilities ? 1 : 0, 1);
             
             if (hasAbilities) {
                 for (let i = 0; i < 3; i++) {
                     const a = (i < abilities.length) ? abilities[i] : { abilityID: 0, rank: 0 };
                     bb.writeMethod6(Number(a.abilityID || 0), PLAYER_FIELD_BITS.abilityId);
                     bb.writeMethod6(Number(a.rank || 0), PLAYER_FIELD_BITS.abilityRank);
                 }
             }
        } else {
            bb.writeMethod6(0, 1);
            bb.writeMethod6(entity.untargetable ? 1 : 0, 1);
            bb.writeMethod739(entity.renderDepthOffset || 0);
            
            const speed = entity.behaviorSpeed || 0;
            if (speed > 0) {
                bb.writeMethod6(1, 1);
                bb.writeMethod4(Math.floor(speed * 1000));
            } else {
                bb.writeMethod6(0, 1);
            }
        }
        
        // Cues
        const cueKeys: Array<keyof EntityProps> = ["characterName", "dramaAnim", "sleepAnim"];
        for (const key of cueKeys) {
            const val = entity[key];
            if (val && typeof val === 'string') {
                bb.writeMethod6(1, 1);
                bb.writeMethod13(val);
            } else {
                bb.writeMethod6(0, 1);
            }
        }
        
        // Summoner
        if (entity.summonerId) {
            bb.writeMethod6(1, 1);
            bb.writeMethod4(entity.summonerId);
        } else {
            bb.writeMethod6(0, 1);
        }
        
        // Power
        if (entity.powerId) {
            bb.writeMethod6(1, 1);
            bb.writeMethod4(entity.powerId);
        } else {
            bb.writeMethod6(0, 1);
        }
        
        bb.writeMethod6(entity.entState || 0, Entity.STATE_BITS);
        bb.writeMethod6(entity.facingLeft ? 1 : 0, 1);
        
        if (entity.isPlayer) {
            bb.writeMethod6(entity.level || 1, Entity.MAX_CHAR_LEVEL_BITS);
            bb.writeMethod6(entity.masterClass || 0, PLAYER_FIELD_BITS.masterClass);

            const hasTalents = (entity.masterClass !== 0) && (entity.talents && entity.talents.some(t => t && t.points > 0));
            bb.writeMethod6(hasTalents ? 1 : 0, 1);
            
            if (hasTalents && entity.talents) {
                for (let i = 0; i < TALENT_SLOT_COUNT; i++) {
                    const t = (i < entity.talents.length) ? entity.talents[i] : null;
                    if (t && t.nodeID > 0 && t.points > 0) {
                        bb.writeMethod6(1, 1);
                        bb.writeMethod6(Number(t.nodeID), PLAYER_FIELD_BITS.talentNodeId);
                        bb.writeMethod6(Number(t.points) - 1, getTalentPointBits(i));
                    } else {
                        bb.writeMethod6(0, 1);
                    }
                }
            }
        }
        
        bb.writeMethod45(Math.floor(entity.healthDelta || 0));
        
        const buffs = entity.buffs || [];
        bb.writeMethod4(buffs.length);
        for (const buff of buffs) {
            bb.writeMethod4(buff.type_id || 0);
            bb.writeMethod4(buff.param1 || 0);
            bb.writeMethod4(buff.param2 || 0);
            bb.writeMethod4(buff.param3 || 0);
            bb.writeMethod4(buff.param4 || 0);
            
            const extra = buff.extra_data || [];
            bb.writeMethod6(extra.length > 0 ? 1 : 0, 1);
            if (extra.length > 0) {
                bb.writeMethod4(extra.length);
                for (const ed of extra) {
                    bb.writeMethod4(ed.id || 0);
                    const vals = ed.values || [];
                    bb.writeMethod4(vals.length);
                    for (const v of vals) {
                         bb.writeFloat(v);
                    }
                }
            }
        }

        return bb.toBuffer();
    }
}
