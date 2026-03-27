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
   
   [Embed(source="/_assets/assets.swf", symbol="symbol1698")]
   public dynamic class a_Room_SDMission02 extends MovieClip
   {
      
      public var am_CollisionObject:MovieClip;
      
      public var am_Moment_Hard:MovieClip;
      
      public var am_Puck6:ac_PuckShadow;
      
      public var am_Puck4:ac_PuckShadow;
      
      public var am_Puck5:ac_PuckShadow2;
      
      public var am_Puck2:ac_PuckShadow2;
      
      public var am_Puck3:ac_PuckShadow;
      
      public var am_Chest:ac_TreasureChestMedium;
      
      public var am_Foreground:MovieClip;
      
      public var am_Puck1:ac_PuckShadow;
      
      public var Script_CaveIn:Array;
      
      public function a_Room_SDMission02()
      {
         super();
         addFrameScript(0,this.frame1);
         this.__setProp_am_Chest_a_Room_SDMission02_cues_0();
         this.__setProp_am_Puck1_a_Room_SDMission02_cues_0();
      }
      
      public function InitRoom(param1:a_GameHook) : void
      {
         this.am_Puck1.bHoldSpawn = true;
         this.am_Puck2.bHoldSpawn = true;
         this.am_Puck3.bHoldSpawn = true;
         this.am_Puck4.bHoldSpawn = true;
         this.am_Puck5.bHoldSpawn = true;
         this.am_Puck6.bHoldSpawn = true;
         param1.initialPhase = this.UpdateStepOne;
      }
      
      public function UpdateStepOne(param1:a_GameHook) : void
      {
         if(this.am_Chest.Defeated())
         {
            param1.PlayScript(this.Script_CaveIn);
            param1.Animate("am_Ceiling","CaveIn",true);
            this.am_Puck1.Spawn();
            this.am_Puck2.Spawn();
            this.am_Puck3.Spawn();
            this.am_Puck4.Spawn();
            this.am_Puck5.Spawn();
            this.am_Puck6.Spawn();
            param1.SetPhase(this.UpdateStepTwo);
         }
      }
      
      public function UpdateStepTwo(param1:a_GameHook) : void
      {
         if(this.am_Puck1.Defeated() && this.am_Puck2.Defeated() && this.am_Puck3.Defeated() && this.am_Puck4.Defeated() && this.am_Puck5.Defeated() && this.am_Puck6.Defeated())
         {
            param1.SetPhase(null);
         }
      }
      
      internal function __setProp_am_Chest_a_Room_SDMission02_cues_0() : *
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
      
      internal function __setProp_am_Puck1_a_Room_SDMission02_cues_0() : *
      {
         try
         {
            this.am_Puck1["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.am_Puck1.characterName = "";
         this.am_Puck1.displayName = "";
         this.am_Puck1.dramaAnim = "";
         this.am_Puck1.itemDrop = "";
         this.am_Puck1.sayOnActivate = "Tehehe!";
         this.am_Puck1.sayOnAlert = "";
         this.am_Puck1.sayOnBloodied = "";
         this.am_Puck1.sayOnDeath = "";
         this.am_Puck1.sayOnInteract = "";
         this.am_Puck1.sayOnSpawn = "";
         this.am_Puck1.sleepAnim = "";
         this.am_Puck1.team = "default";
         this.am_Puck1.waitToAggro = 0;
         try
         {
            this.am_Puck1["componentInspectorSetting"] = false;
         }
         catch(e:Error)
         {
         }
      }
      
      internal function frame1() : *
      {
         this.Script_CaveIn = ["0 Shake 32"];
      }
   }
}

