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
   
   [Embed(source="/_assets/assets.swf", symbol="symbol1125")]
   public dynamic class a_Room_SDMission4_10 extends MovieClip
   {
      
      public var am_Foreground_2:MovieClip;
      
      public var am_Foreground_1:MovieClip;
      
      public var am_CollisionObject:MovieClip;
      
      public var am_EffectMarker2:ac_NephitSpireMarker;
      
      public var am_Warlock1:ac_OasisWarlock;
      
      public var am_EffectMarker1:ac_NephitSpireMarker;
      
      public var am_Tank2:ac_OasisGiant2;
      
      public var am_Warlock2:ac_OasisWarlock;
      
      public var am_Tank1:ac_OasisGiant;
      
      public var am_Puck4:ac_PuckShadow;
      
      public var am_Puck2:ac_OasisPuck;
      
      public var am_Background_1:MovieClip;
      
      public var am_Puck3:ac_PuckShadow;
      
      public var am_Puck1:ac_PuckShadow2;
      
      public var Script_Ambush:Array;
      
      public var Script_Ambush2:Array;
      
      public var bWarlockOne:Boolean;
      
      public var bWarlockTwo:Boolean;
      
      public function a_Room_SDMission4_10()
      {
         super();
         addFrameScript(0,this.frame1);
         this.__setProp_am_Warlock2_a_Room_SDMission4_10_cues_0();
      }
      
      public function InitRoom(param1:a_GameHook) : void
      {
         this.am_Warlock1.bHoldSpawn = true;
         this.am_Warlock2.bHoldSpawn = true;
         param1.initialPhase = this.Update;
      }
      
      public function Update(param1:a_GameHook) : void
      {
         if(!this.bWarlockOne)
         {
            if(this.am_Puck1.Health() < 1 || this.am_Puck2.Health() < 1 || this.am_Puck3.Health() < 1 || this.am_Puck4.Health() < 1)
            {
               param1.PlayScript(this.Script_Ambush);
               this.bWarlockOne = true;
            }
         }
         if(!this.bWarlockTwo)
         {
            if(this.am_Tank1.Health() < 1 || this.am_Tank2.Health() < 1)
            {
               param1.PlayScript(this.Script_Ambush2);
               this.bWarlockTwo = true;
            }
         }
         if(this.bWarlockOne && this.bWarlockTwo)
         {
            param1.SetPhase(null);
         }
      }
      
      internal function __setProp_am_Warlock2_a_Room_SDMission4_10_cues_0() : *
      {
         try
         {
            this.am_Warlock2["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.am_Warlock2.characterName = "";
         this.am_Warlock2.displayName = "";
         this.am_Warlock2.dramaAnim = "";
         this.am_Warlock2.itemDrop = "";
         this.am_Warlock2.sayOnActivate = "The Rebirth demands your blood, human.";
         this.am_Warlock2.sayOnAlert = "";
         this.am_Warlock2.sayOnBloodied = "";
         this.am_Warlock2.sayOnDeath = "";
         this.am_Warlock2.sayOnInteract = "";
         this.am_Warlock2.sayOnSpawn = "";
         this.am_Warlock2.sleepAnim = "";
         this.am_Warlock2.team = "default";
         this.am_Warlock2.waitToAggro = 0;
         try
         {
            this.am_Warlock2["componentInspectorSetting"] = false;
         }
         catch(e:Error)
         {
         }
      }
      
      internal function frame1() : *
      {
         this.Script_Ambush = ["2 QuickFirePower EffectMarker1 OasisTeleportEffect","1 SpawnCue Warlock1","1 Warlock1 Curses upon thee, human!"];
         this.Script_Ambush2 = ["2 QuickFirePower EffectMarker2 OasisTeleportEffect","1 SpawnCue Warlock2","1 Warlock2 The desert shall bloom with they demise!"];
         this.bWarlockOne = false;
         this.bWarlockTwo = false;
      }
   }
}

