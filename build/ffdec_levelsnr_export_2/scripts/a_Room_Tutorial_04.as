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
   
   [Embed(source="/_assets/assets.swf", symbol="symbol997")]
   public dynamic class a_Room_Tutorial_04 extends MovieClip
   {
      
      public var am_CollisionObject:MovieClip;
      
      public var am_Parrot:ac_IntroParrot;
      
      public var __id426_:ac_IntroGoblinBrute;
      
      public var am_Foreground:MovieClip;
      
      public var am_Background:MovieClip;
      
      public var Script_OpeningScene:Array;
      
      public var Script_JumpSlow:Array;
      
      public var Script_JumpFast:Array;
      
      public var Script_Fall:Array;
      
      public var Script_FindDoor:Array;
      
      public function a_Room_Tutorial_04()
      {
         super();
         addFrameScript(0,this.frame1);
         this.__setProp___id426__a_Room_Tutorial_04_cues_0();
         this.__setProp_am_Parrot_a_Room_Tutorial_04_cues_0();
      }
      
      public function InitRoom(param1:a_GameHook) : void
      {
         param1.initialPhase = this.FirstTick;
      }
      
      public function FirstTick(param1:a_GameHook) : void
      {
         if(param1.OnTrigger("am_Trigger_Fall1"))
         {
            param1.PlayScript(this.Script_Fall);
         }
         param1.OnTrigger("am_Trigger_1");
         param1.PlayScript(this.Script_OpeningScene);
         param1.SetPhase(this.WaitingForJump);
      }
      
      public function WaitingForJump(param1:a_GameHook) : void
      {
         if(param1.OnScriptFinish(this.Script_OpeningScene))
         {
            param1.Animate("am_JumpTut","Show",true);
         }
         if(param1.OnTrigger("am_Trigger_Fall2"))
         {
            param1.PlayScript(this.Script_Fall);
         }
         if(param1.OnTrigger("am_Trigger_Fall2"))
         {
            param1.Animate("am_JumpTut","Remove",true);
            param1.Animate("am_DropTut","Show",true);
            param1.CancelScript(this.Script_OpeningScene);
            param1.CancelScript(this.Script_Fall);
            if(param1.GetTime() < 3000)
            {
               param1.PlayScript(this.Script_JumpFast);
            }
            else
            {
               param1.PlayScript(this.Script_JumpSlow);
            }
            param1.SetPhase(this.WaitingForDrop);
         }
      }
      
      public function WaitingForDrop(param1:a_GameHook) : void
      {
         if(param1.OnTrigger("am_Trigger_3"))
         {
            param1.PlayScript(this.Script_Fall);
         }
         if(param1.OnTrigger("am_Trigger_Fall3"))
         {
            param1.Animate("am_DropTut","Remove",true);
            param1.CancelScript(this.Script_JumpFast);
            param1.CancelScript(this.Script_JumpSlow);
            param1.CancelScript(this.Script_Fall);
         }
         if(param1.OnTrigger("am_Trigger_Fall3"))
         {
            param1.PlayScript(this.Script_FindDoor);
         }
         if(param1.OnScriptFinish(this.Script_FindDoor))
         {
            param1.Animate("am_DoorTut","Show",true);
            param1.SetPhase(this.WaitingOnDoor);
         }
      }
      
      public function WaitingOnDoor(param1:a_GameHook) : void
      {
         if(param1.AtTime(15000))
         {
            param1.Animate("am_DoorTut","Remove",true);
            param1.SetPhase(null);
         }
      }
      
      internal function __setProp___id426__a_Room_Tutorial_04_cues_0() : *
      {
         try
         {
            this.__id426_["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.__id426_.characterName = "";
         this.__id426_.displayName = "";
         this.__id426_.dramaAnim = "";
         this.__id426_.itemDrop = "";
         this.__id426_.sayOnActivate = "The human from across the sea!";
         this.__id426_.sayOnAlert = "";
         this.__id426_.sayOnBloodied = "You were a fool to follow us!";
         this.__id426_.sayOnDeath = "";
         this.__id426_.sayOnInteract = "";
         this.__id426_.sayOnSpawn = "";
         this.__id426_.sleepAnim = "";
         this.__id426_.team = "default";
         this.__id426_.waitToAggro = 0;
         try
         {
            this.__id426_["componentInspectorSetting"] = false;
         }
         catch(e:Error)
         {
         }
      }
      
      internal function __setProp_am_Parrot_a_Room_Tutorial_04_cues_0() : *
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
         this.Script_OpeningScene = ["0 Parrot Looks like we have to JUMP!","4 Parrot <Goto Red 6>","2 End"];
         this.Script_JumpSlow = ["0 Parrot Looks like you know what you\'re doing.","2 Parrot <Goto Red 7>"];
         this.Script_JumpFast = ["0 Parrot Looks like you know what you\'re doing.","2 Parrot <Goto Red 7>"];
         this.Script_Fall = ["16 Parrot Be careful not to fall."];
         this.Script_FindDoor = ["0 Parrot <Goto Red 8>","2 Parrot <Scared>Hey look a DOOR!","6 Parrot Maybe she\'s in there.","2 End"];
      }
   }
}

