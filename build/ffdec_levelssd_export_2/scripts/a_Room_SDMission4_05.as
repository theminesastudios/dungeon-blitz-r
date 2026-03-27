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
   
   [Embed(source="/_assets/assets.swf", symbol="symbol1187")]
   public dynamic class a_Room_SDMission4_05 extends MovieClip
   {
      
      public var am_CollisionObject:MovieClip;
      
      public var am_BigGuy:ac_OasisGiant;
      
      public var am_Puck2:ac_OasisPuck;
      
      public var am_Foreground:MovieClip;
      
      public var am_Puck1:ac_OasisPuck;
      
      public var Script_Intro:Array;
      
      public function a_Room_SDMission4_05()
      {
         super();
         addFrameScript(0,this.frame1);
         this.__setProp_am_BigGuy_a_Room_SDMission4_05_cues_0();
      }
      
      public function InitRoom(param1:a_GameHook) : void
      {
         param1.initialPhase = this.Update;
      }
      
      public function Update(param1:a_GameHook) : void
      {
         if(param1.AtTime(0))
         {
            this.am_Puck1.AddBuff("NephitSleep");
            this.am_Puck2.AddBuff("NephitSleep");
            this.am_BigGuy.AddBuff("NephitSleep");
            this.am_Puck1.DeepSleep();
            this.am_Puck2.DeepSleep();
            this.am_BigGuy.DeepSleep();
         }
         if(param1.OnTrigger("am_Trigger_IntroMob"))
         {
            param1.PlayScript(this.Script_Intro);
         }
         if(param1.OnScriptFinish(this.Script_Intro))
         {
            this.am_Puck1.RemoveBuff("NephitSleep");
            this.am_Puck2.RemoveBuff("NephitSleep");
            this.am_BigGuy.RemoveBuff("NephitSleep");
            this.am_Puck1.Aggro();
            this.am_Puck2.Aggro();
            this.am_BigGuy.Aggro();
            param1.SetPhase(null);
         }
      }
      
      internal function __setProp_am_BigGuy_a_Room_SDMission4_05_cues_0() : *
      {
         try
         {
            this.am_BigGuy["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.am_BigGuy.characterName = "";
         this.am_BigGuy.displayName = "";
         this.am_BigGuy.dramaAnim = "";
         this.am_BigGuy.itemDrop = "";
         this.am_BigGuy.sayOnActivate = "The sands rise to reclaim our rights.:All shall be Seelie again.";
         this.am_BigGuy.sayOnAlert = "";
         this.am_BigGuy.sayOnBloodied = "";
         this.am_BigGuy.sayOnDeath = "";
         this.am_BigGuy.sayOnInteract = "";
         this.am_BigGuy.sayOnSpawn = "";
         this.am_BigGuy.sleepAnim = "";
         this.am_BigGuy.team = "default";
         this.am_BigGuy.waitToAggro = 0;
         try
         {
            this.am_BigGuy["componentInspectorSetting"] = false;
         }
         catch(e:Error)
         {
         }
      }
      
      internal function frame1() : *
      {
         this.Script_Intro = ["4 BigGuy <Melee> Cut down the human!","1 End"];
      }
   }
}

