package
{
   import flash.display.MovieClip;
   import flash.events.MouseEvent;
   import flash.geom.Point;
   
   public class class_112 extends class_32
   {
      
      internal var var_1914:String;
      
      internal var var_345:Point;
      
      internal var var_2345:MovieClip;
      
      internal var var_1467:MovieClip;
      
      internal var var_658:class_138;
      
      internal var var_458:class_138;
      
      internal var var_327:class_138;
      
      internal var var_1845:class_33;
      
      internal var var_1990:class_33;
      
      internal var var_480:class_33;
      
      internal var var_2924:class_33;
      
      public function class_112(param1:Game)
      {
         super(param1,"a_QuestTracker",null);
         var_15 = true;
         mbHideOnClear = false;
      }
      
      override public function OnCreateScreen() : void
      {
         this.var_1845 = method_5(var_2.am_ContactMatte,this.method_1922,this.method_1308,this.method_1768);
         this.var_1990 = method_1(var_2.am_InitialMapCover);
         var_2.am_Selector.mouseEnabled = false;
         var_2.am_Selector.mouseChildren = false;
         var_2.am_Selector.visible = false;
         this.var_1467 = var_2.am_ArrowWrapper;
         this.var_2345 = this.var_1467.am_Arrow;
         this.var_658 = method_21(var_2.am_QuestName);
         this.var_458 = method_21(var_2.am_QuestDesc);
         this.var_327 = method_21(var_2.am_ProgressText);
         this.var_480 = method_17(var_2.am_Progress,"Progress",0);
         var_2.am_CacheIcon.mouseEnabled = false;
         var_2.am_CacheIcon.mouseChildren = false;
      }
      
      private function method_1308(param1:MouseEvent) : void
      {
         var_2.am_Selector.visible = true;
      }
      
      private function method_1768(param1:MouseEvent) : void
      {
         var_2.am_Selector.visible = false;
      }
      
      override public function OnDestroyScreen() : void
      {
         this.var_2924 = null;
         this.var_345 = null;
         this.var_1845 = null;
         this.var_480 = null;
         this.var_2345 = null;
         this.var_1467 = null;
         this.var_658 = null;
         this.var_458 = null;
         this.var_327 = null;
         this.var_1990 = null;
      }
      
      private function method_271() : void
      {
         this.var_1914 = null;
         this.var_345 = null;
         this.var_1467.visible = false;
         this.var_327.Hide();
         this.var_480.Hide();
      }
      
      private function method_122(param1:String, param2:Boolean) : void
      {
         var _loc5_:uint = 0;
         var _loc6_:class_158 = null;
         var _loc7_:class_158 = null;
         var _loc3_:Level = var_1.level;
         this.var_1914 = param1;
         if(param1)
         {
            this.var_345 = _loc3_.var_456[param1];
         }
         else
         {
            this.var_345 = null;
         }
         if(!this.var_345)
         {
            this.var_1914 = null;
         }
         if(this.var_345)
         {
            _loc5_ = 0;
            _loc7_ = var_1.screenMap.mActivePath;
            while(_loc5_++ < 20)
            {
               _loc6_ = class_119.method_408(_loc3_.internalName,this.var_345.x,this.var_345.y);
               if(_loc6_ == _loc7_)
               {
                  break;
               }
               if(!_loc6_ || !_loc6_.var_1904)
               {
                  if(Boolean(_loc7_) && Boolean(_loc7_.var_1903))
                  {
                     this.var_345 = _loc7_.var_1903;
                  }
                  break;
               }
               this.var_345 = _loc6_.var_1904;
            }
            this.var_327.method_878(0," ft");
         }
         var _loc4_:* = this.var_1914 != null;
         this.var_1467.visible = _loc4_;
         this.var_327.Show();
         this.var_480.Show();
      }
      
      private function method_1664() : Boolean
      {
         if(!var_1.MissionIsComplete(class_13.const_1151))
         {
            return false;
         }
         if(var_1.MissionIsComplete(class_13.const_944))
         {
            return false;
         }
         if(var_1.InHardMode())
         {
            return false;
         }
         return true;
      }
      
      private function method_1932() : Boolean
      {
         if(var_1.level.internalName == "TutorialBoat")
         {
            return false;
         }
         return true;
      }

      private function method_2048(param1:Level) : uint
      {
         if(!param1)
         {
            return 0;
         }
         if(!param1.bInstanced || param1.var_1657)
         {
            return param1.var_690;
         }
         if(!var_1.groupmates || !var_1.groupmates.length || var_1.bAmGroupLeader)
         {
            return param1.var_690;
         }
         return param1.var_690 >= 100 ? 99 : param1.var_690;
      }
      
      override public function OnRefreshScreen() : void
      {
         var _loc6_:class_13 = null;
         if(!this.method_1932())
         {
            this.var_1990.Show();
            this.var_1845.Hide();
            this.method_271();
            return;
         }
         this.var_1845.Show();
         this.var_1990.Hide();
         var _loc1_:Level = var_1.level;
         var _loc2_:String = _loc1_.internalName;
         var _loc3_:class_13 = var_1.mTrackedMission;
         if(!_loc3_)
         {
            if(_loc1_.var_333)
            {
               this.var_658.SetText("");
               this.var_458.SetText("");
               this.method_271();
            }
            else if(_loc2_ == "CraftTownTutorial")
            {
               _loc6_ = class_14.var_238[class_13.const_118];
               this.var_658.SetText(_loc6_.displayName);
               this.var_458.SetText(_loc6_.var_2116);
               this.var_327.SetText("1/1");
               this.var_480.mHealthPerc = 1;
               this.method_122(null,false);
            }
            else if(_loc1_.bInstanced)
            {
               this.var_658.SetText(Level.method_73(_loc2_));
               this.var_458.SetText("Clear the Dungeon");
               this.var_327.SetText(String(this.method_2048(_loc1_)) + "%");
               this.var_480.mHealthPerc = this.method_2048(_loc1_) / 100;
               this.method_122(null,true);
            }
            else if(this.method_1664())
            {
               this.var_658.SetText("Enter the Dreadfold");
               this.var_458.SetText("Head towards Felbridge to speak with Bella Sagesword");
               if(_loc1_.internalName == "BridgeTown")
               {
                  this.method_122("NPCTraveller",true);
               }
               else
               {
                  this.method_271();
               }
            }
            else
            {
               var _loc7_:String = Level.method_182(_loc2_);
               var _loc8_:String = Level.method_73(null);
               this.var_658.SetText(null);
               this.var_458.SetText("No Quests Available");
               this.method_271();
            }
            return;
         }
         var _loc4_:Mission = var_1.mMissionInfoList[_loc3_.missionID];
         if(!_loc4_)
         {
            this.var_480.mHealthPerc = 0;
            this.var_658.SetText(_loc3_.displayName);
            this.var_327.SetText("");
            if(_loc3_.var_160)
            {
               this.var_458.SetText("Quest Available\nTalk to " + class_35.const_379[_loc3_.var_160]);
               this.method_122(_loc3_.var_160,false);
            }
            else if(_loc3_.var_134)
            {
               this.var_458.SetText("Quest Available\nHead to " + Level.method_73(_loc3_.var_134));
               this.method_122(_loc3_.var_134,true);
            }
            else
            {
               this.var_458.SetText("Quest Available");
               this.method_271();
            }
            return;
         }
         var _loc5_:* = _loc4_.var_145 == Mission.const_58;
         this.var_658.SetText(_loc3_.displayName);
         this.var_458.SetText(_loc5_ ? _loc3_.var_2550 : _loc3_.var_2116);
         if(Boolean(_loc3_.var_134) && _loc2_ == _loc3_.var_134)
         {
            this.var_480.mHealthPerc = this.method_2048(_loc1_) / 100;
            this.var_327.SetText(String(this.method_2048(_loc1_)) + "%");
            this.method_122(null,true);
         }
         else if(!_loc5_)
         {
            this.var_480.mHealthPerc = _loc4_.currCount / _loc3_.var_908;
            this.var_327.SetText(_loc4_.currCount + "/" + _loc3_.var_908);
            if(_loc3_.var_134)
            {
               this.method_122(_loc3_.var_134,true);
            }
            else
            {
               this.method_122(_loc3_.var_1323,false);
            }
         }
         else if(Boolean(_loc3_.var_186) && _loc3_.var_186 != _loc2_)
         {
            this.var_480.mHealthPerc = 0;
            this.var_327.SetText(_loc3_.var_908 ? "1/1" : "0/1");
            this.method_122(_loc3_.var_186,false);
         }
         else
         {
            this.var_480.mHealthPerc = 1;
            this.var_327.SetText("1/1");
            this.method_122(_loc3_.var_319,false);
         }
      }
      
      override public function OnTickScreen() : void
      {
         var _loc1_:Entity = var_1.clientEnt;
         if(!_loc1_)
         {
            return;
         }
         if(!this.var_345)
         {
            return;
         }
         var _loc2_:int = _loc1_.physPosX - this.var_345.x;
         var _loc3_:int = _loc1_.physPosY - this.var_345.y;
         var _loc4_:Number = Math.atan2(_loc2_,_loc3_) * 180 / Math.PI;
         var _loc5_:int = (Math.abs(_loc2_) + Math.abs(_loc3_)) * Game.const_452;
         this.var_2345.rotation = -_loc4_;
         this.var_327.var_213 = _loc5_;
      }
      
      private function method_1922(param1:MouseEvent) : void
      {
         var_1.screenMap.Toggle();
         class_53.method_79("Map:Clicked",1);
      }
   }
}

