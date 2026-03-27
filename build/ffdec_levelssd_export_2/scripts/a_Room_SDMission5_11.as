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
   
   [Embed(source="/_assets/assets.swf", symbol="symbol985")]
   public dynamic class a_Room_SDMission5_11 extends MovieClip
   {
      
      public var am_CollisionObject:MovieClip;
      
      public var am_Gate1:a_Animation_DoorSpike;
      
      public var __id530_:ac_OasisWarlock;
      
      public var am_Background:MovieClip;
      
      public var am_Foreground:MovieClip;
      
      public var Script_ShakeCamera:Array;
      
      public function a_Room_SDMission5_11()
      {
         super();
         addFrameScript(0,this.frame1);
         this.__setProp___id530__a_Room_SDMission5_11_cues_0();
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
      
      internal function __setProp___id530__a_Room_SDMission5_11_cues_0() : *
      {
         try
         {
            this.__id530_["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.__id530_.characterName = "";
         this.__id530_.displayName = "";
         this.__id530_.dramaAnim = "";
         this.__id530_.itemDrop = "";
         this.__id530_.sayOnActivate = "Do you feel the tremors human?:Mortal kind is fodder for the great maw.";
         this.__id530_.sayOnAlert = "";
         this.__id530_.sayOnBloodied = "";
         this.__id530_.sayOnDeath = "None shall be spared...";
         this.__id530_.sayOnInteract = "";
         this.__id530_.sayOnSpawn = "";
         this.__id530_.sleepAnim = "";
         this.__id530_.team = "default";
         this.__id530_.waitToAggro = 0;
         try
         {
            this.__id530_["componentInspectorSetting"] = false;
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

