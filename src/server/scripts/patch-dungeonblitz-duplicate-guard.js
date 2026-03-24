#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function parseArgs(argv) {
    const args = {
        swf: '',
        output: '',
        ffdec: ''
    };

    for (let index = 2; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === '--swf' || arg === '-s') {
            args.swf = argv[++index] || '';
            continue;
        }
        if (arg === '--output' || arg === '-o') {
            args.output = argv[++index] || '';
            continue;
        }
        if (arg === '--ffdec' || arg === '-f') {
            args.ffdec = argv[++index] || '';
            continue;
        }
        if (arg === '--help' || arg === '-h') {
            printHelp();
            process.exit(0);
        }

        throw new Error(`Unknown argument: ${arg}`);
    }

    return args;
}

function printHelp() {
    console.log(
        [
            'Usage:',
            '  node src/server/scripts/patch-dungeonblitz-duplicate-guard.js --swf <path> [--output <path>] [--ffdec <path>]',
            '',
            'Defaults:',
            '  --output defaults to --swf',
            '  --ffdec auto-detects the repo-bundled FFDec jar or shell script'
        ].join('\n')
    );
}

function resolveRepoRoot() {
    return path.resolve(__dirname, '..', '..', '..');
}

function resolvePath(repoRoot, value) {
    if (!value) {
        return '';
    }
    if (path.isAbsolute(value)) {
        return value;
    }
    return path.join(repoRoot, value);
}

function detectFfdec(repoRoot, preferred) {
    const candidates = [];
    if (preferred) {
        candidates.push(resolvePath(repoRoot, preferred));
    }

    candidates.push(
        path.join(repoRoot, 'temp', 'jpexs_25_1_3', 'FFDec.app', 'Contents', 'Resources', 'ffdec.jar'),
        path.join(repoRoot, 'temp', 'jpexs_25_1_3', 'FFDec.app', 'Contents', 'Resources', 'ffdec.sh'),
        path.join(repoRoot, 'temp', 'jpexs_25_1_3', 'FFDec.app', 'Contents', 'Resources', 'ffdec-cli.jar')
    );

    for (const candidate of candidates) {
        if (candidate && fs.existsSync(candidate)) {
            return candidate;
        }
    }

    return '';
}

function runFfdec(ffdecPath, args) {
    const resolved = path.resolve(ffdecPath);
    const basename = path.basename(resolved).toLowerCase();

    if (basename.endsWith('.jar')) {
        execFileSync('java', ['-jar', resolved, '-cli', ...args], {
            stdio: 'inherit'
        });
        return;
    }

    if (basename.endsWith('.sh')) {
        execFileSync(resolved, ['-cli', ...args], {
            stdio: 'inherit'
        });
        return;
    }

    execFileSync(resolved, ['-cli', ...args], {
        stdio: 'inherit'
    });
}

function replaceExact(source, needle, replacement, label) {
    if (!source.includes(needle)) {
        throw new Error(`Could not find patch marker: ${label}`);
    }

    return source.replace(needle, replacement);
}

