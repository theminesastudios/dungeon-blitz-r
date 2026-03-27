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
   
   [Embed(source="/_assets/assets.swf", symbol="symbol929")]
   public dynamic class a_Room_NRIMR03 extends MovieClip
   {
      
      public var am_Goblin:ac_IntroGoblinNPC;
      
      public var am_Torch1:MovieClip;
      
      public var am_Goblin1:ac_IntroGoblinClub;
      
      public var am_CollisionObject:MovieClip;
      
      public var am_Goblin2:ac_IntroGoblinDagger;
      
      public var am_Goblin3:ac_IntroGoblinBrute;
      
      public var am_Goblin4:ac_IntroGoblinDagger;
      
      public var am_Goblin5:ac_IntroGoblinDagger;
      
      public var am_Parrot:ac_IntroParrot;
      
      public var am_Goblin6:ac_IntroGoblinDagger;
      
      public var am_Glow1:MovieClip;
      
      public var am_Goblin7:ac_IntroGoblinDagger;
      
      public var am_Goblin8:ac_IntroGoblinClub;
      
      public var am_Gate:a_Animation_GoblinGate2;
      
      public var am_Foreground:MovieClip;
      
      public var Script_OpeningScene:Array;
      
      public var Script_OpenDoor:Array;
      
      public var Script_AdvanceGoblin:Array;
      
      public var Script_Password:Array;
      
      public var Script_LetMeTry:Array;
      
      public var Script_GoodJobEmote:Array;
      
      public var Script_DelayShake:Array;
      
      public var Script_Shake:Array;
      
      public var bGoblinPromptStarted:Boolean;
      
      public var bEmoteTutorialShown:Boolean;
      
      public function a_Room_NRIMR03()
      {
         super();
         addFrameScript(0,this.frame1);
         this.__setProp_am_Parrot_a_Room_NRIMR03_cues_0();
         this.__setProp_am_Goblin_a_Room_NRIMR03_cues_0();
         this.__setProp_am_Goblin3_a_Room_NRIMR03_cues_0();
      }
      
      public function InitRoom(param1:a_GameHook) : void
      {
         this.bGoblinPromptStarted = false;
         this.bEmoteTutorialShown = false;
         param1.initialPhase = this.FirstTick;
      }
      
      public function FirstTick(param1:a_GameHook) : void
      {
         param1.Animate("am_Glow1","Off",true);
         param1.Animate("am_Torch1","Off",true);
         param1.SetPhase(this.ClearRoomTick);
         param1.PlayScript(this.Script_OpeningScene);
      }
      
      public function ClearRoomTick(param1:a_GameHook) : void
      {
         if(this.am_Goblin1.Defeated() && this.am_Goblin2.Defeated() && this.am_Goblin3.Defeated() && this.am_Goblin4.Defeated() && this.am_Goblin5.Defeated())
         {
            param1.CollisionOff("am_DynamicCollision_PathBlock01");
            param1.SetPhase(this.WaitingOnGoblin);
         }
      }
      
      public function WaitingOnGoblin(param1:a_GameHook) : void
      {
         if(!this.bGoblinPromptStarted && (param1.OnTrigger("am_Trigger_Goblin") || param1.AtTime(2500)))
         {
            this.bGoblinPromptStarted = true;
            param1.PlayScript(this.Script_OpenDoor);
         }
         if(param1.OnScriptFinish(this.Script_OpenDoor))
         {
            param1.Animate("am_Gate","Open",true);
            param1.PlayScript(this.Script_Shake);
            param1.PlayScript(this.Script_AdvanceGoblin);
         }
         if(param1.OnScriptFinish(this.Script_AdvanceGoblin))
         {
            param1.Animate("am_Gate","Close",true);
            param1.PlayScript(this.Script_DelayShake);
            param1.PlayScript(this.Script_Password);
            param1.SetPhase(this.WaitingOnEmoteTick);
         }
      }
      
      public function WaitingOnEmoteTick(param1:a_GameHook) : void
      {
         if(param1.AtTime(6300))
         {
            this.bEmoteTutorialShown = true;
            param1.ShowTutorial("am_HighlighterEmote");
         }
         if(param1.OnScriptFinish(this.Script_Password) || param1.AtTime(40000))
         {
            param1.PlayScript(this.Script_LetMeTry);
         }
         if(this.bEmoteTutorialShown && param1.OnEmote("Cheer L"))
         {
            param1.HideTutorial("am_HighlighterEmote");
            param1.CancelScript(this.Script_Password);
            param1.CancelScript(this.Script_LetMeTry);
            param1.Animate("am_Glow1","Off",false);
            param1.Animate("am_Torch1","Off",false);
            param1.PlaySound("a_Sound_Fireball_Big");
            param1.PlayScript(this.Script_GoodJobEmote);
            param1.CollisionOff("am_DynamicCollision_PathBlock02");
            param1.PlayScript(this.Script_Shake);
            param1.Animate("am_Gate","Open",true);
            param1.SetPhase(null);
         }
      }
      
      internal function __setProp_am_Parrot_a_Room_NRIMR03_cues_0() : *
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
      
      internal function __setProp_am_Goblin_a_Room_NRIMR03_cues_0() : *
      {
         try
         {
            this.am_Goblin["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.am_Goblin.characterName = "";
         this.am_Goblin.displayName = "";
         this.am_Goblin.dramaAnim = "";
         this.am_Goblin.itemDrop = "";
         this.am_Goblin.sayOnActivate = "";
         this.am_Goblin.sayOnAlert = "";
         this.am_Goblin.sayOnBloodied = "";
         this.am_Goblin.sayOnDeath = "";
         this.am_Goblin.sayOnInteract = "";
         this.am_Goblin.sayOnSpawn = "";
         this.am_Goblin.sleepAnim = "";
         this.am_Goblin.team = "neutral";
         this.am_Goblin.waitToAggro = 0;
         try
         {
            this.am_Goblin["componentInspectorSetting"] = false;
         }
         catch(e:Error)
         {
         }
      }
      
      internal function __setProp_am_Goblin3_a_Room_NRIMR03_cues_0() : *
      {
         try
         {
            this.am_Goblin3["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.am_Goblin3.characterName = "";
         this.am_Goblin3.displayName = "";
         this.am_Goblin3.dramaAnim = "";
         this.am_Goblin3.itemDrop = "";
         this.am_Goblin3.sayOnActivate = "The Kraken Slayer!: Avenge our fallen war beast!";
         this.am_Goblin3.sayOnAlert = "";
         this.am_Goblin3.sayOnBloodied = "";
         this.am_Goblin3.sayOnDeath = "";
         this.am_Goblin3.sayOnInteract = "";
         this.am_Goblin3.sayOnSpawn = "";
         this.am_Goblin3.sleepAnim = "";
         this.am_Goblin3.team = "default";
         this.am_Goblin3.waitToAggro = 0;
         try
         {
            this.am_Goblin3["componentInspectorSetting"] = false;
         }
         catch(e:Error)
         {
         }
      }
      
      internal function frame1() : *
      {
         this.Script_OpeningScene = ["0 Parrot Lets go!","4 Parrot <Goto Red 20>"];
         this.Script_OpenDoor = ["0 Parrot <Goto Red 21>","2 Goblin Now what was that PASSWORD?","8 Goblin Oh yeah! You have to CHEER in front of the door.","6 Goblin <Cheer>","4 End"];
         this.Script_AdvanceGoblin = ["0 Goblin <Goto Red 23>","12 RemoveCue Goblin"];
         this.Script_Password = ["4 Parrot Hmmm looks like there is a password.","8 Parrot The goblin CHEERED and the door opened.","10 Parrot That must be it! Try CHEERING.","2 End"];
         this.Script_LetMeTry = ["0 Parrot Let me try!","2 Parrot <Panic>","2 Parrot <Panic>","1 End"];
         this.Script_GoodJobEmote = ["4 Parrot <Panic>Woo hoo!","6 Player She can\'t be much further.","2 Parrot <Goto Red 23>","9 RemoveCue Parrot"];
         this.Script_DelayShake = ["3 Shake 10"];
         this.Script_Shake = ["0 Shake 10"];
      }
   }
}

