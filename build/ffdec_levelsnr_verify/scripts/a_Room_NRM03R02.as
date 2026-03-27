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
   
   [Embed(source="/_assets/assets.swf", symbol="symbol1338")]
   public dynamic class a_Room_NRM03R02 extends MovieClip
   {
      
      public var __id192_:ac_GoblinClub;
      
      public var __id182_:ac_SkeletonClub;
      
      public var __id193_:ac_GoblinBrute;
      
      public var __id183_:ac_SkeletonSword;
      
      public var am_CollisionObject:MovieClip;
      
      public var __id178_:ac_GoblinHatchet;
      
      public var __id179_:ac_GoblinDagger;
      
      public var __id184_:ac_GoblinShamanHood;
      
      public var __id185_:ac_GoblinClub;
      
      public function a_Room_NRM03R02()
      {
         super();
         this.__setProp___id178__a_Room_NRM03R02_cues_0();
         this.__setProp___id179__a_Room_NRM03R02_cues_0();
         this.__setProp___id182__a_Room_NRM03R02_cues_0();
         this.__setProp___id183__a_Room_NRM03R02_cues_0();
         this.__setProp___id184__a_Room_NRM03R02_cues_0();
         this.__setProp___id185__a_Room_NRM03R02_cues_0();
         this.__setProp___id192__a_Room_NRM03R02_cues_0();
         this.__setProp___id193__a_Room_NRM03R02_cues_0();
      }
      
      internal function __setProp___id178__a_Room_NRM03R02_cues_0() : *
      {
         try
         {
            this.__id178_["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.__id178_.characterName = "";
         this.__id178_.displayName = "";
         this.__id178_.dramaAnim = "";
         this.__id178_.itemDrop = "";
         this.__id178_.sayOnActivate = "";
         this.__id178_.sayOnAlert = "No! This is for us!: We have to get back to the Sleeping Lands.";
         this.__id178_.sayOnBloodied = "";
         this.__id178_.sayOnDeath = "";
         this.__id178_.sayOnInteract = "";
         this.__id178_.sayOnSpawn = "";
         this.__id178_.sleepAnim = "";
         this.__id178_.team = "default";
         this.__id178_.waitToAggro = 0;
         try
         {
            this.__id178_["componentInspectorSetting"] = false;
         }
         catch(e:Error)
         {
         }
      }
      
      internal function __setProp___id179__a_Room_NRM03R02_cues_0() : *
      {
         try
         {
            this.__id179_["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.__id179_.characterName = "";
         this.__id179_.displayName = "";
         this.__id179_.dramaAnim = "";
         this.__id179_.itemDrop = "";
         this.__id179_.sayOnActivate = "";
         this.__id179_.sayOnAlert = "";
         this.__id179_.sayOnBloodied = "";
         this.__id179_.sayOnDeath = "Maybe death will take me home...";
         this.__id179_.sayOnInteract = "";
         this.__id179_.sayOnSpawn = "";
         this.__id179_.sleepAnim = "";
         this.__id179_.team = "default";
         this.__id179_.waitToAggro = 0;
         try
         {
            this.__id179_["componentInspectorSetting"] = false;
         }
         catch(e:Error)
         {
         }
      }
      
      internal function __setProp___id182__a_Room_NRM03R02_cues_0() : *
      {
         try
         {
            this.__id182_["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.__id182_.characterName = "";
         this.__id182_.displayName = "";
         this.__id182_.dramaAnim = "";
         this.__id182_.itemDrop = "";
         this.__id182_.sayOnActivate = "";
         this.__id182_.sayOnAlert = "";
         this.__id182_.sayOnBloodied = "";
         this.__id182_.sayOnDeath = "Nephit Knows.";
         this.__id182_.sayOnInteract = "";
         this.__id182_.sayOnSpawn = "";
         this.__id182_.sleepAnim = "";
         this.__id182_.team = "default";
         this.__id182_.waitToAggro = 0;
         try
         {
            this.__id182_["componentInspectorSetting"] = false;
         }
         catch(e:Error)
         {
         }
      }
      
      internal function __setProp___id183__a_Room_NRM03R02_cues_0() : *
      {
         try
         {
            this.__id183_["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.__id183_.characterName = "";
         this.__id183_.displayName = "";
         this.__id183_.dramaAnim = "";
         this.__id183_.itemDrop = "";
         this.__id183_.sayOnActivate = "";
         this.__id183_.sayOnAlert = "";
         this.__id183_.sayOnBloodied = "";
         this.__id183_.sayOnDeath = "Nephit is Eternal.";
         this.__id183_.sayOnInteract = "";
         this.__id183_.sayOnSpawn = "";
         this.__id183_.sleepAnim = "";
         this.__id183_.team = "default";
         this.__id183_.waitToAggro = 0;
         try
         {
            this.__id183_["componentInspectorSetting"] = false;
         }
         catch(e:Error)
         {
         }
      }
      
      internal function __setProp___id184__a_Room_NRM03R02_cues_0() : *
      {
         try
         {
            this.__id184_["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.__id184_.characterName = "";
         this.__id184_.displayName = "";
         this.__id184_.dramaAnim = "";
         this.__id184_.itemDrop = "";
         this.__id184_.sayOnActivate = "";
         this.__id184_.sayOnAlert = ":You toy with what you do not understand, #tc#.";
         this.__id184_.sayOnBloodied = "You won\'t live to tell your little friends";
         this.__id184_.sayOnDeath = "";
         this.__id184_.sayOnInteract = "";
         this.__id184_.sayOnSpawn = "";
         this.__id184_.sleepAnim = "";
         this.__id184_.team = "default";
         this.__id184_.waitToAggro = 0;
         try
         {
            this.__id184_["componentInspectorSetting"] = false;
         }
         catch(e:Error)
         {
         }
      }
      
      internal function __setProp___id185__a_Room_NRM03R02_cues_0() : *
      {
         try
         {
            this.__id185_["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.__id185_.characterName = "";
         this.__id185_.displayName = "";
         this.__id185_.dramaAnim = "";
         this.__id185_.itemDrop = "";
         this.__id185_.sayOnActivate = "Yeargh!";
         this.__id185_.sayOnAlert = "";
         this.__id185_.sayOnBloodied = "";
         this.__id185_.sayOnDeath = "";
         this.__id185_.sayOnInteract = "";
         this.__id185_.sayOnSpawn = "";
         this.__id185_.sleepAnim = "";
         this.__id185_.team = "default";
         this.__id185_.waitToAggro = 0;
         try
         {
            this.__id185_["componentInspectorSetting"] = false;
         }
         catch(e:Error)
         {
         }
      }
      
      internal function __setProp___id192__a_Room_NRM03R02_cues_0() : *
      {
         try
         {
            this.__id192_["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.__id192_.characterName = "";
         this.__id192_.displayName = "";
         this.__id192_.dramaAnim = "";
         this.__id192_.itemDrop = "";
         this.__id192_.sayOnActivate = "Yeargh!";
         this.__id192_.sayOnAlert = "";
         this.__id192_.sayOnBloodied = "";
         this.__id192_.sayOnDeath = "";
         this.__id192_.sayOnInteract = "";
         this.__id192_.sayOnSpawn = "";
         this.__id192_.sleepAnim = "";
         this.__id192_.team = "default";
         this.__id192_.waitToAggro = 0;
         try
         {
            this.__id192_["componentInspectorSetting"] = false;
         }
         catch(e:Error)
         {
         }
      }
      
      internal function __setProp___id193__a_Room_NRM03R02_cues_0() : *
      {
         try
         {
            this.__id193_["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.__id193_.characterName = "";
         this.__id193_.displayName = "";
         this.__id193_.dramaAnim = "";
         this.__id193_.itemDrop = "";
         this.__id193_.sayOnActivate = "";
         this.__id193_.sayOnAlert = "No further!";
         this.__id193_.sayOnBloodied = "";
         this.__id193_.sayOnDeath = "";
         this.__id193_.sayOnInteract = "";
         this.__id193_.sayOnSpawn = "";
         this.__id193_.sleepAnim = "";
         this.__id193_.team = "default";
         this.__id193_.waitToAggro = 0;
         try
         {
            this.__id193_["componentInspectorSetting"] = false;
         }
         catch(e:Error)
         {
         }
      }
   }
}

