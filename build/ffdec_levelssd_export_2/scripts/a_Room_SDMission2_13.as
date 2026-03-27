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
   
   [Embed(source="/_assets/assets.swf", symbol="symbol1464")]
   public dynamic class a_Room_SDMission2_13 extends MovieClip
   {
      
      public var am_CollisionObject:MovieClip;
      
      public var __id279_:ac_ScarabSoldier2;
      
      public var am_Larva4:ac_ScarabLarvaSpawnSmall;
      
      public var am_Larva3:ac_ScarabLarvaSpawn;
      
      public var am_Larva2:ac_ScarabLarvaSpawn;
      
      public var am_Larva1:ac_ScarabLarvaSpawn;
      
      public var am_Foreground:MovieClip;
      
      public function a_Room_SDMission2_13()
      {
         super();
         addFrameScript(0,this.frame1);
         this.__setProp___id279__a_Room_SDMission2_13_Cues_0();
      }
      
      public function InitRoom(param1:a_GameHook) : void
      {
         this.am_Larva1.bHoldSpawn = true;
         this.am_Larva2.bHoldSpawn = true;
         this.am_Larva3.bHoldSpawn = true;
         this.am_Larva4.bHoldSpawn = true;
         param1.initialPhase = this.Update;
      }
      
      public function Update(param1:a_GameHook) : void
      {
         if(param1.AtTime(5000))
         {
            this.am_Larva1.Spawn();
         }
         if(param1.AtTime(5300))
         {
            this.am_Larva2.Spawn();
         }
         if(param1.AtTime(5700))
         {
            this.am_Larva4.Spawn();
         }
         if(param1.AtTime(5850))
         {
            this.am_Larva3.Spawn();
            param1.SetPhase(null);
         }
      }
      
      internal function __setProp___id279__a_Room_SDMission2_13_Cues_0() : *
      {
         try
         {
            this.__id279_["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.__id279_.characterName = "";
         this.__id279_.displayName = "";
         this.__id279_.dramaAnim = "";
         this.__id279_.itemDrop = "";
         this.__id279_.sayOnActivate = "";
         this.__id279_.sayOnAlert = "Creeeeeche for..bid..ennn!";
         this.__id279_.sayOnBloodied = "";
         this.__id279_.sayOnDeath = "";
         this.__id279_.sayOnInteract = "";
         this.__id279_.sayOnSpawn = "";
         this.__id279_.sleepAnim = "";
         this.__id279_.team = "default";
         this.__id279_.waitToAggro = 0;
         try
         {
            this.__id279_["componentInspectorSetting"] = false;
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

