package
{
   import flash.display.MovieClip;
   
   [Embed(source="/_assets/assets.swf", symbol="symbol1647")]
   public dynamic class a_Room_SDMission11 extends MovieClip
   {
      
      public var am_CollisionObject:MovieClip;
      
      public var am_Gate1:a_Animation_DoorSpike;
      
      public var am_Foreground:MovieClip;
      
      public var Script_ShakeCamera:Array;
      
      public function a_Room_SDMission11()
      {
         super();
         addFrameScript(0,this.frame1);
      }
      
      public function InitRoom(param1:a_GameHook) : void
      {
         param1.initialPhase = this.Update;
      }
      
      public function Update(param1:a_GameHook) : void
      {
         if(param1.RoomCleared())
         {
            param1.PlayScript(this.Script_ShakeCamera);
            param1.Animate("am_Gate1","Open",true);
            param1.CollisionOff("am_DynamicCollision_Door");
            param1.SetPhase(null);
         }
      }
      
      internal function frame1() : *
      {
         this.Script_ShakeCamera = ["1 Shake 10"];
      }
   }
}

