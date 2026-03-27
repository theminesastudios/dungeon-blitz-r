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
   
   [Embed(source="/_assets/assets.swf", symbol="symbol1309")]
   public dynamic class a_Room_SDMission3_08 extends MovieClip
   {
      
      public var am_Minions:MovieClip;
      
      public var am_Moment1_Normal:MovieClip;
      
      public var am_LastMonster:ac_SandSpider;
      
      public var am_Spikes:a_SpikeGroup;
      
      public var am_Moment1_Hard:MovieClip;
      
      public var am_DumbBoss:ac_OutlanderBoss;
      
      public var am_CollisionObject:MovieClip;
      
      public var am_Gate1:a_Animation_DoorSpike;
      
      public var am_Lieutenants:MovieClip;
      
      public var am_Moment_Hard:MovieClip;
      
      public var am_Moment_Normal:MovieClip;
      
      public var am_Boss:ac_OutlanderWyrm;
      
      public var am_AlVaeraz:ac_OutlanderBoss;
      
      public var am_Foreground:MovieClip;
      
      public var Script_AlVaerazDead:Array;
      
      public var Script_HealMe:Array;
      
      public var Script_Welcome:Array;
      
      public const NUMBER_OF_WAVES:int = 3;
      
      public const NUMBER_OF_SPIKES:int = 10;
      
      public const NUMBER_OF_MINIONS:int = 11;
      
      public const NUMBER_OF_LIEUTENANTS:int = 10;
      
      public const SPAWN_MINION_AMOUNT:int = 5;
      
      public const SPAWN_LIEUTENANT_AMOUNT:int = 2;
      
      public var currWave:int;
      
      public var bAlVaerazAlive:Boolean;
      
      public var healTimer:int;
      
      public function a_Room_SDMission3_08()
      {
         super();
         addFrameScript(0,this.frame1);
         this.__setProp_am_AlVaeraz_a_Room_SDMission3_08_Cues_0();
         this.__setProp_am_Boss_a_Room_SDMission3_08_Cues_0();
         this.__setProp_am_DumbBoss_a_Room_SDMission3_08_BossFight_0();
      }
      
      public function InitRoom(param1:a_GameHook) : void
      {
         var _loc2_:a_Cue = null;
         this.am_Boss.displayName = "The Pit Lord";
         this.am_Boss.bHoldSpawn = true;
         this.am_AlVaeraz.bHoldSpawn = true;
         this.am_DumbBoss.bHoldEngage = true;
         var _loc3_:int = 0;
         while(_loc3_ < this.NUMBER_OF_MINIONS)
         {
            _loc2_ = this.am_Minions["am_M" + _loc3_] as a_Cue;
            _loc2_.bHoldSpawn = true;
            _loc3_++;
         }
         _loc3_ = 0;
         while(_loc3_ < this.NUMBER_OF_LIEUTENANTS)
         {
            _loc2_ = this.am_Lieutenants["am_L" + _loc3_] as a_Cue;
            _loc2_.bHoldSpawn = true;
            _loc3_++;
         }
         param1.bossFightPhase = null;
         param1.bBossBarOnBottom = true;
         param1.initialPhase = this.UpdateIntro;
         param1.bossFightBeginsWhenThisGuyIsDead = "am_LastMonster";
         param1.cutSceneStartBoss = ["1 Camera 3","4 Boss <Goto Red 1>","8 Boss Everything I\'ve heard about you seems true, #tn#.","12 Player Then you know I\'ve slain the greatest of your kind already.","12 Boss I know. But my brothers didn\'t have my vision.","12 Boss They didn\'t have a trained Champion to fight for them.","12 Boss Come to my side Al\'Vaeraz","1 AlVaeraz <Goto Red 2>","12 Boss Show this would-be slayer why you\'re my prize possession.","12 AlVaeraz With pleasure, master.","8 End"];
         param1.cutSceneDefeatBoss = ["0 Shake 14","1 Boss This is what defeat tastes like? I hate it...","8 End"];
      }
      
      public function UpdateIntro(param1:a_GameHook) : void
      {
         if(param1.AtTime(0))
         {
            this.am_LastMonster.AddBuff("NephitSleep");
            param1.PlayScript(this.Script_Welcome);
         }
         if(param1.AtTime(12500))
         {
            param1.CollisionOff("am_DynamicCollision_RangeBlock");
            param1.Animate("am_Gate1","Open",true);
            param1.SetPhase(this.UpdateNextWave);
         }
      }
      
      public function UpdateNextWave(param1:a_GameHook) : void
      {
         if(param1.AtTime(1000))
         {
            if(this.currWave <= this.NUMBER_OF_WAVES)
            {
               param1.Group(this.am_Minions,this.SPAWN_MINION_AMOUNT).Spawn();
               param1.Group(this.am_Lieutenants,this.SPAWN_LIEUTENANT_AMOUNT).Spawn();
               ++this.currWave;
               param1.SetPhase(this.UpdateArena);
            }
            else
            {
               this.am_Boss.Spawn();
               this.am_AlVaeraz.Spawn();
               this.am_LastMonster.Kill();
               param1.bossFightPhase = this.UpdateBoss;
            }
         }
      }
      
      public function WaveCleared(param1:a_GameHook) : void
      {
         if(param1.AtTime(4000))
         {
            param1.SameGroup(this.am_Minions,this.SPAWN_MINION_AMOUNT).Remove();
            param1.SameGroup(this.am_Lieutenants,this.SPAWN_LIEUTENANT_AMOUNT).Remove();
            param1.SetPhase(this.UpdateNextWave);
         }
      }
      
      public function UpdateArena(param1:a_GameHook) : void
      {
         if(param1.AtTimeRepeat(1000,0) && param1.SameGroup(this.am_Minions,this.SPAWN_MINION_AMOUNT).Defeated() && param1.SameGroup(this.am_Lieutenants,this.SPAWN_LIEUTENANT_AMOUNT).Defeated())
         {
            param1.SetPhase(this.WaveCleared);
         }
      }
      
      public function UpdateBoss(param1:a_GameHook) : void
      {
         if(param1.AtTime(0))
         {
            this.bAlVaerazAlive = true;
            this.am_Boss.AddBuff("GladiatorNerf");
         }
         if(this.am_Boss.Defeated())
         {
            param1.SetPhase(null);
            return;
         }
         if(this.am_AlVaeraz.OnDefeat())
         {
            param1.PlayScript(this.Script_AlVaerazDead);
            this.bAlVaerazAlive = false;
         }
         if(param1.OnScriptFinish(this.Script_AlVaerazDead))
         {
            this.am_Boss.AddBuff("GladiatorEnrage");
         }
         if(this.bAlVaerazAlive)
         {
            if(param1.AtTimeRepeat(this.healTimer,0))
            {
               this.healTimer = Math.random() * 6000 + 8000;
               this.am_Boss.AddBuff("DragonRegen");
               param1.PlayScript(this.Script_HealMe);
            }
         }
      }
      
      internal function __setProp_am_AlVaeraz_a_Room_SDMission3_08_Cues_0() : *
      {
         try
         {
            this.am_AlVaeraz["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.am_AlVaeraz.characterName = "";
         this.am_AlVaeraz.displayName = "AlVaeraz";
         this.am_AlVaeraz.dramaAnim = "";
         this.am_AlVaeraz.itemDrop = "";
         this.am_AlVaeraz.sayOnActivate = "";
         this.am_AlVaeraz.sayOnAlert = "";
         this.am_AlVaeraz.sayOnBloodied = "I\'ll paint the sands red with you!";
         this.am_AlVaeraz.sayOnDeath = "";
         this.am_AlVaeraz.sayOnInteract = "";
         this.am_AlVaeraz.sayOnSpawn = "";
         this.am_AlVaeraz.sleepAnim = "";
         this.am_AlVaeraz.team = "default";
         this.am_AlVaeraz.waitToAggro = 0;
         try
         {
            this.am_AlVaeraz["componentInspectorSetting"] = false;
         }
         catch(e:Error)
         {
         }
      }
      
      internal function __setProp_am_Boss_a_Room_SDMission3_08_Cues_0() : *
      {
         try
         {
            this.am_Boss["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.am_Boss.characterName = "OutlanderWyrm";
         this.am_Boss.displayName = "The Pit Lord";
         this.am_Boss.dramaAnim = "";
         this.am_Boss.itemDrop = "";
         this.am_Boss.sayOnActivate = "";
         this.am_Boss.sayOnAlert = "";
         this.am_Boss.sayOnBloodied = "";
         this.am_Boss.sayOnDeath = "";
         this.am_Boss.sayOnInteract = "";
         this.am_Boss.sayOnSpawn = "";
         this.am_Boss.sleepAnim = "";
         this.am_Boss.team = "default";
         this.am_Boss.waitToAggro = 0;
         try
         {
            this.am_Boss["componentInspectorSetting"] = false;
         }
         catch(e:Error)
         {
         }
      }
      
      internal function __setProp_am_DumbBoss_a_Room_SDMission3_08_BossFight_0() : *
      {
         try
         {
            this.am_DumbBoss["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.am_DumbBoss.characterName = "";
         this.am_DumbBoss.displayName = "Champion of the Sun";
         this.am_DumbBoss.dramaAnim = "";
         this.am_DumbBoss.itemDrop = "";
         this.am_DumbBoss.sayOnActivate = "";
         this.am_DumbBoss.sayOnAlert = "";
         this.am_DumbBoss.sayOnBloodied = "";
         this.am_DumbBoss.sayOnDeath = "";
         this.am_DumbBoss.sayOnInteract = "";
         this.am_DumbBoss.sayOnSpawn = "";
         this.am_DumbBoss.sleepAnim = "";
         this.am_DumbBoss.team = "enemy";
         this.am_DumbBoss.waitToAggro = 0;
         try
         {
            this.am_DumbBoss["componentInspectorSetting"] = false;
         }
         catch(e:Error)
         {
         }
      }
      
      internal function frame1() : *
      {
         this.Script_AlVaerazDead = ["0 Boss AlVaeraz!! You failed me!","5 Boss You will pay for what you have done!","1 Shake 10"];
         this.Script_HealMe = ["0 AlVaeraz Master, give me strength!"];
         this.Script_Welcome = ["1 Gate2 Close","4 Camera 3","6 DumbBoss The mighty #tn#, come to finish off the last dragon.","9 DumbBoss You won\'t get the chance.","8 DumbBoss <Smite2> But your death in the Arena will be good for a few laughs.","8 DumbBoss <Goto Red 3>","2 Gate1 Open","10 RemoveCue DumbBoss","0 Gate1 Close","4 Camera Free"];
         this.currWave = 1;
         this.bAlVaerazAlive = true;
         this.healTimer = Math.random() * 6000 + 8000;
      }
   }
}

