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
   
   [Embed(source="/_assets/assets.swf", symbol="symbol1232")]
   public dynamic class a_Room_GoblinBeachHard_06 extends MovieClip
   {
      
      public var am_Torch3:MovieClip;
      
      public var am_Torch2:MovieClip;
      
      public var am_AmbushGrp:MovieClip;
      
      public var am_Torch1:MovieClip;
      
      public var am_EffectMarker2:ac_NephitSpireMarker;
      
      public var am_CollisionObject:MovieClip;
      
      public var am_Glow2:MovieClip;
      
      public var am_Claw4:a_Animation_GoblinCageClaw;
      
      public var am_EffectMarker1:ac_NephitSpireMarker;
      
      public var am_Glow3:MovieClip;
      
      public var am_Glow1:MovieClip;
      
      public var am_Claw3:a_Animation_GoblinCageClaw;
      
      public var am_Gate:MovieClip;
      
      public var am_Chest:ac_TreasureChestEmpty;
      
      public var am_Foreground:MovieClip;
      
      public var am_Scout:ac_GoblinShamanHood;
      
      public var Script_OpeningScene:Array;
      
      public var Script_RoomCleared:Array;
      
      public function a_Room_GoblinBeachHard_06()
      {
         super();
         addFrameScript(0,this.frame1);
         this.__setProp_am_Chest_a_Room_GoblinBeachHard_06_Cues_0();
      }
      
      public function InitRoom(param1:a_GameHook) : void
      {
         this.am_AmbushGrp.am_Mob1.bHoldSpawn = true;
         this.am_AmbushGrp.am_Mob2.bHoldSpawn = true;
         this.am_AmbushGrp.am_Mob3.bHoldSpawn = true;
         this.am_AmbushGrp.am_Mob4.bHoldSpawn = true;
         this.am_AmbushGrp.am_Mob5.bHoldSpawn = true;
         this.am_AmbushGrp.am_Mob6.bHoldSpawn = true;
         param1.initialPhase = this.UpdateIntro;
      }
      
      public function UpdateIntro(param1:a_GameHook) : void
      {
         if(param1.AtTime(0))
         {
            this.am_Scout.AddBuff("NephitSleep");
            this.am_Scout.DeepSleep();
         }
         if(param1.OnTrigger("am_Trigger_1"))
         {
            param1.PlayScript(this.Script_OpeningScene);
            param1.SetPhase(this.UpdateAmbush);
         }
      }
      
      public function UpdateAmbush(param1:a_GameHook) : void
      {
         if(param1.AtTime(3000))
         {
            param1.Group(this.am_AmbushGrp).Spawn();
         }
         if(param1.Group(this.am_AmbushGrp).Defeated())
         {
            param1.PlayScript(this.Script_RoomCleared);
            param1.SetPhase(this.UpdateEndEvent);
         }
      }
      
      public function UpdateEndEvent(param1:a_GameHook) : void
      {
         if(param1.AtTime(2000))
         {
            this.am_Scout.RemoveBuff("NephitSleep");
            this.am_Scout.Aggro();
            param1.CollisionOff("am_DynamicCollision_Gate");
            param1.Animate("am_Gate","Open",true);
            param1.SetPhase(null);
         }
      }
      
      internal function __setProp_am_Chest_a_Room_GoblinBeachHard_06_Cues_0() : *
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
      
      internal function frame1() : *
      {
         this.Script_OpeningScene = ["0 Camera 5","8 Scout <PullLever> Let\'s have some fun!","5 Camera 4","0 QuickFirePower EffectMarker1 OasisTeleportEffect","0 QuickFirePower EffectMarker2 OasisTeleportEffect","2 Camera free"];
         this.Script_RoomCleared = ["1 Camera 5","8 Scout Nooo...","5 Camera free"];
      }
   }
}

