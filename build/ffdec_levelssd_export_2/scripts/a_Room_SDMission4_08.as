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
   
   [Embed(source="/_assets/assets.swf", symbol="symbol1130")]
   public dynamic class a_Room_SDMission4_08 extends MovieClip
   {
      
      public var am_WarlockExtra2:ac_OasisWarlock;
      
      public var am_CollisionObject:MovieClip;
      
      public var am_EffectMarker2:ac_NephitSpireMarker;
      
      public var am_EffectMarker1:ac_NephitSpireMarker;
      
      public var am_Warlock:ac_OasisWarlock;
      
      public var am_Background_1:MovieClip;
      
      public var am_Chest:ac_TreasureChestMedium;
      
      public var am_WarlockExtra1:ac_OasisWarlock;
      
      public var Script_Ambush:Array;
      
      public function a_Room_SDMission4_08()
      {
         super();
         addFrameScript(0,this.frame1);
         this.__setProp_am_Chest_a_Room_SDMission4_08_cues_0();
      }
      
      public function InitRoom(param1:a_GameHook) : void
      {
         this.am_WarlockExtra1.bHoldSpawn = true;
         this.am_WarlockExtra2.bHoldSpawn = true;
         param1.initialPhase = this.Update;
      }
      
      public function Update(param1:a_GameHook) : void
      {
         if(this.am_Chest.OnDefeat())
         {
            param1.PlayScript(this.Script_Ambush);
            param1.SetPhase(null);
         }
      }
      
      internal function __setProp_am_Chest_a_Room_SDMission4_08_cues_0() : *
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
         this.Script_Ambush = ["2 QuickFirePower EffectMarker1 OasisTeleportEffect","0 QuickFirePower EffectMarker2 OasisTeleportEffect","1 SpawnCue WarlockExtra1","0 SpawnCue WarlockExtra2","3 WarlockExtra1 The Ogre Seelie shall restore the land.","8 WarlockExtra2 We shall renew the soil with your blood."];
      }
   }
}

