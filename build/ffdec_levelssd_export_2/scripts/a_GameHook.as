package
{
   import flash.display.MovieClip;
   
   public class a_GameHook
   {
      
      public var bBossFightBeginsOnRoomClear:Boolean = false;
      
      public var bossFightBeginsWhenThisGuyIsDead:String = null;
      
      public var bBossBarOnBottom:Boolean = false;
      
      public var bossFightPhase:Function = null;
      
      public var initialPhase:Function = null;
      
      public var bDoubleBossFight:Boolean = false;
      
      public var cutSceneStartBoss:Array = null;
      
      public var cutSceneDefeatBoss:Array = null;
      
      public var linkToRoom:Object = null;
      
      public function a_GameHook(param1:Object)
      {
         super();
         this.linkToRoom = param1;
      }
      
      public function DestroyGameHook() : void
      {
         this.bossFightPhase = null;
         this.cutSceneStartBoss = null;
         this.cutSceneDefeatBoss = null;
         this.linkToRoom = null;
         this.bossFightBeginsWhenThisGuyIsDead = null;
      }
      
      public function AtStart() : Boolean
      {
         if(this.linkToRoom)
         {
            return this.linkToRoom.HookAtStart();
         }
         return false;
      }
      
      public function AtTime(param1:uint) : Boolean
      {
         if(this.linkToRoom)
         {
            return this.linkToRoom.HookAtTime(param1);
         }
         return false;
      }
      
      public function AtTimeRepeat(param1:uint, param2:int = -1) : Boolean
      {
         if(this.linkToRoom)
         {
            return this.linkToRoom.HookAtTimeRepeat(param1,param2 >= 0 ? param2 : param1);
         }
         return false;
      }
      
      public function GetTime() : Number
      {
         if(this.linkToRoom)
         {
            return this.linkToRoom.HookGetTime();
         }
         return 0;
      }
      
      public function SetPhase(param1:Function) : void
      {
         if(this.linkToRoom)
         {
            this.linkToRoom.HookSetPhase(param1);
         }
      }
      
      public function Animate(param1:String, param2:String, param3:Boolean = true) : void
      {
         if(this.linkToRoom)
         {
            this.linkToRoom.HookAnimate(param1,param2,param3);
         }
      }
      
      public function PlaySound(param1:String, param2:Number = 1) : void
      {
         if(this.linkToRoom)
         {
            this.linkToRoom.HookPlaySound(param1,param2);
         }
      }
      
      public function SetVar(param1:String, param2:String) : void
      {
         if(this.linkToRoom)
         {
            this.linkToRoom.HookSetVar(param1,param2);
         }
      }
      
      public function GetVar(param1:String) : String
      {
         if(this.linkToRoom)
         {
            return this.linkToRoom.HookGetVar(param1);
         }
         return null;
      }
      
      public function CollisionOn(param1:String) : void
      {
         if(this.linkToRoom)
         {
            this.linkToRoom.HookCollisionOn(param1);
         }
      }
      
      public function CollisionOff(param1:String) : void
      {
         if(this.linkToRoom)
         {
            this.linkToRoom.HookCollisionOff(param1);
         }
      }
      
      public function ShowTutorial(param1:String) : void
      {
         if(this.linkToRoom)
         {
            this.linkToRoom.HookShowTutorial(param1);
         }
      }
      
      public function HideTutorial(param1:String) : void
      {
         if(this.linkToRoom)
         {
            this.linkToRoom.HookHideTutorial(param1);
         }
      }
      
      public function EnableDoor(param1:MovieClip) : void
      {
         if(this.linkToRoom)
         {
            this.linkToRoom.HookEnableDoor(param1);
         }
      }
      
      public function DisableDoor(param1:MovieClip) : void
      {
         if(this.linkToRoom)
         {
            this.linkToRoom.HookDisableDoor(param1);
         }
      }
      
      public function Ambush(param1:String) : void
      {
         if(this.linkToRoom)
         {
            this.linkToRoom.HookAmbush(param1);
         }
      }
      
      public function PlayScript(param1:Array) : void
      {
         if(this.linkToRoom)
         {
            this.linkToRoom.HookPlayScript(param1);
         }
      }
      
      public function CancelScript(param1:Array) : void
      {
         if(this.linkToRoom)
         {
            this.linkToRoom.HookCancelScript(param1);
         }
      }
      
      public function PlayCutScene(param1:Array) : void
      {
         if(this.linkToRoom)
         {
            this.linkToRoom.HookPlayCutScene(param1);
         }
      }
      
      public function OnScriptFinish(param1:Array) : Boolean
      {
         if(this.linkToRoom)
         {
            return this.linkToRoom.HookOnScriptFinish(param1);
         }
         return false;
      }
      
      public function OnTrigger(param1:String) : Boolean
      {
         if(this.linkToRoom)
         {
            return this.linkToRoom.HookOnTrigger(param1);
         }
         return false;
      }
      
      public function OnEnterVolume(param1:String) : Boolean
      {
         if(this.linkToRoom)
         {
            return this.linkToRoom.HookOnEnterVolume(param1);
         }
         return false;
      }
      
      public function OnExitVolume(param1:String) : Boolean
      {
         if(this.linkToRoom)
         {
            return this.linkToRoom.HookOnExitVolume(param1);
         }
         return false;
      }
      
      public function OnEmote(param1:String = null) : Boolean
      {
         if(this.linkToRoom)
         {
            return this.linkToRoom.HookOnEmote(param1);
         }
         return false;
      }
      
      public function OnChat(param1:String = null) : Boolean
      {
         if(this.linkToRoom)
         {
            return this.linkToRoom.HookOnChat(param1);
         }
         return false;
      }
      
      public function ActiveEmote(param1:String = null) : Boolean
      {
         if(this.linkToRoom)
         {
            return this.linkToRoom.HookActiveEmote(param1);
         }
         return false;
      }
      
      public function ActiveChat(param1:String = null) : Boolean
      {
         if(this.linkToRoom)
         {
            return this.linkToRoom.HookActiveChat(param1);
         }
         return false;
      }
      
      public function RoomCleared() : Boolean
      {
         if(this.linkToRoom)
         {
            return this.linkToRoom.HookRoomCleared();
         }
         return false;
      }
      
      public function Group(param1:MovieClip, param2:uint = 0) : a_Group
      {
         return this.linkToRoom.HookGetGroup(param1,param2,true);
      }
      
      public function SameGroup(param1:MovieClip, param2:uint = 0) : a_Group
      {
         return this.linkToRoom.HookGetGroup(param1,param2,false);
      }
      
      public function Trace(param1:String) : void
      {
         if(this.linkToRoom)
         {
            this.linkToRoom.HookTrace(param1);
         }
      }
   }
}

