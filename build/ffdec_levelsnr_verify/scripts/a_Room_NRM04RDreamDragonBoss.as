package
{
   import flash.display.MovieClip;
   
   [Embed(source="/_assets/assets.swf", symbol="symbol1530")]
   public dynamic class a_Room_NRM04RDreamDragonBoss extends MovieClip
   {
      
      public var am_Foreground_2:MovieClip;
      
      public var am_CollisionObject:MovieClip;
      
      public var am_BossFight:a_Volume;
      
      public var am_Foreground_4:MovieClip;
      
      public var am_Boss:ac_YoungDragonDream;
      
      public var am_Foreground_25:MovieClip;
      
      public var am_WaveOne:MovieClip;
      
      public var am_Foreground:MovieClip;
      
      public var am_Foreground_3:MovieClip;
      
      public function a_Room_NRM04RDreamDragonBoss()
      {
         super();
         addFrameScript(0,this.frame1);
      }
      
      public function InitRoom(param1:a_GameHook) : void
      {
         this.am_Boss.displayName = "Sythokhan’s Dream";
         this.am_Boss.dramaAnim = "Sleeping";
         param1.bBossBarOnBottom = false;
         param1.bossFightPhase = this.PhaseFight;
         param1.bBossFightBeginsOnRoomClear = false;
         param1.cutSceneStartBoss = ["0 Camera 1","8 Boss A human slave disturbs my dream.","6 Player A dragon! Maybe this really is a dream...","12 Boss <WakeUp L>A dream, yes. But not YOUR dream, little thing.","12 Boss <None> Perhaps devouring you will awaken my body in the Sleeping Lands.","12 Player The Sleeping Lands? What does that mean?","12 Boss You won\'t live long enough to understand, slave.","12 Camera Free"];
         param1.cutSceneDefeatBoss = ["4 Boss I AWAKEN! My legion rises to make your world tremble...","12 Player That doesn\'t sound good...","12 Player I need to know more about these Sleeping Lands.","8 End"];
      }
      
      public function PhaseFight(param1:a_GameHook) : void
      {
         if(this.am_Boss.AtHealth(0.5))
         {
            param1.Ambush("am_WaveOne");
            this.am_Boss.Skit("Why do I torment myself with these fantasies?:Come forth my fellow dreamers.");
         }
      }
      
      internal function frame1() : *
      {
      }
   }
}

