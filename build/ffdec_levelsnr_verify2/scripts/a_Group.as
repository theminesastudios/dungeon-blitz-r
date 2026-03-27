package
{
   public class a_Group
   {
      
      internal var mGroupName:String;
      
      internal var mRoom:Object;
      
      private var mChooseCount:uint;
      
      private var mbSorted:Boolean;
      
      internal var bHoldSpawn:Boolean;
      
      private var mCueList:Vector.<a_Cue>;
      
      private var mCueTotalCount:uint;
      
      public function a_Group(param1:String, param2:Object)
      {
         super();
         this.mRoom = param2;
         this.mGroupName = param1;
         this.mCueList = new Vector.<a_Cue>();
      }
      
      public function DestroyGroup() : void
      {
         this.mRoom = null;
         this.mCueList = null;
      }
      
      public function AddNewCue(param1:a_Cue) : void
      {
         this.mCueList.push(param1);
         this.mCueTotalCount = this.mCueList.length;
         this.mChooseCount = this.mCueTotalCount;
         this.Sort();
         if(this.bHoldSpawn)
         {
            param1.bHoldSpawn = this.bHoldSpawn;
         }
      }
      
      public function Choose(param1:uint) : void
      {
         var _loc2_:a_Cue = null;
         var _loc3_:uint = 0;
         var _loc4_:uint = 0;
         if(!param1 || param1 >= this.mCueTotalCount)
         {
            this.mChooseCount = this.mCueTotalCount;
            if(!this.mbSorted)
            {
               this.Sort();
            }
            return;
         }
         var _loc5_:uint = 0;
         while(_loc5_ < param1)
         {
            _loc4_ = this.mCueTotalCount - _loc5_;
            _loc3_ = _loc5_ + Math.random() * _loc4_;
            _loc2_ = this.mCueList[_loc5_];
            this.mCueList[_loc5_] = this.mCueList[_loc3_];
            this.mCueList[_loc3_] = _loc2_;
            _loc5_++;
         }
         this.mChooseCount = param1;
         this.mbSorted = false;
      }
      
      private function Sort() : void
      {
         this.mbSorted = true;
         this.mCueList.sort(this.SortCuesLeftToRight);
      }
      
      private function SortCuesLeftToRight(param1:a_Cue, param2:a_Cue) : int
      {
         return param1.x < param2.x ? -1 : (param1.x > param2.x ? 1 : 0);
      }
      
      public function Aggro() : void
      {
         var _loc1_:uint = 0;
         while(_loc1_ < this.mChooseCount)
         {
            this.mRoom.CueHookAggro(this.mCueList[_loc1_]);
            _loc1_++;
         }
      }
      
      public function ClearHate() : void
      {
         var _loc1_:uint = 0;
         while(_loc1_ < this.mChooseCount)
         {
            this.mRoom.CueHookClearHate(this.mCueList[_loc1_]);
            _loc1_++;
         }
      }
      
      public function Revive() : void
      {
         var _loc1_:uint = 0;
         while(_loc1_ < this.mChooseCount)
         {
            this.mRoom.CueHookRevive(this.mCueList[_loc1_]);
            _loc1_++;
         }
      }
      
      public function Kill() : void
      {
         var _loc1_:uint = 0;
         while(_loc1_ < this.mChooseCount)
         {
            this.mRoom.CueHookKill(this.mCueList[_loc1_]);
            _loc1_++;
         }
      }
      
      public function Spawn() : void
      {
         var _loc1_:uint = 0;
         while(_loc1_ < this.mChooseCount)
         {
            this.mRoom.CueHookSpawn(this.mCueList[_loc1_]);
            _loc1_++;
         }
      }
      
      public function Remove() : void
      {
         var _loc1_:uint = 0;
         while(_loc1_ < this.mChooseCount)
         {
            this.mRoom.CueHookRemove(this.mCueList[_loc1_]);
            _loc1_++;
         }
      }
      
      public function FirePower(param1:String, param2:String = null) : void
      {
         var _loc3_:uint = 0;
         while(_loc3_ < this.mChooseCount)
         {
            this.mRoom.CueHookFirePower(this.mCueList[_loc3_],param1,param2);
            _loc3_++;
         }
      }
      
      public function QuickFirePower(param1:String, param2:String = null) : void
      {
         var _loc3_:uint = 0;
         while(_loc3_ < this.mChooseCount)
         {
            this.mRoom.CueHookQuickFirePower(this.mCueList[_loc3_],param1,param2);
            _loc3_++;
         }
      }
      
      public function DelayFirePower(param1:String, param2:uint, param3:String = null) : void
      {
         var _loc4_:uint = 0;
         while(_loc4_ < this.mChooseCount)
         {
            this.mRoom.CueHookDelayFirePower(this.mCueList[_loc4_],param1,param2,param3);
            _loc4_++;
         }
      }
      
      public function Defeated() : Boolean
      {
         var _loc1_:uint = 0;
         while(_loc1_ < this.mChooseCount)
         {
            if(!this.mRoom.CueHookDefeated(this.mCueList[_loc1_]))
            {
               return false;
            }
            _loc1_++;
         }
         return true;
      }
      
      public function FirePowerSequence(param1:String, param2:uint, param3:String = null) : void
      {
         var _loc4_:uint = 0;
         while(_loc4_ < this.mChooseCount)
         {
            this.mRoom.CueHookDelayFirePower(this.mCueList[_loc4_],param1,param2 * _loc4_,param3);
            _loc4_++;
         }
      }
      
      public function GroupAggro() : void
      {
         this.mRoom.CueListHookGroupAggro(this.mCueList,this.mChooseCount);
      }
   }
}