function sanitizeLevelDecompilerArtifacts(source) {
    const eol = source.includes('\r\n') ? '\r\n' : '\n';
    const join = (lines) => lines.join(eol);

    const badParentGroupBlock = join([
        '         if((Boolean(param1.parent ? param1.parent.name : null)) && !null.indexOf("am_"))',
        '         {',
        '            _loc9_ = param3.method_691(null);',
        '            if(!_loc9_)',
        '            {',
        '               _loc9_ = new a_Group(null,param3);',
        '               param3.var_1159.push(_loc9_);',
        '            }',
        '            _loc5_.groupName = null;',
        '            _loc9_.AddNewCue(_loc5_);',
        '            if(!null.indexOf("am_Wave"))',
        '            {',
        '               _loc5_.bDoNotAutoSpawn = true;',
        '            }',
        '         }'
    ]);
    const fixedParentGroupBlock = join([
        '         _loc14_ = param1.parent ? param1.parent.name : null;',
        '         if(Boolean(_loc14_) && !_loc14_.indexOf("am_"))',
        '         {',
        '            _loc9_ = param3.method_691(_loc14_);',
        '            if(!_loc9_)',
        '            {',
        '               _loc9_ = new a_Group(_loc14_,param3);',
        '               param3.var_1159.push(_loc9_);',
        '            }',
        '            _loc5_.groupName = _loc14_;',
        '            _loc9_.AddNewCue(_loc5_);',
        '            if(!_loc14_.indexOf("am_Wave"))',
        '            {',
        '               _loc5_.bDoNotAutoSpawn = true;',
        '            }',
        '         }'
    ]);
    if (source.includes(badParentGroupBlock)) {
        source = replaceExact(source, badParentGroupBlock, fixedParentGroupBlock, 'Level decompile fix: parent cue group block');
    }

    const badLevelSpriteBlock = join([
        '                     var _loc60_:class_147 = this.var_1.var_77.method_625(_loc54_ as MovieClip,_loc15_,_loc59_,this.levelFileName,_loc55_,_loc17_,Boolean(param4 & const_336) || !_loc16_.indexOf("am_Foreground"),Boolean(param4 & const_305) || !_loc16_.indexOf("am_Background"));',
        '                     param2.var_1530.push(null);',
        '                     _loc54_.visible = false;',
        '                     this.var_1119.push(_loc54_);',
        '                     if(this.levelSymbolName == "a_Level_TutorialBoat")',
        '                     {',
        '                        null.width = NaN;',
        '                     }'
    ]);
    const fixedLevelSpriteBlock = join([
        '                     var _loc60_:class_147 = this.var_1.var_77.method_625(_loc54_ as MovieClip,_loc15_,_loc59_,this.levelFileName,_loc55_,_loc17_,Boolean(param4 & const_336) || !_loc16_.indexOf("am_Foreground"),Boolean(param4 & const_305) || !_loc16_.indexOf("am_Background"));',
        '                     param2.var_1530.push(_loc60_);',
        '                     _loc54_.visible = false;',
        '                     this.var_1119.push(_loc54_);',
        '                     if(this.levelSymbolName == "a_Level_TutorialBoat")',
        '                     {',
        '                        _loc60_.width = NaN;',
        '                     }'
    ]);
    if (source.includes(badLevelSpriteBlock)) {
        source = replaceExact(source, badLevelSpriteBlock, fixedLevelSpriteBlock, 'Level decompile fix: sprite export block');
    }

    const badLevelVectorBlock = join([
        '                     var _loc14_:class_147 = this.var_1.var_77.method_625(_loc11_ as MovieClip,_loc9_,_loc13_,this.levelFileName,_loc12_,param5,Boolean(param3 & const_336) || !_loc10_.indexOf("am_Foreground"),Boolean(param3 & const_305) || !_loc10_.indexOf("am_Background"));',
        '                     param2.var_1530.push(null);',
        '                     _loc11_.visible = false;'
    ]);
    const fixedLevelVectorBlock = join([
        '                     var _loc14_:class_147 = this.var_1.var_77.method_625(_loc11_ as MovieClip,_loc9_,_loc13_,this.levelFileName,_loc12_,param5,Boolean(param3 & const_336) || !_loc10_.indexOf("am_Foreground"),Boolean(param3 & const_305) || !_loc10_.indexOf("am_Background"));',
        '                     param2.var_1530.push(_loc14_);',
        '                     _loc11_.visible = false;'
    ]);
    if (source.includes(badLevelVectorBlock)) {
        source = replaceExact(source, badLevelVectorBlock, fixedLevelVectorBlock, 'Level decompile fix: vector export block');
    }

    return source;
}

function patchConnection(source) {
    if (source.includes('if(!this.socket || !param1 || !param1.var_50 || !this.socket.connected)')) {
        return source;
    }

    const eol = source.includes('\r\n') ? '\r\n' : '\n';
    const join = (lines) => lines.join(eol);

    return replaceExact(
        source,
        join([
            '      public function SendPacket(param1:Packet) : void',
            '      {',
            '         this.socket.writeShort(param1.type);',
            '         this.socket.writeShort(param1.var_50.method_685());',
            '         this.socket.writeBytes(param1.var_50.var_359);',
            '         this.socket.flush();',
            '      }'
        ]),
        join([
            '      public function SendPacket(param1:Packet) : void',
            '      {',
            '         if(!this.socket || !param1 || !param1.var_50 || !this.socket.connected)',
            '         {',
            '            return;',
            '         }',
            '         this.socket.writeShort(param1.type);',
            '         this.socket.writeShort(param1.var_50.method_685());',
            '         this.socket.writeBytes(param1.var_50.var_359);',
            '         this.socket.flush();',
            '      }'
        ]),
        'Connection SendPacket null guard'
    );
}

