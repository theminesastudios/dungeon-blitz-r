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

// Initialize Router
const router = new PacketRouter();

// Register Handlers
router.register(0x11, LoginHandler.handleLoginVersion);       // Version
router.register(0x13, LoginHandler.handleLoginCreate);        // Create Account
router.register(0x14, LoginHandler.handleLoginAuthenticate);  // Login
router.register(0x16, CharacterHandler.handleCharacterSelect); // Select Character
router.register(0x17, CharacterHandler.handleLoginCharacterCreate); // Create Character
router.register(0x1f, CharacterHandler.handleGameServerLogin); // Game Server Login

// Missing Packets
router.register(0x8, EntityHandler.handleEntityFullUpdate); // Entity Full Update
router.register(0xA2, CommandHandler.handleLinkUpdater); // Link Updater
router.register(0x41, LevelHandler.handleRequestDoorState); // Request Door State

router.register(0xF3, SocialHandler.handleRequestVisitPlayerHouse); // Visit House
router.register(0x2D, LevelHandler.handleOpenDoor); // Open Door
router.register(0x1D, LevelHandler.handleLevelTransferRequest); // Level Transfer
router.register(0x07, LevelHandler.handleEntityIncrementalUpdate); // Movement Update

// Pet Packets
router.register(0xB3, PetHandler.handleEquipPets);
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
router.register(0xDC, BuildingHandler.handleBuildingSpeedUpRequest);

// System
router.register(0x7C, SystemHandler.handleClientCrashReport);

// Talent Packets
router.register(0xD2, TalentHandler.handleRespecTalentTree);
router.register(0xC0, TalentHandler.handleAllocateTalentTreePoints);
router.register(0xD4, TalentHandler.handleTrainTalentPoint);
router.register(0xE0, TalentHandler.handleTalentSpeedup);
router.register(0xD6, TalentHandler.handleTalentClaim);
router.register(0xC3, TalentHandler.handleActiveTalentChangeRequest);
router.register(0xDF, TalentHandler.handleClearTalentResearch);

// Sigil Packets
router.register(0x106, SigilHandler.handleRoyalSigilStorePurchase);

// Start Servers
const policyServer = new PolicyServer(Config.POLICY_PORT);
policyServer.start();

const staticServer = new StaticServer(80, '../../client/content/localhost');
staticServer.start();


const gameServer = new GameServer(Config.PORTS[0], router);
AILogic.start();
gameServer.start();

