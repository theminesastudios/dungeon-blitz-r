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
   
   [Embed(source="/_assets/assets.swf", symbol="symbol1579")]
   public dynamic class a_Room_SDMission2_05 extends MovieClip
   {
      
      public var am_CollisionObject:MovieClip;
      
      public var am_Larva6:ac_ScarabLarvaSpawnSmall;
      
      public var __id184_:ac_ScarabSoldier;
      
      public var am_Larva5:ac_ScarabLarvaSpawnSmall;
      
      public var am_Larva4:ac_ScarabLarvaSpawn;
      
      public var am_Larva3:ac_ScarabLarvaSpawn;
      
      public var am_Larva2:ac_ScarabLarvaSpawn;
      
      public var am_Larva1:ac_ScarabLarvaSpawn;
      
      public var am_Foreground:MovieClip;
      
      public function a_Room_SDMission2_05()
      {
         super();
         addFrameScript(0,this.frame1);
         this.__setProp___id184__a_Room_SDMission2_05_Cues_0();
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
         if(param1.OnTrigger("am_Trigger_Larva"))
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
      
      internal function __setProp___id184__a_Room_SDMission2_05_Cues_0() : *
      {
         try
         {
            this.__id184_["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.__id184_.characterName = "";
         this.__id184_.displayName = "";
         this.__id184_.dramaAnim = "";
         this.__id184_.itemDrop = "";
         this.__id184_.sayOnActivate = "";
         this.__id184_.sayOnAlert = "Weeee riiiise...:Seeeelie daaaawn...";
         this.__id184_.sayOnBloodied = "";
         this.__id184_.sayOnDeath = "";
         this.__id184_.sayOnInteract = "";
         this.__id184_.sayOnSpawn = "";
         this.__id184_.sleepAnim = "";
         this.__id184_.team = "default";
         this.__id184_.waitToAggro = 0;
         try
         {
            this.__id184_["componentInspectorSetting"] = false;
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

