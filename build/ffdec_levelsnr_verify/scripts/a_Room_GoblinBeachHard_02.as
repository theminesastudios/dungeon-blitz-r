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
   
   [Embed(source="/_assets/assets.swf", symbol="symbol1225")]
   public dynamic class a_Room_GoblinBeachHard_02 extends MovieClip
   {
      
      public var am_CollisionObject:MovieClip;
      
      public var am_EffectMarker1:ac_NephitSpireMarker;
      
      public var __id297_:ac_GoblinBrute;
      
      public var am_Add1:ac_GoblinShamanSkullHat;
      
      public var am_Add2:ac_GoblinArmorAxe;
      
      public var am_Gate:MovieClip;
      
      public var am_Doorway:MovieClip;
      
      public var am_Mage1:ac_GoblinShamanHood;
      
      public var am_Foreground:MovieClip;
      
      public var am_Scout:ac_GoblinArmorSword;
      
      public var Script_Summon:Array;
      
      public var Script_Ambush1:Array;
      
      public var Script_Ambush2:Array;
      
      public var Script_Shake:Array;
      
      public function a_Room_GoblinBeachHard_02()
      {
         super();
         addFrameScript(0,this.frame1);
         this.__setProp___id297__a_Room_GoblinBeachHard_02_Details();
      }
      
      public function InitRoom(param1:a_GameHook) : void
      {
         this.am_Mage1.bHoldSpawn = true;
         this.am_Add1.bHoldSpawn = true;
         this.am_Add2.bHoldSpawn = true;
         param1.initialPhase = this.Update;
      }
      
      public function Update(param1:a_GameHook) : void
      {
         if(param1.AtTime(0))
         {
            this.am_Scout.AddBuff("NephitSleep");
            this.am_Scout.DeepSleep();
         }
         if(param1.OnTrigger("am_Trigger_1"))
         {
            param1.SetPhase(this.UpdateSummonWaveOne);
         }
      }
      
      public function UpdateSummonWaveOne(param1:a_GameHook) : void
      {
         if(param1.AtTime(0))
         {
            param1.PlayScript(this.Script_Summon);
         }
         if(param1.AtTime(600))
         {
            param1.PlayScript(this.Script_Ambush1);
         }
         if(param1.AtTime(1200))
         {
            param1.PlayScript(this.Script_Ambush2);
         }
         if(param1.AtTime(1300))
         {
            this.am_Scout.Aggro();
            this.am_Scout.RemoveBuff("NephitSleep");
         }
         if(param1.RoomCleared())
         {
            param1.CollisionOff("am_DynamicCollision_GateBlock");
            param1.PlaySound("a_Sound_Fireball_Big");
            param1.PlayScript(this.Script_Shake);
            param1.Animate("am_Gate","Open",true);
            param1.SetPhase(null);
         }
      }
      
      internal function __setProp___id297__a_Room_GoblinBeachHard_02_Details() : *
      {
         try
         {
            this.__id297_["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.__id297_.characterName = "";
         this.__id297_.displayName = "";
         this.__id297_.dramaAnim = "";
         this.__id297_.itemDrop = "";
         this.__id297_.sayOnActivate = "This is for our kraken, human!:DIE!!!";
         this.__id297_.sayOnAlert = "";
         this.__id297_.sayOnBloodied = "";
         this.__id297_.sayOnDeath = "";
         this.__id297_.sayOnInteract = "";
         this.__id297_.sayOnSpawn = "";
         this.__id297_.sleepAnim = "";
         this.__id297_.team = "default";
         this.__id297_.waitToAggro = 0;
         try
         {
            this.__id297_["componentInspectorSetting"] = false;
         }
         catch(e:Error)
         {
         }
      }
      
      internal function frame1() : *
      {
         this.Script_Summon = ["1 Scout <Cheer> Now!!!","1 SpawnCue Mage1","0 Mage1 <Board> The Curse of Zegl upon Ye!"];
         this.Script_Ambush1 = ["2 QuickFirePower EffectMarker1 OasisTeleportEffect","1 SpawnCue Add1"];
         this.Script_Ambush2 = ["2 SpawnCue Add2","0 Add2 <Board>"];
         this.Script_Shake = ["0 Shake 20"];
      }
   }
}

