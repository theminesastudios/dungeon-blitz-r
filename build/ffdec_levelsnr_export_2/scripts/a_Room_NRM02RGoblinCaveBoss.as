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
   
   [Embed(source="/_assets/assets.swf", symbol="symbol701")]
   public dynamic class a_Room_NRM02RGoblinCaveBoss extends MovieClip
   {
      
      public var am_Goblin1:ac_IntroGoblinDagger;
      
      public var am_CollisionObject:MovieClip;
      
      public var am_BossFight:a_Volume;
      
      public var am_Boss:ac_GoblinBoss1;
      
      public var am_Parrot:ac_IntroParrot;
      
      public var am_WaveTwo:MovieClip;
      
      public var __id462_:ac_TreasureChestEmpty;
      
      public var am_Chains:ac_Chains03;
      
      public var am_WaveThree:MovieClip;
      
      public var am_WaveOne:MovieClip;
      
      public var am_Anna:ac_NPCAnna;
      
      public var am_Foreground:MovieClip;
      
      public var Script_ParrotPanic:Array;
      
      public var Script_Pause:Array;
      
      public var Script_ThankYou:Array;
      
      public var bChainsBroken:Boolean;
      
      public function a_Room_NRM02RGoblinCaveBoss()
      {
         super();
         addFrameScript(0,this.frame1);
         this.__setProp_am_Parrot_a_Room_NRM02RGoblinCaveBoss_Details();
         this.__setProp_am_Anna_a_Room_NRM02RGoblinCaveBoss_cues_0();
         this.__setProp___id462__a_Room_NRM02RGoblinCaveBoss_collisions_0();
      }
      
      public function InitRoom(param1:a_GameHook) : void
      {
         this.am_Boss.displayName = "Tag Ugo";
         param1.bBossBarOnBottom = false;
         param1.bossFightPhase = this.PhaseFight;
         param1.bBossFightBeginsOnRoomClear = false;
         param1.cutSceneStartBoss = ["6 Parrot <Panic>LOOK!","2 Camera 1","2 Goblin1 Boss! He\'s|She\'s here!","4 Boss <Run Loop><Goto Red 1>You\'re the one that killed our Kraken!","8 Boss <End>That was the last of our Monster Fleet!","4 Parrot <Goto Red 2>","4 Camera 2","0 Anna Ha! Poor trogs!","8 Anna Did someone hurt your little squiddy?","8 Camera 1","4 Boss Quiet, you!","4 Boss <Cheer>Get him|her, boys!","6 Player Sounds like fighting words to me.","4 Camera Free"];
         param1.cutSceneDefeatBoss = ["4 Boss Oh...everything\'s gone wrong...","8 Boss Maybe the others were right...","8 Boss ...Nephit... wouldn\'t have let this happen...","4 Camera 2","8 Anna Nice one, stranger!","6 Camera Free","2 End"];
      }
      
      public function PhaseFight(param1:a_GameHook) : void
      {
         if(this.am_Chains.Defeated() && !this.bChainsBroken)
         {
            this.bChainsBroken = true;
            this.am_Anna.SetAnimation("ReadyRelaxed");
         }
         if(param1.AtTimeRepeat(6000))
         {
            param1.PlayScript(this.Script_ParrotPanic);
         }
         if(param1.AtTimeRepeat(12000) && !this.bChainsBroken)
         {
            this.am_Anna.Skit("HELP!");
         }
         if(this.am_Boss.AtHealth(0.8))
         {
            param1.Ambush("am_WaveOne");
            this.am_WaveOne.am_Leader1.Skit("We\'ll help you boss!");
            this.am_Boss.Skit(":I don\'t need any help takin care of some human!");
         }
         if(this.am_Boss.AtHealth(0.5))
         {
            param1.Ambush("am_WaveTwo");
            this.am_WaveTwo.am_Leader2.Skit("You got him|her on the ropes, Boss!:We\'ll help finish him|her off!");
            this.am_Boss.Skit("Bah!::Hands off, you louts!:He\'s|She\'s Mine!");
         }
         if(this.am_Boss.AtHealth(0.33))
         {
            param1.Ambush("am_WaveThree");
            this.am_Boss.Skit("Gah!::^tThis one\'s kind of tough...");
            this.am_WaveThree.am_Leader3.Skit("We\'ll save you, Boss!");
         }
         if(this.am_Boss.Defeated())
         {
            param1.SetPhase(this.AfterBossTick);
         }
      }
      
      public function AfterBossTick(param1:a_GameHook) : void
      {
         if(this.am_Chains.Defeated())
         {
            this.am_Anna.SetAnimation("Sexy");
            param1.PlayScript(this.Script_ThankYou);
            param1.SetPhase(null);
         }
      }
      
      internal function __setProp_am_Parrot_a_Room_NRM02RGoblinCaveBoss_Details() : *
      {
         try
         {
            this.am_Parrot["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.am_Parrot.characterName = "";
         this.am_Parrot.displayName = "";
         this.am_Parrot.dramaAnim = "";
         this.am_Parrot.itemDrop = "";
         this.am_Parrot.sayOnActivate = "";
         this.am_Parrot.sayOnAlert = "";
         this.am_Parrot.sayOnBloodied = "";
         this.am_Parrot.sayOnDeath = "";
         this.am_Parrot.sayOnInteract = "";
         this.am_Parrot.sayOnSpawn = "";
         this.am_Parrot.sleepAnim = "";
         this.am_Parrot.team = "neutral";
         this.am_Parrot.waitToAggro = 0;
         try
         {
            this.am_Parrot["componentInspectorSetting"] = false;
         }
         catch(e:Error)
         {
         }
      }
      
      internal function __setProp_am_Anna_a_Room_NRM02RGoblinCaveBoss_cues_0() : *
      {
         try
         {
            this.am_Anna["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.am_Anna.characterName = "Anna";
         this.am_Anna.displayName = "";
         this.am_Anna.dramaAnim = "";
         this.am_Anna.itemDrop = "";
         this.am_Anna.sayOnActivate = "";
         this.am_Anna.sayOnAlert = "";
         this.am_Anna.sayOnBloodied = "";
         this.am_Anna.sayOnDeath = "";
         this.am_Anna.sayOnInteract = "";
         this.am_Anna.sayOnSpawn = "";
         this.am_Anna.sleepAnim = "";
         this.am_Anna.team = "neutral";
         this.am_Anna.waitToAggro = 0;
         try
         {
            this.am_Anna["componentInspectorSetting"] = false;
         }
         catch(e:Error)
         {
         }
      }
      
      internal function __setProp___id462__a_Room_NRM02RGoblinCaveBoss_collisions_0() : *
      {
         try
         {
            this.__id462_["componentInspectorSetting"] = true;
         }
         catch(e:Error)
         {
         }
         this.__id462_.characterName = "";
         this.__id462_.displayName = "";
         this.__id462_.dramaAnim = "";
         this.__id462_.itemDrop = "Gold_2";
         this.__id462_.sayOnActivate = "";
         this.__id462_.sayOnAlert = "";
         this.__id462_.sayOnBloodied = "";
         this.__id462_.sayOnDeath = "";
         this.__id462_.sayOnInteract = "";
         this.__id462_.sayOnSpawn = "";
         this.__id462_.sleepAnim = "";
         this.__id462_.team = "default";
         this.__id462_.waitToAggro = 0;
         try
         {
            this.__id462_["componentInspectorSetting"] = false;
         }
         catch(e:Error)
         {
         }
      }
      
      internal function frame1() : *
      {
         this.Script_ParrotPanic = ["0 Parrot <Panic>"];
         this.Script_Pause = ["34 End"];
         this.Script_ThankYou = ["2 Anna Thank you! You\'re quite the goblin slayer.","8 Parrot <Panic> He|She kills krakens too!","8 Anna Well, I don\'t think one of those would fit in here.","10 Anna But that\'s good to know!","6 Anna Let\'s head back to town."];
         this.bChainsBroken = false;
      }
   }
}

