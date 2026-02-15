import { Client } from '../core/Client';
import { BitReader } from '../network/protocol/bitReader';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { JsonAdapter } from '../database/JsonAdapter';
import { TalentConfig } from '../core/TalentConfig';
import { GlobalState } from '../core/GlobalState';

const db = new JsonAdapter();

export class TalentHandler {

    static async handleRespecTalentTree(client: Client, data: Buffer): Promise<void> {
        if (!client.character) return;
        
        // Check for respec stone (CharmID 91)
        const charms = client.character.charms || [];
        let hasStone = false;
        
        for (let i = 0; i < charms.length; i++) {
            if (charms[i]['charmID'] === 91 && (charms[i]['count'] || 0) > 0) {
                charms[i]['count'] = (charms[i]['count'] || 0) - 1;
                if (charms[i]['count'] <= 0) {
                    charms.splice(i, 1);
                }
                hasStone = true;
                break;
            }
        }
        
        if (!hasStone) return; // Fail silently or send error?
        
        const mc = String(client.character.MasterClass || 1);
        if (!client.character.TalentTree) client.character.TalentTree = {};
        
        const nodes = [];
        for (let i = 0; i < 27; i++) {
            nodes.push({
                nodeID: TalentConfig.indexToNodeId(i),
                points: 0,
                filled: false
            });
        }
        
        if (!client.character.TalentTree[mc]) client.character.TalentTree[mc] = {};
        client.character.TalentTree[mc].nodes = nodes;
        
        await TalentHandler.saveCharacter(client);
    }

    static async handleAllocateTalentTreePoints(client: Client, data: Buffer): Promise<void> {
        const br = new BitReader(data);
        if (!client.character) return;

        const mc = String(client.character.MasterClass || 1);
        if (!client.character.TalentTree) client.character.TalentTree = {};
        if (!client.character.TalentTree[mc]) client.character.TalentTree[mc] = {};

        const slots = new Array(27);
        
        for (let i = 0; i < 27; i++) {
            const hasNode = br.readMethod15(); // boolean
            const nodeIdExpected = TalentConfig.indexToNodeId(i);
            
            if (hasNode) {
                const nodeIdPacket = br.readMethod6(6); // class_118.const_127 = 6
                const bitWidth = TalentConfig.getSlotBitWidth(i);
                const pointsSpent = br.readMethod6(bitWidth) + 1;
                
                slots[i] = {
                    nodeID: nodeIdPacket,
                    points: pointsSpent,
                    filled: true
                };
            } else {
                slots[i] = {
                    nodeID: nodeIdExpected,
                    points: 0,
                    filled: false
                };
            }
        }

        // Actions
        while (br.readMethod15()) {
            const isSignet = br.readMethod15();
            if (isSignet) {
                 const nodeIndex = br.readMethod6(6);
                 const signetGroup = br.readMethod6(6);
                 const signetIndex = br.readMethod6(6) - 1;
                 // Store signet actions if needed? 
                 // Logic in python just parsed them.
                 // Maybe we need to apply them to 'slots'?
                 // Python: logic parses actions but doesn't seem to modify slots array defined earlier?
                 // Wait, python code:
                 // actions.append(...)
                 // then talent_tree["nodes"] = slots
                 // It ignores actions?
                 // Ah, maybe they are just validation or event logging? 
                 // Or maybe I missed where actions are used.
                 // For now I will parse and ignore like the python snippet seems to imply (it assigns slots to tree["nodes"]).
            } else {
                const nodeIndex = br.readMethod6(6);
                // Upgrade action
            }
        }

        client.character.TalentTree[mc].nodes = slots;
        await TalentHandler.saveCharacter(client);
    }

