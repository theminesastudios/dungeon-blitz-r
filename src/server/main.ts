import './core/loadEnv';

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
import { TalentHandler } from './handlers/TalentHandler';
import { SigilHandler } from './handlers/SigilHandler';
import { GameData } from './core/GameData';
import { MissionLoader } from './data/MissionLoader';
import { MissionDialogueLoader } from './data/MissionDialogueLoader';
import { NpcDialogueLoader } from './data/NpcDialogueLoader';
import { DialogueTranslationLoader } from './data/DialogueTranslationLoader';
import { NpcLoader } from './data/NpcLoader';
import { CombatHandler } from './handlers/CombatHandler';
import { BuildingHandler } from './handlers/BuildingHandler';
import { SystemHandler } from './handlers/SystemHandler';
import { AILogic } from './core/AILogic';
import { MissionHandler } from './handlers/MissionHandler';
import { LockboxHandler } from './handlers/LockboxHandler';
import { NpcHandler } from './handlers/NpcHandler';
import { RewardHandler } from './handlers/RewardHandler';
import { LootDepthRewardHandler } from './handlers/LootDepthRewardHandler';
import { EquipmentHandler } from './handlers/EquipmentHandler';
import { GearSetHandler } from './handlers/GearSetHandler';
import { AbilityHandler } from './handlers/AbilityHandler';
import { DebugLogger } from './core/Debug';
import { GuildHandler } from './handlers/GuildHandler';
import { ForgeHandler } from './handlers/ForgeHandler';
import { PetHandler } from './handlers/PetHandler';
import { discordSocialBridge } from './integrations/DiscordSocialBridge';
import { ProjectInfo } from './core/ProjectInfo';
import * as path from 'path';

import { StaticServer } from './core/StaticServer';

type DungeonCompletionPatchTarget = {
    DUNGEONS_REQUIRING_BOSS_DEFEAT?: Set<string>;
    REQUIRED_DUNGEON_BOSS_NAMES_BY_LEVEL?: Record<string, ReadonlySet<string>>;
    DUNGEONS_WHERE_CLIENT_COMPLETION_RELEASES_POST_DEATH_CUTSCENE?: Set<string>;
};

function applyDungeonCompletionPatches(): void {
    const missionHandler = MissionHandler as unknown as DungeonCompletionPatchTarget;

    missionHandler.DUNGEONS_REQUIRING_BOSS_DEFEAT?.add('SRN_Mission3');
    missionHandler.DUNGEONS_REQUIRING_BOSS_DEFEAT?.add('SRN_Mission3Hard');
    missionHandler.DUNGEONS_REQUIRING_BOSS_DEFEAT?.add('GhostBossDungeon');
    missionHandler.DUNGEONS_REQUIRING_BOSS_DEFEAT?.add('GhostBossDungeonHard');

    missionHandler.DUNGEONS_WHERE_CLIENT_COMPLETION_RELEASES_POST_DEATH_CUTSCENE?.add('GhostBossDungeon');
    missionHandler.DUNGEONS_WHERE_CLIENT_COMPLETION_RELEASES_POST_DEATH_CUTSCENE?.add('GhostBossDungeonHard');

    const requiredBossNames = missionHandler.REQUIRED_DUNGEON_BOSS_NAMES_BY_LEVEL;
    if (!requiredBossNames) {
        return;
    }

    requiredBossNames.SRN_Mission3 = new Set(['YoungDragonGreen']);
    requiredBossNames.SRN_Mission3Hard = new Set(['YoungDragonGreenHard']);
    requiredBossNames.GhostBossDungeon = new Set(['NephitLargeEye']);
    requiredBossNames.GhostBossDungeonHard = new Set(['NephitLargeEyeHard']);
}

applyDungeonCompletionPatches();

// Load Config
const dataDir = path.join(Config.DATA_DIR, 'data');
LevelConfig.load(dataDir);
CharacterTemplates.load(dataDir);
PetConfig.load(dataDir);
GameData.load(dataDir);
MissionLoader.load(dataDir);
MissionDialogueLoader.load(dataDir);
NpcDialogueLoader.load(dataDir);
DialogueTranslationLoader.load(dataDir);
NpcLoader.load(dataDir);
console.log(`[Startup] ${ProjectInfo.name} v${ProjectInfo.version}`);
DebugLogger.logStartup();
discordSocialBridge.initialize();

