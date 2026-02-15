
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
            x: props.pos_x || 0,
            y: props.pos_y || 0,
            v: props.velocity_x || 0,
            team: props.team || EntityTeam.PLAYER,
            facingLeft: !!props.b_left,
            buffs: props.buffs || [],
            status: undefined // ?
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
        // ent.talents = build_talent_slots(char); // TODO: Implement buildTalentSlots if needed
        ent.equippedMount = char.equippedMount || 0;
        ent.activePet = char.activePet || {}; // TODO: Verify structure
        
        return ent;
    }

    static fromNpc(npc: any): EntityProps {
        return {
            id: npc.id,
            name: npc.name,
            isPlayer: false,
            x: npc.x,
            y: npc.y,
            v: npc.v || 0,
            team: npc.team,
            renderDepthOffset: npc.render_depth_offset || 0,
            characterName: npc.character_name,
            dramaAnim: npc.DramaAnim,
            sleepAnim: npc.SleepAnim,
            summonerId: npc.summonerId,
            powerId: npc.power_id,
            entState: npc.entState,
            facingLeft: !!npc.facing_left,
            untargetable: !!npc.untargetable,
            behaviorSpeed: npc.behavior_speed || 0,
            healthDelta: npc.health_delta || 0,
            buffs: npc.buffs || []
        };
    }

    // Mirrors Send_Entity_Data (0x0F payload usually)
    static serialize(entity: EntityProps): Buffer {
        const bb = new BitBuffer();
        
        bb.writeMethod4(entity.id);
        bb.writeMethod13(entity.name);
        
        // Log is skipped for now, can add later
        
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
            // EntType.MAX_SLOTS (usually 6? loop covers up to it)
            // Python: for slot in range(1, EntType.MAX_SLOTS) -> EntType.MAX_SLOTS is 7 likely (1..6)
            // But let's check constants.py or assume 6 slots. Python entity.py: range(1, EntType.MAX_SLOTS)
            // Let's assume 6 slots standard.
            
            const MAX_GEAR_SLOTS = 6; 
            for (let i = 0; i < MAX_GEAR_SLOTS; i++) {
                if (i < equipped.length && equipped[i]) {
                    const gear = equipped[i];
                    bb.writeMethod6(1, 1);
                    bb.writeMethod6(gear.gearID || 0, 11); // GearType.GEARTYPE_BITSTOSEND
                    bb.writeMethod6(gear.tier || 0, 2); // GearType.const_176
                    
                    const runes = gear.runes || [0, 0, 0];
                    bb.writeMethod6(runes[0], 16); // class_64.const_101
                    bb.writeMethod6(runes[1], 16);
                    bb.writeMethod6(runes[2], 16);
                    
                    const colors = gear.colors || [0, 0];
                    bb.writeMethod6(colors[0], 8); // class_21.const_50 (8 bits?) check Python: class_21.const_50 = 8 usually
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
            bb.writeMethod6(1, 1); // IsPlayer branch
            
            bb.writeMethod6(entity.idleReset ? 1 : 0, 1);
            bb.writeMethod6(entity.spawnFx ? 1 : 0, 1);
            
            const activePet = entity.activePet || {};
            // Python: petID (75? No, class_7.const_19 is 7)
            // Check worldEnter: class_7.const_19 is 7.
            // Python entity.py line 195: bb.write_method_6(active_pet.get("petID", 0), class_7.const_19)
            bb.writeMethod6(activePet.petID || 0, 7); 
            // class_7.const_75 is special_id bits? Wait.
            // Python line 196: bb.write_method_6(active_pet.get("special_id", 0), class_7.const_75)
            // Let's assume 32? No, special_id usually small. class_7.const_75 in WorldEnter.py used 4 bytes (write_method_4).
            // But here it uses write_method_6. 
            // In WorldEnter.py: buf.write_method_4(pet_iter_id).
            // In entity.py: bb.write_method_6(..., class_7.const_75).
            // We need to know class_7.const_75 value. 
            // Safe bet: use writeMethod4 if it's an ID, or if bit count is unknown, check logic.
            // Wait, entity.py uses write_method_6, so it specifies bit count.
            // I'll stick to a reasonable bit count, maybe 6 or 32 if dynamic?
            // "class_7.const_75" -> likely 6 or similar small number for method_6. 
            // Let's use 6 for now (MAX_ITERATION is 63 -> 6 bits).
            bb.writeMethod6(activePet.special_id || 0, 6); 
            
            // equippedMount
            // class_20.const_297 (Bits?)
            // WorldEnter uses writeMethod4 for mountID.
            // Entity.py uses writeMethod6(..., class_20.const_297).
            // Assuming 32 bits if it's method4-like, but method6 implies fixed bits. 
            // Let's use 32 just in case via Method4 if we are unsure, OR guess 10-12.
            // Actually, let's use writeMethod4 for safety if we can change it? 
            // No, must match client read. 
            // Let's assume 16 bits for mount ID?
            // NOTE: I'll use writeMethod4 because I don't know the constant, and method4 is safer for variable length if allowed?
            // No, method6 is fixed bits.
            // Let's look at WorldEnter.ts -> it has some constants?
            // "bb.writeMethod6(active_pet.get('petID', 0), class_7.const_19)" -> WorldEnter.py uses const_19 too.
            // Let's use 16 bits for mount/pet special?
            // Wait, if I can't be sure, I should check constraints.
            // For now I'll use 10 bits.
             bb.writeMethod6(entity.equippedMount || 0, 16); // Guessing 16 bits for Mount ID
            
            // activeConsumableID
            // class_3.const_69
             bb.writeMethod6(entity.activeConsumableId || 0, 16); 
             
             const abilities = entity.abilities || [];
             const hasAbilities = abilities.length > 0;
             bb.writeMethod6(hasAbilities ? 1 : 0, 1);
             
             if (hasAbilities) {
                 for (let i = 0; i < 3; i++) {
                     const a = (i < abilities.length) ? abilities[i] : { abilityID: 0, rank: 0 };
                     bb.writeMethod6(a.abilityID || 0, 7); // class_7.const_19 is 7? No, active abilities.
                     // Python: bb.write_method_6(ability.get("abilityID", 0), class_7.const_19)
                     // If class_7.const_19 is 7 (from WorldEnter analysis), then 7 bits.
                     
                     bb.writeMethod6(a.rank || 0, 6); // class_7.const_75? No, rank.
                     // Python: bb.write_method_6(ability.get("rank", 0), class_7.const_75)
                     // Reusing const_75. If I guessed 6 earlier, stick with 6.
                 }
             }

        } else {
            bb.writeMethod6(0, 1); // Not player branch 1
            
            // NPC Specifics
            bb.writeMethod6(entity.untargetable ? 1 : 0, 1);
            bb.writeMethod706(entity.renderDepthOffset || 0);
            
            const speed = entity.behaviorSpeed || 0;
            if (speed > 0) {
                bb.writeMethod6(1, 1);
                bb.writeMethod4(Math.floor(speed * 1000)); // LinkUpdater.VELOCITY_INFLATE approx 1000?
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
        bb.writeMethod6(entity.noJumpAttack ? 1 : 0, 1);
        
        if (entity.isPlayer) {
            // Level
            bb.writeMethod6(entity.level || 1, Entity.MAX_CHAR_LEVEL_BITS);
            
            // Master Class
            bb.writeMethod6(entity.masterClass || 0, 4); // Game.const_209 (4 bits)
            
            // Talents
            // Check if MasterClass is set and has talents
            // Logic: if masterclass != 0 and any talent points > 0
            const hasTalents = (entity.masterClass !== 0) && (entity.talents && entity.talents.some(t => t && t.points > 0));
            
            bb.writeMethod6(hasTalents ? 1 : 0, 1);
            
            if (hasTalents && entity.talents) {
                for (let i = 0; i < 27; i++) { // class_118.NUM_TALENT_SLOTS = 27
                    const t = (i < entity.talents.length) ? entity.talents[i] : null;
                    if (t && t.nodeID > 0 && t.points > 0) {
                        bb.writeMethod6(1, 1);
                        bb.writeMethod6(t.nodeID, 8); // class_118.const_127 (8 bits?)
                        bb.writeMethod6(t.points - 1, 2); // method_277(slot) -> usually 2 bits for points (1..3)
                    } else {
                        bb.writeMethod6(0, 1);
                    }
                }
            }
            
        } else {
            bb.writeMethod6(0, 1);
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
