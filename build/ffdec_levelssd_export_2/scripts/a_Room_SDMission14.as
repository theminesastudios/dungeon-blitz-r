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
   
   [Embed(source="/_assets/assets.swf", symbol="symbol1632")]
   public dynamic class a_Room_SDMission14 extends MovieClip
   {
      
      public var am_Spires2:MovieClip;
      
      public var am_CollisionObject:MovieClip;
      
      public var am_Mimic:ac_Mimic;
      
      public var am_Foreground:MovieClip;
      
      public var am_Spires1:MovieClip;
      
      public var Script_Mimic:Array;
      
      public var Script_MimicDead:Array;
      
      public var Script_CameraShake:Array;
      
      public function a_Room_SDMission14()
      {
         super();
         addFrameScript(0,this.frame1);
         this.__setProp_am_Mimic_a_Room_SDMission14_Cues_0();
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
         }
         if(param1.AtTimeRepeat(5000,3000))
         {
            param1.Group(this.am_Spires2,3).FirePower("MimicSpire");
            param1.PlayScript(this.Script_CameraShake);
         }
      }
      
      internal function __setProp_am_Mimic_a_Room_SDMission14_Cues_0() : *
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
         this.am_Mimic.sayOnBloodied = "Your life will not end in riches";
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
         this.Script_Mimic = ["0 Mimic Greed shall be your demise!","9 Mimic Mwahahaha!"];
         this.Script_MimicDead = ["0 Shake 12"];
         this.Script_CameraShake = ["10 Shake 8"];
      }
   }
}

