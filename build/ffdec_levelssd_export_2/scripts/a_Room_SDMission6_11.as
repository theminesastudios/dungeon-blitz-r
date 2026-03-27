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
   
   [Embed(source="/_assets/assets.swf", symbol="symbol753")]
   public dynamic class a_Room_SDMission6_11 extends MovieClip
   {
      
      public var am_BossFight:a_Volume;
      
      public var am_CollisionObject:MovieClip;
      
      public var am_Boss:ac_GolemLord;
      
      public var am_Add1:ac_GolemDefender;
      
      public var am_Add2:ac_GolemDefender;
      
      public var am_Sparks:MovieClip;
      
      public var am_Foreground:MovieClip;
      
      public var Script_AddsKilled:Array;
      
      public var Script_MoveBossToCenter:Array;
      
      public var bFirstSpark:Boolean;
      
      public var bStartMainFight:Boolean;
      
      public function a_Room_SDMission6_11()
      {
         super();
         addFrameScript(0,this.frame1);
         this.__setProp_am_Boss_a_Room_SDMission6_11_Cues_0();
      }
      
      public function InitRoom(param1:a_GameHook) : void
      {
         this.am_Boss.displayName = "The Prime Builder";
         this.am_Sparks.am_Trap1.bHoldSpawn = true;
         this.am_Sparks.am_Trap2.bHoldSpawn = true;
         this.am_Sparks.am_Trap3.bHoldSpawn = true;
         this.am_Sparks.am_Trap4.bHoldSpawn = true;
         this.am_Sparks.am_Trap5.bHoldSpawn = true;
         this.am_Sparks.am_Trap6.bHoldSpawn = true;
         param1.bBossBarOnBottom = true;
         param1.bossFightPhase = this.UpdateGuardPhase;
         param1.bBossFightBeginsOnRoomClear = false;
         param1.cutSceneStartBoss = ["3 Camera 3","6 Boss Our labors produce perfection.","12 Boss The living can never know flawless existence.","12 Boss We cannot serve you or any living thing.","12 Boss As we eliminated our creators, so we eliminate you.","12 End"];
         param1.cutSceneDefeatBoss = ["2 Shake 25","1 Boss A less than perfect end...","8 End"];
      }
      
      public function UpdateGuardPhase(param1:a_GameHook) : void
      {
         if(param1.AtTime(0))
         {
            this.am_Boss.AddBuff("GhostStealth");
            this.am_Add1.Aggro();
            this.am_Add2.Aggro();
         }
         if(this.am_Boss.Defeated())
         {
            param1.SetPhase(null);
            return;
         }
         if(this.am_Add1.Defeated() && this.am_Add2.Defeated() && !this.bStartMainFight)
         {
            this.bStartMainFight = true;
            param1.PlayScript(this.Script_AddsKilled);
         }
         if(param1.OnScriptFinish(this.Script_AddsKilled))
         {
            param1.SetPhase(this.UpdatePhaseOne);
         }
      }
      
      public function UpdatePhaseOne(param1:a_GameHook) : void
      {
         if(param1.AtTime(0))
         {
            this.am_Boss.RemoveBuff("GhostStealth");
         }
         if(this.am_Boss.Defeated())
         {
            param1.SetPhase(null);
            param1.Group(this.am_Sparks).Kill();
            return;
         }
         if(param1.AtTimeRepeat(4000,4000))
         {
            if(this.bFirstSpark)
            {
               this.bFirstSpark = false;
               param1.Group(this.am_Sparks,2).Spawn();
            }
            else
            {
               if(param1.SameGroup(this.am_Sparks,2).Defeated())
               {
                  param1.SameGroup(this.am_Sparks,2).Remove();
               }
               param1.Group(this.am_Sparks,2).Spawn();
            }
         }
      }
      
      internal function __setProp_am_Boss_a_Room_SDMission6_11_Cues_0() : *
      {
         try
         {
            this.am_Boss["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.am_Boss.characterName = "GolemLord";
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
         this.Script_AddsKilled = ["0 Shake 18","8 Boss All shall be rebuilt.","8 Boss You cannot destroy perfection.","2 End"];
         this.Script_MoveBossToCenter = ["0 Boss <Goto Red 1>"];
         this.bFirstSpark = true;
         this.bStartMainFight = false;
      }
   }
}

