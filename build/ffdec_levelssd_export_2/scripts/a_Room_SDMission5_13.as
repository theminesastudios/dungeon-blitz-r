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
   
   [Embed(source="/_assets/assets.swf", symbol="symbol925")]
   public dynamic class a_Room_SDMission5_13 extends MovieClip
   {
      
      public var am_LargeLarva1:ac_ScarabLarvaSpawnerHidden;
      
      public var am_LargeLarva2:ac_ScarabLarvaSpawnerHidden;
      
      public var am_Mage:ac_OasisWarlock;
      
      public var am_Spawner4:ac_ScarabLarvaSpawnerHidden;
      
      public var am_BossFight:a_Volume;
      
      public var am_CollisionObject:MovieClip;
      
      public var am_Spawner1:ac_ScarabLarvaSpawnerHidden;
      
      public var am_Boss:ac_SandWormGreater;
      
      public var am_Spawner3:ac_ScarabLarvaSpawnerHidden;
      
      public var am_Spawner2:ac_ScarabLarvaSpawnerHidden;
      
      public var am_Claws:MovieClip;
      
      public var am_Foreground:MovieClip;
      
      public var Script_CameraShake:Array;
      
      public function a_Room_SDMission5_13()
      {
         super();
         addFrameScript(0,this.frame1);
         this.__setProp_am_Boss_a_Room_SDMission5_13_Effect_0();
      }
      
      public function InitRoom(param1:a_GameHook) : void
      {
         this.am_Boss.displayName = "Sand Leviathan";
         this.am_Boss.bHoldEngage = true;
         param1.bossFightPhase = null;
         param1.bBossBarOnBottom = true;
         param1.initialPhase = this.UpdateFirstTick;
         param1.bBossFightBeginsOnRoomClear = false;
         param1.cutSceneStartBoss = ["5 Shake 8","6 Mage You\'re too late, human. The Sand Leviathan comes!","10 Player Is this your Emperor\'s plan? Feed all Shazari to monsters?","12 Mage The Emperor follows our wise counsel. He has rare wisdom.","12 Mage The Emperor\'s will be done, it comes!","6 Shake 10","4 Camera 3","4 Boss <Emerge>","0 Shake 20","6 Boss <Spew>","8 End"];
         param1.cutSceneDefeatBoss = ["2 Shake 25","8 Player It seems Rathbone\'s suspicions were correct.","12 Player The Emperor of Valhaven is involved with the attacks on Shazari.","8 End"];
      }
      
      public function UpdateFirstTick(param1:a_GameHook) : void
      {
         if(param1.AtTime(0))
         {
            this.am_Boss.SetAnimation("Burrowed");
            this.am_Boss.DeepSleep();
            param1.bossFightPhase = this.UpdateEmergePhase;
         }
      }
      
      public function UpdateEmergePhase(param1:a_GameHook) : void
      {
         if(param1.AtTime(0))
         {
            this.am_Boss.SetMelee("SandWormMeleeL");
            this.am_Boss.SetRanged("SandWormShot");
            this.am_Boss.RemoveBuff("NephitSleep");
            this.am_Boss.AddBuff("ScarabLightArmor");
            param1.PlayScript(this.Script_CameraShake);
            this.am_Boss.Aggro();
         }
         if(this.am_Boss.Defeated())
         {
            param1.SetPhase(null);
            return;
         }
         if(param1.AtTime(1200))
         {
            this.am_LargeLarva1.FirePower("ScorpionSpawnLarva");
            this.am_LargeLarva2.FirePower("ScorpionSpawnLarva");
         }
         if(param1.AtTime(3000))
         {
            this.am_Spawner1.FirePower("ScorpionSpawnLarvaSmall");
         }
         if(param1.AtTime(4200))
         {
            this.am_Spawner2.FirePower("ScorpionSpawnLarvaSmall");
         }
         if(param1.AtTime(6400))
         {
            this.am_Spawner3.FirePower("ScorpionSpawnLarvaSmall");
         }
         if(param1.AtTime(7100))
         {
            this.am_Spawner4.FirePower("ScorpionSpawnLarvaSmall");
         }
         if(param1.AtTime(8000))
         {
            this.am_Boss.RemoveAllBuffs();
            this.am_Boss.SetAnimation("Submerge");
            this.am_Boss.AddBuff("NephitSleep");
            this.am_Boss.SetMelee(null);
            this.am_Boss.SetRanged(null);
            param1.SetPhase(this.UpdateSubmergePhase);
         }
      }
      
      public function UpdateSubmergePhase(param1:a_GameHook) : void
      {
         if(param1.AtTime(0))
         {
            param1.PlayScript(this.Script_CameraShake);
         }
         if(this.am_Boss.Defeated())
         {
            param1.SetPhase(null);
            return;
         }
         if(param1.AtTimeRepeat(1000,1000))
         {
            param1.Group(this.am_Claws,1).FirePower("SandClawMelee");
         }
         if(param1.AtTime(10200))
         {
            this.am_Boss.Skit("<Emerge>");
            param1.SetPhase(this.UpdateEmergePhase);
         }
      }
      
      internal function __setProp_am_Boss_a_Room_SDMission5_13_Effect_0() : *
      {
         try
         {
            this.am_Boss["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.am_Boss.characterName = "SandWormGreater";
         this.am_Boss.displayName = "";
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
      
      internal function frame1() : *
      {
         this.Script_CameraShake = ["1 Shake 18"];
      }
   }
}

