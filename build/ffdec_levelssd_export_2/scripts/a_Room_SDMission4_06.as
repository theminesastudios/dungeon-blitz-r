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
   
   [Embed(source="/_assets/assets.swf", symbol="symbol1181")]
   public dynamic class a_Room_SDMission4_06 extends MovieClip
   {
      
      public var am_Foreground_2:MovieClip;
      
      public var am_Foreground_1:MovieClip;
      
      public var am_Mob1:ac_OasisGiant;
      
      public var am_CollisionObject:MovieClip;
      
      public var am_EffectMarker:ac_NephitSpireMarker;
      
      public var am_Warlock:ac_OasisWarlock;
      
      public var am_Background_1:MovieClip;
      
      public var am_Foreground:MovieClip;
      
      public var Script_Ambush:Array;
      
      public function a_Room_SDMission4_06()
      {
         super();
         addFrameScript(0,this.frame1);
         this.__setProp_am_Warlock_a_Room_SDMission4_06_cues_0();
      }
      
      public function InitRoom(param1:a_GameHook) : void
      {
         this.am_Warlock.bHoldSpawn = true;
         param1.initialPhase = this.Update;
      }
      
      public function Update(param1:a_GameHook) : void
      {
         if(this.am_Mob1.Health() < 1)
         {
            param1.PlayScript(this.Script_Ambush);
            param1.SetPhase(null);
         }
      }
      
      internal function __setProp_am_Warlock_a_Room_SDMission4_06_cues_0() : *
      {
         try
         {
            this.am_Warlock["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.am_Warlock.characterName = "";
         this.am_Warlock.displayName = "";
         this.am_Warlock.dramaAnim = "";
         this.am_Warlock.itemDrop = "";
         this.am_Warlock.sayOnActivate = "Beware, Goblin-lover!:We will reclaim what\'s ours!";
         this.am_Warlock.sayOnAlert = "";
         this.am_Warlock.sayOnBloodied = "";
         this.am_Warlock.sayOnDeath = "";
         this.am_Warlock.sayOnInteract = "";
         this.am_Warlock.sayOnSpawn = "";
         this.am_Warlock.sleepAnim = "";
         this.am_Warlock.team = "default";
         this.am_Warlock.waitToAggro = 0;
         try
         {
            this.am_Warlock["componentInspectorSetting"] = false;
         }
         catch(e:Error)
         {
         }
      }
      
      internal function frame1() : *
      {
         this.Script_Ambush = ["2 QuickFirePower EffectMarker OasisTeleportEffect","1 SpawnCue Warlock","1 Warlock The Ogre Seelie have reclaimed these lands!","8 Warlock Begone, intruder!"];
      }
   }
}

