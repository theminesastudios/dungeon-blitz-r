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
   
   [Embed(source="/_assets/assets.swf", symbol="symbol952")]
   public dynamic class a_Room_SDMission5_12 extends MovieClip
   {
      
      public var am_CollisionObject:MovieClip;
      
      public var am_Worm2:ac_SandWorm;
      
      public var am_Worm1:ac_SandWorm2;
      
      public var am_Foreground:MovieClip;
      
      public var am_Chest:ac_TreasureChestMedium;
      
      public var am_Background:MovieClip;
      
      public var Script_IntroWorm:Array;
      
      public var Script_CameraShake:Array;
      
      public function a_Room_SDMission5_12()
      {
         super();
         addFrameScript(0,this.frame1);
         this.__setProp_am_Chest_a_Room_SDMission5_12_road_0();
      }
      
      public function InitRoom(param1:a_GameHook) : void
      {
         this.am_Worm1.bHoldSpawn = true;
         this.am_Worm2.bHoldSpawn = true;
         param1.initialPhase = this.Update;
      }
      
      public function Update(param1:a_GameHook) : void
      {
         if(param1.AtTime(0))
         {
            param1.CollisionOff("am_DynamicCollision_Ambush");
         }
         if(this.am_Chest.OnDefeat())
         {
            param1.CollisionOn("am_DynamicCollision_Ambush");
         }
         if(param1.OnTrigger("am_Trigger_Ambush"))
         {
            this.am_Worm1.Spawn();
            this.am_Worm1.DeepSleep();
            this.am_Worm1.Skit("<Emerge>");
            this.am_Worm2.Spawn();
            this.am_Worm2.DeepSleep();
            this.am_Worm2.Skit("<Emerge>");
            param1.PlayScript(this.Script_IntroWorm);
         }
         if(param1.OnScriptFinish(this.Script_IntroWorm))
         {
            this.am_Worm1.Skit("<Spew>");
            this.am_Worm2.Skit("<Spew>");
            param1.PlayScript(this.Script_CameraShake);
         }
         if(param1.OnScriptFinish(this.Script_CameraShake))
         {
            this.am_Worm1.Aggro();
            this.am_Worm2.Aggro();
            param1.SetPhase(null);
         }
      }
      
      internal function __setProp_am_Chest_a_Room_SDMission5_12_road_0() : *
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
         this.am_Chest.itemDrop = "Gold_3";
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
         this.Script_IntroWorm = ["3 End"];
         this.Script_CameraShake = ["1 Shake 35","2 End"];
      }
   }
}

