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
   
   [Embed(source="/_assets/assets.swf", symbol="symbol598")]
   public dynamic class a_Room_Tutorial_05_ALT extends MovieClip
   {
      
      public var am_CollisionObject:MovieClip;
      
      public var am_Parrot:ac_IntroParrot;
      
      public var am_WaveTwo:MovieClip;
      
      public var am_WaveBoss:ac_TreasureChestEmpty;
      
      public var am_WaveOne:MovieClip;
      
      public var am_Foreground:MovieClip;
      
      public var am_Background:MovieClip;
      
      public var Script_OpeningScene:Array;
      
      public var Script_Ambush:Array;
      
      public var Script_RoomCleared:Array;
      
      public var Script_SkipTheChest:Array;
      
      public var bChestOpened:Boolean;
      
      public function a_Room_Tutorial_05_ALT()
      {
         super();
         addFrameScript(0,this.frame1);
         this.__setProp_am_WaveBoss_a_Room_Tutorial_05_ALT_cues_0();
         this.__setProp_am_Parrot_a_Room_Tutorial_05_ALT_cues_0();
      }
      
      public function InitRoom(param1:a_GameHook) : void
      {
         param1.initialPhase = this.FirstTick;
         this.bChestOpened = false;
      }
      
      public function FirstTick(param1:a_GameHook) : void
      {
         param1.PlayScript(this.Script_OpeningScene);
         param1.SetPhase(this.ChestRoomTick);
      }
      
      public function ChestRoomTick(param1:a_GameHook) : void
      {
         if(param1.OnTrigger("am_Trigger_Skip"))
         {
            param1.PlayScript(this.Script_SkipTheChest);
         }
         if(this.am_WaveBoss.Defeated() && !this.bChestOpened)
         {
            param1.CancelScript(this.Script_SkipTheChest);
            this.bChestOpened = true;
            param1.CollisionOff("am_DynamicCollision_PathBlock02");
            param1.PlayScript(this.Script_Ambush);
         }
         if(param1.RoomCleared())
         {
            param1.CancelScript(this.Script_Ambush);
            param1.PlayScript(this.Script_RoomCleared);
            param1.SetPhase(null);
         }
      }
      
      internal function __setProp_am_WaveBoss_a_Room_Tutorial_05_ALT_cues_0() : *
      {
         try
         {
            this.am_WaveBoss["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.am_WaveBoss.characterName = "";
         this.am_WaveBoss.displayName = "";
         this.am_WaveBoss.dramaAnim = "";
         this.am_WaveBoss.itemDrop = "Gold_2";
         this.am_WaveBoss.sayOnActivate = "";
         this.am_WaveBoss.sayOnAlert = "";
         this.am_WaveBoss.sayOnBloodied = "";
         this.am_WaveBoss.sayOnDeath = "";
         this.am_WaveBoss.sayOnInteract = "";
         this.am_WaveBoss.sayOnSpawn = "";
         this.am_WaveBoss.sleepAnim = "";
         this.am_WaveBoss.team = "default";
         this.am_WaveBoss.waitToAggro = 0;
         try
         {
            this.am_WaveBoss["componentInspectorSetting"] = false;
         }
         catch(e:Error)
         {
         }
      }
      
      internal function __setProp_am_Parrot_a_Room_Tutorial_05_ALT_cues_0() : *
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
         this.Script_OpeningScene = ["0 Parrot <Scared>A treasure chest!+3:<Goto Red 9>+5:Too bad I dont have pockets.+13Open it with your weapon!"];
         this.Script_Ambush = ["0 Parrot <Panic>Look out!+2:<Goto Red 10>"];
         this.Script_RoomCleared = ["0 Parrot You should be more careful!","3 Parrot <Goto Red 11>+3:<Goto Red 12>"];
         this.Script_SkipTheChest = ["0 Parrot <Panic>Hey come back!+6:Open it with your weapon."];
         this.bChestOpened = false;
      }
   }
}

