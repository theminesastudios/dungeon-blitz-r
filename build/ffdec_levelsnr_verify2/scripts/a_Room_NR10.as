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
   
   [Embed(source="/_assets/assets.swf", symbol="symbol237")]
   public dynamic class a_Room_NR10 extends MovieClip
   {
      
      public var am_CollisionObject:MovieClip;
      
      public var __id562_:ac_NPCRuggedVillager03;
      
      public var __id563_:ac_NPCAnnaOutside;
      
      public var __id566_:ac_GoblinBrute;
      
      public function a_Room_NR10()
      {
         super();
         this.__setProp___id562__a_Room_NR10_cues_0();
         this.__setProp___id563__a_Room_NR10_cues_0();
         this.__setProp___id566__a_Room_NR10_collisions_0();
      }
      
      internal function __setProp___id562__a_Room_NR10_cues_0() : *
      {
         try
         {
            this.__id562_["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.__id562_.characterName = "NR_Villager02";
         this.__id562_.displayName = "";
         this.__id562_.dramaAnim = "";
         this.__id562_.itemDrop = "";
         this.__id562_.sayOnActivate = "";
         this.__id562_.sayOnAlert = "";
         this.__id562_.sayOnBloodied = "";
         this.__id562_.sayOnDeath = "";
         this.__id562_.sayOnInteract = "";
         this.__id562_.sayOnSpawn = "";
         this.__id562_.sleepAnim = "";
         this.__id562_.team = "neutral";
         this.__id562_.waitToAggro = 0;
         try
         {
            this.__id562_["componentInspectorSetting"] = false;
         }
         catch(e:Error)
         {
         }
      }
      
      internal function __setProp___id563__a_Room_NR10_cues_0() : *
      {
         try
         {
            this.__id563_["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.__id563_.characterName = "NR_QuestAnna01";
         this.__id563_.displayName = "";
         this.__id563_.dramaAnim = "";
         this.__id563_.itemDrop = "";
         this.__id563_.sayOnActivate = "";
         this.__id563_.sayOnAlert = "";
         this.__id563_.sayOnBloodied = "";
         this.__id563_.sayOnDeath = "";
         this.__id563_.sayOnInteract = "";
         this.__id563_.sayOnSpawn = "";
         this.__id563_.sleepAnim = "";
         this.__id563_.team = "neutral";
         this.__id563_.waitToAggro = 0;
         try
         {
            this.__id563_["componentInspectorSetting"] = false;
         }
         catch(e:Error)
         {
         }
      }
      
      internal function __setProp___id566__a_Room_NR10_collisions_0() : *
      {
         try
         {
            this.__id566_["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.__id566_.characterName = "";
         this.__id566_.displayName = "";
         this.__id566_.dramaAnim = "";
         this.__id566_.itemDrop = "";
         this.__id566_.sayOnActivate = "The Kraken Slayer!";
         this.__id566_.sayOnAlert = "";
         this.__id566_.sayOnBloodied = "";
         this.__id566_.sayOnDeath = "";
         this.__id566_.sayOnInteract = "";
         this.__id566_.sayOnSpawn = "";
         this.__id566_.sleepAnim = "";
         this.__id566_.team = "default";
         this.__id566_.waitToAggro = 0;
         try
         {
            this.__id566_["componentInspectorSetting"] = false;
         }
         catch(e:Error)
         {
         }
      }
   }
}