// Initialize Router
const router = new PacketRouter();

// Register Handlers
router.register(0x11, LoginHandler.handleLoginVersion);
router.register(0x13, LoginHandler.handleLoginCreate);
router.register(0x14, LoginHandler.handleLoginAuthenticate);
router.register(0x16, CharacterHandler.handleCharacterSelect);
router.register(0x17, CharacterHandler.handleLoginCharacterCreate);
router.register(0x19, CharacterHandler.handlePaperDollRequest);
router.register(0x1f, CharacterHandler.handleGameServerLogin);
router.register(0x8E, CharacterHandler.handleHomeLookChange);
router.register(0xF4, CharacterHandler.handleRequestArmoryGears);
router.register(0xBA, CharacterHandler.handleApplyDyes);

router.register(0x8, EntityHandler.handleEntityFullUpdate);
router.register(0xA2, CommandHandler.handleLinkUpdater);
router.register(0x10D, CommandHandler.handleActivatePotion);
router.register(0x10E, CommandHandler.handleQueuePotion);
router.register(0x113, CommandHandler.handleUpdateAlertState);
router.register(0xBC, CommandHandler.handleKeyBindingSave);
router.register(0xBB, CommandHandler.handleHpIncreaseNotice);
router.register(0xFC, CommandHandler.handleSendCombatStats);
router.register(0x2A, LootDepthRewardHandler.handleGrantReward);
router.register(0x38, RewardHandler.handlePickupLootdrop);
router.register(0x30, EquipmentHandler.handleUpdateEquipment);
router.register(0x31, EquipmentHandler.handleUpdateSingleGear);
router.register(0xB0, EquipmentHandler.handleSocketCharm);
router.register(0xC6, GearSetHandler.handleOverwriteGearSet);
router.register(0xC7, GearSetHandler.handleCreateGearSet);
router.register(0xC8, GearSetHandler.handleRenameGearSet);
router.register(0x105, LockboxHandler.handleBuyLockboxKeys);
router.register(0x107, LockboxHandler.handleLockboxReward);
router.register(0x114, LockboxHandler.handleBuyTreasureTrove);
router.register(0xBD, AbilityHandler.handleActiveAbilitiesUpdate);
router.register(0xBE, AbilityHandler.handleStartAbilityResearch);
router.register(0x41, LevelHandler.handleRequestDoorState);
router.register(0x3F, MissionHandler.handleSetLevelComplete);
router.register(0x8D, MissionHandler.handleBadgeRequest);
router.register(0xB7, LevelHandler.handleQuestProgressUpdate);
router.register(0xA5, LevelHandler.handleRoomEventStart);
router.register(0xA6, LevelHandler.handleRoomClose);
router.register(0xA8, LevelHandler.handlePlaySound);
router.register(0xA9, LevelHandler.handleRoomStateUpdate);
router.register(0xAA, LevelHandler.handleActionUpdate);
router.register(0xAB, LevelHandler.handleRoomInfoUpdate);
router.register(0xAC, LevelHandler.handleRoomBossInfo);
router.register(0xAD, LevelHandler.handleRoomUnlock);
router.register(0xAE, LevelHandler.handleSetUntargetable);
router.register(0x95, SocialHandler.handleZonePanelRequest);
router.register(0x2C, SocialHandler.handlePublicChat);
router.register(0x46, SocialHandler.handlePrivateMessage);
router.register(0x40, SocialHandler.handleLevelState);
router.register(0x76, SocialHandler.handleRoomThought);
router.register(0x8A, LevelHandler.handleChangeMaxSpeed);
router.register(0x7D, LevelHandler.handleChangeOffsetY);
router.register(0x7E, SocialHandler.handleEmoteBegin);
router.register(0x7F, SocialHandler.handleEmoteEnd);
router.register(0x7A, NpcHandler.handleTalkToNpc);
router.register(0xA7, SocialHandler.handleEmote);
router.register(0xC5, SocialHandler.handleStartSkit);
router.register(0x65, SocialHandler.handleGroupInvite);
router.register(0x59, SocialHandler.handleQueryMessageAnswer);
router.register(0x8B, SocialHandler.handleMapLocationUpdate);
router.register(0x67, SocialHandler.handleGroupKick);
router.register(0x66, SocialHandler.handleGroupLeave);
router.register(0x68, SocialHandler.handleGroupLeader);
router.register(0x69, SocialHandler.handleGroupLock);
router.register(0x6A, SocialHandler.handleJoinPartyRequest);
router.register(0x63, SocialHandler.handleSendGroupChat);
router.register(0x6B, SocialHandler.handleTeleportToPlayer);
router.register(0x90, SocialHandler.handleFriendRequest);
router.register(0x91, SocialHandler.handleUnfriend);
router.register(0x43, SocialHandler.handleToggleIgnore);
router.register(0x9E, SocialHandler.handleRequestIgnoreList);
router.register(0xC9, SocialHandler.handleRequestFriendList);
router.register(0x4D, GuildHandler.handleCreateGuild);
router.register(0x4E, GuildHandler.handleDisbandGuild);
router.register(0x4F, GuildHandler.handleInviteGuildMember);
router.register(0x50, GuildHandler.handleKickGuildMember);
router.register(0x51, GuildHandler.handlePromoteGuildMember);
router.register(0x52, GuildHandler.handleDemoteGuildMember);
router.register(0x53, GuildHandler.handleTransferGuildLeadership);
router.register(0x54, GuildHandler.handleQuitGuild);
router.register(0x5F, GuildHandler.handleGuildChat);
router.register(0x61, GuildHandler.handleOfficerChat);