function patchLinkUpdater(source) {
    if (
        source.includes('DUPLICATE_REMOTE_ENTITY_POSITION_TOLERANCE') &&
        source.includes('private function method_1828(') &&
        !source.includes('if(!(_loc8_.var_20 & Entity.REMOTE) || Boolean(_loc8_.var_20 & Entity.PLAYER))')
    ) {
        return source;
    }

    const eol = source.includes('\r\n') ? '\r\n' : '\n';
    const join = (lines) => lines.join(eol);
    const velocityPattern = /(      public static const VELOCITY_DEFLATE:Number = 0\.0001;\r?\n)\s*\r?\n/;
    if (!source.includes('DUPLICATE_REMOTE_ENTITY_POSITION_TOLERANCE')) {
        if (!velocityPattern.test(source)) {
            throw new Error('Could not find patch marker: LinkUpdater constant block');
        }
        source = source.replace(
            velocityPattern,
            `$1${eol}      private static const DUPLICATE_REMOTE_ENTITY_POSITION_TOLERANCE:uint = 24;${eol}${eol}`
        );
    }
    if (!source.includes('private function method_1828(')) {
        source = replaceExact(
            source,
            join([
                '      public function method_1397(param1:Entity) : void',
                '      {',
                '         var _loc2_:Packet = null;',
                '         _loc2_ = new Packet(PKTTYPE_ENT_DESTROY);',
                '         _loc2_.method_9(param1.id);',
                '         this.var_1.serverConn.SendPacket(_loc2_);',
                '      }',
                '      ',
                '      private function method_1615(param1:Packet) : void'
            ]),
            join([
                '      public function method_1397(param1:Entity) : void',
                '      {',
                '         var _loc2_:Packet = null;',
                '         _loc2_ = new Packet(PKTTYPE_ENT_DESTROY);',
                '         _loc2_.method_9(param1.id);',
                '         this.var_1.serverConn.SendPacket(_loc2_);',
                '      }',
                '      ',
                '      private function method_1828(param1:uint, param2:String, param3:uint, param4:int, param5:int, param6:uint, param7:String) : Entity',
                '      {',
                '         var _loc8_:Entity = null;',
                '         var _loc9_:a_Cue = null;',
                '         var _loc10_:a_Cue = null;',
                '         for each(_loc8_ in this.var_1.entities)',
                '         {',
                '            if(!_loc8_ || !_loc8_.bIAmValid || _loc8_.id == param1)',
                '            {',
                '               continue;',
                '            }',
                '            if(Boolean(_loc8_.var_20 & Entity.PLAYER))',
                '            {',
                '               continue;',
                '            }',
                '            if(_loc8_.team != param3 || _loc8_.summonerId != param6)',
                '            {',
                '               continue;',
                '            }',
                '            if(!_loc8_.entType || _loc8_.entType.entName != param2)',
                '            {',
                '               continue;',
                '            }',
                '            if(param7)',
                '            {',
                '               _loc9_ = _loc8_.cue;',
                '               _loc10_ = this.var_1.level.var_1046[param7];',
                '               if(_loc9_ != _loc10_)',
                '               {',
                '                  continue;',
                '               }',
                '            }',
                '            if(Math.abs(_loc8_.physPosX - param4) > DUPLICATE_REMOTE_ENTITY_POSITION_TOLERANCE)',
                '            {',
                '               continue;',
                '            }',
                '            if(Math.abs(_loc8_.physPosY - param5) > DUPLICATE_REMOTE_ENTITY_POSITION_TOLERANCE)',
                '            {',
                '               continue;',
                '            }',
                '            return _loc8_;',
                '         }',
                '         return null;',
                '      }',
                '      ',
                '      private function method_1615(param1:Packet) : void'
            ]),
            'LinkUpdater helper insertion'
        );
    }

    if (!source.includes('private function method_1830(')) {
        source = replaceExact(
            source,
            join([
                '      private function method_1615(param1:Packet) : void'
            ]),
            join([
                '      private function method_1830(param1:String, param2:int, param3:int) : a_Cue',
                '      {',
                '         var _loc4_:Room = null;',
                '         var _loc5_:a_Cue = null;',
                '         var _loc6_:a_Cue = null;',
                '         var _loc7_:EntType = null;',
                '         var _loc8_:Point = null;',
                '         var _loc9_:Number = NaN;',
                '         var _loc10_:Number = Number.MAX_VALUE;',
                '         if(!this.var_1 || !this.var_1.level || !this.var_1.level.var_299)',
                '         {',
                '            return null;',
                '         }',
                '         for each(_loc4_ in this.var_1.level.var_299)',
                '         {',
                '            if(!_loc4_ || !_loc4_.var_460)',
                '            {',
                '               continue;',
                '            }',
                '            for each(_loc5_ in _loc4_.var_460)',
                '            {',
                '               if(!_loc5_ || _loc5_.bSpawned)',
                '               {',
                '                  continue;',
                '               }',
                '               _loc7_ = _loc5_.entType ? EntType.method_48(_loc5_.entType) : null;',
                '               if(!_loc7_ || _loc7_.entName != param1)',
                '               {',
                '                  continue;',
                '               }',
                '               _loc8_ = _loc5_.groupSnapPos ? _loc5_.groupSnapPos : this.var_1.method_234(_loc5_);',
                '               if(!_loc8_)',
                '               {',
                '                  continue;',
                '               }',
                '               _loc9_ = Math.abs(_loc8_.x - param2) + Math.abs(_loc8_.y - param3);',
                '               if(_loc9_ < _loc10_)',
                '               {',
                '                  _loc10_ = _loc9_;',
                '                  _loc6_ = _loc5_;',
                '               }',
                '            }',
                '         }',
                '         return _loc10_ <= DUPLICATE_REMOTE_ENTITY_POSITION_TOLERANCE * 4 ? _loc6_ : null;',
                '      }',
                '      ',
                '      private function method_1615(param1:Packet) : void'
            ]),
            'LinkUpdater cue resolver insertion'
        );
    }

    if (source.includes('if(!(_loc8_.var_20 & Entity.REMOTE) || Boolean(_loc8_.var_20 & Entity.PLAYER))')) {
        source = replaceExact(
            source,
            join([
                '            if(!(_loc8_.var_20 & Entity.REMOTE) || Boolean(_loc8_.var_20 & Entity.PLAYER))',
                '            {',
                '               continue;',
                '            }'
            ]),
            join([
                '            if(Boolean(_loc8_.var_20 & Entity.PLAYER))',
                '            {',
                '               continue;',
                '            }'
            ]),
            'LinkUpdater broaden duplicate matcher to local entities'
        );
    }

    if (source.includes('if(!(!(_loc8_.var_20 & Entity.REMOTE) || Boolean(_loc8_.var_20 & Entity.PLAYER)))')) {
        source = replaceExact(
            source,
            join([
                '               if(!(!(_loc8_.var_20 & Entity.REMOTE) || Boolean(_loc8_.var_20 & Entity.PLAYER)))',
                '               {'
            ]),
            join([
                '               if(!(Boolean(_loc8_.var_20 & Entity.PLAYER)))',
                '               {'
            ]),
            'LinkUpdater broaden duplicate matcher to local entities (decompiled form)'
        );
    }

    if (!source.includes('var _loc74_:Boolean = false;')) {
        source = replaceExact(
            source,
            join([
                '         var _loc71_:Number = NaN;',
                '         var _loc72_:Entity = null;',
                '         _loc2_ = param1.method_4();'
            ]),
            join([
                '         var _loc71_:Number = NaN;',
                '         var _loc72_:Entity = null;',
                '         var _loc73_:Entity = null;',
                '         var _loc74_:Boolean = false;',
                '         _loc2_ = param1.method_4();'
            ]),
            'LinkUpdater local variable insertion'
        );
    }

    if (!source.includes('_loc73_ && (!_loc73_.var_38 || !_loc73_.gfx || !_loc73_.gfx.m_TheDO)')) {
        source = replaceExact(
            source,
            join([
                '         if(_loc73_)',
                '         {',
                '            _loc46_ = _loc73_;'
            ]),
            join([
                '         if(_loc73_ && (!_loc73_.var_38 || !_loc73_.gfx || !_loc73_.gfx.m_TheDO))',
                '         {',
                '            _loc73_ = null;',
                '         }',
                '         if(_loc73_)',
                '         {',
                '            _loc46_ = _loc73_;'
            ]),
            'LinkUpdater adoption candidate state guard'
        );
    }

    if (!source.includes('if(!_loc46_.cue)') || !source.includes('this.method_1830(_loc3_,_loc5_,_loc6_)')) {
        source = replaceExact(
            source,
            join([
                '         if(_loc46_.cue)',
                '         {',
                '            _loc46_.cue.bSpawned = true;',
                '         }'
            ]),
            join([
                '         if(!_loc46_.cue)',
                '         {',
                '            _loc46_.cue = this.method_1830(_loc3_,_loc5_,_loc6_);',
                '         }',
                '         if(_loc46_.cue)',
                '         {',
                '            _loc46_.cue.bSpawned = true;',
                '         }'
            ]),
            'LinkUpdater cue resolver usage'
        );
    }

    if (!source.includes('_loc74_ = true;')) {
        source = replaceExact(
            source,
            join([
                '         _loc45_ = _loc25_ ? class_14.var_419[_loc25_] : null;',
                '         _loc46_ = new Entity(this.var_1,_loc3_,this.var_1.level.var_1046[_loc11_],_loc5_,_loc6_,Entity.REMOTE | _loc12_,_loc8_,_loc2_,_loc32_,_loc29_,_loc31_,_loc37_,_loc36_,_loc41_,_loc40_,_loc45_);',
                '         _loc46_.var_38.var_914 = _loc5_;'
            ]),
            join([
                '         _loc45_ = _loc25_ ? class_14.var_419[_loc25_] : null;',
                '         if(_loc12_ != Entity.PLAYER)',
                '         {',
                '            _loc73_ = this.method_1828(_loc2_,_loc3_,_loc8_,_loc5_,_loc6_,_loc29_,_loc11_);',
                '         }',
                '         if(_loc73_)',
                '         {',
                '            _loc46_ = _loc73_;',
                '            _loc74_ = true;',
                '            _loc46_.id = _loc2_;',
                '            _loc46_.cue = this.var_1.level.var_1046[_loc11_];',
                '            _loc46_.team = _loc8_;',
                '            _loc46_.summonerId = _loc29_;',
                '            _loc46_.var_99 = _loc31_;',
                '            _loc46_.physPosX = _loc5_;',
                '            _loc46_.physPosY = _loc6_;',
                '            _loc46_.startPhysPosX = _loc5_;',
                '            _loc46_.startPhysPosY = _loc6_;',
                '            _loc46_.appearPosX = _loc46_.physPosX;',
                '            _loc46_.appearPosY = _loc46_.physPosY + _loc46_.yOffsetToSimulateZ + this.var_1.var_776;',
                '         }',
                '         else',
                '         {',
                '            _loc46_ = new Entity(this.var_1,_loc3_,this.var_1.level.var_1046[_loc11_],_loc5_,_loc6_,Entity.REMOTE | _loc12_,_loc8_,_loc2_,_loc32_,_loc29_,_loc31_,_loc37_,_loc36_,_loc41_,_loc40_,_loc45_);',
                '         }',
                '         _loc46_.var_38.var_914 = _loc5_;'
            ]),
            'LinkUpdater duplicate entity adoption block'
        );
    }

    if (!source.includes('_loc46_.cue.bSpawned = true;')) {
        source = replaceExact(
            source,
            join([
                '         _loc46_.var_38.var_914 = _loc5_;'
            ]),
            join([
                '         if(_loc46_.cue)',
                '         {',
                '            _loc46_.cue.bSpawned = true;',
                '         }',
                '         _loc46_.var_38.var_914 = _loc5_;'
            ]),
            'LinkUpdater cue spawn guard'
        );
    }

    if (!source.includes('if(!_loc3_ || !_loc3_.var_38)')) {
        source = replaceExact(
            source,
            join([
                '         _loc2_ = param1.method_4();',
                '         _loc3_ = this.var_1.GetEntFromID(_loc2_);',
                '         if(!_loc3_)',
                '         {',
                '            return;',
                '         }'
            ]),
            join([
                '         _loc2_ = param1.method_4();',
                '         _loc3_ = this.var_1.GetEntFromID(_loc2_);',
                '         if(!_loc3_ || !_loc3_.var_38)',
                '         {',
                '            return;',
                '         }'
            ]),
            'LinkUpdater incremental null guard'
        );
    }

    if (!source.includes('if(!_loc74_)') || !source.includes('this.var_1.entities.push(_loc46_);')) {
        source = replaceExact(
            source,
            join([
                '         if(_loc46_.id == this.var_1.clientEntID)',
                '         {',
                '            this.var_1.method_184(_loc46_.currHP);',
                '         }',
                '         this.var_1.entities.push(_loc46_);',
                '         _loc46_.var_38.var_1792 = this.var_1.mTimeThisTick;'
            ]),
            join([
                '         if(_loc46_.id == this.var_1.clientEntID)',
                '         {',
                '            this.var_1.method_184(_loc46_.currHP);',
                '         }',
                '         if(!_loc74_)',
                '         {',
                '            this.var_1.entities.push(_loc46_);',
                '         }',
                '         _loc46_.var_38.var_1792 = this.var_1.mTimeThisTick;'
            ]),
            'LinkUpdater entity push guard'
        );
    }

    if (!source.includes('if(!_loc74_)') || !source.includes('_loc46_.method_1646();')) {
        source = replaceExact(
            source,
            join([
                '         if(_loc14_)',
                '         {',
                '            _loc46_.method_1646();',
                '         }',
                '         else if(_loc13_)',
                '         {',
                '            _loc46_.method_1273();',
                '         }'
            ]),
            join([
                '         if(_loc14_)',
                '         {',
                '            if(!_loc74_)',
                '            {',
                '               _loc46_.method_1646();',
                '            }',
                '         }',
                '         else if(_loc13_)',
                '         {',
                '            if(!_loc74_)',
                '            {',
                '               _loc46_.method_1273();',
                '            }',
                '         }'
            ]),
            'LinkUpdater respawn FX guard'
        );
    }

    return source;
}

