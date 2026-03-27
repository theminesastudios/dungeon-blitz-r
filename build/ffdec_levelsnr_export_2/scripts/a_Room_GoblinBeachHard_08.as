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
   
   [Embed(source="/_assets/assets.swf", symbol="symbol1242")]
   public dynamic class a_Room_GoblinBeachHard_08 extends MovieClip
   {
      
      public var am_CollisionObject:MovieClip;
      
      public var __id279_:ac_GoblinHatchet;
      
      public var am_Mage2:ac_GoblinShamanHood;
      
      public var am_Gob1:ac_GoblinShamanSkullHat;
      
      public var am_Gate:a_Animation_GoblinGate2;
      
      public var am_Gob2:ac_GoblinArmorAxe;
      
      public var am_Mage1:ac_GoblinShamanHood;
      
      public var am_Gob3:ac_GoblinArmorSword;
      
      public var am_Foreground:MovieClip;
      
      public var Script_Ambush:Array;
      
      public var Script_Shake:Array;
      
      public function a_Room_GoblinBeachHard_08()
      {
         super();
         addFrameScript(0,this.frame1);
         this.__setProp___id279__a_Room_GoblinBeachHard_08_cues_0();
      }
      
      public function InitRoom(param1:a_GameHook) : void
      {
         this.am_Mage1.bHoldSpawn = true;
         this.am_Mage2.bHoldSpawn = true;
         param1.initialPhase = this.Update;
      }
      
      public function Update(param1:a_GameHook) : void
      {
         if(param1.AtTime(0))
         {
            this.am_Gob1.AddBuff("NephitSleep");
            this.am_Gob1.DeepSleep();
         }
         if(param1.OnTrigger("am_Trigger_1"))
         {
            param1.PlayScript(this.Script_Ambush);
         }
         if(param1.OnScriptFinish(this.Script_Ambush))
         {
            this.am_Gob1.RemoveBuff("NephitSleep");
            this.am_Gob1.Aggro();
            this.am_Gob2.Aggro();
            this.am_Gob3.Aggro();
         }
         if(param1.RoomCleared())
         {
            param1.CollisionOff("am_DynamicCollision_PathBlock02");
            param1.PlayScript(this.Script_Shake);
            param1.Animate("am_Gate","Open",true);
            param1.SetPhase(null);
         }
      }
      
      internal function __setProp___id279__a_Room_GoblinBeachHard_08_cues_0() : *
      {
         try
         {
            this.__id279_["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.__id279_.characterName = "";
         this.__id279_.displayName = "";
         this.__id279_.dramaAnim = "";
         this.__id279_.itemDrop = "";
         this.__id279_.sayOnActivate = "You won\'t get out of here alive, human.";
         this.__id279_.sayOnAlert = "";
         this.__id279_.sayOnBloodied = "";
         this.__id279_.sayOnDeath = "";
         this.__id279_.sayOnInteract = "";
         this.__id279_.sayOnSpawn = "";
         this.__id279_.sleepAnim = "";
         this.__id279_.team = "default";
         this.__id279_.waitToAggro = 0;
         try
         {
            this.__id279_["componentInspectorSetting"] = false;
         }
         catch(e:Error)
         {
         }
      }
      
      internal function frame1() : *
      {
         this.Script_Ambush = ["0 Gob1 <PullLever> Coming here was an idiotic mistake, human!","2 SpawnCue Mage1","0 Mage1 <Board>","2 SpawnCue Mage2","0 Mage2 <Board>"];
         this.Script_Shake = ["0 Shake 15"];
      }
   }
}

