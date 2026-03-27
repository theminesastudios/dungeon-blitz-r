package
{
   import adobe.utils.*;
   import flash.accessibility.*;
   import flash.desktop.*;
   import flash.display.*;
   import flash.errors.*;
   import flash.events.*;
   import flash.external.*;
   import flash.filters.*;
   import flash.geom.*;
   import flash.globalization.*;
   import flash.media.*;
   import flash.net.*;
   import flash.net.drm.*;
   import flash.printing.*;
   import flash.profiler.*;
   import flash.sampler.*;
   import flash.sensors.*;
   import flash.system.*;
   import flash.text.*;
   import flash.text.engine.*;
   import flash.text.ime.*;
   import flash.ui.*;
   import flash.utils.*;
   import flash.xml.*;
   
   [Embed(source="/_assets/assets.swf", symbol="symbol493")]
   public dynamic class a_Room_SD12 extends MovieClip
   {
      
      public var __id728_:ac_NPCGoblinNomad04;
      
      public var am_CollisionObject:MovieClip;
      
      public var __id723_:ac_NPCGoblinNomad03;
      
      public var __id726_:ac_NPCGoblinNomad05;
      
      public var __id727_:ac_NPCGoblinNomad01;
      
      public var am_Background_1:MovieClip;
      
      public var __id724_:ac_NPCGoblinNomad06;
      
      public var __id725_:ac_NPCGoblinNomad02;
      
      public var am_Background:a_Animation_EB_SandDrift;
      
      public var am_Foreground:MovieClip;
      
      public function a_Room_SD12()
      {
         super();
         this.__setProp___id723__a_Room_SD12_cues_0();
         this.__setProp___id724__a_Room_SD12_cues_0();
         this.__setProp___id725__a_Room_SD12_cues_0();
         this.__setProp___id726__a_Room_SD12_cues_0();
         this.__setProp___id727__a_Room_SD12_cues_0();
         this.__setProp___id728__a_Room_SD12_cues_0();
      }
      
      internal function __setProp___id723__a_Room_SD12_cues_0() : *
      {
         try
         {
            this.__id723_["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.__id723_.characterName = "SD_Chief01";
         this.__id723_.displayName = "";
         this.__id723_.dramaAnim = "";
         this.__id723_.itemDrop = "";
         this.__id723_.sayOnActivate = "";
         this.__id723_.sayOnAlert = "";
         this.__id723_.sayOnBloodied = "";
         this.__id723_.sayOnDeath = "";
         this.__id723_.sayOnInteract = "";
         this.__id723_.sayOnSpawn = "";
         this.__id723_.sleepAnim = "";
         this.__id723_.team = "neutral";
         this.__id723_.waitToAggro = 0;
         try
         {
            this.__id723_["componentInspectorSetting"] = false;
         }
         catch(e:Error)
         {
         }
      }
      
      internal function __setProp___id724__a_Room_SD12_cues_0() : *
      {
         try
         {
            this.__id724_["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.__id724_.characterName = "NPCGoblinNomad06";
         this.__id724_.displayName = "Gettika Wanoo";
         this.__id724_.dramaAnim = "";
         this.__id724_.itemDrop = "";
         this.__id724_.sayOnActivate = "";
         this.__id724_.sayOnAlert = "";
         this.__id724_.sayOnBloodied = "";
         this.__id724_.sayOnDeath = "";
         this.__id724_.sayOnInteract = "The Seelie don\'t seem interested in trade.=They seem interested in bossing us around.";
         this.__id724_.sayOnSpawn = "";
         this.__id724_.sleepAnim = "";
         this.__id724_.team = "neutral";
         this.__id724_.waitToAggro = 0;
         try
         {
            this.__id724_["componentInspectorSetting"] = false;
         }
         catch(e:Error)
         {
         }
      }
      
      internal function __setProp___id725__a_Room_SD12_cues_0() : *
      {
         try
         {
            this.__id725_["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.__id725_.characterName = "NPCGoblinNomad02";
         this.__id725_.displayName = "Givitz";
         this.__id725_.dramaAnim = "";
         this.__id725_.itemDrop = "";
         this.__id725_.sayOnActivate = "";
         this.__id725_.sayOnAlert = "";
         this.__id725_.sayOnBloodied = "";
         this.__id725_.sayOnDeath = "";
         this.__id725_.sayOnInteract = "The dragons are gone...=Maybe someone will do the same for the Emperor.";
         this.__id725_.sayOnSpawn = "";
         this.__id725_.sleepAnim = "";
         this.__id725_.team = "neutral";
         this.__id725_.waitToAggro = 0;
         try
         {
            this.__id725_["componentInspectorSetting"] = false;
         }
         catch(e:Error)
         {
         }
      }
      
      internal function __setProp___id726__a_Room_SD12_cues_0() : *
      {
         try
         {
            this.__id726_["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.__id726_.characterName = "NPCGoblinNomad05";
         this.__id726_.displayName = "Koku";
         this.__id726_.dramaAnim = "";
         this.__id726_.itemDrop = "";
         this.__id726_.sayOnActivate = "";
         this.__id726_.sayOnAlert = "";
         this.__id726_.sayOnBloodied = "";
         this.__id726_.sayOnDeath = "";
         this.__id726_.sayOnInteract = "...";
         this.__id726_.sayOnSpawn = "";
         this.__id726_.sleepAnim = "";
         this.__id726_.team = "neutral";
         this.__id726_.waitToAggro = 0;
         try
         {
            this.__id726_["componentInspectorSetting"] = false;
         }
         catch(e:Error)
         {
         }
      }
      
      internal function __setProp___id727__a_Room_SD12_cues_0() : *
      {
         try
         {
            this.__id727_["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.__id727_.characterName = "SD_Nomad01";
         this.__id727_.displayName = "";
         this.__id727_.dramaAnim = "";
         this.__id727_.itemDrop = "";
         this.__id727_.sayOnActivate = "";
         this.__id727_.sayOnAlert = "";
         this.__id727_.sayOnBloodied = "";
         this.__id727_.sayOnDeath = "";
         this.__id727_.sayOnInteract = "";
         this.__id727_.sayOnSpawn = "";
         this.__id727_.sleepAnim = "";
         this.__id727_.team = "neutral";
         this.__id727_.waitToAggro = 0;
         try
         {
            this.__id727_["componentInspectorSetting"] = false;
         }
         catch(e:Error)
         {
         }
      }
      
      internal function __setProp___id728__a_Room_SD12_cues_0() : *
      {
         try
         {
            this.__id728_["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.__id728_.characterName = "NPCGoblinNomad04";
         this.__id728_.displayName = "Yaku";
         this.__id728_.dramaAnim = "";
         this.__id728_.itemDrop = "";
         this.__id728_.sayOnActivate = "";
         this.__id728_.sayOnAlert = "";
         this.__id728_.sayOnBloodied = "";
         this.__id728_.sayOnDeath = "";
         this.__id728_.sayOnInteract = "Hello friend!=A warm goblin welcome to you!=Would you like some water?=Perhaps some fresh dates?";
         this.__id728_.sayOnSpawn = "";
         this.__id728_.sleepAnim = "";
         this.__id728_.team = "neutral";
         this.__id728_.waitToAggro = 0;
         try
         {
            this.__id728_["componentInspectorSetting"] = false;
         }
         catch(e:Error)
         {
         }
      }
   }
}

