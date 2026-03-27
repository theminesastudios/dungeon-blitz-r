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
   
   [Embed(source="/_assets/assets.swf", symbol="symbol1213")]
   public dynamic class a_Room_GoblinBeachHard_09 extends MovieClip
   {
      
      public var __id307_:ac_TreasureChestEmpty;
      
      public var am_Goblin1:ac_GoblinArmorAxe;
      
      public var am_CollisionObject:MovieClip;
      
      public var am_EffectMarker2:ac_NephitSpireMarker;
      
      public var am_BossFight:a_Volume;
      
      public var am_EffectMarker1:ac_NephitSpireMarker;
      
      public var am_Grp1:MovieClip;
      
      public var am_Boss:ac_GoblinBoss1;
      
      public var am_Grp2:MovieClip;
      
      public var am_Grp3:MovieClip;
      
      public var am_Grp4:MovieClip;
      
      public var am_Grp5:MovieClip;
      
      public var am_Grp6:MovieClip;
      
      public var am_Foreground:MovieClip;
      
      public var Script_SpawnAddsEffect:Array;
      
      public function a_Room_GoblinBeachHard_09()
      {
         super();
         addFrameScript(0,this.frame1);
         this.__setProp___id307__a_Room_GoblinBeachHard_09_collisions_0();
      }
      
      public function InitRoom(param1:a_GameHook) : void
      {
         this.am_Grp1.am_add1.bHoldSpawn = true;
         this.am_Grp1.am_add2.bHoldSpawn = true;
         this.am_Grp2.am_add3.bHoldSpawn = true;
         this.am_Grp2.am_add4.bHoldSpawn = true;
         this.am_Grp3.am_add5.bHoldSpawn = true;
         this.am_Grp3.am_add6.bHoldSpawn = true;
         this.am_Grp4.am_add7.bHoldSpawn = true;
         this.am_Grp4.am_add8.bHoldSpawn = true;
         this.am_Grp5.am_add9.bHoldSpawn = true;
         this.am_Grp5.am_add10.bHoldSpawn = true;
         this.am_Grp6.am_add11.bHoldSpawn = true;
         this.am_Grp6.am_add12.bHoldSpawn = true;
         this.am_Boss.displayName = "Tag Ugo";
         param1.bBossBarOnBottom = false;
         param1.bossFightPhase = this.PhaseFight;
         param1.bBossFightBeginsOnRoomClear = false;
         param1.cutSceneStartBoss = ["2 Camera 1","2 Goblin1 Boss! He\'s|She\'s here!","4 Boss <Goto Red 1>So, the Kraken Slayer, eh?","8 Boss Don\'t look like much to me.","10 Player More than enough to give you what I gave your kraken.","4 Boss <Cheer>Get em|er, boys!","4 Camera Free"];
         param1.cutSceneDefeatBoss = ["4 Boss Oh...don\'t feel so hot...","8 Player That\'s what you get, gobllin...","8 Player I\'ve already won this fight once before.","10 Camera Free","2 End"];
      }
      
      public function PhaseFight(param1:a_GameHook) : void
      {
         if(this.am_Boss.AtHealth(0.8))
         {
            param1.PlayScript(this.Script_SpawnAddsEffect);
            param1.Group(this.am_Grp1).Spawn();
            param1.Group(this.am_Grp2).Spawn();
         }
         if(this.am_Boss.AtHealth(0.5))
         {
            param1.PlayScript(this.Script_SpawnAddsEffect);
            param1.Group(this.am_Grp3).Spawn();
            param1.Group(this.am_Grp4).Spawn();
         }
         if(this.am_Boss.AtHealth(0.33))
         {
            param1.PlayScript(this.Script_SpawnAddsEffect);
            param1.Group(this.am_Grp5).Spawn();
            param1.Group(this.am_Grp6).Spawn();
         }
         if(this.am_Boss.Defeated())
         {
            param1.SetPhase(null);
         }
      }
      
      internal function __setProp___id307__a_Room_GoblinBeachHard_09_collisions_0() : *
      {
         try
         {
            this.__id307_["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.__id307_.characterName = "";
         this.__id307_.displayName = "";
         this.__id307_.dramaAnim = "";
         this.__id307_.itemDrop = "Gold_2";
         this.__id307_.sayOnActivate = "";
         this.__id307_.sayOnAlert = "";
         this.__id307_.sayOnBloodied = "";
         this.__id307_.sayOnDeath = "";
         this.__id307_.sayOnInteract = "";
         this.__id307_.sayOnSpawn = "";
         this.__id307_.sleepAnim = "";
         this.__id307_.team = "default";
         this.__id307_.waitToAggro = 0;
         try
         {
            this.__id307_["componentInspectorSetting"] = false;
         }
         catch(e:Error)
         {
         }
      }
      
      internal function frame1() : *
      {
         this.Script_SpawnAddsEffect = ["0 QuickFirePower EffectMarker1 OasisTeleportEffect","0 QuickFirePower EffectMarker2 OasisTeleportEffect"];
      }
   }
}

