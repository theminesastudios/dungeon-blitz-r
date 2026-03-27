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
   
   [Embed(source="/_assets/assets.swf", symbol="symbol1034")]
   public dynamic class a_Room_SDMission5_07 extends MovieClip
   {
      
      public var am_CollisionObject:MovieClip;
      
      public var __id476_:ac_OasisWarlock;
      
      public var __id475_:ac_TreasureChestMedium;
      
      public var am_Chest:ac_TreasureChestLarge;
      
      public var am_Worm1:ac_SandWorm;
      
      public var am_Foreground:MovieClip;
      
      public var am_Background:MovieClip;
      
      public var Script_IntroWorm:Array;
      
      public var Script_CameraShake:Array;
      
      public function a_Room_SDMission5_07()
      {
         super();
         addFrameScript(0,this.frame1);
         this.__setProp_am_Chest_a_Room_SDMission5_07_cues_0();
         this.__setProp___id475__a_Room_SDMission5_07_cues_0();
         this.__setProp___id476__a_Room_SDMission5_07_cues_0();
      }
      
      public function InitRoom(param1:a_GameHook) : void
      {
         this.am_Worm1.bHoldSpawn = true;
         param1.initialPhase = this.Update;
      }
      
      public function Update(param1:a_GameHook) : void
      {
         if(this.am_Chest.OnDefeat())
         {
            this.am_Worm1.Spawn();
            this.am_Worm1.DeepSleep();
            this.am_Worm1.Skit("<Emerge>");
            param1.PlayScript(this.Script_IntroWorm);
         }
         if(param1.OnScriptFinish(this.Script_IntroWorm))
         {
            this.am_Worm1.Skit("<Spew>");
            param1.PlayScript(this.Script_CameraShake);
         }
         if(param1.OnScriptFinish(this.Script_CameraShake))
         {
            this.am_Worm1.Aggro();
            param1.SetPhase(null);
         }
      }
      
      internal function __setProp_am_Chest_a_Room_SDMission5_07_cues_0() : *
      {
         try
         {
            this.am_Chest["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.am_Chest.characterName = "";
         this.am_Chest.displayName = "";
         this.am_Chest.dramaAnim = "";
         this.am_Chest.itemDrop = "Gold_3";
         this.am_Chest.sayOnActivate = "";
         this.am_Chest.sayOnAlert = "";
         this.am_Chest.sayOnBloodied = "";
         this.am_Chest.sayOnDeath = "";
         this.am_Chest.sayOnInteract = "";
         this.am_Chest.sayOnSpawn = "";
         this.am_Chest.sleepAnim = "";
         this.am_Chest.team = "default";
         this.am_Chest.waitToAggro = 0;
         try
         {
            this.am_Chest["componentInspectorSetting"] = false;
         }
         catch(e:Error)
         {
         }
      }
      
      internal function __setProp___id475__a_Room_SDMission5_07_cues_0() : *
      {
         try
         {
            this.__id475_["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.__id475_.characterName = "";
         this.__id475_.displayName = "";
         this.__id475_.dramaAnim = "";
         this.__id475_.itemDrop = "Gold_1";
         this.__id475_.sayOnActivate = "";
         this.__id475_.sayOnAlert = "";
         this.__id475_.sayOnBloodied = "";
         this.__id475_.sayOnDeath = "";
         this.__id475_.sayOnInteract = "";
         this.__id475_.sayOnSpawn = "";
         this.__id475_.sleepAnim = "";
         this.__id475_.team = "default";
         this.__id475_.waitToAggro = 0;
         try
         {
            this.__id475_["componentInspectorSetting"] = false;
         }
         catch(e:Error)
         {
         }
      }
      
      internal function __setProp___id476__a_Room_SDMission5_07_cues_0() : *
      {
         try
         {
            this.__id476_["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.__id476_.characterName = "";
         this.__id476_.displayName = "";
         this.__id476_.dramaAnim = "";
         this.__id476_.itemDrop = "";
         this.__id476_.sayOnActivate = "Timid little thing, you have lost your way.";
         this.__id476_.sayOnAlert = "";
         this.__id476_.sayOnBloodied = "The Seelie rise like a desert wind.";
         this.__id476_.sayOnDeath = "Aaaaa...no...";
         this.__id476_.sayOnInteract = "";
         this.__id476_.sayOnSpawn = "";
         this.__id476_.sleepAnim = "";
         this.__id476_.team = "default";
         this.__id476_.waitToAggro = 0;
         try
         {
            this.__id476_["componentInspectorSetting"] = false;
         }
         catch(e:Error)
         {
         }
      }
      
      internal function frame1() : *
      {
         this.Script_IntroWorm = ["3 End"];
         this.Script_CameraShake = ["1 Shake 35","2 End"];
      }
   }
}