function patchRoom(source) {
    const eol = source.includes('\r\n') ? '\r\n' : '\n';
    const join = (lines) => lines.join(eol);
    const outdoorServerNpcGuard = '(this.var_1.level.internalName == "NewbieRoad" || this.var_1.level.internalName == "NewbieRoadHard")';
    const instancedAuthorityGuardBlock = join([
        '         if(this.bInstanced && !this.var_1.level.bDungeonAuthority)',
        '         {',
        '            return null;',
        '         }'
    ]);
    const oldJoinerGuard = join([
        '         if(this.bInstanced && this.var_1.groupmates && this.var_1.groupmates.length && !this.var_1.bAmGroupLeader)',
        '         {',
        '            return null;',
        '         }'
    ]);
    const conditionalJoinerGuard = join([
        '         if(this.bInstanced && this.var_1.groupmates && this.var_1.groupmates.length && !this.var_1.bAmGroupLeader)',
        '         {',
        '            var _loc14_:class_133 = null;',
        '            for each(_loc14_ in this.var_1.groupmates)',
        '            {',
        '               if(_loc14_.bOnline && _loc14_.var_2370)',
        '               {',
        '                  return null;',
        '               }',
        '            }',
        '         }'
    ]);
            const combinedJoinerGuardBlock = join([
                '         if(this.bInstanced && this.var_1.groupmates && this.var_1.groupmates.length && !this.var_1.bAmGroupLeader)',
                '         {',
                '            var _loc14_:class_133 = null;',
                '            for each(_loc14_ in this.var_1.groupmates)',
                '            {',
                '               if(_loc14_.bOnline && _loc14_.var_2370)',
                '               {',
        '                  return null;',
                '               }',
                '            }',
                '         }',
                `         if(${outdoorServerNpcGuard} && this.var_1.groupmates && this.var_1.groupmates.length && !this.var_1.bAmGroupLeader)`,
                '         {',
                '            if(param1.team != "friend")',
                '            {',
                '               return null;',
                '            }',
                '         }'
            ]);
            const instancedMasterGuard = join([
                '         if(!(DevSettings.flags & DevSettings.DEVFLAG_MASTER_CLIENT) && !(DevSettings.flags & DevSettings.DEVFLAG_STANDALONE_CLIENT))',
                '         {',
                '            return;',
                '         }'
            ]);
    const instancedMasterGuardPatched = join([
        '         if(!this.bInstanced && !(DevSettings.flags & DevSettings.DEVFLAG_MASTER_CLIENT) && !(DevSettings.flags & DevSettings.DEVFLAG_STANDALONE_CLIENT))',
        '         {',
        '            return;',
        '         }'
    ]);
    const instancedMasterGuardDecompiled = join([
        '         DevSettings;',
        '         if(!(-1 & DevSettings.DEVFLAG_MASTER_CLIENT) && !(-1 & DevSettings.DEVFLAG_STANDALONE_CLIENT))',
        '         {',
        '            return;',
        '         }'
    ]);
    const instancedMasterGuardDecompiledPatched = join([
        '         DevSettings;',
        '         if(!this.bInstanced && !(-1 & DevSettings.DEVFLAG_MASTER_CLIENT) && !(-1 & DevSettings.DEVFLAG_STANDALONE_CLIENT))',
        '         {',
        '            return;',
        '         }'
    ]);

    if (source.includes('null.bDisabled = param3 != "On";')) {
        source = replaceExact(
            source,
            join([
                '            var _loc4_:Door = this.var_1.level.method_1462(param2);',
                '            if(_loc4_)',
                '            {',
                '               null.bDisabled = param3 != "On";',
                '            }'
            ]),
            join([
                '            var _loc4_:Door = this.var_1.level.method_1462(param2);',
                '            if(_loc4_)',
                '            {',
                '               _loc4_.bDisabled = param3 != "On";',
                '            }'
            ]),
            'Room decompile fix: door state'
        );
    }

    if (source.includes('if((Boolean(_loc5_)) && null.entState != Entity.const_6)')) {
        source = replaceExact(
            source,
            join([
                '            var _loc5_:Entity = this.var_1.GetEntFromID(int(param2));',
                '            if((Boolean(_loc5_)) && null.entState != Entity.const_6)',
                '            {',
                '               null.gfx.m_Seq.method_34(Seq.C_USEPOWER,param3,true);',
                '            }'
            ]),
            join([
                '            var _loc5_:Entity = this.var_1.GetEntFromID(int(param2));',
                '            if((Boolean(_loc5_)) && _loc5_.entState != Entity.const_6)',
                '            {',
                '               _loc5_.gfx.m_Seq.method_34(Seq.C_USEPOWER,param3,true);',
                '            }'
            ]),
            'Room decompile fix: entity animation'
        );
    }

    if (source.includes('var _loc34_:SuperAnimInstance = this.method_67(null);')) {
        source = replaceExact(
            source,
            join([
                '               var _loc33_:String = "am_WaveFG" + (_loc10_ == 1 ? 14 : _loc10_ - 1);',
                '               var _loc34_:SuperAnimInstance = this.method_67(null);',
                '               _loc17_.x = null.m_TheDO.x + 200 + Math.random() * 200;'
            ]),
            join([
                '               var _loc33_:String = "am_WaveFG" + (_loc10_ == 1 ? 14 : _loc10_ - 1);',
                '               var _loc34_:SuperAnimInstance = this.method_67(_loc33_);',
                '               _loc17_.x = _loc34_.m_TheDO.x + 200 + Math.random() * 200;'
            ]),
            'Room decompile fix: wave animation anchor'
        );
    }

    if (source.includes('var _loc8_:* = §§findproperty(_loc6_);')) {
        source = replaceExact(
            source,
            join([
                '               if(_loc6_.x - _loc3_.x > const_1046)',
                '               {',
                '                  var _loc8_:* = §§findproperty(_loc6_);',
                '                  var _loc9_:Number = Number(_loc8_._loc6_) + 1;',
                '                  _loc8_._loc6_ = _loc9_;',
                '               }'
            ]),
            join([
                '               if(_loc6_.x - _loc3_.x > const_1046)',
                '               {',
                '                  _loc6_.aggroTeamID = _loc3_.aggroTeamID + 1;',
                '               }'
            ]),
            'Room decompile fix: aggro team grouping'
        );
    }

    if (source.includes(instancedMasterGuard) && !source.includes(instancedMasterGuardPatched)) {
        source = replaceExact(
            source,
            instancedMasterGuard,
            instancedMasterGuardPatched,
            'Room instanced master-client gate'
        );
    } else if (source.includes(instancedMasterGuardDecompiled) && !source.includes(instancedMasterGuardDecompiledPatched)) {
        source = replaceExact(
            source,
            instancedMasterGuardDecompiled,
            instancedMasterGuardDecompiledPatched,
            'Room instanced master-client gate (decompiled)'
        );
    }

    for (const legacyGuard of [combinedJoinerGuardBlock, conditionalJoinerGuard, oldJoinerGuard]) {
        if (source.includes(legacyGuard) && !source.includes(instancedAuthorityGuardBlock)) {
            source = replaceExact(
                source,
                legacyGuard,
                instancedAuthorityGuardBlock,
                'Room instanced authority cue guard'
            );
        }
    }

    if (!source.includes(instancedAuthorityGuardBlock)) {
        source = source.replace(
            /         if\(this\.bInstanced && this\.var_1\.groupmates && this\.var_1\.groupmates\.length && !this\.var_1\.bAmGroupLeader\)[\s\S]*?         }\r?\n(?=         if\(\(this\.var_1\.level\.internalName == "NewbieRoad" \|\| this\.var_1\.level\.internalName == "NewbieRoadHard"\) && this\.var_1\.groupmates)/,
            `${instancedAuthorityGuardBlock}${eol}`
        );
    }

    if (source.includes(instancedAuthorityGuardBlock)) {
        return source;
    }

    return replaceExact(
        source,
        join([
            '         if(!_loc3_ || !_loc3_.entName.indexOf("EmberBush"))',
            '         {',
            '            return null;',
            '         }',
            '         if(param1.bRareSpawn)'
        ]),
        join([
            '         if(!_loc3_ || !_loc3_.entName.indexOf("EmberBush"))',
            '         {',
            '            return null;',
            '         }',
            `         if(${outdoorServerNpcGuard})`,
            '         {',
            '            if(param1.team != "enemy")',
            '            {',
            '               return null;',
            '            }',
            '         }',
            '         if(this.bInstanced && !this.var_1.level.bDungeonAuthority)',
            '         {',
            '            return null;',
            '         }',
            `         if(${outdoorServerNpcGuard} && this.var_1.groupmates && this.var_1.groupmates.length && !this.var_1.bAmGroupLeader)`,
            '         {',
            '            if(param1.team != "friend")',
            '            {',
            '               return null;',
            '            }',
            '         }',
            '         if(param1.bRareSpawn)'
        ]),
        'Room joiner cue spawn guard'
    );
}

