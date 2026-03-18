param(
    [string]$SwfPath = "",
    [string]$OutputPath = "",
    [string]$FfdecPath = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Resolve-FfdecCliPath {
    param([string]$PreferredPath)

    $candidates = @()
    if ($PreferredPath) {
        $candidates += $PreferredPath
    }
    $candidates += @(
        "C:\Program Files (x86)\FFDec\ffdec-cli.exe",
        "C:\Program Files\FFDec\ffdec-cli.exe"
    )

    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path $candidate)) {
            return (Resolve-Path $candidate).Path
        }
    }

    $fromPath = Get-Command "ffdec-cli.exe" -ErrorAction SilentlyContinue
    if ($fromPath) {
        return $fromPath.Source
    }

    throw "FFDec CLI not found. Install JPEXS FFDec or pass -FfdecPath."
}

function Replace-Exact {
    param(
        [string]$Source,
        [string]$Needle,
        [string]$Replacement,
        [string]$Label
    )

    if (-not $Source.Contains($Needle)) {
        throw "Could not find patch marker: $Label"
    }

    return $Source.Replace($Needle, $Replacement)
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
if (-not $SwfPath) {
    $SwfPath = Join-Path $repoRoot "src\client\content\localhost\p\cbp\DungeonBlitz.swf"
}
if (-not [System.IO.Path]::IsPathRooted($SwfPath)) {
    $SwfPath = Join-Path $repoRoot $SwfPath
}
$SwfPath = (Resolve-Path $SwfPath).Path

if (-not $OutputPath) {
    $OutputPath = $SwfPath
}
elseif (-not [System.IO.Path]::IsPathRooted($OutputPath)) {
    $OutputPath = Join-Path $repoRoot $OutputPath
}

$ffdecCli = Resolve-FfdecCliPath -PreferredPath $FfdecPath
$workRoot = Join-Path $repoRoot "build\ffdec-dungeonblitz-duplicate-guard"
$scriptsRoot = Join-Path $workRoot "scripts"
$patchedSwfPath = Join-Path $workRoot "DungeonBlitz.patched.swf"

New-Item -ItemType Directory -Force -Path $workRoot | Out-Null

& $ffdecCli -cli -selectclass LinkUpdater -export script $workRoot $SwfPath | Out-Null

$linkUpdaterPath = Join-Path $scriptsRoot "LinkUpdater.as"
if (-not (Test-Path $linkUpdaterPath)) {
    throw "FFDec export did not produce scripts\LinkUpdater.as"
}

$source = Get-Content -Raw $linkUpdaterPath
if (-not $source.Contains("DUPLICATE_REMOTE_ENTITY_POSITION_TOLERANCE")) {
    $source = Replace-Exact -Source $source -Needle @'
      public static const VELOCITY_DEFLATE:Number = 0.0001;
      
      public static const const_1264:String = "localhost";
'@ -Replacement @'
      public static const VELOCITY_DEFLATE:Number = 0.0001;

      private static const DUPLICATE_REMOTE_ENTITY_POSITION_TOLERANCE:uint = 24;
      
      public static const const_1264:String = "localhost";
'@ -Label "LinkUpdater constant block"

    $source = Replace-Exact -Source $source -Needle @'
      public function method_1397(param1:Entity) : void
      {
         var _loc2_:Packet = null;
         _loc2_ = new Packet(PKTTYPE_ENT_DESTROY);
         _loc2_.method_9(param1.id);
         this.var_1.serverConn.SendPacket(_loc2_);
      }
      
      private function method_1615(param1:Packet) : void
'@ -Replacement @'
      public function method_1397(param1:Entity) : void
      {
         var _loc2_:Packet = null;
         _loc2_ = new Packet(PKTTYPE_ENT_DESTROY);
         _loc2_.method_9(param1.id);
         this.var_1.serverConn.SendPacket(_loc2_);
      }

      private function method_1828(param1:uint, param2:String, param3:uint, param4:int, param5:int, param6:uint, param7:String) : Entity
      {
         var _loc8_:Entity = null;
         var _loc9_:a_Cue = null;
         var _loc10_:a_Cue = null;
         for each(_loc8_ in this.var_1.entities)
         {
            if(!_loc8_ || !_loc8_.bIAmValid || _loc8_.id == param1)
            {
               continue;
            }
            if(!(_loc8_.var_20 & Entity.REMOTE) || Boolean(_loc8_.var_20 & Entity.PLAYER))
            {
               continue;
            }
            if(_loc8_.team != param3 || _loc8_.summonerId != param6)
            {
               continue;
            }
            if(!_loc8_.entType || _loc8_.entType.entName != param2)
            {
               continue;
            }
            if(param7)
            {
               _loc9_ = _loc8_.cue;
               _loc10_ = this.var_1.level.var_1046[param7];
               if(_loc9_ != _loc10_)
               {
                  continue;
               }
            }
            if(Math.abs(_loc8_.physPosX - param4) > DUPLICATE_REMOTE_ENTITY_POSITION_TOLERANCE)
            {
               continue;
            }
            if(Math.abs(_loc8_.physPosY - param5) > DUPLICATE_REMOTE_ENTITY_POSITION_TOLERANCE)
            {
               continue;
            }
            return _loc8_;
         }
         return null;
      }
      
      private function method_1615(param1:Packet) : void
'@ -Label "LinkUpdater helper insertion"

    $source = Replace-Exact -Source $source -Needle @'
         var _loc71_:Number = NaN;
         var _loc72_:Entity = null;
         _loc2_ = param1.method_4();
'@ -Replacement @'
         var _loc71_:Number = NaN;
         var _loc72_:Entity = null;
         var _loc73_:Entity = null;
         var _loc74_:Boolean = false;
         _loc2_ = param1.method_4();
'@ -Label "LinkUpdater local variable insertion"

    $source = Replace-Exact -Source $source -Needle @'
         _loc45_ = _loc25_ ? class_14.var_419[_loc25_] : null;
         _loc46_ = new Entity(this.var_1,_loc3_,this.var_1.level.var_1046[_loc11_],_loc5_,_loc6_,Entity.REMOTE | _loc12_,_loc8_,_loc2_,_loc32_,_loc29_,_loc31_,_loc37_,_loc36_,_loc41_,_loc40_,_loc45_);
         _loc46_.var_38.var_914 = _loc5_;
'@ -Replacement @'
         _loc45_ = _loc25_ ? class_14.var_419[_loc25_] : null;
         if(_loc12_ != Entity.PLAYER)
         {
            _loc73_ = this.method_1828(_loc2_,_loc3_,_loc8_,_loc5_,_loc6_,_loc29_,_loc11_);
         }
         if(_loc73_)
         {
            _loc46_ = _loc73_;
            _loc74_ = true;
            _loc46_.id = _loc2_;
            _loc46_.cue = this.var_1.level.var_1046[_loc11_];
            _loc46_.team = _loc8_;
            _loc46_.summonerId = _loc29_;
            _loc46_.var_99 = _loc31_;
            _loc46_.physPosX = _loc5_;
            _loc46_.physPosY = _loc6_;
            _loc46_.startPhysPosX = _loc5_;
            _loc46_.startPhysPosY = _loc6_;
            _loc46_.appearPosX = _loc46_.physPosX;
            _loc46_.appearPosY = _loc46_.physPosY + _loc46_.yOffsetToSimulateZ + this.var_1.var_776;
         }
         else
         {
            _loc46_ = new Entity(this.var_1,_loc3_,this.var_1.level.var_1046[_loc11_],_loc5_,_loc6_,Entity.REMOTE | _loc12_,_loc8_,_loc2_,_loc32_,_loc29_,_loc31_,_loc37_,_loc36_,_loc41_,_loc40_,_loc45_);
         }
         _loc46_.var_38.var_914 = _loc5_;
'@ -Label "LinkUpdater duplicate entity adoption block"

    $source = Replace-Exact -Source $source -Needle @'
         if(_loc46_.id == this.var_1.clientEntID)
         {
            this.var_1.method_184(_loc46_.currHP);
         }
         this.var_1.entities.push(_loc46_);
         _loc46_.var_38.var_1792 = this.var_1.mTimeThisTick;
'@ -Replacement @'
         if(_loc46_.id == this.var_1.clientEntID)
         {
            this.var_1.method_184(_loc46_.currHP);
         }
         if(!_loc74_)
         {
            this.var_1.entities.push(_loc46_);
         }
         _loc46_.var_38.var_1792 = this.var_1.mTimeThisTick;
'@ -Label "LinkUpdater entity push guard"

    $source = Replace-Exact -Source $source -Needle @'
         if(_loc14_)
         {
            _loc46_.method_1646();
         }
         else if(_loc13_)
         {
            _loc46_.method_1273();
         }
'@ -Replacement @'
         if(_loc14_)
         {
            if(!_loc74_)
            {
               _loc46_.method_1646();
            }
         }
         else if(_loc13_)
         {
            if(!_loc74_)
            {
               _loc46_.method_1273();
            }
         }
'@ -Label "LinkUpdater respawn FX guard"
}

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($linkUpdaterPath, $source, $utf8NoBom)

& $ffdecCli -cli -importScript $SwfPath $patchedSwfPath $scriptsRoot | Out-Null
Copy-Item -Force $patchedSwfPath $OutputPath

Write-Host "Patched SWF written to $OutputPath"
