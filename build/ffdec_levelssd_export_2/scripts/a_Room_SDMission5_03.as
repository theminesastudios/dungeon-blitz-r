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
   
   [Embed(source="/_assets/assets.swf", symbol="symbol1060")]
   public dynamic class a_Room_SDMission5_03 extends MovieClip
   {
      
      public var am_Worm:ac_SandWorm;
      
      public var am_CollisionObject:MovieClip;
      
      public var __id416_:ac_SandWasp;
      
      public var am_Foreground:MovieClip;
      
      public var am_Background:MovieClip;
      
      public var Script_IntroWorm:Array;
      
      public var Script_CameraShake:Array;
      
      public function a_Room_SDMission5_03()
      {
         super();
         addFrameScript(0,this.frame1);
         this.__setProp___id416__a_Room_SDMission5_03_cues_0();
      }
      
      public function InitRoom(param1:a_GameHook) : void
      {
         this.am_Worm.bHoldSpawn = true;
         param1.initialPhase = this.Update;
      }
      
      public function Update(param1:a_GameHook) : void
      {
         if(param1.OnTrigger("am_Trigger_Sandworm"))
         {
            this.am_Worm.Spawn();
            this.am_Worm.DeepSleep();
            this.am_Worm.Skit("<Emerge>");
            param1.PlayScript(this.Script_IntroWorm);
         }
         if(param1.OnScriptFinish(this.Script_IntroWorm))
         {
            this.am_Worm.Skit("<Spew>");
            param1.PlayScript(this.Script_CameraShake);
         }
         if(param1.OnScriptFinish(this.Script_CameraShake))
         {
            this.am_Worm.Aggro();
            param1.SetPhase(null);
         }
      }
      
      internal function __setProp___id416__a_Room_SDMission5_03_cues_0() : *
      {
         try
         {
            this.__id416_["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.__id416_.characterName = "";
         this.__id416_.displayName = "";
         this.__id416_.dramaAnim = "";
         this.__id416_.itemDrop = "";
         this.__id416_.sayOnActivate = "Seeeelieeez! Nooo youuuz!";
         this.__id416_.sayOnAlert = "";
         this.__id416_.sayOnBloodied = "";
         this.__id416_.sayOnDeath = "";
         this.__id416_.sayOnInteract = "";
         this.__id416_.sayOnSpawn = "";
         this.__id416_.sleepAnim = "";
         this.__id416_.team = "default";
         this.__id416_.waitToAggro = 0;
         try
         {
            this.__id416_["componentInspectorSetting"] = false;
         }
         catch(e:Error)
         {
         }
      }
      
      internal function frame1() : *
      {
         this.Script_IntroWorm = ["3 End"];
         this.Script_CameraShake = ["1 Shake 35","2 End"];
      }
   }
}