function patchLevel(source) {
    source = sanitizeLevelDecompilerArtifacts(source);
    const eol = source.includes('\r\n') ? '\r\n' : '\n';
    const join = (lines) => lines.join(eol);
    const authorityField = '      internal var bDungeonAuthority:Boolean = true;';
    const emptyAuthorityHandler = join([
        '      public function method_1627(param1:String, param2:String, param3:String) : void',
        '      {',
        '      }'
    ]);
    const patchedAuthorityHandler = join([
        '      public function method_1627(param1:String, param2:String, param3:String) : void',
        '      {',
        '         var _loc4_:Room = null;',
        '         if(param1 == "SetDungeonAuthority" && param2 == "DB_DungeonAuthority")',
        '         {',
        '            this.bDungeonAuthority = param3 == "On";',
        '            if(this.bDungeonAuthority)',
        '            {',
        '               for each(_loc4_ in this.var_299)',
        '               {',
        '                  if(_loc4_ && _loc4_.bInitialized)',
        '                  {',
        '                     _loc4_.method_1097();',
        '                  }',
        '               }',
        '            }',
        '         }',
        '      }'
    ]);
    const legacyPatchedAuthorityHandler = join([
        '      public function method_1627(param1:String, param2:String, param3:String) : void',
        '      {',
        '         var _loc4_:Room = null;',
        '         if(param1 == "SetDungeonAuthority" && param2 == "DB_DungeonAuthority")',
        '         {',
        '            this.bDungeonAuthority = param3 == "On";',
        '            if(this.bDungeonAuthority)',
        '            {',
        '               for each(_loc4_ in this.var_299)',
        '               {',
        '                  _loc4_.method_1097();',
        '               }',
        '            }',
        '         }',
        '      }'
    ]);
    const oldTickGuard = join([
        '         if(!const_919)',
        '         {',
            '            if(this.var_333)',
            '            {'
    ]);
    const patchedTickGuard = join([
        '         if(!const_919 && !this.bInstanced)',
        '         {',
            '            if(this.var_333)',
            '            {'
    ]);

    if (!source.includes(authorityField)) {
        source = replaceExact(
            source,
            '      internal var bInstanced:Boolean = false;',
            join([
                '      internal var bInstanced:Boolean = false;',
                '',
                authorityField
            ]),
            'Level authority field'
        );
    }

    if (!source.includes('this.bDungeonAuthority = !this.bInstanced;')) {
        source = replaceExact(
            source,
            join([
                '         this.internalName = param4;',
                '         this.bInstanced = param7;',
                '         this.momentParamsString = param5 ? param5 : "Normal";'
            ]),
            join([
                '         this.internalName = param4;',
                '         this.bInstanced = param7;',
                '         this.bDungeonAuthority = !this.bInstanced;',
                '         this.momentParamsString = param5 ? param5 : "Normal";'
            ]),
            'Level authority initialization'
        );
    }

    if (source.includes(emptyAuthorityHandler) && !source.includes('SetDungeonAuthority')) {
        source = replaceExact(
            source,
            emptyAuthorityHandler,
            patchedAuthorityHandler,
            'Level authority state handler'
        );
    }

    if (source.includes(legacyPatchedAuthorityHandler) && !source.includes('if(_loc4_ && _loc4_.bInitialized)')) {
        source = replaceExact(
            source,
            legacyPatchedAuthorityHandler,
            patchedAuthorityHandler,
            'Level authority state handler initialized-room guard'
        );
    }

    if (!source.includes(patchedTickGuard)) {
        if (!source.includes(oldTickGuard)) {
            return source;
        }

        source = replaceExact(
            source,
            oldTickGuard,
            patchedTickGuard,
            'Level instanced tick authority gate'
        );
    }

    return source;
}

