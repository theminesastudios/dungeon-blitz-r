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
   
   [Embed(source="/_assets/assets.swf", symbol="symbol1523")]
   public dynamic class a_Room_SDMission2_11 extends MovieClip
   {
      
      public var am_CollisionObject:MovieClip;
      
      public var __id265_:ac_ScarabSoldier2;
      
      public var am_Larva6:ac_ScarabLarvaSpawnSmall;
      
      public var am_Larva5:ac_ScarabLarvaSpawnSmall;
      
      public var am_Larva4:ac_ScarabLarvaSpawn;
      
      public var am_Larva3:ac_ScarabLarvaSpawn;
      
      public var am_Larva2:ac_ScarabLarvaSpawn;
      
      public var am_Larva1:ac_ScarabLarvaSpawn;
      
      public var am_Chest:ac_TreasureChestMedium;
      
      public var am_Foreground:MovieClip;
      
      public function a_Room_SDMission2_11()
      {
         super();
         addFrameScript(0,this.frame1);
         this.__setProp_am_Chest_a_Room_SDMission2_11_effects_0();
         this.__setProp___id265__a_Room_SDMission2_11_cues_0();
      }
      
      public function InitRoom(param1:a_GameHook) : void
      {
         this.am_Larva1.bHoldSpawn = true;
         this.am_Larva2.bHoldSpawn = true;
         this.am_Larva3.bHoldSpawn = true;
         this.am_Larva4.bHoldSpawn = true;
         this.am_Larva5.bHoldSpawn = true;
         this.am_Larva6.bHoldSpawn = true;
         param1.initialPhase = this.UpdateTrigger;
      }
      
      public function UpdateTrigger(param1:a_GameHook) : void
      {
         if(this.am_Chest.OnDefeat())
         {
            param1.SetPhase(this.UpdateDropLarva);
         }
      }
      
      public function UpdateDropLarva(param1:a_GameHook) : void
      {
         if(param1.AtTime(250))
         {
            this.am_Larva1.Spawn();
         }
         if(param1.AtTime(380))
         {
            this.am_Larva5.Spawn();
         }
         if(param1.AtTime(400))
         {
            this.am_Larva2.Spawn();
         }
         if(param1.AtTime(560))
         {
            this.am_Larva3.Spawn();
         }
         if(param1.AtTime(650))
         {
            this.am_Larva6.Spawn();
         }
         if(param1.AtTime(700))
         {
            this.am_Larva4.Spawn();
            param1.SetPhase(null);
         }
      }
      
      internal function __setProp_am_Chest_a_Room_SDMission2_11_effects_0() : *
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
      
      internal function __setProp___id265__a_Room_SDMission2_11_cues_0() : *
      {
         try
         {
            this.__id265_["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.__id265_.characterName = "";
         this.__id265_.displayName = "";
         this.__id265_.dramaAnim = "";
         this.__id265_.itemDrop = "";
         this.__id265_.sayOnActivate = "";
         this.__id265_.sayOnAlert = "Goooo frooom heeeere!";
         this.__id265_.sayOnBloodied = "";
         this.__id265_.sayOnDeath = "";
         this.__id265_.sayOnInteract = "";
         this.__id265_.sayOnSpawn = "";
         this.__id265_.sleepAnim = "";
         this.__id265_.team = "default";
         this.__id265_.waitToAggro = 0;
         try
         {
            this.__id265_["componentInspectorSetting"] = false;
         }
         catch(e:Error)
         {
         }
      }
      
      internal function frame1() : *
      {
      }
   }
}

