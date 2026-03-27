package
{
   import flash.display.MovieClip;
   
   [Embed(source="/_assets/assets.swf", symbol="symbol810")]
   public dynamic class a_Room_Tutorial_02 extends MovieClip
   {
      
      public var am_Torch3:MovieClip;
      
      public var am_Torch2:MovieClip;
      
      public var am_Torch1:MovieClip;
      
      public var am_CollisionObject:MovieClip;
      
      public var am_Glow2:MovieClip;
      
      public var am_Parrot:ac_IntroParrot;
      
      public var am_Glow3:MovieClip;
      
      public var am_Glow1:MovieClip;
      
      public var am_Dummy3:ac_IntroDummy3;
      
      public var am_Dummy2:ac_IntroDummy2;
      
      public var am_Gate:MovieClip;
      
      public var am_Doorway:MovieClip;
      
      public var am_Dummy1:ac_IntroDummy1;
      
      public var am_Foreground:MovieClip;
      
      public var Script_OpeningScene:Array;
      
      public var Script_TheDoorIsClosed:Array;
      
      public var Script_HeyLookADummy:Array;
      
      public var Script_TryAttackingIt:Array;
      
      public var Script_ExplainFirstPower:Array;
      
      public var Script_ExplainFirstPowerAlternate:Array;
      
      public var Script_ExplainSecondPower:Array;
      
      public var Script_RoomCompleted:Array;
      
      public var Script_Shake:Array;
      
      public var bDummyOneDead:Boolean;
      
      public var bDummyOneHandled:Boolean;
      
      public var bDummyTwoHandled:Boolean;
      
      public var bDummyThreeHandled:Boolean;
      
      public var bExplainationFinsihed:Boolean;
      
      public function a_Room_Tutorial_02()
      {
         super();
         addFrameScript(0,this.frame1);
      }
      
      public function InitRoom(param1:a_GameHook) : void
      {
         param1.initialPhase = this.FirstTick;
         this.am_Dummy1.bHoldSpawn = true;
         this.am_Dummy2.bHoldSpawn = true;
         this.am_Dummy3.bHoldSpawn = true;
         this.bDummyOneDead = false;
         this.bDummyOneHandled = false;
         this.bDummyTwoHandled = false;
         this.bDummyThreeHandled = false;
         this.bExplainationFinsihed = false;
      }
      
      public function FirstTick(param1:a_GameHook) : void
      {
         param1.PlayScript(this.Script_OpeningScene);
         param1.SetPhase(this.WaitingOnDummiesTick);
         param1.Animate("am_Glow1","Off",true);
         param1.Animate("am_Glow2","Off",true);
         param1.Animate("am_Glow3","Off",true);
         param1.Animate("am_Torch1","Off",true);
         param1.Animate("am_Torch2","Off",true);
         param1.Animate("am_Torch3","Off",true);
      }
      
      public function WaitingOnDummiesTick(param1:a_GameHook) : void
      {
         if(param1.OnScriptFinish(this.Script_OpeningScene))
         {
            param1.PlayScript(this.Script_TheDoorIsClosed);
         }
         if(param1.OnScriptFinish(this.Script_TheDoorIsClosed))
         {
            param1.SetPhase(this.CombosTick);
         }
      }
      
      public function CombosTick(param1:a_GameHook) : void
      {
         if(param1.AtTime(0))
         {
            this.am_Dummy1.Spawn();
            param1.PlayScript(this.Script_Shake);
            param1.PlayScript(this.Script_HeyLookADummy);
            param1.ShowTutorial("am_HighlighterManaBar");
         }
         if(!this.bDummyOneHandled && this.DummyDefeated(this.am_Dummy1))
         {
            this.bDummyOneHandled = true;
            this.bDummyOneDead = true;
            param1.CancelScript(this.Script_HeyLookADummy);
            param1.CancelScript(this.Script_TryAttackingIt);
            if(this.bExplainationFinsihed)
            {
               param1.PlayScript(this.Script_ExplainFirstPower);
            }
            else
            {
               param1.PlayScript(this.Script_ExplainFirstPowerAlternate);
            }
            param1.HideTutorial("am_HighlighterManaBar");
            param1.Animate("am_Glow1","Off",false);
            param1.Animate("am_Torch1","Off",false);
            param1.PlaySound("a_Sound_Fireball_Big");
         }
         if(param1.OnScriptFinish(this.Script_HeyLookADummy) && !this.bDummyOneDead)
         {
            param1.PlayScript(this.Script_TryAttackingIt);
         }
         if(param1.OnScriptFinish(this.Script_ExplainFirstPower) || param1.OnScriptFinish(this.Script_ExplainFirstPowerAlternate))
         {
            param1.SetPhase(this.FirstPowerTick);
            return;
         }
         if(param1.OnScriptFinish(this.Script_TryAttackingIt))
         {
            this.bExplainationFinsihed = true;
         }
         if(param1.AtTimeRepeat(12000) && this.bExplainationFinsihed && !this.bDummyOneDead)
         {
            param1.PlayScript(this.Script_TryAttackingIt);
         }
      }
      
      public function FirstPowerTick(param1:a_GameHook) : void
      {
         if(param1.AtTime(0))
         {
            this.am_Dummy1.Remove();
            this.am_Dummy2.Spawn();
            param1.PlayScript(this.Script_Shake);
            param1.ShowTutorial("am_HighlighterPower1");
         }
         if(!this.bDummyTwoHandled && this.DummyDefeated(this.am_Dummy2))
         {
            this.bDummyTwoHandled = true;
            param1.HideTutorial("am_HighlighterPower1");
            param1.PlayScript(this.Script_ExplainSecondPower);
            param1.Animate("am_Glow2","Off",false);
            param1.Animate("am_Torch2","Off",false);
            param1.PlaySound("a_Sound_Fireball_Big");
         }
         if(param1.OnScriptFinish(this.Script_ExplainSecondPower))
         {
            param1.SetPhase(this.SecondPowerTick);
         }
      }
      
      public function SecondPowerTick(param1:a_GameHook) : void
      {
         if(param1.AtTime(0))
         {
            this.am_Dummy2.Remove();
            this.am_Dummy3.Spawn();
            param1.PlayScript(this.Script_Shake);
            param1.ShowTutorial("am_HighlighterPower2");
         }
         if(!this.bDummyThreeHandled && this.DummyDefeated(this.am_Dummy3))
         {
            this.bDummyThreeHandled = true;
            param1.HideTutorial("am_HighlighterPower2");
            param1.CollisionOff("am_DynamicCollision_GateBlock");
            param1.PlayScript(this.Script_RoomCompleted);
            param1.Animate("am_Glow3","Off",false);
            param1.Animate("am_Torch3","Off",false);
            param1.PlaySound("a_Sound_Fireball_Big");
            param1.PlayScript(this.Script_Shake);
            param1.Animate("am_Gate","Open",true);
            param1.SetPhase(null);
         }
      }
      
      public function DummyDefeated(param1:a_Cue) : Boolean
      {
         return param1.bSpawned && (param1.OnDefeat() || param1.Defeated() || param1.Health() <= 0);
      }
      
      internal function frame1() : *
      {
         this.Script_OpeningScene = ["0 Parrot <Goto Red 24>","4 Parrot Phew that was close!","4 Player Lets keep going.","2 Parrot <Goto Red 4>","6 End"];
         this.Script_TheDoorIsClosed = ["6 Parrot <Panic>Uh oh the door is closed.","6 End"];
         this.Script_HeyLookADummy = ["0 Parrot <Goto Red 15>","4 Parrot <Scared>Whoa look at that!","6 Parrot A training DUMMY.","6 End"];
         this.Script_TryAttackingIt = ["0 Parrot Try attacking it!"];
         this.Script_ExplainFirstPower = ["0 Parrot <Goto Red 16>","1 Parrot <Panic>Great!","8 Parrot Try using your FIRST ability.","2 End"];
         this.Script_ExplainFirstPowerAlternate = ["0 Parrot <Goto Red 16>","1 Parrot <Panic>Ha ha looks like you know what you are doing!","10 Parrot Try using your FIRST ability.","2 End"];
         this.Script_ExplainSecondPower = ["0 Parrot <Goto Red 17>","1 Parrot <Panic>You\'re a natural!","10 Parrot Now try using your SECOND ability.","10 Parrot Remember, build up your mana bar with basic attacks.","8 Parrot Then spend mana on your special attacks.","2 End"];
         this.Script_RoomCompleted = ["2 Parrot <Scared>Hey the door opened!","4 Parrot <Goto Red 5>","6 Player We\'ve got to hurry, come on!","5 RemoveCue Parrot"];
         this.Script_Shake = ["0 Shake 10"];
         this.bDummyOneDead = false;
         this.bDummyOneHandled = false;
         this.bDummyTwoHandled = false;
         this.bDummyThreeHandled = false;
         this.bExplainationFinsihed = false;
      }
   }
}