function main() {
    const repoRoot = resolveRepoRoot();
    const args = parseArgs(process.argv);
    const swfPath = resolvePath(
        repoRoot,
        args.swf || path.join('src', 'client', 'content', 'localhost', 'p', 'cbp', 'DungeonBlitz.swf')
    );
    const outputPath = resolvePath(repoRoot, args.output || swfPath);
    const ffdecPath = detectFfdec(repoRoot, args.ffdec);

    if (!fs.existsSync(swfPath)) {
        throw new Error(`SWF not found: ${swfPath}`);
    }
    if (!ffdecPath) {
        throw new Error('FFDec not found. Pass --ffdec or restore the repo-bundled FFDec app.');
    }

    const workRoot = path.join(
        repoRoot,
        'build',
        'ffdec-dungeonblitz-duplicate-guard',
        path.basename(swfPath, path.extname(swfPath))
    );
    const scriptsRoot = path.join(workRoot, 'scripts');
    const patchedSwfPath = path.join(workRoot, `${path.basename(swfPath, path.extname(swfPath))}.patched.swf`);

    fs.rmSync(workRoot, { recursive: true, force: true });
    fs.mkdirSync(workRoot, { recursive: true });
    runFfdec(ffdecPath, ['-selectclass', 'LinkUpdater,Room,Level,Connection', '-export', 'script', workRoot, swfPath]);

    const linkUpdaterPath = path.join(scriptsRoot, 'LinkUpdater.as');
    const roomPath = path.join(scriptsRoot, 'Room.as');
    const levelPath = path.join(scriptsRoot, 'Level.as');
    const connectionPath = path.join(scriptsRoot, 'Connection.as');
    if (!fs.existsSync(linkUpdaterPath) || !fs.existsSync(roomPath) || !fs.existsSync(levelPath) || !fs.existsSync(connectionPath)) {
        throw new Error(`FFDec export did not produce expected scripts in ${scriptsRoot}`);
    }

    const originalLinkUpdater = fs.readFileSync(linkUpdaterPath, 'utf8');
    const originalRoom = fs.readFileSync(roomPath, 'utf8');
    const originalLevel = fs.readFileSync(levelPath, 'utf8');
    const originalConnection = fs.readFileSync(connectionPath, 'utf8');
    const patchedLinkUpdater = patchLinkUpdater(originalLinkUpdater);
    const patchedRoom = patchRoom(originalRoom);
    const patchedLevel = patchLevel(originalLevel);
    const patchedConnection = patchConnection(originalConnection);
    if (
        patchedLinkUpdater !== originalLinkUpdater ||
        patchedRoom !== originalRoom ||
        patchedLevel !== originalLevel ||
        patchedConnection !== originalConnection
    ) {
        if (patchedLinkUpdater !== originalLinkUpdater) {
            fs.writeFileSync(linkUpdaterPath, patchedLinkUpdater, 'utf8');
        }
        if (patchedRoom !== originalRoom) {
            fs.writeFileSync(roomPath, patchedRoom, 'utf8');
        }
        if (patchedLevel !== originalLevel) {
            fs.writeFileSync(levelPath, patchedLevel, 'utf8');
        }
        if (patchedConnection !== originalConnection) {
            fs.writeFileSync(connectionPath, patchedConnection, 'utf8');
        }
        runFfdec(ffdecPath, ['-importScript', swfPath, patchedSwfPath, scriptsRoot]);
        fs.copyFileSync(patchedSwfPath, outputPath);
        console.log(`Patched SWF written to ${outputPath}`);
        return;
    }

    console.log(`SWF already contains duplicate guard patch: ${swfPath}`);
    if (path.resolve(outputPath) !== path.resolve(swfPath)) {
        fs.copyFileSync(swfPath, outputPath);
    }
}

try {
    main();
} catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
}
