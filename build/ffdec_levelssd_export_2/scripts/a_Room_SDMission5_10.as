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
   
   [Embed(source="/_assets/assets.swf", symbol="symbol993")]
   public dynamic class a_Room_SDMission5_10 extends MovieClip
   {
      
      public var am_CollisionObject:MovieClip;
      
      public var am_Larva3:ac_ScarabLarvaSpawn;
      
      public var am_Larva2:ac_ScarabLarvaSpawn;
      
      public var am_Larva1:ac_ScarabLarvaSpawn;
      
      public var __id504_:ac_ShadeMage2;
      
      public function a_Room_SDMission5_10()
      {
         super();
         addFrameScript(0,this.frame1);
         this.__setProp___id504__a_Room_SDMission5_10_cues_0();
      }
      
      public function InitRoom(param1:a_GameHook) : void
      {
         this.am_Larva1.bHoldSpawn = true;
         this.am_Larva2.bHoldSpawn = true;
         this.am_Larva3.bHoldSpawn = true;
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
         if(param1.AtTime(200))
         {
            this.am_Larva1.Spawn();
         }
         if(param1.AtTime(350))
         {
            this.am_Larva3.Spawn();
         }
         if(param1.AtTime(500))
         {
            this.am_Larva3.Spawn();
            param1.SetPhase(null);
         }
      }
      
      internal function __setProp___id504__a_Room_SDMission5_10_cues_0() : *
      {
         try
         {
            this.__id504_["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.__id504_.characterName = "";
         this.__id504_.displayName = "";
         this.__id504_.dramaAnim = "";
         this.__id504_.itemDrop = "";
         this.__id504_.sayOnActivate = "";
         this.__id504_.sayOnAlert = "";
         this.__id504_.sayOnBloodied = "We shall cleanse the land of your kind.";
         this.__id504_.sayOnDeath = "";
         this.__id504_.sayOnInteract = "";
         this.__id504_.sayOnSpawn = "";
         this.__id504_.sleepAnim = "";
         this.__id504_.team = "default";
         this.__id504_.waitToAggro = 0;
         try
         {
            this.__id504_["componentInspectorSetting"] = false;
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

