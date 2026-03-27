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
   
   [Embed(source="/_assets/assets.swf", symbol="symbol1000")]
   public dynamic class a_Room_SDMission5_09 extends MovieClip
   {
      
      public var am_CollisionObject:MovieClip;
      
      public var __id502_:ac_OasisGiant2;
      
      public var am_Larva2:ac_ScarabLarvaSpawn;
      
      public var am_Larva1:ac_ScarabLarvaSpawn;
      
      public var am_Foreground:MovieClip;
      
      public function a_Room_SDMission5_09()
      {
         super();
         addFrameScript(0,this.frame1);
         this.__setProp___id502__a_Room_SDMission5_09_collisions_0();
      }
      
      public function InitRoom(param1:a_GameHook) : void
      {
         this.am_Larva1.bHoldSpawn = true;
         this.am_Larva2.bHoldSpawn = true;
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
            this.am_Larva2.Spawn();
            param1.SetPhase(null);
         }
      }
      
      internal function __setProp___id502__a_Room_SDMission5_09_collisions_0() : *
      {
         try
         {
            this.__id502_["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.__id502_.characterName = "";
         this.__id502_.displayName = "";
         this.__id502_.dramaAnim = "";
         this.__id502_.itemDrop = "";
         this.__id502_.sayOnActivate = "You can\'t stop this, human.:Shazari will be wiped clean.";
         this.__id502_.sayOnAlert = "";
         this.__id502_.sayOnBloodied = "This shall once again by Seelie land!";
         this.__id502_.sayOnDeath = "Gaaaagh...";
         this.__id502_.sayOnInteract = "";
         this.__id502_.sayOnSpawn = "";
         this.__id502_.sleepAnim = "";
         this.__id502_.team = "default";
         this.__id502_.waitToAggro = 0;
         try
         {
            this.__id502_["componentInspectorSetting"] = false;
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

