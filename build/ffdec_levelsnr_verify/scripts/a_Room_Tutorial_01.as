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
   
   [Embed(source="/_assets/assets.swf", symbol="symbol769")]
   public dynamic class a_Room_Tutorial_01 extends MovieClip
   {
      
      public var am_Goblin:ac_IntroGoblinClub;
      
      public var am_CollisionObject:MovieClip;
      
      public var am_Goblin2:ac_IntroGoblinDagger;
      
      public var am_Goblin3:ac_IntroGoblinDagger;
      
      public var am_Goblin4:ac_IntroGoblinArmorSword;
      
      public var am_ChainGlow:a_Animation_EB_ChainsGlow;
      
      public var am_Goblin5:ac_IntroGoblinClub;
      
      public var am_Parrot:ac_IntroParrot;
      
      public var am_Goblin6:ac_IntroGoblinDagger;
      
      public var am_Chains:ac_Chains02;
      
      public var am_Foreground:MovieClip;
      
      public var Script_OpeningScene:Array;
      
      public var Script_SetMeFree:Array;
      
      public var Script_ParrotAsksForHelp:Array;
      
      public var Script_ParrotHelpRepeat:Array;
      
      public var Script_ParrotSaysThanks:Array;
      
      public var Script_ParrotSaysLookOut:Array;
      
      public var Script_ParrotSaysLetsGo:Array;
      
      public var Script_ComeOn:Array;
      
      public var bTriggerTripped:Boolean;
      
      public function a_Room_Tutorial_01()
      {
         super();
         addFrameScript(0,this.frame1);
         this.__setProp_am_Goblin4_a_Room_Tutorial_01_cues_0();
      }
      
      public function InitRoom(param1:a_GameHook) : void
      {
         param1.initialPhase = this.FirstTick;
         this.am_Goblin3.sayOnActivate = "Get him!|her!";
      }
      
      public function FirstTick(param1:a_GameHook) : void
      {
         param1.PlayScript(this.Script_OpeningScene);
         param1.SetPhase(this.IntroTick);
      }
      
      public function IntroTick(param1:a_GameHook) : void
      {
         if(param1.OnScriptFinish(this.Script_OpeningScene))
         {
            this.am_Goblin.Aggro();
            this.am_Goblin2.Aggro();
            this.am_Goblin3.Aggro();
         }
         if(this.am_Goblin.Defeated() && this.am_Goblin2.Defeated() && this.am_Goblin3.Defeated())
         {
            param1.CollisionOff("am_DynamicCollision_GoblinFight");
            if(!this.am_Chains.Defeated())
            {
               param1.SetPhase(this.WaitForBreakChains);
            }
            else
            {
               param1.SetPhase(this.ExitingRoom);
            }
         }
      }
      
      public function WaitForBreakChains(param1:a_GameHook) : void
      {
         if(param1.AtTime(0))
         {
            param1.PlayScript(this.Script_ParrotAsksForHelp);
            if(!this.am_Chains.Defeated())
            {
               param1.Animate("am_ChainsTut","Show",true);
               param1.Animate("am_ChainGlow","Glow",true);
            }
         }
         if(param1.AtTimeRepeat(11000))
         {
            param1.PlayScript(this.Script_ParrotHelpRepeat);
         }
         if(this.am_Chains.Defeated())
         {
            param1.Animate("am_ChainsTut","Remove",true);
            param1.Animate("am_ChainGlow","Remove",true);
            param1.SetPhase(this.ExitingRoom);
         }
      }
      
      public function ExitingRoom(param1:a_GameHook) : void
      {
         if(param1.AtTime(0))
         {
            param1.CollisionOff("am_DynamicCollision_WaitingForHelp");
            param1.PlayScript(this.Script_ParrotSaysThanks);
         }
         if(param1.AtTimeRepeat(8000) && !this.bTriggerTripped)
         {
            param1.PlayScript(this.Script_ComeOn);
         }
         if(param1.OnTrigger("am_Trigger_LookOut"))
         {
            this.bTriggerTripped = true;
            param1.CancelScript(this.Script_ComeOn);
            param1.CancelScript(this.Script_ParrotSaysThanks);
            if(!this.am_Goblin4.Defeated() || !this.am_Goblin5.Defeated() || !this.am_Goblin6.Defeated())
            {
               param1.PlayScript(this.Script_ParrotSaysLookOut);
            }
            this.am_Goblin4.Aggro();
            this.am_Goblin5.Aggro();
            this.am_Goblin6.Aggro();
         }
         if(param1.RoomCleared())
         {
            if(!this.bTriggerTripped)
            {
               param1.PlayScript(this.Script_ParrotSaysLetsGo);
            }
            param1.CollisionOff("am_DynamicCollision_BodyBlock");
            param1.CollisionOff("am_DynamicCollision_CamBlock");
            param1.SetPhase(null);
         }
      }
      
      internal function __setProp_am_Goblin4_a_Room_Tutorial_01_cues_0() : *
      {
         try
         {
            this.am_Goblin4["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.am_Goblin4.characterName = "";
         this.am_Goblin4.displayName = "";
         this.am_Goblin4.dramaAnim = "";
         this.am_Goblin4.itemDrop = "";
         this.am_Goblin4.sayOnActivate = "";
         this.am_Goblin4.sayOnAlert = "It\'s the human who killed our Kraken!";
         this.am_Goblin4.sayOnBloodied = "";
         this.am_Goblin4.sayOnDeath = "";
         this.am_Goblin4.sayOnInteract = "";
         this.am_Goblin4.sayOnSpawn = "";
         this.am_Goblin4.sleepAnim = "";
         this.am_Goblin4.team = "default";
         this.am_Goblin4.waitToAggro = 0;
         try
         {
            this.am_Goblin4["componentInspectorSetting"] = false;
         }
         catch(e:Error)
         {
         }
      }
      
      internal function frame1() : *
      {
         this.Script_OpeningScene = ["2 Goblin2 Let\'s eat it!","4 Parrot <Scared>Squaaakkkkk!","4 Goblin Look! An intruder!"];
         this.Script_SetMeFree = ["0 Parrot <Panic>Hey where are you going!?"];
         this.Script_ParrotAsksForHelp = ["0 Parrot The goblins caught me spying!+6:Help me!+6:Try breaking these CHAINS with your weapon."];
         this.Script_ParrotHelpRepeat = ["0 Parrot <Panic>Break these CHAINS with your weapon"];
         this.Script_ParrotSaysThanks = ["0 Parrot Phew thanks!","2 Parrot <Goto Red 3>","8 Player Did those goblins have a prisoner with them?","10 Parrot Yes! They caught her on the beach! She\'s this way!"];
         this.Script_ParrotSaysLookOut = ["0 Parrot <Panic>Look out!","2 Parrot <Goto Red 2>","6 RemoveCue Parrot"];
         this.Script_ParrotSaysLetsGo = ["0 Parrot <Goto Red 2>","6 RemoveCue Parrot"];
         this.Script_ComeOn = ["0 Parrot <Panic>Come on lets go!"];
         this.bTriggerTripped = false;
      }
   }
}

