import { GameServer } from './core/server';
import { PolicyServer } from './network/policyServer';
import { Config } from './core/config';
import { PacketRouter } from './network/packetRouter';
import { LoginHandler } from './handlers/LoginHandler';
import { CharacterHandler } from './handlers/CharacterHandler';
import { EntityHandler } from './handlers/EntityHandler';
import { CommandHandler } from './handlers/CommandHandler';
import { LevelHandler } from './handlers/LevelHandler';
import { SocialHandler } from './handlers/SocialHandler';
import { LevelConfig } from './core/LevelConfig';
import { CharacterTemplates } from './core/CharacterTemplates';
import { PetConfig } from './core/PetConfig';
import { PetHandler } from './handlers/PetHandler';
import { TalentHandler } from './handlers/TalentHandler';
import { SigilHandler } from './handlers/SigilHandler';
import { GameData } from './core/GameData';
import { MissionLoader } from './data/MissionLoader';
import { NpcLoader } from './data/NpcLoader';
import { CombatHandler } from './handlers/CombatHandler';
import { BuildingHandler } from './handlers/BuildingHandler';
import { SystemHandler } from './handlers/SystemHandler';
import { AILogic } from './core/AILogic';
import { MissionHandler } from './handlers/MissionHandler';
import { NpcHandler } from './handlers/NpcHandler';
import { RewardHandler } from './handlers/RewardHandler';
import { EquipmentHandler } from './handlers/EquipmentHandler';
import { AbilityHandler } from './handlers/AbilityHandler';
import { DebugLogger } from './core/Debug';
import * as path from 'path';

import { StaticServer } from './core/StaticServer';

// Load Config
const dataDir = path.join(Config.DATA_DIR, 'data');
LevelConfig.load(dataDir);
CharacterTemplates.load(dataDir);
PetConfig.load(dataDir);
GameData.load(dataDir);
MissionLoader.load(dataDir);
NpcLoader.load(dataDir);
DebugLogger.logStartup();

// Initialize Router
const router = new PacketRouter();

// Register Handlers
router.register(0x11, LoginHandler.handleLoginVersion);       // Version
router.register(0x13, LoginHandler.handleLoginCreate);        // Create Account
router.register(0x14, LoginHandler.handleLoginAuthenticate);  // Login
router.register(0x16, CharacterHandler.handleCharacterSelect); // Select Character
router.register(0x17, CharacterHandler.handleLoginCharacterCreate); // Create Character
router.register(0x19, CharacterHandler.handlePaperDollRequest); // Paper Doll Request
router.register(0x1f, CharacterHandler.handleGameServerLogin); // Game Server Login

// Missing Packets
router.register(0x8, EntityHandler.handleEntityFullUpdate); // Entity Full Update
router.register(0xA2, CommandHandler.handleLinkUpdater); // Link Updater
router.register(0x10E, CommandHandler.handleQueuePotion); // Queue Potion
router.register(0x2A, RewardHandler.handleGrantReward); // Grant Reward
router.register(0x38, RewardHandler.handlePickupLootdrop); // Pickup Lootdrop
router.register(0x30, EquipmentHandler.handleUpdateEquipment); // Update Equipment
router.register(0x31, EquipmentHandler.handleUpdateSingleGear); // Update Single Gear
router.register(0xBD, AbilityHandler.handleActiveAbilitiesUpdate); // Active Ability Loadout
router.register(0xBE, AbilityHandler.handleStartAbilityResearch); // Start Ability Research
router.register(0x41, LevelHandler.handleRequestDoorState); // Request Door State
router.register(0x3F, MissionHandler.handleSetLevelComplete); // Level Complete
router.register(0x8D, MissionHandler.handleBadgeRequest); // Badge / Achievement
router.register(0xB7, LevelHandler.handleQuestProgressUpdate); // Quest Progress Update
router.register(0xA5, LevelHandler.handleRoomEventStart); // Room Event Start
router.register(0xA6, LevelHandler.handleRoomClose); // Room Close
router.register(0xA8, LevelHandler.handlePlaySound); // Play Sound
router.register(0xA9, LevelHandler.handleRoomStateUpdate); // Room State Update
router.register(0xAA, LevelHandler.handleActionUpdate); // Action Update
router.register(0xAB, LevelHandler.handleRoomInfoUpdate); // Room Info Update
router.register(0xAC, LevelHandler.handleRoomBossInfo); // Room Boss Info
router.register(0xAD, LevelHandler.handleRoomUnlock); // Room Unlock
router.register(0xAE, LevelHandler.handleSetUntargetable); // Set Untargetable
router.register(0x95, SocialHandler.handleZonePanelRequest); // Zone Panel Request
router.register(0x2C, SocialHandler.handlePublicChat); // Public Chat
router.register(0x46, SocialHandler.handlePrivateMessage); // Private Message
router.register(0x40, SocialHandler.handleLevelState); // Level State
router.register(0x76, SocialHandler.handleRoomThought); // Room Thought
router.register(0x8A, LevelHandler.handleChangeMaxSpeed); // Change Max Speed
router.register(0x7D, LevelHandler.handleChangeOffsetY); // Change Offset Y
router.register(0x7E, SocialHandler.handleEmoteBegin); // Emote Begin
router.register(0x7F, SocialHandler.handleEmoteEnd); // Emote End
router.register(0x7A, NpcHandler.handleTalkToNpc); // Talk To NPC
router.register(0xA7, SocialHandler.handleEmote); // Emote
router.register(0xC5, SocialHandler.handleStartSkit); // Start Skit
router.register(0x65, SocialHandler.handleGroupInvite); // Group Invite
router.register(0x59, SocialHandler.handleQueryMessageAnswer); // Query Message Answer
router.register(0x8B, SocialHandler.handleMapLocationUpdate); // Group Map Position
router.register(0x67, SocialHandler.handleGroupKick); // Group Kick
router.register(0x66, SocialHandler.handleGroupLeave); // Group Leave
router.register(0x68, SocialHandler.handleGroupLeader); // Group Leader
router.register(0x69, SocialHandler.handleGroupLock); // Group Lock
router.register(0x6A, SocialHandler.handleJoinPartyRequest); // Join Party
router.register(0x63, SocialHandler.handleSendGroupChat); // Group Chat
router.register(0x6B, SocialHandler.handleTeleportToPlayer); // Teleport To Party Member
router.register(0x90, SocialHandler.handleFriendRequest); // Friend Request / Accept
router.register(0x91, SocialHandler.handleUnfriend); // Unfriend / Decline
router.register(0xC9, SocialHandler.handleRequestFriendList); // Friend List Request

