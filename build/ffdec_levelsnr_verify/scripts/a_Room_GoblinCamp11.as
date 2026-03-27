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
   
   [Embed(source="/_assets/assets.swf", symbol="symbol1092")]
   public dynamic class a_Room_GoblinCamp11 extends MovieClip
   {
      
      public var am_Foreground_2:a_Animation_EB_SewerWaterFall1;
      
      public var am_Foreground_1:MovieClip;
      
      public var am_Foreground_7:MovieClip;
      
      public var am_CollisionObject:MovieClip;
      
      public var am_BossFight:a_Volume;
      
      public var am_Foreground_6:MovieClip;
      
      public var am_Foreground_5:MovieClip;
      
      public var am_Foreground_4:MovieClip;
      
      public var am_Boss:ac_GoblinBoss2;
      
      public var am_AmbushOne:MovieClip;
      
      public var am_Background_1:a_Animation_EB_SewerWaterFall1;
      
      public var am_Foreground_3:MovieClip;
      
      public var am_Background_2:MovieClip;
      
      public function a_Room_GoblinCamp11()
      {
         super();
         addFrameScript(0,this.frame1);
      }
      
      public function InitRoom(param1:a_GameHook) : void
      {
         this.am_Boss.displayName = "Chief Tourzahl";
         param1.bBossBarOnBottom = false;
         param1.bossFightPhase = this.PhaseFight;
         param1.bBossFightBeginsOnRoomClear = false;
         this.am_Boss.dramaAnim = "Sitting";
         this.am_Boss.sleepAnim = "None";
         param1.Group(this.am_AmbushOne).bHoldSpawn = true;
         param1.cutSceneStartBoss = ["0 Camera 1","4 Boss So, you\'re the Kraken Slayer.","12 Player Good, you\'ve heard of me. Guess what\'s coming next?","12 Boss <GetUp>Better to die by your hand than Nephit\'s.","12 Player Who is this Nephit guy anyway?","10 Boss He\'s one of your people, not one of us goblins.","13 Boss <Flourish L>Whoever wins here will have to deal with his foul magic.","12 Camera Free"];
         param1.cutSceneDefeatBoss = ["4 Boss Goblins will curse your name for 1000 years.","12 Player As long as you remember you lost the war.","12 End"];
      }
      
      public function PhaseFight(param1:a_GameHook) : void
      {
         if(this.am_Boss.AtHealth(0.5))
         {
            param1.Ambush("am_AmbushOne");
            this.am_Boss.Skit("Goblins! This is our final stand!");
            this.am_AmbushOne.am_Lt.Skit(":We\'re coming, boss");
         }
      }
      
      internal function frame1() : *
      {
      }
   }
}

