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
   
   [Embed(source="/_assets/assets.swf", symbol="symbol1203")]
   public dynamic class a_Room_GoblinBeachHard_03 extends MovieClip
   {
      
      public var am_CollisionObject:MovieClip;
      
      public var am_Bomber1:ac_GoblinArmorAxe;
      
      public var am_Bomber2:ac_GoblinArmorSword;
      
      public var am_Gob1:ac_GoblinBrute;
      
      public var __id312_:ac_GoblinHatchet;
      
      public var am_Gob2:ac_GoblinClub;
      
      public var am_Mage1:ac_GoblinShamanHood;
      
      public var am_Gob3:ac_GoblinDagger;
      
      public var am_Foreground:MovieClip;
      
      public var Script_Ambush3:Array;
      
      public var Script_Ambush1:Array;
      
      public var Script_Ambush2:Array;
      
      public function a_Room_GoblinBeachHard_03()
      {
         super();
         addFrameScript(0,this.frame1);
         this.__setProp___id312__a_Room_GoblinBeachHard_03_cues_0();
         this.__setProp_am_Mage1_a_Room_GoblinBeachHard_03_cues_0();
         this.__setProp_am_Bomber2_a_Room_GoblinBeachHard_03_cues_0();
      }
      
      public function InitRoom(param1:a_GameHook) : void
      {
         this.am_Mage1.bHoldSpawn = true;
         this.am_Bomber1.bHoldSpawn = true;
         this.am_Bomber2.bHoldSpawn = true;
         param1.initialPhase = this.Update;
      }
      
      public function Update(param1:a_GameHook) : void
      {
         if(this.am_Gob1.Health() < 1 || this.am_Gob2.Health() < 1 || this.am_Gob3.Health() < 1)
         {
            param1.SetPhase(this.UpdateAmbush);
         }
      }
      
      public function UpdateAmbush(param1:a_GameHook) : void
      {
         if(param1.AtTime(2000))
         {
            param1.PlayScript(this.Script_Ambush2);
         }
         if(param1.AtTime(3000))
         {
            param1.PlayScript(this.Script_Ambush3);
         }
         if(param1.AtTime(3600))
         {
            param1.PlayScript(this.Script_Ambush1);
            param1.SetPhase(null);
         }
      }
      
      internal function __setProp___id312__a_Room_GoblinBeachHard_03_cues_0() : *
      {
         try
         {
            this.__id312_["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.__id312_.characterName = "";
         this.__id312_.displayName = "";
         this.__id312_.dramaAnim = "";
         this.__id312_.itemDrop = "";
         this.__id312_.sayOnActivate = "You\'re no hero!:You killed our kraken!";
         this.__id312_.sayOnAlert = "";
         this.__id312_.sayOnBloodied = "";
         this.__id312_.sayOnDeath = "";
         this.__id312_.sayOnInteract = "";
         this.__id312_.sayOnSpawn = "";
         this.__id312_.sleepAnim = "";
         this.__id312_.team = "default";
         this.__id312_.waitToAggro = 0;
         try
         {
            this.__id312_["componentInspectorSetting"] = false;
         }
         catch(e:Error)
         {
         }
      }
      
      internal function __setProp_am_Mage1_a_Room_GoblinBeachHard_03_cues_0() : *
      {
         try
         {
            this.am_Mage1["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.am_Mage1.characterName = "";
         this.am_Mage1.displayName = "";
         this.am_Mage1.dramaAnim = "";
         this.am_Mage1.itemDrop = "";
         this.am_Mage1.sayOnActivate = "Doom to the Kraken Slayer!";
         this.am_Mage1.sayOnAlert = "";
         this.am_Mage1.sayOnBloodied = "";
         this.am_Mage1.sayOnDeath = "";
         this.am_Mage1.sayOnInteract = "";
         this.am_Mage1.sayOnSpawn = "";
         this.am_Mage1.sleepAnim = "";
         this.am_Mage1.team = "default";
         this.am_Mage1.waitToAggro = 0;
         try
         {
            this.am_Mage1["componentInspectorSetting"] = false;
         }
         catch(e:Error)
         {
         }
      }
      
      internal function __setProp_am_Bomber2_a_Room_GoblinBeachHard_03_cues_0() : *
      {
         try
         {
            this.am_Bomber2["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.am_Bomber2.characterName = "";
         this.am_Bomber2.displayName = "";
         this.am_Bomber2.dramaAnim = "";
         this.am_Bomber2.itemDrop = "";
         this.am_Bomber2.sayOnActivate = "Tehe lets blow stuff up!";
         this.am_Bomber2.sayOnAlert = "";
         this.am_Bomber2.sayOnBloodied = "";
         this.am_Bomber2.sayOnDeath = "";
         this.am_Bomber2.sayOnInteract = "";
         this.am_Bomber2.sayOnSpawn = "";
         this.am_Bomber2.sleepAnim = "";
         this.am_Bomber2.team = "default";
         this.am_Bomber2.waitToAggro = 0;
         try
         {
            this.am_Bomber2["componentInspectorSetting"] = false;
         }
         catch(e:Error)
         {
         }
      }
      
      internal function frame1() : *
      {
         this.Script_Ambush3 = ["2 SpawnCue Mage1","0 Mage1 <Board>"];
         this.Script_Ambush1 = ["2 SpawnCue Bomber1","0 Bomber1 <Board>"];
         this.Script_Ambush2 = ["2 SpawnCue Bomber2","0 Bomber2 <Board>"];
      }
   }
}

