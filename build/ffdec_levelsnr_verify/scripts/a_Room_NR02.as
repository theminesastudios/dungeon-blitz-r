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
   
   [Embed(source="/_assets/assets.swf", symbol="symbol321")]
   public dynamic class a_Room_NR02 extends MovieClip
   {
      
      public var am_CollisionObject:MovieClip;
      
      public var __id527_:ac_NPCVillager03a;
      
      public var __id524_:ac_GoblinArmorSword;
      
      public function a_Room_NR02()
      {
         super();
         this.__setProp___id524__a_Room_NR02_cues_0();
         this.__setProp___id527__a_Room_NR02_cues_0();
      }
      
      internal function __setProp___id524__a_Room_NR02_cues_0() : *
      {
         try
         {
            this.__id524_["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.__id524_.characterName = "";
         this.__id524_.displayName = "";
         this.__id524_.dramaAnim = "";
         this.__id524_.itemDrop = "";
         this.__id524_.sayOnActivate = "";
         this.__id524_.sayOnAlert = "Kraken Slayer!:DIE!!!!";
         this.__id524_.sayOnBloodied = "";
         this.__id524_.sayOnDeath = "";
         this.__id524_.sayOnInteract = "";
         this.__id524_.sayOnSpawn = "";
         this.__id524_.sleepAnim = "";
         this.__id524_.team = "default";
         this.__id524_.waitToAggro = 0;
         try
         {
            this.__id524_["componentInspectorSetting"] = false;
         }
         catch(e:Error)
         {
         }
      }
      
      internal function __setProp___id527__a_Room_NR02_cues_0() : *
      {
         try
         {
            this.__id527_["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.__id527_.characterName = "NR_CartGuy";
         this.__id527_.displayName = "";
         this.__id527_.dramaAnim = "";
         this.__id527_.itemDrop = "";
         this.__id527_.sayOnActivate = "";
         this.__id527_.sayOnAlert = "";
         this.__id527_.sayOnBloodied = "";
         this.__id527_.sayOnDeath = "";
         this.__id527_.sayOnInteract = "";
         this.__id527_.sayOnSpawn = "";
         this.__id527_.sleepAnim = "";
         this.__id527_.team = "neutral";
         this.__id527_.waitToAggro = 0;
         try
         {
            this.__id527_["componentInspectorSetting"] = false;
         }
         catch(e:Error)
         {
         }
      }
   }
}