router.register(0xF3, SocialHandler.handleRequestVisitPlayerHouse); // Visit House
router.register(0x2D, LevelHandler.handleOpenDoor); // Open Door
router.register(0x1D, LevelHandler.handleLevelTransferRequest); // Level Transfer
router.register(0x07, LevelHandler.handleEntityIncrementalUpdate); // Movement Update

// Pet Packets
router.register(0xB3, PetHandler.handleEquipPets);
router.register(0xB2, PetHandler.handleMountEquipPacket);
router.register(0xE4, PetHandler.handleRequestHatcheryEggs);
router.register(0xEC, PetHandler.handleTrainPet);
router.register(0xEF, PetHandler.handlePetTrainingCollect);
router.register(0xED, PetHandler.handlePetTrainingCancel);
router.register(0xF0, PetHandler.handlePetSpeedUp);
router.register(0xE6, PetHandler.handleEggHatch);
router.register(0xE9, PetHandler.handleEggSpeedUp);
router.register(0xEA, PetHandler.handleCollectHatchedEgg);
router.register(0xE8, PetHandler.handleCancelEggHatch);

// Combat
router.register(0x9, CombatHandler.handlePowerCast);
router.register(0x0A, CombatHandler.handlePowerHit);
router.register(0x0E, CombatHandler.handleProjectileExplode);
router.register(0x0D, CombatHandler.handleEntityDestroy);
router.register(0x77, CombatHandler.handleRequestRespawn);
router.register(0x82, CombatHandler.handleRespawnBroadcast);
router.register(0x79, CombatHandler.handleBuffTickDot);
router.register(0x0B, CombatHandler.handleAddBuff);
router.register(0x0C, CombatHandler.handleRemoveBuff);

// Buildings
router.register(0xD7, BuildingHandler.handleBuildingUpgrade);
router.register(0xD9, BuildingHandler.handleBuildingClaim);
router.register(0xDC, BuildingHandler.handleBuildingSpeedUpRequest);

// System
router.register(0x7C, SystemHandler.handleClientCrashReport);

// Talent Packets
router.register(0xD2, TalentHandler.handleRespecTalentTree);
router.register(0xD1, AbilityHandler.handleClaimAbilityResearch);
router.register(0xC0, TalentHandler.handleAllocateTalentTreePoints);
router.register(0xD4, TalentHandler.handleTrainTalentPoint);
router.register(0xE0, TalentHandler.handleTalentSpeedup);
router.register(0xD6, TalentHandler.handleTalentClaim);
router.register(0xC3, TalentHandler.handleActiveTalentChangeRequest);
router.register(0xDD, AbilityHandler.handleClearAbilityResearch);
router.register(0xDE, AbilityHandler.handleSpeedupAbilityResearch);
router.register(0xDF, TalentHandler.handleClearTalentResearch);

// Sigil Packets
router.register(0x106, SigilHandler.handleRoyalSigilStorePurchase);

// Start Servers
if (Config.ENABLE_POLICY_SERVER) {
    const policyServer = new PolicyServer(Config.POLICY_PORT, Config.BIND_HOST);
    policyServer.start();
} else {
    console.log(
        `[Policy] Dedicated policy server disabled; serving socket policy inline on ${Config.BIND_HOST}:${Config.PORTS[0]}`
    );
}

const staticServer = new StaticServer(Config.STATIC_PORT, '../client/content/localhost', Config.BIND_HOST);
staticServer.start();


const gameServer = new GameServer(Config.PORTS[0], router, Config.BIND_HOST);
AILogic.start();
gameServer.start();
