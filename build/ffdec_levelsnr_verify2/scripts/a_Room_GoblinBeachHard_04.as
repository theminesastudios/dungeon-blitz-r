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
   
   [Embed(source="/_assets/assets.swf", symbol="symbol1255")]
   public dynamic class a_Room_GoblinBeachHard_04 extends MovieClip
   {
      
      public var am_p2:ac_PsychophageBaby;
      
      public var am_p3:ac_PsychophageBaby;
      
      public var am_p4:ac_PsychophageBaby;
      
      public var am_p5:ac_PsychophageBaby;
      
      public var am_EffectMarker2:ac_NephitSpireMarker;
      
      public var am_CollisionObject:MovieClip;
      
      public var am_p6:ac_PsychophageBaby;
      
      public var am_EffectMarker1:ac_NephitSpireMarker;
      
      public var am_Brute2:ac_GoblinBrute;
      
      public var am_Brute1:ac_GoblinShamanHood;
      
      public var am_Gob1:ac_GoblinShamanSkullHat;
      
      public var am_Gob2:ac_GoblinShamanSkullHat;
      
      public var am_Foreground:MovieClip;
      
      public var am_Background:MovieClip;
      
      public var am_Scout:ac_GoblinClub;
      
      public var am_p1:ac_PsychophageBaby;
      
      public var Script_OpeningScene:Array;
      
      public var Script_Ambush1:Array;
      
      public var Script_Ambush2:Array;
      
      public var bFliersSpawned:Boolean;
      
      public var bTriggerTripped:Boolean;
      
      public var bDoorTriggerTripped:Boolean;
      
      public function a_Room_GoblinBeachHard_04()
      {
         super();
         addFrameScript(0,this.frame1);
         this.__setProp_am_Scout_a_Room_GoblinBeachHard_04_cues_0();
         this.__setProp_am_Brute2_a_Room_GoblinBeachHard_04_collisions_0();
         this.__setProp_am_Gob2_a_Room_GoblinBeachHard_04_collisions_0();
         this.__setProp_am_Gob1_a_Room_GoblinBeachHard_04_collisions_0();
         this.__setProp_am_Brute1_a_Room_GoblinBeachHard_04_collisions_0();
      }
      
      public function InitRoom(param1:a_GameHook) : void
      {
         this.am_p1.bHoldSpawn = true;
         this.am_p2.bHoldSpawn = true;
         this.am_p3.bHoldSpawn = true;
         this.am_p4.bHoldSpawn = true;
         this.am_p5.bHoldSpawn = true;
         this.am_p6.bHoldSpawn = true;
         this.am_Gob1.bHoldSpawn = true;
         this.am_Gob2.bHoldSpawn = true;
         this.am_Brute1.bHoldSpawn = true;
         this.am_Brute2.bHoldSpawn = true;
         param1.initialPhase = this.UpdateIntro;
      }
      
      public function UpdateIntro(param1:a_GameHook) : void
      {
         if(param1.AtTime(0))
         {
            param1.PlayScript(this.Script_OpeningScene);
            param1.SetPhase(this.UpdateFliers);
         }
      }
      
      public function UpdateFliers(param1:a_GameHook) : void
      {
         if(!this.bFliersSpawned)
         {
            if(param1.AtTime(200))
            {
               this.am_p1.Spawn();
               this.am_p1.DeepSleep();
               this.am_p1.Skit("<Goto Red 1>");
            }
            if(param1.AtTime(500))
            {
               this.am_p2.Spawn();
               this.am_p2.DeepSleep();
               this.am_p2.Skit("<Goto Red 5>");
            }
            if(param1.AtTime(700))
            {
               this.am_p3.Spawn();
               this.am_p3.DeepSleep();
               this.am_p3.Skit("<Goto Red 6>");
            }
            if(param1.AtTime(1200))
            {
               this.am_p4.Spawn();
               this.am_p4.DeepSleep();
               this.am_p4.Skit("<Goto Red 4>");
            }
            if(param1.AtTime(1600))
            {
               this.am_p5.Spawn();
               this.am_p5.DeepSleep();
               this.am_p5.Skit("<Goto Red 3>");
            }
            if(param1.AtTime(2000))
            {
               this.am_p6.Spawn();
               this.am_p6.DeepSleep();
               this.am_p6.Skit("<Goto Red 2>");
            }
            if(param1.AtTime(2200))
            {
               this.am_p1.Aggro();
            }
            if(param1.AtTime(2500))
            {
               this.am_p2.Aggro();
            }
            if(param1.AtTime(2700))
            {
               this.am_p3.Aggro();
            }
            if(param1.AtTime(3200))
            {
               this.am_p4.Aggro();
            }
            if(param1.AtTime(3600))
            {
               this.am_p5.Aggro();
            }
            if(param1.AtTime(4000))
            {
               this.am_p6.Aggro();
               this.bFliersSpawned = true;
            }
         }
         if(param1.OnTrigger("am_Trigger_2"))
         {
            param1.PlayScript(this.Script_Ambush1);
            this.bTriggerTripped = true;
         }
         if(param1.OnTrigger("am_Trigger_3"))
         {
            param1.PlayScript(this.Script_Ambush2);
            this.bDoorTriggerTripped = true;
         }
         if(this.bTriggerTripped && this.bFliersSpawned && this.bDoorTriggerTripped)
         {
            param1.SetPhase(null);
         }
      }
      
      internal function __setProp_am_Scout_a_Room_GoblinBeachHard_04_cues_0() : *
      {
         try
         {
            this.am_Scout["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.am_Scout.characterName = "";
         this.am_Scout.displayName = "";
         this.am_Scout.dramaAnim = "";
         this.am_Scout.itemDrop = "";
         this.am_Scout.sayOnActivate = "";
         this.am_Scout.sayOnAlert = "";
         this.am_Scout.sayOnBloodied = "";
         this.am_Scout.sayOnDeath = "Nooooo!";
         this.am_Scout.sayOnInteract = "";
         this.am_Scout.sayOnSpawn = "";
         this.am_Scout.sleepAnim = "";
         this.am_Scout.team = "default";
         this.am_Scout.waitToAggro = 0;
         try
         {
            this.am_Scout["componentInspectorSetting"] = false;
         }
         catch(e:Error)
         {
         }
      }
      
      internal function __setProp_am_Brute2_a_Room_GoblinBeachHard_04_collisions_0() : *
      {
         try
         {
            this.am_Brute2["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.am_Brute2.characterName = "";
         this.am_Brute2.displayName = "";
         this.am_Brute2.dramaAnim = "";
         this.am_Brute2.itemDrop = "";
         this.am_Brute2.sayOnActivate = "We conquered you humans!:We won!";
         this.am_Brute2.sayOnAlert = "";
         this.am_Brute2.sayOnBloodied = "";
         this.am_Brute2.sayOnDeath = "Maybe I\'m wrong...";
         this.am_Brute2.sayOnInteract = "";
         this.am_Brute2.sayOnSpawn = "";
         this.am_Brute2.sleepAnim = "";
         this.am_Brute2.team = "default";
         this.am_Brute2.waitToAggro = 0;
         try
         {
            this.am_Brute2["componentInspectorSetting"] = false;
         }
         catch(e:Error)
         {
         }
      }
      
      internal function __setProp_am_Gob2_a_Room_GoblinBeachHard_04_collisions_0() : *
      {
         try
         {
            this.am_Gob2["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.am_Gob2.characterName = "";
         this.am_Gob2.displayName = "";
         this.am_Gob2.dramaAnim = "";
         this.am_Gob2.itemDrop = "";
         this.am_Gob2.sayOnActivate = "Time to die!";
         this.am_Gob2.sayOnAlert = "";
         this.am_Gob2.sayOnBloodied = "";
         this.am_Gob2.sayOnDeath = "";
         this.am_Gob2.sayOnInteract = "";
         this.am_Gob2.sayOnSpawn = "";
         this.am_Gob2.sleepAnim = "";
         this.am_Gob2.team = "default";
         this.am_Gob2.waitToAggro = 0;
         try
         {
            this.am_Gob2["componentInspectorSetting"] = false;
         }
         catch(e:Error)
         {
         }
      }
      
      internal function __setProp_am_Gob1_a_Room_GoblinBeachHard_04_collisions_0() : *
      {
         try
         {
            this.am_Gob1["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.am_Gob1.characterName = "";
         this.am_Gob1.displayName = "";
         this.am_Gob1.dramaAnim = "";
         this.am_Gob1.itemDrop = "";
         this.am_Gob1.sayOnActivate = "";
         this.am_Gob1.sayOnAlert = "";
         this.am_Gob1.sayOnBloodied = "";
         this.am_Gob1.sayOnDeath = "Ouch...";
         this.am_Gob1.sayOnInteract = "";
         this.am_Gob1.sayOnSpawn = "";
         this.am_Gob1.sleepAnim = "";
         this.am_Gob1.team = "default";
         this.am_Gob1.waitToAggro = 0;
         try
         {
            this.am_Gob1["componentInspectorSetting"] = false;
         }
         catch(e:Error)
         {
         }
      }
      
      internal function __setProp_am_Brute1_a_Room_GoblinBeachHard_04_collisions_0() : *
      {
         try
         {
            this.am_Brute1["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.am_Brute1.characterName = "";
         this.am_Brute1.displayName = "";
         this.am_Brute1.dramaAnim = "";
         this.am_Brute1.itemDrop = "";
         this.am_Brute1.sayOnActivate = "Tehehehe";
         this.am_Brute1.sayOnAlert = "";
         this.am_Brute1.sayOnBloodied = "";
         this.am_Brute1.sayOnDeath = "";
         this.am_Brute1.sayOnInteract = "";
         this.am_Brute1.sayOnSpawn = "";
         this.am_Brute1.sleepAnim = "";
         this.am_Brute1.team = "default";
         this.am_Brute1.waitToAggro = 0;
         try
         {
            this.am_Brute1["componentInspectorSetting"] = false;
         }
         catch(e:Error)
         {
         }
      }
      
      internal function frame1() : *
      {
         this.Script_OpeningScene = ["0 Camera 2","2 Scout <PullLever> Death Eyes, kill the Kraken slayer!","4 Camera Free"];
         this.Script_Ambush1 = ["2 SpawnCue Brute1","0 Brute1 <Board>","2 SpawnCue Brute2","0 Brute2 <Board>"];
         this.Script_Ambush2 = ["2 QuickFirePower EffectMarker1 OasisTeleportEffect","1 SpawnCue Gob1","2 QuickFirePower EffectMarker2 OasisTeleportEffect","1 SpawnCue Gob2"];
         this.bFliersSpawned = false;
         this.bTriggerTripped = false;
         this.bDoorTriggerTripped = false;
      }
   }
}

