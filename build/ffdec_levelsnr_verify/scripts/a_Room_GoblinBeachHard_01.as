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
   
   [Embed(source="/_assets/assets.swf", symbol="symbol1220")]
   public dynamic class a_Room_GoblinBeachHard_01 extends MovieClip
   {
      
      public var am_Goblin:ac_GoblinArmorAxe;
      
      public var am_G1:ac_GoblinArmorSword;
      
      public var am_G2:ac_GoblinHatchet;
      
      public var am_G3:ac_GoblinArmorAxe;
      
      public var am_CollisionObject:MovieClip;
      
      public var am_Parrot:ac_Parrot;
      
      public var am_Flier4:ac_PsychophageBaby;
      
      public var __id302_:ac_GoblinHatchet;
      
      public var am_Flier3:ac_PsychophageBaby;
      
      public var am_Flier2:ac_PsychophageBaby;
      
      public var am_Foreground:MovieClip;
      
      public var am_Flier1:ac_PsychophageBaby;
      
      public var Script_OpeningScene:Array;
      
      public function a_Room_GoblinBeachHard_01()
      {
         super();
         addFrameScript(0,this.frame1);
         this.__setProp___id302__a_Room_GoblinBeachHard_01_Details();
         this.__setProp_am_G2_a_Room_GoblinBeachHard_01_cues_0();
         this.__setProp_am_Parrot_a_Room_GoblinBeachHard_01_Layer3_0();
      }
      
      public function InitRoom(param1:a_GameHook) : void
      {
         this.am_Flier1.bHoldSpawn = true;
         this.am_Flier2.bHoldSpawn = true;
         this.am_Flier3.bHoldSpawn = true;
         this.am_Flier4.bHoldSpawn = true;
         param1.initialPhase = this.UpdateIntro;
      }
      
      public function UpdateIntro(param1:a_GameHook) : void
      {
         if(param1.AtTime(0))
         {
            param1.PlayScript(this.Script_OpeningScene);
         }
         if(param1.AtTime(2600))
         {
            this.am_G1.Aggro();
            this.am_G2.Aggro();
            this.am_G3.Aggro();
         }
         if(this.am_Goblin.Health() < 1)
         {
            param1.SetPhase(this.UpdateFliers);
         }
      }
      
      public function UpdateFliers(param1:a_GameHook) : void
      {
         if(param1.AtTime(2000))
         {
            this.am_Flier1.Spawn();
            this.am_Flier1.DeepSleep();
            this.am_Flier1.Skit("<Goto Red 2>");
         }
         if(param1.AtTime(4000))
         {
            this.am_Flier1.Aggro();
         }
         if(param1.AtTime(3500))
         {
            this.am_Flier3.Spawn();
            this.am_Flier3.DeepSleep();
            this.am_Flier3.Skit("<Goto Red 3>");
         }
         if(param1.AtTime(6000))
         {
            this.am_Flier3.Aggro();
         }
         if(param1.AtTime(5000))
         {
            this.am_Flier2.Spawn();
            this.am_Flier2.DeepSleep();
            this.am_Flier2.Skit("<Goto Red 3>");
         }
         if(param1.AtTime(8500))
         {
            this.am_Flier2.Aggro();
         }
         if(param1.AtTime(6100))
         {
            this.am_Flier4.Spawn();
            this.am_Flier4.DeepSleep();
            this.am_Flier4.Skit("<Goto Red 2>");
         }
         if(param1.AtTime(8000))
         {
            param1.SetPhase(null);
            this.am_Flier4.Aggro();
         }
      }
      
      internal function __setProp___id302__a_Room_GoblinBeachHard_01_Details() : *
      {
         try
         {
            this.__id302_["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.__id302_.characterName = "";
         this.__id302_.displayName = "";
         this.__id302_.dramaAnim = "";
         this.__id302_.itemDrop = "";
         this.__id302_.sayOnActivate = "";
         this.__id302_.sayOnAlert = "He freed to bird:I was gonna eat that for dinner!";
         this.__id302_.sayOnBloodied = "";
         this.__id302_.sayOnDeath = "";
         this.__id302_.sayOnInteract = "";
         this.__id302_.sayOnSpawn = "";
         this.__id302_.sleepAnim = "";
         this.__id302_.team = "default";
         this.__id302_.waitToAggro = 0;
         try
         {
            this.__id302_["componentInspectorSetting"] = false;
         }
         catch(e:Error)
         {
         }
      }
      
      internal function __setProp_am_G2_a_Room_GoblinBeachHard_01_cues_0() : *
      {
         try
         {
            this.am_G2["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.am_G2.characterName = "";
         this.am_G2.displayName = "";
         this.am_G2.dramaAnim = "";
         this.am_G2.itemDrop = "";
         this.am_G2.sayOnActivate = "";
         this.am_G2.sayOnAlert = "The Kraken Slayer!:Cut him|her to pieces!";
         this.am_G2.sayOnBloodied = "";
         this.am_G2.sayOnDeath = "";
         this.am_G2.sayOnInteract = "";
         this.am_G2.sayOnSpawn = "";
         this.am_G2.sleepAnim = "";
         this.am_G2.team = "default";
         this.am_G2.waitToAggro = 0;
         try
         {
            this.am_G2["componentInspectorSetting"] = false;
         }
         catch(e:Error)
         {
         }
      }
      
      internal function __setProp_am_Parrot_a_Room_GoblinBeachHard_01_Layer3_0() : *
      {
         try
         {
            this.am_Parrot["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.am_Parrot.characterName = "";
         this.am_Parrot.displayName = "";
         this.am_Parrot.dramaAnim = "";
         this.am_Parrot.itemDrop = "";
         this.am_Parrot.sayOnActivate = "";
         this.am_Parrot.sayOnAlert = "";
         this.am_Parrot.sayOnBloodied = "";
         this.am_Parrot.sayOnDeath = "";
         this.am_Parrot.sayOnInteract = "";
         this.am_Parrot.sayOnSpawn = "";
         this.am_Parrot.sleepAnim = "";
         this.am_Parrot.team = "neutral";
         this.am_Parrot.waitToAggro = 0;
         try
         {
            this.am_Parrot["componentInspectorSetting"] = false;
         }
         catch(e:Error)
         {
         }
      }
      
      internal function frame1() : *
      {
         this.Script_OpeningScene = ["0 Camera 1","4 Parrot <Scared> Hey, #tn#!","6 Parrot <Panic> This time you\'re on your own!","6 Parrot <Goto Red 1>","4 Camera Free","6 RemoveCue Parrot"];
      }
   }
}

