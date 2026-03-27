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
   
   [Embed(source="/_assets/assets.swf", symbol="symbol1237")]
   public dynamic class a_Room_GoblinBeachHard_07 extends MovieClip
   {
      
      public var am_Mob1:ac_PsychophageBaby;
      
      public var am_Mob2:ac_PsychophageBaby;
      
      public var am_Goblin2:ac_GoblinBrute;
      
      public var am_Mob3:ac_PsychophageBaby;
      
      public var am_CollisionObject:MovieClip;
      
      public var __id290_:ac_GoblinHatchet;
      
      public var am_Goblin3:ac_GoblinShamanHood;
      
      public var am_Mob4:ac_PsychophageBaby;
      
      public var am_Mob5:ac_PsychophageBaby;
      
      public var am_Foreground_C:MovieClip;
      
      public var am_Mob6:ac_PsychophageBaby;
      
      public var am_Foreground_B:MovieClip;
      
      public var am_Mob7:ac_PsychophageBaby;
      
      public var am_Foreground_A:MovieClip;
      
      public var __id287_:ac_TreasureChestEmpty;
      
      public var am_Mob8:ac_PsychophageBaby;
      
      public var am_Mob9:ac_PsychophageBaby;
      
      public var am_Foreground_D:MovieClip;
      
      public var am_Foreground:MovieClip;
      
      public var bWave1:Boolean;
      
      public var bWave2:Boolean;
      
      public var bWave3:Boolean;
      
      public function a_Room_GoblinBeachHard_07()
      {
         super();
         addFrameScript(0,this.frame1);
         this.__setProp___id287__a_Room_GoblinBeachHard_07_cues_0();
         this.__setProp___id290__a_Room_GoblinBeachHard_07_collisions_0();
         this.__setProp_am_Goblin3_a_Room_GoblinBeachHard_07_collisions_0();
      }
      
      public function InitRoom(param1:a_GameHook) : void
      {
         this.am_Mob1.bHoldSpawn = true;
         this.am_Mob2.bHoldSpawn = true;
         this.am_Mob3.bHoldSpawn = true;
         this.am_Mob4.bHoldSpawn = true;
         this.am_Mob5.bHoldSpawn = true;
         this.am_Mob6.bHoldSpawn = true;
         this.am_Mob7.bHoldSpawn = true;
         this.am_Mob8.bHoldSpawn = true;
         this.am_Mob9.bHoldSpawn = true;
         param1.initialPhase = this.UpdateSpawnWave;
      }
      
      public function UpdateSpawnWave(param1:a_GameHook) : void
      {
         if(param1.OnTrigger("am_Trigger_1"))
         {
            this.am_Mob1.Spawn();
            this.am_Mob1.DeepSleep();
            this.am_Mob1.Skit("<Goto Red 1>");
            this.am_Mob2.Spawn();
            this.am_Mob2.DeepSleep();
            this.am_Mob2.Skit("<Goto Red 2>");
            this.am_Mob3.Spawn();
            this.am_Mob3.DeepSleep();
            this.am_Mob3.Skit("<Goto Red 3>");
            this.bWave1 = true;
            param1.SetPhase(this.UpdateWaveOnePosition);
            return;
         }
         if(param1.OnTrigger("am_Trigger_2"))
         {
            this.am_Mob4.Spawn();
            this.am_Mob4.DeepSleep();
            this.am_Mob4.Skit("<Goto Red 4>");
            this.am_Mob5.Spawn();
            this.am_Mob5.DeepSleep();
            this.am_Mob5.Skit("<Goto Red 5>");
            this.am_Mob6.Spawn();
            this.am_Mob6.DeepSleep();
            this.am_Mob6.Skit("<Goto Red 6>");
            this.bWave2 = true;
            param1.SetPhase(this.UpdateWaveTwoPosition);
            return;
         }
         if(param1.OnTrigger("am_Trigger_3"))
         {
            this.am_Mob7.Spawn();
            this.am_Mob7.DeepSleep();
            this.am_Mob7.Skit("<Goto Red 7>");
            this.am_Mob8.Spawn();
            this.am_Mob8.DeepSleep();
            this.am_Mob8.Skit("<Goto Red 8>");
            this.am_Mob9.Spawn();
            this.am_Mob9.DeepSleep();
            this.am_Mob9.Skit("<Goto Red 9>");
            this.bWave3 = true;
            param1.SetPhase(this.UpdateWaveThreePosition);
            return;
         }
         if(this.bWave1 && this.bWave2 && this.bWave3)
         {
            param1.SetPhase(null);
         }
      }
      
      public function UpdateWaveOnePosition(param1:a_GameHook) : void
      {
         if(param1.AtTime(2000))
         {
            this.am_Mob1.Aggro();
            this.am_Mob2.Aggro();
            this.am_Mob3.Aggro();
            param1.SetPhase(this.UpdateSpawnWave);
         }
      }
      
      public function UpdateWaveTwoPosition(param1:a_GameHook) : void
      {
         if(param1.AtTime(2000))
         {
            this.am_Mob4.Aggro();
            this.am_Mob5.Aggro();
            this.am_Mob6.Aggro();
            param1.SetPhase(this.UpdateSpawnWave);
         }
      }
      
      public function UpdateWaveThreePosition(param1:a_GameHook) : void
      {
         if(param1.AtTime(2000))
         {
            this.am_Mob7.Aggro();
            this.am_Mob8.Aggro();
            this.am_Mob9.Aggro();
            param1.SetPhase(this.UpdateSpawnWave);
         }
      }
      
      internal function __setProp___id287__a_Room_GoblinBeachHard_07_cues_0() : *
      {
         try
         {
            this.__id287_["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.__id287_.characterName = "";
         this.__id287_.displayName = "";
         this.__id287_.dramaAnim = "";
         this.__id287_.itemDrop = "Gold_1";
         this.__id287_.sayOnActivate = "";
         this.__id287_.sayOnAlert = "";
         this.__id287_.sayOnBloodied = "";
         this.__id287_.sayOnDeath = "";
         this.__id287_.sayOnInteract = "";
         this.__id287_.sayOnSpawn = "";
         this.__id287_.sleepAnim = "";
         this.__id287_.team = "default";
         this.__id287_.waitToAggro = 0;
         try
         {
            this.__id287_["componentInspectorSetting"] = false;
         }
         catch(e:Error)
         {
         }
      }
      
      internal function __setProp___id290__a_Room_GoblinBeachHard_07_collisions_0() : *
      {
         try
         {
            this.__id290_["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.__id290_.characterName = "";
         this.__id290_.displayName = "";
         this.__id290_.dramaAnim = "";
         this.__id290_.itemDrop = "";
         this.__id290_.sayOnActivate = "Die, Kraken Slayer!:DIE!!!";
         this.__id290_.sayOnAlert = "";
         this.__id290_.sayOnBloodied = "";
         this.__id290_.sayOnDeath = "";
         this.__id290_.sayOnInteract = "";
         this.__id290_.sayOnSpawn = "";
         this.__id290_.sleepAnim = "";
         this.__id290_.team = "default";
         this.__id290_.waitToAggro = 0;
         try
         {
            this.__id290_["componentInspectorSetting"] = false;
         }
         catch(e:Error)
         {
         }
      }
      
      internal function __setProp_am_Goblin3_a_Room_GoblinBeachHard_07_collisions_0() : *
      {
         try
         {
            this.am_Goblin3["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.am_Goblin3.characterName = "";
         this.am_Goblin3.displayName = "";
         this.am_Goblin3.dramaAnim = "";
         this.am_Goblin3.itemDrop = "";
         this.am_Goblin3.sayOnActivate = "We see your scheme, human!:Goblins will rise again!";
         this.am_Goblin3.sayOnAlert = "";
         this.am_Goblin3.sayOnBloodied = "";
         this.am_Goblin3.sayOnDeath = "";
         this.am_Goblin3.sayOnInteract = "";
         this.am_Goblin3.sayOnSpawn = "";
         this.am_Goblin3.sleepAnim = "";
         this.am_Goblin3.team = "default";
         this.am_Goblin3.waitToAggro = 0;
         try
         {
            this.am_Goblin3["componentInspectorSetting"] = false;
         }
         catch(e:Error)
         {
         }
      }
      
      internal function frame1() : *
      {
         this.bWave1 = false;
         this.bWave2 = false;
         this.bWave3 = false;
      }
   }
}

