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
   
   [Embed(source="/_assets/assets.swf", symbol="symbol871")]
   public dynamic class a_Room_NRIMR05_ALT extends MovieClip
   {
      
      public var am_Goblin:ac_IntroGoblinShamanSkullHat;
      
      public var am_Torch3:MovieClip;
      
      public var am_Torch2:MovieClip;
      
      public var am_Torch1:MovieClip;
      
      public var am_CollisionObject:MovieClip;
      
      public var am_Glow2:MovieClip;
      
      public var am_Claw4:a_Animation_GoblinCageClaw;
      
      public var am_Parrot:ac_IntroParrot;
      
      public var am_Glow3:MovieClip;
      
      public var am_Phage3:ac_IntroPsychophageBaby;
      
      public var am_Phage2:ac_IntroPsychophageBaby;
      
      public var am_Glow1:MovieClip;
      
      public var am_Claw3:a_Animation_GoblinCageClaw;
      
      public var am_Phage1:ac_IntroPsychophageBaby;
      
      public var am_Gate:MovieClip;
      
      public var am_TrapEnt:ac_IntroTrap;
      
      public var am_Chest:ac_TreasureChestEmpty;
      
      public var am_Foreground:MovieClip;
      
      public var Script_OpeningScene:Array;
      
      public var Script_GoblinTrapSequence:Array;
      
      public var Script_RoomComplete:Array;
      
      public var Script_ParrotToRed14:Array;
      
      public var Script_BehindYou:Array;
      
      public var Script_OpenGate:Array;
      
      public var Script_KillFlierRepeat:Array;
      
      public var Script_Pause:Array;
      
      public var Script_Shake:Array;
      
      public var bPhageAlive:Boolean;
      
      public var bAtFirstTarget:Boolean;
      
      public var bTrapSequenceStarted:Boolean;
      
      public function a_Room_NRIMR05_ALT()
      {
         super();
         addFrameScript(0,this.frame1);
         this.__setProp_am_Chest_a_Room_NRIMR05_ALT_Cues_0();
         this.__setProp_am_Goblin_a_Room_NRIMR05_ALT_Collisions_0();
      }
      
      public function InitRoom(param1:a_GameHook) : void
      {
         param1.initialPhase = this.FirstTick;
         this.am_Phage1.bHoldSpawn = true;
         this.am_Phage2.bHoldSpawn = true;
         this.am_Phage3.bHoldSpawn = true;
         this.am_TrapEnt.bHoldSpawn = true;
         this.bPhageAlive = true;
         this.bAtFirstTarget = false;
         this.bTrapSequenceStarted = false;
      }
      
      public function FirstTick(param1:a_GameHook) : void
      {
         param1.Animate("am_Glow1","Off",true);
         param1.Animate("am_Glow2","Off",true);
         param1.Animate("am_Glow3","Off",true);
         param1.Animate("am_Torch1","Off",true);
         param1.Animate("am_Torch2","Off",true);
         param1.Animate("am_Torch3","Off",true);
         param1.PlayScript(this.Script_OpeningScene);
         param1.SetPhase(this.WaitingForTrapTick);
      }
      
      public function WaitingForTrapTick(param1:a_GameHook) : void
      {
         if(!this.bTrapSequenceStarted && (param1.OnTrigger("am_Trigger_Trap") || this.am_Chest.OnDefeat() || this.am_Chest.Defeated() || this.am_Chest.Health() <= 0))
         {
            this.bTrapSequenceStarted = true;
            this.am_TrapEnt.Spawn();
            param1.PlayScript(this.Script_GoblinTrapSequence);
         }
         if(param1.OnScriptFinish(this.Script_GoblinTrapSequence))
         {
            param1.CollisionOff("am_DynamicCollision_TrapWall");
            param1.Animate("am_Claw1","Close",true);
            param1.Animate("am_Claw2","Close",true);
            param1.Animate("am_Claw3","Close",true);
            param1.Animate("am_Claw4","Close",true);
            param1.PlayScript(this.Script_Shake);
            param1.SetPhase(this.StartFliersTick);
         }
      }
      
      public function StartFliersTick(param1:a_GameHook) : void
      {
         if(param1.AtTime(1000))
         {
            param1.PlayScript(this.Script_ParrotToRed14);
         }
         if(param1.AtTime(2000))
         {
            this.am_Phage1.Spawn();
            this.am_Phage1.Aggro();
            this.am_Phage1.Goto("Red 19");
            param1.SetPhase(this.KillPhageOneTick);
         }
      }
      
      public function KillPhageOneTick(param1:a_GameHook) : void
      {
         if(param1.AtTimeRepeat(5000) && this.bPhageAlive)
         {
            if(this.bAtFirstTarget)
            {
               this.am_Phage1.Goto("Red 19");
            }
            else
            {
               this.am_Phage1.Goto("Red 28");
            }
            this.bAtFirstTarget = !this.bAtFirstTarget;
         }
         if(param1.AtTimeRepeat(12000) && this.bPhageAlive)
         {
            param1.PlayScript(this.Script_KillFlierRepeat);
         }
         if(this.am_Phage1.OnDefeat())
         {
            this.bPhageAlive = false;
            param1.CancelScript(this.Script_KillFlierRepeat);
            param1.Animate("am_Glow1","Off",false);
            param1.Animate("am_Torch1","Off",false);
            param1.PlaySound("a_Sound_Fireball_Big");
            param1.PlayScript(this.Script_BehindYou);
         }
         if(param1.OnScriptFinish(this.Script_BehindYou))
         {
            this.bPhageAlive = true;
            this.bAtFirstTarget = false;
            this.am_Phage2.Spawn();
            this.am_Phage2.Aggro();
            this.am_Phage2.Goto("Red 27");
            param1.SetPhase(this.KillPhageTwoTick);
            param1.Animate("am_BumpTut","Show",true);
         }
      }
      
      public function KillPhageTwoTick(param1:a_GameHook) : void
      {
         if(param1.AtTimeRepeat(5000) && this.bPhageAlive)
         {
            if(this.bAtFirstTarget)
            {
               this.am_Phage2.Goto("Red 27");
            }
            else
            {
               this.am_Phage2.Goto("Red 18");
            }
            this.bAtFirstTarget = !this.bAtFirstTarget;
         }
         if(this.am_Phage2.OnDefeat())
         {
            this.bPhageAlive = false;
            param1.Animate("am_Glow2","Off",false);
            param1.Animate("am_Torch2","Off",false);
            param1.PlaySound("a_Sound_Fireball_Big");
            param1.PlayScript(this.Script_BehindYou);
            param1.Animate("am_BumpTut","Remove",true);
         }
         if(param1.OnScriptFinish(this.Script_BehindYou))
         {
            this.bPhageAlive = true;
            this.am_Phage3.Spawn();
            this.am_Phage3.Aggro();
            param1.SetPhase(this.KillPhageThreeTick);
         }
      }
      
      public function KillPhageThreeTick(param1:a_GameHook) : void
      {
         if(param1.AtTimeRepeat(5000) && this.bPhageAlive)
         {
            if(this.bAtFirstTarget)
            {
               this.am_Phage3.Goto("Red 19");
            }
            else
            {
               this.am_Phage3.Goto("Red 28");
            }
            this.bAtFirstTarget = !this.bAtFirstTarget;
         }
         if(this.am_Phage3.OnDefeat())
         {
            this.bPhageAlive = false;
            param1.Animate("am_Glow3","Off",false);
            param1.Animate("am_Torch3","Off",false);
            param1.PlaySound("a_Sound_Fireball_Big");
            param1.PlayScript(this.Script_Pause);
         }
         if(param1.OnScriptFinish(this.Script_Pause))
         {
            param1.Animate("am_Claw1","Open",true);
            param1.Animate("am_Claw2","Open",true);
            param1.Animate("am_Claw3","Open",true);
            param1.Animate("am_Claw4","Open",true);
            param1.Animate("am_Parrot","Panic",true);
            this.am_TrapEnt.Remove();
            param1.PlayScript(this.Script_Shake);
            param1.PlayScript(this.Script_OpenGate);
            param1.PlayScript(this.Script_RoomComplete);
         }
         if(param1.OnScriptFinish(this.Script_OpenGate))
         {
            param1.Animate("am_Gate","Open",true);
            param1.CollisionOff("am_DynamicCollision_Gate");
         }
         if(param1.OnScriptFinish(this.Script_RoomComplete))
         {
            param1.SetPhase(null);
         }
      }
      
      internal function __setProp_am_Chest_a_Room_NRIMR05_ALT_Cues_0() : *
      {
         try
         {
            this.am_Chest["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.am_Chest.characterName = "";
         this.am_Chest.displayName = "";
         this.am_Chest.dramaAnim = "";
         this.am_Chest.itemDrop = "Gold_2";
         this.am_Chest.sayOnActivate = "";
         this.am_Chest.sayOnAlert = "";
         this.am_Chest.sayOnBloodied = "";
         this.am_Chest.sayOnDeath = "";
         this.am_Chest.sayOnInteract = "";
         this.am_Chest.sayOnSpawn = "";
         this.am_Chest.sleepAnim = "";
         this.am_Chest.team = "default";
         this.am_Chest.waitToAggro = 0;
         try
         {
            this.am_Chest["componentInspectorSetting"] = false;
         }
         catch(e:Error)
         {
         }
      }
      
      internal function __setProp_am_Goblin_a_Room_NRIMR05_ALT_Collisions_0() : *
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
         this.am_Goblin.sayOnActivate = "I was just kidding!";
         this.am_Goblin.sayOnAlert = "";
         this.am_Goblin.sayOnBloodied = "";
         this.am_Goblin.sayOnDeath = "Well that backfired...";
         this.am_Goblin.sayOnInteract = "";
         this.am_Goblin.sayOnSpawn = "";
         this.am_Goblin.sleepAnim = "";
         this.am_Goblin.team = "default";
         this.am_Goblin.waitToAggro = 0;
         try
         {
            this.am_Goblin["componentInspectorSetting"] = false;
         }
         catch(e:Error)
         {
         }
      }
      
      internal function frame1() : *
      {
         this.Script_OpeningScene = ["0 Parrot <Goto Red 13>","4 Parrot <Scared>More gold those Goblins stole!"];
         this.Script_GoblinTrapSequence = ["0 Parrot <Panic>Uh oh look over there!","6 Camera 4","6 Goblin Mwahahaha gotcha, Kraken Slayer!","6 Goblin <PullLever>Get\'em boys!","5 Camera Free","2 Parrot <Panic> Look out!","0 Player ^t!?","2 End"];
         this.Script_RoomComplete = ["0 Parrot <Panic>Now we\'re talking!","6 Camera 4","4 Goblin Um... thats not good.","6 Camera Free","2 End"];
         this.Script_ParrotToRed14 = ["0 Parrot <Goto Red 14>","4 Parrot <Scared>Yikes! Death Eyes!"];
         this.Script_BehindYou = ["0 Parrot <Panic>Quick behind you!"];
         this.Script_OpenGate = ["8 Shake 10","2 Parrot <Goto Red 30>"];
         this.Script_KillFlierRepeat = ["0 Parrot Shoot him down!"];
         this.Script_Pause = ["4 End"];
         this.Script_Shake = ["0 Shake 20"];
         this.bPhageAlive = true;
         this.bAtFirstTarget = false;
         this.bTrapSequenceStarted = false;
      }
   }
}

