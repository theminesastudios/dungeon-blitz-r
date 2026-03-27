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
   
   [Embed(source="/_assets/assets.swf", symbol="symbol94")]
   public dynamic class a_Room_NR07 extends MovieClip
   {
      
      public var __id590_:ac_NPCRuggedVillager07;
      
      public var __id591_:ac_NPCElric;
      
      public var __id596_:ac_NPCAffric;
      
      public var __id597_:ac_NPCOdem;
      
      public var __id594_:ac_NPCVillager02;
      
      public var am_CollisionObject:MovieClip;
      
      public var am_Foreground2:MovieClip;
      
      public var am_Foreground1:MovieClip;
      
      public var __id598_:ac_NPCAlderman;
      
      public var __id599_:ac_NPCAnnaOutside;
      
      public var __id592_:ac_NPCRuggedVillager02;
      
      public var am_Foreground:MovieClip;
      
      public var am_Background:MovieClip;
      
      public var __id593_:ac_NPCVillager04;
      
      public function a_Room_NR07()
      {
         super();
         this.__setProp___id590__a_Room_NR07_cues_0();
         this.__setProp___id591__a_Room_NR07_cues_0();
         this.__setProp___id592__a_Room_NR07_cues_0();
         this.__setProp___id593__a_Room_NR07_cues_0();
         this.__setProp___id594__a_Room_NR07_cues_0();
         this.__setProp___id596__a_Room_NR07_cues_0();
         this.__setProp___id597__a_Room_NR07_cues_0();
         this.__setProp___id598__a_Room_NR07_cues_0();
         this.__setProp___id599__a_Room_NR07_cues_0();
      }
      
      internal function __setProp___id590__a_Room_NR07_cues_0() : *
      {
         try
         {
            this.__id590_["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.__id590_.characterName = "NR_IntroVillager";
         this.__id590_.displayName = "Tyna";
         this.__id590_.dramaAnim = "";
         this.__id590_.itemDrop = "";
         this.__id590_.sayOnActivate = "";
         this.__id590_.sayOnAlert = "";
         this.__id590_.sayOnBloodied = "";
         this.__id590_.sayOnDeath = "";
         this.__id590_.sayOnInteract = "We\'ve fought the goblins for 50 years.=I thought other humans were a fairytale.=But you\'re real.=And you\'re really good at killing goblins.=I like that in a person.";
         this.__id590_.sayOnSpawn = "";
         this.__id590_.sleepAnim = "";
         this.__id590_.team = "neutral";
         this.__id590_.waitToAggro = 0;
         try
         {
            this.__id590_["componentInspectorSetting"] = false;
         }
         catch(e:Error)
         {
         }
      }
      
      internal function __setProp___id591__a_Room_NR07_cues_0() : *
      {
         try
         {
            this.__id591_["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.__id591_.characterName = "NR_Elric";
         this.__id591_.displayName = "Ehric";
         this.__id591_.dramaAnim = "";
         this.__id591_.itemDrop = "";
         this.__id591_.sayOnActivate = "";
         this.__id591_.sayOnAlert = "";
         this.__id591_.sayOnBloodied = "";
         this.__id591_.sayOnDeath = "";
         this.__id591_.sayOnInteract = "I\'ve never seen humans from outside Wolf\'s End.=We thought we were alone.=Spent my whole life fearing goblins.=And worse things.=Can\'t even swim, what with the krakens.";
         this.__id591_.sayOnSpawn = "";
         this.__id591_.sleepAnim = "";
         this.__id591_.team = "neutral";
         this.__id591_.waitToAggro = 0;
         try
         {
            this.__id591_["componentInspectorSetting"] = false;
         }
         catch(e:Error)
         {
         }
      }
      
      internal function __setProp___id592__a_Room_NR07_cues_0() : *
      {
         try
         {
            this.__id592_["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.__id592_.characterName = "NR_Mayor01";
         this.__id592_.displayName = "";
         this.__id592_.dramaAnim = "";
         this.__id592_.itemDrop = "";
         this.__id592_.sayOnActivate = "";
         this.__id592_.sayOnAlert = "";
         this.__id592_.sayOnBloodied = "";
         this.__id592_.sayOnDeath = "";
         this.__id592_.sayOnInteract = "";
         this.__id592_.sayOnSpawn = "";
         this.__id592_.sleepAnim = "";
         this.__id592_.team = "neutral";
         this.__id592_.waitToAggro = 0;
         try
         {
            this.__id592_["componentInspectorSetting"] = false;
         }
         catch(e:Error)
         {
         }
      }
      
      internal function __setProp___id593__a_Room_NR07_cues_0() : *
      {
         try
         {
            this.__id593_["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.__id593_.characterName = "NR_Merchant01";
         this.__id593_.displayName = "Galrius";
         this.__id593_.dramaAnim = "";
         this.__id593_.itemDrop = "";
         this.__id593_.sayOnActivate = "";
         this.__id593_.sayOnAlert = "";
         this.__id593_.sayOnBloodied = "";
         this.__id593_.sayOnDeath = "";
         this.__id593_.sayOnInteract = "The goblins haven\'t gotten everything";
         this.__id593_.sayOnSpawn = "";
         this.__id593_.sleepAnim = "";
         this.__id593_.team = "neutral";
         this.__id593_.waitToAggro = 0;
         try
         {
            this.__id593_["componentInspectorSetting"] = false;
         }
         catch(e:Error)
         {
         }
      }
      
      internal function __setProp___id594__a_Room_NR07_cues_0() : *
      {
         try
         {
            this.__id594_["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.__id594_.characterName = "NR_Trainer01";
         this.__id594_.displayName = "Tess";
         this.__id594_.dramaAnim = "";
         this.__id594_.itemDrop = "";
         this.__id594_.sayOnActivate = "";
         this.__id594_.sayOnAlert = "";
         this.__id594_.sayOnBloodied = "";
         this.__id594_.sayOnDeath = "";
         this.__id594_.sayOnInteract = "You\'ve got a lot of potential, #tc#.:I\'ve got an eye for this kind of thing.";
         this.__id594_.sayOnSpawn = "";
         this.__id594_.sleepAnim = "";
         this.__id594_.team = "neutral";
         this.__id594_.waitToAggro = 0;
         try
         {
            this.__id594_["componentInspectorSetting"] = false;
         }
         catch(e:Error)
         {
         }
      }
      
      internal function __setProp___id596__a_Room_NR07_cues_0() : *
      {
         try
         {
            this.__id596_["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.__id596_.characterName = "NRAffric";
         this.__id596_.displayName = "Affric";
         this.__id596_.dramaAnim = "";
         this.__id596_.itemDrop = "";
         this.__id596_.sayOnActivate = "";
         this.__id596_.sayOnAlert = "";
         this.__id596_.sayOnBloodied = "";
         this.__id596_.sayOnDeath = "";
         this.__id596_.sayOnInteract = "Did the King really send you?=@Yes, he did.=I didn\'t know there was a king.=I didn\'t know there were other humans besides us.=I thought it was all made up.";
         this.__id596_.sayOnSpawn = "";
         this.__id596_.sleepAnim = "";
         this.__id596_.team = "neutral";
         this.__id596_.waitToAggro = 0;
         try
         {
            this.__id596_["componentInspectorSetting"] = false;
         }
         catch(e:Error)
         {
         }
      }
      
      internal function __setProp___id597__a_Room_NR07_cues_0() : *
      {
         try
         {
            this.__id597_["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.__id597_.characterName = "NROdem";
         this.__id597_.displayName = "Odem";
         this.__id597_.dramaAnim = "";
         this.__id597_.itemDrop = "";
         this.__id597_.sayOnActivate = "";
         this.__id597_.sayOnAlert = "";
         this.__id597_.sayOnBloodied = "";
         this.__id597_.sayOnDeath = "";
         this.__id597_.sayOnInteract = "Had to stop our patrols.=Too many goblins...=Too many undead.=My Rangers would be slaughtered out there.";
         this.__id597_.sayOnSpawn = "";
         this.__id597_.sleepAnim = "";
         this.__id597_.team = "neutral";
         this.__id597_.waitToAggro = 0;
         try
         {
            this.__id597_["componentInspectorSetting"] = false;
         }
         catch(e:Error)
         {
         }
      }
      
      internal function __setProp___id598__a_Room_NR07_cues_0() : *
      {
         try
         {
            this.__id598_["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.__id598_.characterName = "";
         this.__id598_.displayName = "";
         this.__id598_.dramaAnim = "";
         this.__id598_.itemDrop = "";
         this.__id598_.sayOnActivate = "";
         this.__id598_.sayOnAlert = "";
         this.__id598_.sayOnBloodied = "";
         this.__id598_.sayOnDeath = "";
         this.__id598_.sayOnInteract = "";
         this.__id598_.sayOnSpawn = "";
         this.__id598_.sleepAnim = "";
         this.__id598_.team = "neutral";
         this.__id598_.waitToAggro = 0;
         try
         {
            this.__id598_["componentInspectorSetting"] = false;
         }
         catch(e:Error)
         {
         }
      }
      
      internal function __setProp___id599__a_Room_NR07_cues_0() : *
      {
         try
         {
            this.__id599_["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.__id599_.characterName = "AnnaOutside";
         this.__id599_.displayName = "";
         this.__id599_.dramaAnim = "";
         this.__id599_.itemDrop = "";
         this.__id599_.sayOnActivate = "";
         this.__id599_.sayOnAlert = "";
         this.__id599_.sayOnBloodied = "";
         this.__id599_.sayOnDeath = "";
         this.__id599_.sayOnInteract = "";
         this.__id599_.sayOnSpawn = "";
         this.__id599_.sleepAnim = "";
         this.__id599_.team = "neutral";
         this.__id599_.waitToAggro = 0;
         try
         {
            this.__id599_["componentInspectorSetting"] = false;
         }
         catch(e:Error)
         {
         }
      }
   }
}

