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
   
   [Embed(source="/_assets/assets.swf", symbol="symbol1162")]
   public dynamic class a_Room_SDMission4_11 extends MovieClip
   {
      
      public var am_LastMonster:ac_SandSpider;
      
      public var am_CollisionObject:MovieClip;
      
      public var am_Boss:ac_OasisVizier;
      
      public var am_Clone3:ac_OasisVizierYellow;
      
      public var am_CloneMarker3:ac_NephitSpireMarker;
      
      public var am_Clone2:ac_OasisVizierGreen;
      
      public var am_CloneMarker2:ac_NephitSpireMarker;
      
      public var am_Clone1:ac_OasisVizierRed;
      
      public var am_CloneMarker1:ac_NephitSpireMarker;
      
      public var am_Foreground:MovieClip;
      
      public var Script_ResetPositonRed:Array;
      
      public var Script_ResetPositonGreen:Array;
      
      public var Script_ResetPositonYellow:Array;
      
      public var Script_MergeToCenter:Array;
      
      public var Script_BossIntro:Array;
      
      public var bFirstRed:Boolean;
      
      public var bFirstGreen:Boolean;
      
      public var bFirstYellow:Boolean;
      
      public function a_Room_SDMission4_11()
      {
         super();
         addFrameScript(0,this.frame1);
         this.__setProp_am_Clone1_a_Room_SDMission4_11_Cues_0();
         this.__setProp_am_Clone3_a_Room_SDMission4_11_Cues_0();
      }
      
      public function InitRoom(param1:a_GameHook) : void
      {
         this.am_Boss.displayName = "Dejih the Ogre-Magus";
         this.am_Boss.bHoldSpawn = true;
         this.am_Clone2.bHoldSpawn = true;
         this.am_Clone3.bHoldSpawn = true;
         param1.bossFightPhase = null;
         param1.bBossBarOnBottom = true;
         param1.initialPhase = this.UpdateIntro;
         param1.bossFightBeginsWhenThisGuyIsDead = "am_LastMonster";
         param1.cutSceneStartBoss = ["5 Boss Soon all Shazari will flourish like this Oasis.","12 Player And I assume you\'re not willing to share the bountiful new land?","12 Boss Share the land of the Magi? With mortal scum? Unthinkable!","9 Boss <Cast1> Courts of the Night, grant me strength!","14 End"];
         param1.cutSceneDefeatBoss = ["0 Shake 22","8 Player It really is quite nice here...","10 Player Now that the Ogre Magi are all gone.","10 End"];
      }
      
      public function UpdateIntro(param1:a_GameHook) : void
      {
         var _loc2_:Number = NaN;
         if(param1.AtTime(0))
         {
            this.am_LastMonster.AddBuff("NephitSleep");
            param1.PlayCutScene(this.Script_BossIntro);
         }
         if(param1.AtTime(10500))
         {
            this.am_Clone1.AddBuff("Ethereal");
            this.am_Clone2.AddBuff("Ethereal");
            this.am_Clone3.AddBuff("Ethereal");
            this.am_Clone1.DeepSleep();
            this.am_Clone2.DeepSleep();
            this.am_Clone3.DeepSleep();
         }
         if(param1.AtTime(12000))
         {
            _loc2_ = Math.random();
            if(_loc2_ < 0.33)
            {
               param1.SetPhase(this.UpdateRed);
            }
            else if(_loc2_ < 0.66)
            {
               param1.SetPhase(this.UpdateGreen);
            }
            else
            {
               param1.SetPhase(this.UpdateYellow);
            }
         }
      }
      
      public function UpdateRed(param1:a_GameHook) : void
      {
         if(param1.AtTime(0))
         {
            this.am_Clone1.RemoveBuff("Ethereal");
            this.am_Clone1.RemoveBuff("MoveFast");
            this.am_Clone1.AddBuff("RedChieftain");
            this.am_Clone1.FirePower("WarlockActive");
            this.am_Clone1.Aggro();
            if(this.bFirstRed)
            {
               this.am_Clone1.Skit("The Curse of Seelie-kind upon thee!");
               this.bFirstRed = false;
            }
         }
         if(this.am_Clone1.Defeated() || this.am_Clone2.Defeated() || this.am_Clone3.Defeated())
         {
            param1.SetPhase(this.StartMainBossFight);
            return;
         }
         if(param1.AtTime(9000))
         {
            this.am_Clone1.FirePower("OasisTeleportEffect");
            this.am_Clone1.RemoveAllBuffs();
            this.am_Clone1.AddBuff("Ethereal");
            this.am_Clone1.AddBuff("MoveFast");
            this.am_Clone1.DeepSleep();
            param1.PlayScript(this.Script_ResetPositonRed);
            if(Math.random() < 0.5)
            {
               param1.SetPhase(this.UpdateGreen);
            }
            else
            {
               param1.SetPhase(this.UpdateYellow);
            }
         }
      }
      
      public function UpdateGreen(param1:a_GameHook) : void
      {
         if(param1.AtTime(0))
         {
            this.am_Clone2.RemoveBuff("Ethereal");
            this.am_Clone2.RemoveBuff("MoveFast");
            this.am_Clone2.AddBuff("GreenChieftain");
            this.am_Clone2.FirePower("WarlockActive");
            this.am_Clone2.Aggro();
            if(this.bFirstGreen)
            {
               this.am_Clone2.Skit("My very life draws strength from the land!");
               this.bFirstGreen = false;
            }
         }
         if(this.am_Clone1.Defeated() || this.am_Clone2.Defeated() || this.am_Clone3.Defeated())
         {
            param1.SetPhase(this.StartMainBossFight);
            return;
         }
         if(param1.AtTime(9000))
         {
            this.am_Clone2.FirePower("OasisTeleportEffect");
            this.am_Clone2.RemoveAllBuffs();
            this.am_Clone2.AddBuff("Ethereal");
            this.am_Clone2.AddBuff("MoveFast");
            this.am_Clone2.DeepSleep();
            param1.PlayScript(this.Script_ResetPositonGreen);
            if(Math.random() < 0.5)
            {
               param1.SetPhase(this.UpdateRed);
            }
            else
            {
               param1.SetPhase(this.UpdateYellow);
            }
         }
      }
      
      public function UpdateYellow(param1:a_GameHook) : void
      {
         if(param1.AtTime(0))
         {
            this.am_Clone3.RemoveBuff("Ethereal");
            this.am_Clone3.RemoveBuff("MoveFast");
            this.am_Clone3.AddBuff("YellowChieftain");
            this.am_Clone3.FirePower("WarlockActive");
            this.am_Clone3.Aggro();
            if(this.bFirstYellow)
            {
               this.am_Clone3.Skit("Die, human! Feed the sands!");
               this.bFirstYellow = false;
            }
         }
         if(this.am_Clone1.Defeated() || this.am_Clone2.Defeated() || this.am_Clone3.Defeated())
         {
            param1.SetPhase(this.StartMainBossFight);
            return;
         }
         if(param1.AtTime(9000))
         {
            this.am_Clone3.FirePower("OasisTeleportEffect");
            this.am_Clone3.RemoveAllBuffs();
            this.am_Clone3.AddBuff("Ethereal");
            this.am_Clone3.AddBuff("MoveFast");
            this.am_Clone3.DeepSleep();
            param1.PlayScript(this.Script_ResetPositonYellow);
            if(Math.random() < 0.5)
            {
               param1.SetPhase(this.UpdateRed);
            }
            else
            {
               param1.SetPhase(this.UpdateGreen);
            }
         }
      }
      
      public function StartMainBossFight(param1:a_GameHook) : void
      {
         if(param1.AtTime(0))
         {
            this.am_Clone1.RemoveAllBuffs();
            this.am_Clone2.RemoveAllBuffs();
            this.am_Clone3.RemoveAllBuffs();
            this.am_Clone1.AddBuff("Ethereal");
            this.am_Clone2.AddBuff("Ethereal");
            this.am_Clone3.AddBuff("Ethereal");
            this.am_Clone1.AddBuff("MoveFast");
            this.am_Clone2.AddBuff("MoveFast");
            this.am_Clone3.AddBuff("MoveFast");
            this.am_Clone1.DeepSleep();
            this.am_Clone2.DeepSleep();
            this.am_Clone3.DeepSleep();
            param1.PlayScript(this.Script_MergeToCenter);
         }
         if(param1.AtTime(3000))
         {
            this.am_LastMonster.Kill();
            param1.bossFightPhase = this.UpdateMainBoss;
         }
      }
      
      public function UpdateMainBoss(param1:a_GameHook) : void
      {
         if(this.am_Boss.Defeated())
         {
            param1.SetPhase(null);
         }
      }
      
      internal function __setProp_am_Clone1_a_Room_SDMission4_11_Cues_0() : *
      {
         try
         {
            this.am_Clone1["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.am_Clone1.characterName = "OasisVizier";
         this.am_Clone1.displayName = "";
         this.am_Clone1.dramaAnim = "";
         this.am_Clone1.itemDrop = "";
         this.am_Clone1.sayOnActivate = "";
         this.am_Clone1.sayOnAlert = "";
         this.am_Clone1.sayOnBloodied = "";
         this.am_Clone1.sayOnDeath = "No I cannot die!";
         this.am_Clone1.sayOnInteract = "";
         this.am_Clone1.sayOnSpawn = "";
         this.am_Clone1.sleepAnim = "";
         this.am_Clone1.team = "default";
         this.am_Clone1.waitToAggro = 0;
         try
         {
            this.am_Clone1["componentInspectorSetting"] = false;
         }
         catch(e:Error)
         {
         }
      }
      
      internal function __setProp_am_Clone3_a_Room_SDMission4_11_Cues_0() : *
      {
         try
         {
            this.am_Clone3["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.am_Clone3.characterName = "";
         this.am_Clone3.displayName = "";
         this.am_Clone3.dramaAnim = "";
         this.am_Clone3.itemDrop = "";
         this.am_Clone3.sayOnActivate = "";
         this.am_Clone3.sayOnAlert = "";
         this.am_Clone3.sayOnBloodied = "";
         this.am_Clone3.sayOnDeath = "Now witness my true form";
         this.am_Clone3.sayOnInteract = "";
         this.am_Clone3.sayOnSpawn = "";
         this.am_Clone3.sleepAnim = "";
         this.am_Clone3.team = "default";
         this.am_Clone3.waitToAggro = 0;
         try
         {
            this.am_Clone3["componentInspectorSetting"] = false;
         }
         catch(e:Error)
         {
         }
      }
      
      internal function frame1() : *
      {
         this.Script_ResetPositonRed = ["0 Clone1 <Goto Red 1>"];
         this.Script_ResetPositonGreen = ["0 Clone2 <Goto Red 2>"];
         this.Script_ResetPositonYellow = ["0 Clone3 <Goto Red 3>"];
         this.Script_MergeToCenter = ["0 Clone1 <Goto Red 1>","0 Clone2 <Goto Red 2>","0 Clone3 <Goto Red 3>","5 Clone1 Mwahahaha!","5 QuickFirePower CloneMarker1 OasisTeleportEffectLarge","0 QuickFirePower CloneMarker2 OasisTeleportEffectLarge","0 QuickFirePower CloneMarker3 OasisTeleportEffectLarge","0 Shake 50","1 RemoveCue Clone1","0 RemoveCue Clone2","0 RemoveCue Clone3","0 SpawnCue Boss"];
         this.Script_BossIntro = ["6 Camera 3","8 Clone1 Our ancestors built this land.","10 Clone1 We claim our blood right!","5 QuickFirePower Clone1 OasisTeleportEffect","1 SpawnCue Clone2","0 SpawnCue Clone3","2 Clone2 <Goto Red 2>","0 Clone3 <Goto Red 3>","8 Clone1 <Cast1> This is our destiny!","4 Camera Free"];
         this.bFirstRed = true;
         this.bFirstGreen = true;
         this.bFirstYellow = true;
      }
   }
}

