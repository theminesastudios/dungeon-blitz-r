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
   
   [Embed(source="/_assets/assets.swf", symbol="symbol1652")]
   public dynamic class a_Room_SDMission12 extends MovieClip
   {
      
      public var am_PortalCue:ac_DoorPortal;
      
      public var am_PortalDoor:a_DoorLocal_I;
      
      public var am_CollisionObject:MovieClip;
      
      public var am_Guardian:ac_SandMummy;
      
      public var am_Marker1:ac_RageGuardianServant;
      
      public var am_Marker2:ac_RageGuardianServant;
      
      public var Script_GuardianScene:Array;
      
      public var Script_FreeCamera:Array;
      
      public var Script_Totems:Array;
      
      public var Script_GuardianDefeated:Array;
      
      public var bServantsActive:Boolean;
      
      public function a_Room_SDMission12()
      {
         super();
         addFrameScript(0,this.frame1);
         this.__setProp_am_Guardian_a_Room_SDMission12_Cues_0();
      }
      
      public function InitRoom(param1:a_GameHook) : void
      {
         this.am_PortalDoor.bDisabled = true;
         this.am_PortalCue.bHoldSpawn = true;
         param1.initialPhase = this.UpdateIntro;
      }
      
      public function UpdateIntro(param1:a_GameHook) : void
      {
         if(param1.AtTime(0))
         {
            this.am_Marker1.Kill();
            this.am_Marker2.Kill();
            param1.PlayScript(this.Script_GuardianScene);
         }
         if(param1.AtTime(5000))
         {
            param1.SetPhase(this.UpdateFight);
         }
      }
      
      public function UpdateFight(param1:a_GameHook) : void
      {
         if(param1.AtTime(0))
         {
            this.am_Guardian.Aggro();
            param1.PlayScript(this.Script_FreeCamera);
            param1.CollisionOff("am_DynamicCollision_RangeBlock");
            this.bServantsActive = true;
            param1.PlayScript(this.Script_Totems);
            this.am_Marker1.Revive();
            this.am_Marker2.Revive();
            this.am_Marker1.AddBuff("EarthServantArmor");
            this.am_Marker2.AddBuff("EarthServantArmor");
            this.am_Guardian.AddBuff("RageMummyArmor");
         }
         if(this.am_Guardian.Defeated())
         {
            param1.PlayScript(this.Script_GuardianDefeated);
            this.am_Marker1.Kill();
            this.am_Marker2.Kill();
            this.am_PortalCue.Spawn();
            this.am_PortalCue.SetAnimation("Sleep");
            param1.SetPhase(this.UpdateCloseScene);
            return;
         }
         if(this.am_Marker1.Health() <= 0 && this.am_Marker2.Health() <= 0 && this.bServantsActive)
         {
            this.am_Guardian.RemoveBuff("RageMummyArmor");
            this.bServantsActive = false;
         }
      }
      
      public function UpdateCloseScene(param1:a_GameHook) : void
      {
         if(param1.AtTime(800))
         {
            param1.EnableDoor(this.am_PortalDoor);
            this.am_PortalCue.SetAnimation("Ready");
            param1.SetPhase(null);
         }
      }
      
      internal function __setProp_am_Guardian_a_Room_SDMission12_Cues_0() : *
      {
         try
         {
            this.am_Guardian["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.am_Guardian.characterName = "Guardian";
         this.am_Guardian.displayName = "";
         this.am_Guardian.dramaAnim = "";
         this.am_Guardian.itemDrop = "";
         this.am_Guardian.sayOnActivate = "";
         this.am_Guardian.sayOnAlert = "";
         this.am_Guardian.sayOnBloodied = "";
         this.am_Guardian.sayOnDeath = "";
         this.am_Guardian.sayOnInteract = "";
         this.am_Guardian.sayOnSpawn = "";
         this.am_Guardian.sleepAnim = "";
         this.am_Guardian.team = "default";
         this.am_Guardian.waitToAggro = 0;
         try
         {
            this.am_Guardian["componentInspectorSetting"] = false;
         }
         catch(e:Error)
         {
         }
      }
      
      internal function frame1() : *
      {
         this.Script_GuardianScene = ["2 Camera 3","6 Guardian You come to plunder our glory?"];
         this.Script_FreeCamera = ["5 Camera Free"];
         this.Script_Totems = ["0 Guardian Totems of the Seelie, protect me!","0 Shake 12"];
         this.Script_GuardianDefeated = ["1 Guardian You defile the Ogre Magi legacy...","6 End"];
         this.bServantsActive = false;
      }
   }
}

