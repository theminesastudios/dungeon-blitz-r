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
   
   [Embed(source="/_assets/assets.swf", symbol="symbol1114")]
   public dynamic class a_Room_SDMission4_09 extends MovieClip
   {
      
      public var am_CollisionObject:MovieClip;
      
      public var am_EffectMarker1:ac_NephitSpireMarker;
      
      public var am_Raptor1:ac_OasisRaptor;
      
      public var am_Raptor2:ac_OasisRaptor2;
      
      public var am_Tank:ac_OasisGiant;
      
      public var am_Raptor3:ac_OasisRaptor2;
      
      public var am_Raptor4:ac_OasisRaptor;
      
      public var am_Warlock:ac_OasisWarlock;
      
      public var am_Raptor5:ac_OasisRaptor2;
      
      public var am_Foreground:MovieClip;
      
      public var Script_Ambush:Array;
      
      public function a_Room_SDMission4_09()
      {
         super();
         addFrameScript(0,this.frame1);
         this.__setProp_am_Tank_a_Room_SDMission4_09_cues_0();
      }
      
      public function InitRoom(param1:a_GameHook) : void
      {
         this.am_Warlock.bHoldSpawn = true;
         param1.initialPhase = this.Update;
      }
      
      public function Update(param1:a_GameHook) : void
      {
         if(param1.OnTrigger("am_Trigger_Ambush"))
         {
            param1.PlayScript(this.Script_Ambush);
            this.am_Tank.Aggro();
            this.am_Raptor1.Aggro();
            this.am_Raptor2.Aggro();
            this.am_Raptor3.Aggro();
            this.am_Raptor4.Aggro();
            this.am_Raptor5.Aggro();
            this.am_Tank.Skit("<Melee>");
            param1.SetPhase(null);
         }
      }
      
      internal function __setProp_am_Tank_a_Room_SDMission4_09_cues_0() : *
      {
         try
         {
            this.am_Tank["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.am_Tank.characterName = "";
         this.am_Tank.displayName = "";
         this.am_Tank.dramaAnim = "";
         this.am_Tank.itemDrop = "";
         this.am_Tank.sayOnActivate = "We shall feed you to the sands!";
         this.am_Tank.sayOnAlert = "";
         this.am_Tank.sayOnBloodied = "";
         this.am_Tank.sayOnDeath = "";
         this.am_Tank.sayOnInteract = "";
         this.am_Tank.sayOnSpawn = "";
         this.am_Tank.sleepAnim = "";
         this.am_Tank.team = "default";
         this.am_Tank.waitToAggro = 0;
         try
         {
            this.am_Tank["componentInspectorSetting"] = false;
         }
         catch(e:Error)
         {
         }
      }
      
      internal function frame1() : *
      {
         this.Script_Ambush = ["0 QuickFirePower EffectMarker1 OasisTeleportEffect","1 SpawnCue Warlock","1 Warlock This land will be our paradise...","8 Warlock Once we clear it of you lowly pests."];
      }
   }
}

