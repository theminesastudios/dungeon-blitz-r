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
   
   [Embed(source="/_assets/assets.swf", symbol="symbol1517")]
   public dynamic class a_Room_SDMission2_12 extends MovieClip
   {
      
      public var am_CollisionObject:MovieClip;
      
      public var am_BossFight:a_Volume;
      
      public var am_Moment_Hard:MovieClip;
      
      public var am_Moment_Normal:MovieClip;
      
      public var am_Boss:ac_ScarabScorpion;
      
      public var am_Foreground:MovieClip;
      
      public var am_Adds:MovieClip;
      
      public var Script_Enrage:Array;
      
      public function a_Room_SDMission2_12()
      {
         super();
         addFrameScript(0,this.frame1);
         this.__setProp_am_Boss_a_Room_SDMission2_12_Cues_0();
      }
      
      public function InitRoom(param1:a_GameHook) : void
      {
         this.am_Boss.displayName = "Enormous Sandspawn";
         param1.bBossBarOnBottom = true;
         param1.bossFightPhase = this.UpdateNormal;
         param1.bBossFightBeginsOnRoomClear = false;
         param1.cutSceneStartBoss = ["2 Camera 3","10 BossWall Break","2 Player By the Stars, what is THAT?!?","2 Shake 8","5 Shake 8","5 Shake 15","0 Boss <Goto Red 2>","2 Boss <Melee> Yiiiiiiiiii!","18 End"];
         param1.cutSceneDefeatBoss = ["2 Shake 25","10 Player Please let that thing stay dead.","10 Player The wild life here seems disturbingly aggressive.","10 End"];
      }
      
      public function UpdateNormal(param1:a_GameHook) : void
      {
         if(param1.AtTime(0))
         {
            this.am_Boss.ResetPowers();
            this.am_Boss.AddBuff("ScarabLightArmor");
         }
         if(this.am_Boss.Health() < 1)
         {
            if(param1.AtTimeRepeat(4000,2800))
            {
               param1.Group(this.am_Adds,1).FirePower("ScorpionSpawnLarvaSmall");
            }
            if(param1.AtTimeRepeat(4000,3100))
            {
               param1.Group(this.am_Adds,1).FirePower("ScorpionSpawnLarvaSmall");
            }
            if(param1.AtTimeRepeat(9000,4000))
            {
               param1.Group(this.am_Adds,1).FirePower("ScorpionSpawnLarva");
            }
         }
         if(this.am_Boss.Health() <= 0.3)
         {
            param1.SetPhase(this.UpdateEnrage);
         }
      }
      
      public function UpdateEnrage(param1:a_GameHook) : void
      {
         if(param1.AtTime(0))
         {
            param1.PlayScript(this.Script_Enrage);
            this.am_Boss.RemoveBuff("ScarabLightArmor");
            this.am_Boss.AddBuff("ScarabEnrage");
            this.am_Boss.SetPowers(["ScorpionHeavyLEnrage"]);
         }
         if(this.am_Boss.Defeated())
         {
            param1.SetPhase(null);
            return;
         }
         if(this.am_Boss.Health() > 0.3)
         {
            this.am_Boss.RemoveBuff("ScarabEnrage");
            param1.SetPhase(this.UpdateNormal);
         }
      }
      
      internal function __setProp_am_Boss_a_Room_SDMission2_12_Cues_0() : *
      {
         try
         {
            this.am_Boss["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.am_Boss.characterName = "ScarabScorpion";
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
         this.Script_Enrage = ["0 Boss <Bolster>","1 Shake 6"];
      }
   }
}

