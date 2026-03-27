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
   
   [Embed(source="/_assets/assets.swf", symbol="symbol1367")]
   public dynamic class a_Room_NRM03RGhostBoss extends MovieClip
   {
      
      public var am_CollisionObject:MovieClip;
      
      public var am_BossFight:a_Volume;
      
      public var am_Moment_Hard:MovieClip;
      
      public var am_Moment_Normal:MovieClip;
      
      public var am_Boss:ac_GrayGhostLord;
      
      public var am_WaveTwo:MovieClip;
      
      public var am_WaveOne:MovieClip;
      
      public var am_Skeleton1:ac_SkeletonSorcerer;
      
      public function a_Room_NRM03RGhostBoss()
      {
         super();
         addFrameScript(0,this.frame1);
         this.__setProp_am_Boss_a_Room_NRM03RGhostBoss_cues_0();
      }
      
      public function InitRoom(param1:a_GameHook) : void
      {
         this.am_Boss.displayName = "Nephit";
         this.am_Boss.bHoldSpawn = true;
         param1.bBossBarOnBottom = false;
         param1.bossFightPhase = this.PhaseFight;
         param1.bBossFightBeginsOnRoomClear = false;
         param1.cutSceneStartBoss = ["0 Camera 1","4 Skeleton1 Bow down, mortal! The Great Nephit approaches!","8 SpawnCue am_Boss","0 FirePower Boss GhostDrama","4 Boss I am The Great Nephit, Wisest Ur-Sage, Conqueror of Death.","12 Player Death Conqueror? You look pretty dead to me.","7 Boss <Surprised>","6 Boss Dead because humans like YOU failed to do your duty when the goblins invaded.","1 Boss <Point01 L>","14 Boss Now the Goblins serve me, because only I can lead them home.","4 Boss <>","12 Boss <ObeyMe>","1 Boss Once I uncover the Dream Dragon’s final secret, all shall obey!","14 Boss <Point02>Slaves, destroy him!|her!","4 Camera Free"];
         param1.cutSceneDefeatBoss = ["4 Boss Wretch! I cannot die...","12 Boss I came back once, I shall again!","12 Player Please, come find me if you want more of the same.","12 Player I wonder what the Dream Dragon he mentioned might be.","10 End"];
      }
      
      public function PhaseFight(param1:a_GameHook) : void
      {
         if(this.am_Boss.AtHealth(0.7))
         {
            param1.Ambush("am_WaveTwo");
            this.am_Boss.Skit("Dead, rise to my defense!:The Ur-Sage demands it!:Kill him|her!");
         }
         if(this.am_Boss.AtHealth(0.45))
         {
            param1.Ambush("am_WaveOne");
            this.am_Boss.Skit("Why do you fight so?:I conquered Death itself:You\'re nothing.");
         }
      }
      
      internal function __setProp_am_Boss_a_Room_NRM03RGhostBoss_cues_0() : *
      {
         try
         {
            this.am_Boss["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.am_Boss.characterName = "NRGhostBoss";
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
      }
   }
}