router.register(0xF3, SocialHandler.handleRequestVisitPlayerHouse);
router.register(0x2D, LevelHandler.handleOpenDoor);
router.register(0x1D, LevelHandler.handleLevelTransferRequest);
router.register(0x07, LevelHandler.handleEntityIncrementalUpdate);

router.register(0x110, ForgeHandler.handleUseForgeConsumable);
router.register(0xB1, ForgeHandler.handleStartForge);
router.register(0xE2, ForgeHandler.handleForgeSpeedUpPacket);
router.register(0xD0, ForgeHandler.handleCollectForgeCharm);
router.register(0xE1, ForgeHandler.handleCancelForge);
router.register(0xD3, ForgeHandler.handleAllocateMagicForgeArtisanSkillPoints);
router.register(0xCF, ForgeHandler.handleMagicForgeReroll);

router.register(0x9, CombatHandler.handlePowerCast);
router.register(0x0A, CombatHandler.handlePowerHit);
router.register(0x0E, CombatHandler.handleProjectileExplode);
router.register(0x0D, CombatHandler.handleEntityDestroy);
router.register(0x77, CombatHandler.handleRequestRespawn);
router.register(0x82, CombatHandler.handleRespawnBroadcast);
router.register(0x78, CombatHandler.handleCharRegen);
router.register(0x79, CombatHandler.handleBuffTickDot);
router.register(0x0B, CombatHandler.handleAddBuff);
router.register(0x0C, CombatHandler.handleRemoveBuff);

router.register(0xD7, BuildingHandler.handleBuildingUpgrade);
router.register(0xD9, BuildingHandler.handleBuildingClaim);
router.register(0xDB, BuildingHandler.handleBuildingCancel);
router.register(0xDC, BuildingHandler.handleBuildingSpeedUpRequest);

router.register(0x7C, SystemHandler.handleClientCrashReport);

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

router.register(0xB2, PetHandler.handleMountEquipPacket);
router.register(0xB3, PetHandler.handleEquipPets);
router.register(0xE4, PetHandler.handleRequestHatcheryEggs);
router.register(0xE6, PetHandler.handleEggHatch);
router.register(0xE8, PetHandler.handleCancelEggHatch);
router.register(0xE9, PetHandler.handleEggSpeedUp);
router.register(0xEA, PetHandler.handleCollectHatchedEgg);
router.register(0xEC, PetHandler.handleTrainPet);
router.register(0xED, PetHandler.handlePetTrainingCancel);
router.register(0xEF, PetHandler.handlePetTrainingCollect);
router.register(0xF0, PetHandler.handlePetSpeedUp);

router.register(0x106, SigilHandler.handleRoyalSigilStorePurchase);

let policyServer: PolicyServer | null = null;
if (Config.ENABLE_POLICY_SERVER) {
    policyServer = new PolicyServer(Config.POLICY_PORT, Config.BIND_HOST);
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
