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
   
   [Embed(source="/_assets/assets.swf", symbol="symbol1417")]
   public dynamic class a_Room_SDMission3_03 extends MovieClip
   {
      
      public var am_CollisionObject:MovieClip;
      
      public var am_Gate1:a_Animation_DoorSpike;
      
      public var __id288_:ac_OutlanderRogue;
      
      public var Script_ShakeCamera:Array;
      
      public function a_Room_SDMission3_03()
      {
         super();
         addFrameScript(0,this.frame1);
         this.__setProp___id288__a_Room_SDMission3_03_Cues_0();
      }
      
      public function InitRoom(param1:a_GameHook) : void
      {
         param1.initialPhase = this.Update;
      }
      
      public function Update(param1:a_GameHook) : void
      {
         if(param1.RoomCleared())
         {
            param1.PlayScript(this.Script_ShakeCamera);
            param1.Animate("am_Gate1","Open",true);
            param1.CollisionOff("am_DynamicCollision_Door");
            param1.SetPhase(null);
         }
      }
      
      internal function __setProp___id288__a_Room_SDMission3_03_Cues_0() : *
      {
         try
         {
            this.__id288_["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.__id288_.characterName = "";
         this.__id288_.displayName = "";
         this.__id288_.dramaAnim = "";
         this.__id288_.itemDrop = "";
         this.__id288_.sayOnActivate = "";
         this.__id288_.sayOnAlert = "The raptors sniff out more Arena fodder?:No..:Just who do you think you are?";
         this.__id288_.sayOnBloodied = "";
         this.__id288_.sayOnDeath = "";
         this.__id288_.sayOnInteract = "";
         this.__id288_.sayOnSpawn = "";
         this.__id288_.sleepAnim = "";
         this.__id288_.team = "default";
         this.__id288_.waitToAggro = 0;
         try
         {
            this.__id288_["componentInspectorSetting"] = false;
         }
         catch(e:Error)
         {
         }
      }
      
      internal function frame1() : *
      {
         this.Script_ShakeCamera = ["1 Shake 10"];
      }
   }
}

