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
   
   [Embed(source="/_assets/assets.swf", symbol="symbol861")]
   public dynamic class a_Room_SDMission6_05 extends MovieClip
   {
      
      public var am_Spires2:MovieClip;
      
      public var am_Spires3:MovieClip;
      
      public var am_Spires4:MovieClip;
      
      public var am_CollisionObject:MovieClip;
      
      public var am_Mimic:ac_Mimic;
      
      public var __id595_:ac_GolemBrute;
      
      public var __id592_:ac_TreasureChestMedium;
      
      public var am_Spires1:MovieClip;
      
      public var Script_Mimic:Array;
      
      public var Script_MimicDead:Array;
      
      public var Script_CameraShake:Array;
      
      public function a_Room_SDMission6_05()
      {
         super();
         addFrameScript(0,this.frame1);
         this.__setProp___id592__a_Room_SDMission6_05_cues_0();
         this.__setProp___id595__a_Room_SDMission6_05_cues_0();
         this.__setProp_am_Mimic_a_Room_SDMission6_05_cues_0();
      }
      
      public function InitRoom(param1:a_GameHook) : void
      {
         param1.initialPhase = this.UpdateStepOne;
      }
      
      public function UpdateStepOne(param1:a_GameHook) : void
      {
         if(this.am_Mimic.Health() < 1 || param1.OnTrigger("am_Trigger_Mimic"))
         {
            this.am_Mimic.SetAnimation(null);
            this.am_Mimic.Aggro();
            param1.PlayScript(this.Script_Mimic);
            param1.SetPhase(this.UpdateStepTwo);
         }
      }
      
      public function UpdateStepTwo(param1:a_GameHook) : void
      {
         if(this.am_Mimic.Defeated())
         {
            param1.PlayScript(this.Script_MimicDead);
            param1.SetPhase(null);
            return;
         }
         if(param1.AtTimeRepeat(3000,0))
         {
            param1.Group(this.am_Spires1,3).FirePower("MimicSpire");
            param1.PlayScript(this.Script_CameraShake);
            param1.Group(this.am_Spires3,4).FirePower("MimicSpire");
            param1.PlayScript(this.Script_CameraShake);
         }
         if(param1.AtTimeRepeat(5000,3000))
         {
            param1.Group(this.am_Spires2,3).FirePower("MimicSpire");
            param1.PlayScript(this.Script_CameraShake);
            param1.Group(this.am_Spires4,4).FirePower("MimicSpire");
            param1.PlayScript(this.Script_CameraShake);
         }
      }
      
      internal function __setProp___id592__a_Room_SDMission6_05_cues_0() : *
      {
         try
         {
            this.__id592_["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.__id592_.characterName = "";
         this.__id592_.displayName = "";
         this.__id592_.dramaAnim = "";
         this.__id592_.itemDrop = "Gold_3";
         this.__id592_.sayOnActivate = "";
         this.__id592_.sayOnAlert = "";
         this.__id592_.sayOnBloodied = "";
         this.__id592_.sayOnDeath = "";
         this.__id592_.sayOnInteract = "";
         this.__id592_.sayOnSpawn = "";
         this.__id592_.sleepAnim = "";
         this.__id592_.team = "default";
         this.__id592_.waitToAggro = 0;
         try
         {
            this.__id592_["componentInspectorSetting"] = false;
         }
         catch(e:Error)
         {
         }
      }
      
      internal function __setProp___id595__a_Room_SDMission6_05_cues_0() : *
      {
         try
         {
            this.__id595_["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.__id595_.characterName = "";
         this.__id595_.displayName = "";
         this.__id595_.dramaAnim = "";
         this.__id595_.itemDrop = "";
         this.__id595_.sayOnActivate = "We are in service of Perfection.";
         this.__id595_.sayOnAlert = "";
         this.__id595_.sayOnBloodied = "";
         this.__id595_.sayOnDeath = "";
         this.__id595_.sayOnInteract = "";
         this.__id595_.sayOnSpawn = "";
         this.__id595_.sleepAnim = "";
         this.__id595_.team = "default";
         this.__id595_.waitToAggro = 0;
         try
         {
            this.__id595_["componentInspectorSetting"] = false;
         }
         catch(e:Error)
         {
         }
      }
      
      internal function __setProp_am_Mimic_a_Room_SDMission6_05_cues_0() : *
      {
         try
         {
            this.am_Mimic["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.am_Mimic.characterName = "Mimic";
         this.am_Mimic.displayName = "";
         this.am_Mimic.dramaAnim = "";
         this.am_Mimic.itemDrop = "";
         this.am_Mimic.sayOnActivate = "";
         this.am_Mimic.sayOnAlert = "";
         this.am_Mimic.sayOnBloodied = "";
         this.am_Mimic.sayOnDeath = "";
         this.am_Mimic.sayOnInteract = "";
         this.am_Mimic.sayOnSpawn = "";
         this.am_Mimic.sleepAnim = "";
         this.am_Mimic.team = "default";
         this.am_Mimic.waitToAggro = 0;
         try
         {
            this.am_Mimic["componentInspectorSetting"] = false;
         }
         catch(e:Error)
         {
         }
      }
      
      internal function frame1() : *
      {
         this.Script_Mimic = ["0 Mimic Jackpot! Mwahahahaha"];
         this.Script_MimicDead = ["0 Shake 25"];
         this.Script_CameraShake = ["10 Shake 8"];
      }
   }
}

