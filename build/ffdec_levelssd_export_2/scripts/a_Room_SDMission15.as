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
   
   [Embed(source="/_assets/assets.swf", symbol="symbol1625")]
   public dynamic class a_Room_SDMission15 extends MovieClip
   {
      
      public var am_BossFight:a_Volume;
      
      public var am_CollisionObject:MovieClip;
      
      public var am_Boss:ac_RageGuardian;
      
      public var am_Adds:MovieClip;
      
      public var Script_SummonAdd:Array;
      
      public var Script_SummonAddSpeech:Array;
      
      public const NUMBER_OF_ADDS:int = 4;
      
      public var adds:Vector.<a_Cue>;
      
      public var activeServants:Vector.<a_Cue>;
      
      public function a_Room_SDMission15()
      {
         super();
         addFrameScript(0,this.frame1);
      }
      
      public function InitRoom(param1:a_GameHook) : void
      {
         var _loc2_:a_Cue = null;
         this.am_Boss.displayName = "Pharoh Amenrahtep";
         var _loc3_:int = 1;
         while(_loc3_ <= this.NUMBER_OF_ADDS)
         {
            _loc2_ = this.am_Adds["am_Marker" + _loc3_] as a_Cue;
            this.adds.push(_loc2_);
            _loc3_++;
         }
         this.adds.fixed = true;
         param1.bBossBarOnBottom = true;
         param1.bossFightPhase = this.Update;
         param1.bBossFightBeginsOnRoomClear = false;
         param1.cutSceneStartBoss = ["2 Camera 3","2 Boss <Goto Red 2>","4 Boss You dare defile this sacred space!","8 Boss The Ogre Magi built this realm...","8 Boss <Roar> Your presence here is an outrage to my legacy!","8 End"];
         param1.cutSceneDefeatBoss = ["2 Shake 25","1 Boss My people will reclaim their blood right...","10 End"];
      }
      
      public function WaitingForPull(param1:a_GameHook) : void
      {
         if(this.am_Boss.Health() != 1)
         {
            param1.SetPhase(this.Update);
         }
      }
      
      public function Update(param1:a_GameHook) : void
      {
         var _loc2_:int = 0;
         var _loc3_:a_Cue = null;
         var _loc4_:* = 0;
         var _loc5_:int = 0;
         if(param1.AtTime(0))
         {
            this.am_Boss.Skit("I curse your line, human!");
            param1.Group(this.am_Adds,this.NUMBER_OF_ADDS).Kill();
         }
         if(this.am_Boss.Defeated())
         {
            this.adds = null;
            this.activeServants = null;
            param1.Group(this.am_Adds,this.NUMBER_OF_ADDS).Kill();
            param1.SetPhase(null);
            return;
         }
         if(param1.AtTimeRepeat(12000,6000))
         {
            _loc2_ = Math.random() * this.NUMBER_OF_ADDS;
            _loc3_ = this.adds[_loc2_];
            if(_loc3_.Health() <= 0)
            {
               _loc3_.Revive();
               this.activeServants.push(_loc3_);
               _loc3_.AddBuff("EarthServantArmor");
               param1.PlayScript(this.Script_SummonAdd);
               param1.PlayScript(this.Script_SummonAddSpeech);
               this.am_Boss.AddBuff("RageMummyArmor");
            }
         }
         if(param1.AtTimeRepeat(500,0))
         {
            _loc4_ = int(this.activeServants.length);
            if(_loc4_ == 0)
            {
               this.am_Boss.RemoveBuff("RageMummyArmor");
            }
            else
            {
               _loc5_ = 0;
               while(_loc5_ < _loc4_)
               {
                  _loc3_ = this.activeServants[_loc5_];
                  if(_loc3_.Health() <= 0)
                  {
                     _loc3_.RemoveBuff("EarthServantArmor");
                     this.activeServants.splice(_loc5_,1);
                     _loc4_--;
                  }
                  _loc5_++;
               }
            }
         }
      }
      
      internal function frame1() : *
      {
         this.Script_SummonAdd = ["2 Shake 16"];
         this.Script_SummonAddSpeech = ["0 Boss <Roar> Seelie Counts, fortify me!"];
         this.adds = new Vector.<a_Cue>(0,false);
         this.activeServants = new Vector.<a_Cue>(0,false);
      }
   }
}

