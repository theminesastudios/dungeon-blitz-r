package
{
   import flash.display.MovieClip;
   import flash.geom.Point;
   import flash.utils.Dictionary;
   
   public class a_Cue extends MovieClip
   {
      
      public var characterName:String = null;
      
      public var displayName:String = null;
      
      public var itemDrop:String = null;
      
      public var sayOnSpawn:String = null;
      
      public var sayOnAlert:String = null;
      
      public var sayOnInteract:String = null;
      
      public var sayOnActivate:String = null;
      
      public var sayOnBloodied:String = null;
      
      public var sayOnDeath:String = null;
      
      public var waitToAggro:uint = 0;
      
      public var params:Array = null;
      
      public var dramaAnim:String = null;
      
      public var sleepAnim:String = null;
      
      public var team:String = null;
      
      public var bHoldSpawn:Boolean = false;
      
      public var bHoldEngage:Boolean = false;
      
      internal var entType:String = null;
      
      public var instance:String = null;
      
      internal var parsedParams:Dictionary = null;
      
      internal var id:String;
      
      internal var spawn:String;
      
      internal var treasure:String;
      
      internal var spawnName:String;
      
      internal var type:String;
      
      internal var chest:String;
      
      internal var mLastSpawned:uint;
      
      internal var bRareSpawn:Boolean;
      
      internal var bSpawned:Boolean = false;
      
      internal var defeatTick:uint = 0;
      
      internal var groupSnapPos:Point;
      
      internal var groupSnapOffsetY:int;
      
      internal var bDidGroundSnap:Boolean = false;
      
      internal var groupName:String = null;
      
      internal var aggroTeamID:int;
      
      internal var bDoNotAutoSpawn:Boolean = false;
      
      internal var room:Object = null;
      
      internal var behaviorTweaks:Array = null;
      
      public function a_Cue()
      {
         super();
      }
      
      public function DestroyCue() : void
      {
         this.room = null;
         this.behaviorTweaks = null;
      }
      
      public function IsFacingLeft() : Boolean
      {
         if(rotation > 90 || rotation < -90)
         {
            return false;
         }
         return true;
      }
      
      public function Skit(param1:String) : void
      {
         if(this.room)
         {
            this.room.CueHookSkit(this,param1);
         }
      }
      
      public function Alert() : void
      {
         if(this.room)
         {
            this.room.CueHookAlert(this);
         }
      }
      
      public function Aggro() : void
      {
         if(this.room)
         {
            this.room.CueHookAggro(this);
         }
      }
      
      public function Sleep() : void
      {
         if(this.room)
         {
            this.room.CueHookSleep(this);
         }
      }
      
      public function DeepSleep() : void
      {
         if(this.room)
         {
            this.room.CueHookDeepSleep(this);
         }
      }
      
      public function Spawn() : void
      {
         if(this.room)
         {
            this.room.CueHookSpawn(this);
         }
      }
      
      public function Remove() : void
      {
         if(this.room)
         {
            this.room.CueHookRemove(this);
         }
      }
      
      public function ClearHate() : void
      {
         if(this.room)
         {
            this.room.CueHookClearHate(this);
         }
      }
      
      public function SetPowers(param1:Array) : void
      {
         if(this.room)
         {
            this.room.CueHookSetPowers(this,param1);
         }
      }
      
      public function ResetPowers() : void
      {
         if(this.room)
         {
            this.room.CueHookResetPowers(this);
         }
      }
      
      public function AddPowers(param1:Array) : void
      {
         if(this.room)
         {
            this.room.CueHookAddPowers(this,param1);
         }
      }
      
      public function RemovePowers(param1:Array) : void
      {
         if(this.room)
         {
            this.room.CueHookRemovePowers(this,param1);
         }
      }
      
      public function SetMelee(param1:String) : void
      {
         if(this.room)
         {
            this.room.CueHookSetMelee(this,param1);
         }
      }
      
      public function SetRanged(param1:String) : void
      {
         if(this.room)
         {
            this.room.CueHookSetRanged(this,param1);
         }
      }
      
      public function SetAnimation(param1:String) : void
      {
         if(this.room)
         {
            this.room.CueHookSetAnimation(this,param1);
         }
      }
      
      public function Revive() : void
      {
         if(this.room)
         {
            this.room.CueHookRevive(this);
         }
      }
      
      public function Kill() : void
      {
         if(this.room)
         {
            this.room.CueHookKill(this);
         }
      }
      
      public function AddBuff(param1:String) : void
      {
         if(this.room)
         {
            this.room.CueHookAddBuff(this,param1);
         }
      }
      
      public function RemoveBuff(param1:String) : void
      {
         if(this.room)
         {
            this.room.CueHookRemoveBuff(this,param1);
         }
      }
      
      public function RemoveAllBuffs() : void
      {
         if(this.room)
         {
            this.room.CueHookRemoveAllBuffs(this);
         }
      }
      
      public function FirePower(param1:String, param2:String = null) : void
      {
         if(this.room)
         {
            this.room.CueHookFirePower(this,param1,param2);
         }
      }
      
      public function QuickFirePower(param1:String, param2:String = null) : void
      {
         if(this.room)
         {
            this.room.CueHookQuickFirePower(this,param1,param2);
         }
      }
      
      public function DelayFirePower(param1:String, param2:uint, param3:String = null) : void
      {
         if(this.room)
         {
            this.room.CueHookDelayFirePower(this,param1,param2,param3);
         }
      }
      
      public function Defeated() : Boolean
      {
         if(this.room)
         {
            return this.room.CueHookDefeated(this);
         }
         return true;
      }
      
      public function Health() : Number
      {
         if(this.room)
         {
            return this.room.CueHookHealth(this);
         }
         return 0;
      }
      
      public function OnDefeat() : Boolean
      {
         if(this.room)
         {
            return this.room.CueHookOnDefeat(this);
         }
         return true;
      }
      
      public function AtHealth(param1:Number) : Boolean
      {
         if(this.room)
         {
            return this.room.CueHookAtHealth(this,param1);
         }
         return false;
      }
      
      public function Goto(param1:String, param2:uint = 0) : void
      {
         if(this.room)
         {
            this.room.CueHookGoto(this,param1,param2);
         }
      }
      
      public function HasArrived() : Boolean
      {
         if(this.room)
         {
            return this.room.CueHasArrived(this);
         }
         return true;
      }
      
      public function TweakBehavior(param1:String, param2:Boolean) : void
      {
         if(!this.behaviorTweaks)
         {
            this.behaviorTweaks = new Array();
         }
         this.behaviorTweaks[param1] = param2;
         if(this.room)
         {
            this.room.CueHookTweakBehavior(this,param1,param2);
         }
      }
      
      public function Behavior(param1:String) : void
      {
         if(this.room)
         {
            this.room.CueHookBehavior(this,param1);
         }
      }
      
      public function ResetBehavior() : void
      {
         if(this.room)
         {
            this.room.CueHookResetBehavior(this);
         }
      }
      
      public function Stance(param1:String) : void
      {
         if(this.room)
         {
            this.room.CueHookStance(this,param1);
         }
      }
   }
}

