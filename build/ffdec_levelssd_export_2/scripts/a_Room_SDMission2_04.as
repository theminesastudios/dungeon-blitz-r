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
   
   [Embed(source="/_assets/assets.swf", symbol="symbol1602")]
   public dynamic class a_Room_SDMission2_04 extends MovieClip
   {
      
      public var __id165_:ac_ScarabSoldier;
      
      public var am_CollisionObject:MovieClip;
      
      public var am_Larva9:ac_ScarabLarvaSpawnSmall;
      
      public var am_Larva8:ac_ScarabLarvaSpawnSmall;
      
      public var am_Moment_Hard:MovieClip;
      
      public var am_Larva7:ac_ScarabLarvaSpawn;
      
      public var am_MiniBoss:ac_ScarabRogue;
      
      public var am_Larva6:ac_ScarabLarvaSpawnSmall;
      
      public var am_WaveTwo:MovieClip;
      
      public var am_Larva5:ac_ScarabLarvaSpawnSmall;
      
      public var am_Larva4:ac_ScarabLarvaSpawnSmall;
      
      public var am_Larva3:ac_ScarabLarvaSpawn;
      
      public var am_Larva2:ac_ScarabLarvaSpawn;
      
      public var am_Larva10:ac_ScarabLarvaSpawnSmall;
      
      public var am_Larva1:ac_ScarabLarvaSpawn;
      
      public var am_Larva11:ac_ScarabLarvaSpawn;
      
      public var am_WaveOne:MovieClip;
      
      public var am_Larva12:ac_ScarabLarvaSpawn;
      
      public var am_Foreground:MovieClip;
      
      public var Script_MiniBoss:Array;
      
      public var Script_Weakened:Array;
      
      public function a_Room_SDMission2_04()
      {
         super();
         addFrameScript(0,this.frame1);
         this.__setProp_am_MiniBoss_a_Room_SDMission2_04_Cues_0();
         this.__setProp___id165__a_Room_SDMission2_04_Cues_0();
      }
      
      public function InitRoom(param1:a_GameHook) : void
      {
         this.am_Larva1.bHoldSpawn = true;
         this.am_Larva2.bHoldSpawn = true;
         this.am_Larva3.bHoldSpawn = true;
         this.am_Larva4.bHoldSpawn = true;
         this.am_Larva5.bHoldSpawn = true;
         this.am_Larva6.bHoldSpawn = true;
         this.am_Larva7.bHoldSpawn = true;
         this.am_Larva8.bHoldSpawn = true;
         this.am_Larva9.bHoldSpawn = true;
         this.am_Larva10.bHoldSpawn = true;
         this.am_Larva11.bHoldSpawn = true;
         this.am_Larva12.bHoldSpawn = true;
         param1.initialPhase = this.UpdateTrigger;
      }
      
      public function UpdateTrigger(param1:a_GameHook) : void
      {
         if(param1.OnTrigger("am_Trigger_MiniBoss") || this.am_MiniBoss.Health() < 1)
         {
            param1.SetPhase(this.UpdateDropLarva);
         }
      }
      
      public function UpdateDropLarva(param1:a_GameHook) : void
      {
         if(param1.AtTime(0))
         {
            param1.PlayScript(this.Script_MiniBoss);
            this.am_MiniBoss.Aggro();
         }
         if(param1.AtTime(400))
         {
            this.am_Larva1.Spawn();
         }
         if(param1.AtTime(500))
         {
            this.am_Larva5.Spawn();
         }
         if(param1.AtTime(550))
         {
            this.am_Larva2.Spawn();
         }
         if(param1.AtTime(600))
         {
            this.am_Larva3.Spawn();
         }
         if(param1.AtTime(690))
         {
            this.am_Larva6.Spawn();
         }
         if(param1.AtTime(800))
         {
            this.am_Larva4.Spawn();
         }
         if(this.am_MiniBoss.Health() <= 0.4)
         {
            param1.SetPhase(this.UpdateSecondDrop);
         }
      }
      
      public function UpdateSecondDrop(param1:a_GameHook) : void
      {
         if(param1.AtTime(0))
         {
            param1.PlayScript(this.Script_Weakened);
         }
         if(param1.AtTime(400))
         {
            this.am_Larva7.Spawn();
         }
         if(param1.AtTime(500))
         {
            this.am_Larva8.Spawn();
         }
         if(param1.AtTime(550))
         {
            this.am_Larva9.Spawn();
         }
         if(param1.AtTime(600))
         {
            this.am_Larva10.Spawn();
         }
         if(param1.AtTime(690))
         {
            this.am_Larva11.Spawn();
         }
         if(param1.AtTime(800))
         {
            this.am_Larva12.Spawn();
            param1.SetPhase(null);
         }
      }
      
      internal function __setProp_am_MiniBoss_a_Room_SDMission2_04_Cues_0() : *
      {
         try
         {
            this.am_MiniBoss["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.am_MiniBoss.characterName = "ScarabRogue";
         this.am_MiniBoss.displayName = "";
         this.am_MiniBoss.dramaAnim = "";
         this.am_MiniBoss.itemDrop = "";
         this.am_MiniBoss.sayOnActivate = "";
         this.am_MiniBoss.sayOnAlert = "";
         this.am_MiniBoss.sayOnBloodied = "";
         this.am_MiniBoss.sayOnDeath = "";
         this.am_MiniBoss.sayOnInteract = "";
         this.am_MiniBoss.sayOnSpawn = "";
         this.am_MiniBoss.sleepAnim = "";
         this.am_MiniBoss.team = "default";
         this.am_MiniBoss.waitToAggro = 0;
         try
         {
            this.am_MiniBoss["componentInspectorSetting"] = false;
         }
         catch(e:Error)
         {
         }
      }
      
      internal function __setProp___id165__a_Room_SDMission2_04_Cues_0() : *
      {
         try
         {
            this.__id165_["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.__id165_.characterName = "";
         this.__id165_.displayName = "";
         this.__id165_.dramaAnim = "";
         this.__id165_.itemDrop = "";
         this.__id165_.sayOnActivate = "";
         this.__id165_.sayOnAlert = "Uuuunder Uuus...:Seeeelie houuuuse.";
         this.__id165_.sayOnBloodied = "";
         this.__id165_.sayOnDeath = "";
         this.__id165_.sayOnInteract = "";
         this.__id165_.sayOnSpawn = "";
         this.__id165_.sleepAnim = "";
         this.__id165_.team = "default";
         this.__id165_.waitToAggro = 0;
         try
         {
            this.__id165_["componentInspectorSetting"] = false;
         }
         catch(e:Error)
         {
         }
      }
      
      internal function frame1() : *
      {
         this.Script_MiniBoss = ["0 MiniBoss What?!? Where did you come from?"];
         this.Script_Weakened = ["0 MiniBoss It\'s too late, mortal. The Seelie shall return to Shazari!"];
      }
   }
}