    static async handleTrainTalentPoint(client: Client, data: Buffer): Promise<void> {
        const br = new BitReader(data);
        const classIndex = br.readMethod20(2);
        const isInstant = br.readMethod15();

        if (!client.character) return;
        
        if (!client.character.talentPoints) client.character.talentPoints = {};
        const currentPoints = client.character.talentPoints[String(classIndex)] || 0;
        
        const durationIdx = currentPoints + 1;
        const duration = TalentConfig.RESEARCH_DURATIONS[durationIdx] || 0;
        const goldCost = TalentConfig.RESEARCH_COSTS[durationIdx] || 0;
        const idolCost = TalentConfig.IDOL_COST[durationIdx] || 0;
        
        if (isInstant) {
            if ((client.character.mammothIdols || 0) < idolCost) return;
            client.character.mammothIdols = (client.character.mammothIdols || 0) - idolCost;
            
            // Should send premium purchase?
            
            // Complete immediately
             if (!client.character.talentPoints) client.character.talentPoints = {};
             client.character.talentPoints[String(classIndex)] = currentPoints + 1;
             
             // Python calls _on_talent_done_for which likely sends 0xD5 packet
             await TalentHandler.saveCharacter(client);
             
             const bb = new BitBuffer();
             bb.writeMethod6(classIndex, 2);
             bb.writeMethod6(1, 1); // status 1
             client.sendBitBuffer(0xD5, bb);
             
            return;
        }
        
        if ((client.character.gold || 0) < goldCost) return;
        client.character.gold = (client.character.gold || 0) - goldCost;
        
        const now = Math.floor(Date.now() / 1000);
        const readyTime = now + duration;
        
        client.character.talentResearch = {
            classIndex: classIndex,
            ReadyTime: readyTime
        };
        
        await TalentHandler.saveCharacter(client);
    }
    
    static async handleTalentSpeedup(client: Client, data: Buffer): Promise<void> {
        const br = new BitReader(data);
        const idolCost = br.readMethod9();
        
        if (!client.character) return;
        const tr = client.character.talentResearch;
        if (!tr || tr.classIndex === undefined) return;
        
        if (idolCost > 0) {
             if ((client.character.mammothIdols || 0) < idolCost) return;
             client.character.mammothIdols = (client.character.mammothIdols || 0) - idolCost;
        }
        
        tr.ReadyTime = 0;
        await TalentHandler.saveCharacter(client);
        
        // Packet 0xD5 complete
        const bb = new BitBuffer();
        bb.writeMethod6(tr.classIndex, 2);
        bb.writeMethod6(1, 1);
        client.sendBitBuffer(0xD5, bb);
    }
    
    static async handleTalentClaim(client: Client, data: Buffer): Promise<void> {
        if (!client.character) return;
        const tr = client.character.talentResearch;
        if (!tr || tr.classIndex === undefined) return;
        
        const classIdx = tr.classIndex;
        if (!client.character.talentPoints) client.character.talentPoints = {};
        
        const current = client.character.talentPoints[String(classIdx)] || 0;
        client.character.talentPoints[String(classIdx)] = current + 1;
        
        client.character.talentResearch = {
            classIndex: null, // or undefined? Python uses None
            ReadyTime: 0
        };
        
        await TalentHandler.saveCharacter(client);
    }
    
    static async handleClearTalentResearch(client: Client, data: Buffer): Promise<void> {
        if (!client.character) return;
         client.character.talentResearch = {
            classIndex: null,
            ReadyTime: 0
        };
        await TalentHandler.saveCharacter(client);
    }
    
    static async handleActiveTalentChangeRequest(client: Client, data: Buffer): Promise<void> {
        const br = new BitReader(data);
        const entityId = br.readMethod4();
        const masterClassId = br.readMethod6(4); // Game.const_209 = 4
        
        if (!client.character) return;
        client.character.MasterClass = masterClassId;
        
        await TalentHandler.saveCharacter(client);
        
        const bb = new BitBuffer();
        bb.writeMethod4(entityId);
        bb.writeMethod6(masterClassId, 4);
        client.sendBitBuffer(0xC3, bb);
        
        // Send active tree data (0xC1)
        // Python: send_active_talent_tree_data
        
        const treePkt = new BitBuffer();
        treePkt.writeMethod4(entityId);
        
        const mc = String(masterClassId);
        const tree = (client.character.TalentTree && client.character.TalentTree[mc]) ? client.character.TalentTree[mc] : {};
        const nodes = tree.nodes || new Array(27).fill(null);
        
        for (let i = 0; i < 27; i++) {
            let slot = nodes[i];
            if (!slot) slot = { filled: false, points: 0, nodeID: i + 1 };
             
            if (slot.filled) {
                treePkt.writeMethod6(1, 1);
                treePkt.writeMethod6(slot.nodeID, 6);
                const width = TalentConfig.getSlotBitWidth(i);
                treePkt.writeMethod6(slot.points - 1, width);
            } else {
                treePkt.writeMethod6(0, 1);
            }
        }
        
        client.sendBitBuffer(0xC1, treePkt);
    }

    private static async saveCharacter(client: Client) {
        if (client.userId && client.character) {
             const chars = await db.loadCharacters(client.userId);
             const idx = chars.findIndex(c => c.name === client.character?.name);
             if (idx !== -1) {
                 chars[idx] = client.character;
                 await db.saveCharacters(client.userId, chars);
             }
        }
    }
}
