#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const TARGET_SWFS = [
    path.join('src', 'client', 'content', 'localhost', 'p', 'cbp', 'DungeonBlitz.localhost.swf'),
    path.join('src', 'client', 'content', 'localhost', 'p', 'cbp', 'DungeonBlitz.multiplayer.swf')
];

function parseArgs(argv) {
    const args = {
        ffdec: '',
        verify: false,
        swfs: []
    };

    for (let index = 2; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === '--ffdec' || arg === '-f') {
            args.ffdec = argv[++index] || '';
            continue;
        }
        if (arg === '--swf' || arg === '-s') {
            args.swfs.push(argv[++index] || '');
            continue;
        }
        if (arg === '--verify') {
            args.verify = true;
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
            '  node src/server/scripts/patch-dungeonblitz-tutorial-party-progress.js [--verify] [--swf <path>] [--ffdec <path>]',
            '',
            'Defaults:',
            '  patches both served SWFs:',
            `    ${TARGET_SWFS[0]}`,
            `    ${TARGET_SWFS[1]}`,
            '  --verify exports the selected SWFs and checks that the tutorial party-progress markers are present'
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
        path.join(repoRoot, 'build', 'tools', 'ffdec_25.1.3', 'ffdec.jar'),
        path.join(repoRoot, 'build', 'tools', 'ffdec_25.1.3', 'ffdec.sh'),
        path.join(repoRoot, 'build', 'tools', 'ffdec_25.1.3', 'ffdec-cli.jar'),
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

function replaceFirstMatching(source, needles, replacement, label) {
    for (const needle of needles) {
        if (source.includes(needle)) {
            return source.replace(needle, replacement);
        }
    }

    throw new Error(`Could not find patch marker: ${label}`);
}

function patchLinkUpdater(source) {
    const eol = source.includes('\r\n') ? '\r\n' : '\n';
    const join = (lines) => lines.join(eol);
    const tutorialOnlyGuard = '         if(!this.var_1 || !this.var_1.level || this.var_1.level.internalName != "TutorialDungeon")';
    const expandedGuard = '         if(!this.var_1 || !this.var_1.level || (this.var_1.level.internalName != "TutorialDungeon" && this.var_1.level.internalName != "GoblinRiverDungeon" && this.var_1.level.internalName != "GoblinRiverDungeonHard"))';

    if (!source.includes('private function method_1912(param1:Entity) : void')) {
        source = replaceExact(
            source,
            join([
                '      private function method_1615(param1:Packet) : void'
            ]),
            join([
                '      private function method_1912(param1:Entity) : void',
                '      {',
                '         var _loc2_:Room = null;',
                '         var _loc3_:uint = 0;',
                '         if(!param1 || !param1.cue || !param1.cue.room)',
                '         {',
                '            return;',
                '         }',
                expandedGuard,
                '         {',
                '            return;',
                '         }',
                '         _loc2_ = param1.cue.room as Room;',
                '         if(!_loc2_)',
                '         {',
                '            return;',
                '         }',
                '         param1.var_1609 = _loc2_;',
                '         param1.currRoom = _loc2_;',
                '         if(_loc2_.var_229.indexOf(param1) == -1)',
                '         {',
                '            _loc2_.var_229.push(param1);',
                '         }',
                '         _loc3_ = _loc2_.method_348();',
                '         if(_loc3_ > _loc2_.var_2261)',
                '         {',
                '            _loc2_.var_2261 = _loc3_;',
                '         }',
                '         _loc3_ = _loc2_.method_1990();',
                '         if(_loc3_ > _loc2_.var_802)',
                '         {',
                '            _loc2_.var_802 = _loc3_;',
                '         }',
                '      }',
                '      ',
                '      private function method_1615(param1:Packet) : void'
            ]),
            'LinkUpdater tutorial room bookkeeping helper'
        );
    }

    if (!source.includes('this.var_1.level.internalName != "GoblinRiverDungeonHard"')) {
        source = replaceFirstMatching(
            source,
            [tutorialOnlyGuard, expandedGuard],
            expandedGuard,
            'LinkUpdater tutorial/goblin river scope'
        );
    }

    if (!source.includes('this.method_1912(_loc46_);')) {
        source = replaceExact(
            source,
            join([
                '         if(_loc46_.cue)',
                '         {',
                '            _loc46_.cue.bSpawned = true;',
                '         }',
                '         _loc46_.var_38.var_914 = _loc5_;'
            ]),
            join([
                '         if(_loc46_.cue)',
                '         {',
                '            _loc46_.cue.bSpawned = true;',
                '         }',
                '         if(_loc12_ != Entity.PLAYER)',
                '         {',
                '            this.method_1912(_loc46_);',
                '         }',
                '         _loc46_.var_38.var_914 = _loc5_;'
            ]),
            'LinkUpdater tutorial room bookkeeping call'
        );
    }

    return source;
}

function patchRoom(source) {
    const eol = source.includes('\r\n') ? '\r\n' : '\n';
    const join = (lines) => lines.join(eol);
    const originalMethod1264 = join([
        '      public function method_1264() : Number',
        '      {',
        '         if(!this.var_2261)',
        '         {',
        '            return 1;',
        '         }',
        '         if(Boolean(this.var_2261) && !this.var_802)',
        '         {',
        '            return 0;',
        '         }',
        '         if(!this.var_802)',
        '         {',
        '            return 1;',
        '         }',
        '         var _loc1_:uint = this.method_1990();',
        '         if(_loc1_ >= this.var_802)',
        '         {',
        '            return 0;',
        '         }',
        '         if(this.var_1217 > this.var_802)',
        '         {',
        '            this.var_1217 = this.var_802;',
        '         }',
        '         return 1 - (_loc1_ + this.var_1217) / this.var_802;',
        '      }'
    ]);
    const tutorialOnlyMethod1264 = join([
        '      public function method_1264() : Number',
        '      {',
        '         var _loc1_:uint = 0;',
        '         if(!this.var_2261)',
        '         {',
        '            if(this.var_1 && this.var_1.level && this.var_1.level.internalName == "TutorialDungeon")',
        '            {',
        '               _loc1_ = this.method_348();',
        '               if(_loc1_)',
        '               {',
        '                  this.var_2261 = _loc1_;',
        '                  this.var_802 = this.method_1990();',
        '               }',
        '            }',
        '            if(!this.var_2261)',
        '            {',
        '               return 1;',
        '            }',
        '         }',
        '         if(Boolean(this.var_2261) && !this.var_802)',
        '         {',
        '            return 0;',
        '         }',
        '         if(!this.var_802)',
        '         {',
        '            return 1;',
        '         }',
        '         _loc1_ = this.method_1990();',
        '         if(_loc1_ >= this.var_802)',
        '         {',
        '            return 0;',
        '         }',
        '         if(this.var_1217 > this.var_802)',
        '         {',
        '            this.var_1217 = this.var_802;',
        '         }',
        '         return 1 - (_loc1_ + this.var_1217) / this.var_802;',
        '      }'
    ]);
    const expandedMethod1264 = join([
        '      public function method_1264() : Number',
        '      {',
        '         var _loc1_:uint = 0;',
        '         var _loc2_:uint = 0;',
        '         if(this.var_1 && this.var_1.level && (this.var_1.level.internalName == "TutorialDungeon" || this.var_1.level.internalName == "GoblinRiverDungeon" || this.var_1.level.internalName == "GoblinRiverDungeonHard"))',
        '         {',
        '            _loc1_ = this.method_348();',
        '            if(_loc1_ > this.var_2261)',
        '            {',
        '               this.var_2261 = _loc1_;',
        '            }',
        '            _loc2_ = this.method_1990();',
        '            if(_loc2_ > this.var_802)',
        '            {',
        '               this.var_802 = _loc2_;',
        '            }',
        '         }',
        '         if(!this.var_2261)',
        '         {',
        '            return 1;',
        '         }',
        '         if(Boolean(this.var_2261) && !this.var_802)',
        '         {',
        '            return 0;',
        '         }',
        '         if(!this.var_802)',
        '         {',
        '            return 1;',
        '         }',
        '         _loc2_ = this.method_1990();',
        '         if(_loc2_ >= this.var_802)',
        '         {',
        '            return 0;',
        '         }',
        '         if(this.var_1217 > this.var_802)',
        '         {',
        '            this.var_1217 = this.var_802;',
        '         }',
        '         return 1 - (_loc2_ + this.var_1217) / this.var_802;',
        '      }'
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
                '         var _loc7_:int = int(_loc1_.length);',
                '         _loc2_ = 0;',
                '         while(_loc2_ < _loc7_)',
                '         {',
                '            _loc3_ = _loc1_[_loc2_];',
                '            _loc3_.aggroTeamID = 1;',
                '            if(_loc2_ + 1 < _loc7_)',
                '            {',
                '               var _loc6_:a_Cue = _loc1_[_loc2_ + 1];',
                '               if(_loc6_.x - _loc3_.x > const_1046)',
                '               {',
                '                  var _loc8_:* = §§findproperty(_loc6_);',
                '                  var _loc9_:Number = Number(_loc8_._loc6_) + 1;',
                '                  _loc8_._loc6_ = _loc9_;',
                '               }',
                '            }',
                '            _loc2_++;',
                '         }'
            ]),
            join([
                '         var _loc6_:int = 1;',
                '         var _loc8_:int = int(_loc1_.length);',
                '         _loc2_ = 0;',
                '         while(_loc2_ < _loc8_)',
                '         {',
                '            _loc3_ = _loc1_[_loc2_];',
                '            _loc3_.aggroTeamID = _loc6_;',
                '            if(_loc2_ + 1 < _loc8_)',
                '            {',
                '               var _loc7_:a_Cue = _loc1_[_loc2_ + 1];',
                '               if(_loc7_.x - _loc3_.x > const_1046)',
                '               {',
                '                  _loc6_++;',
                '               }',
                '            }',
                '            _loc2_++;',
                '         }'
            ]),
            'Room decompile fix: aggro team counter'
        );
    }

    if (!source.includes('this.var_1.level.internalName == "GoblinRiverDungeonHard"')) {
        source = replaceFirstMatching(
            source,
            [tutorialOnlyMethod1264, originalMethod1264],
            expandedMethod1264,
            'Room tutorial/goblin river bootstrap in method_1264'
        );
    }

    return source;
}

function assertVerification(content, checks, targetLabel) {
    for (const check of checks) {
        if (!content.includes(check.needle)) {
            throw new Error(`${targetLabel} is missing verification marker: ${check.label}`);
        }
    }
}

function verifyPatchedScripts(class112Source, linkUpdaterSource, roomSource, swfPath) {
    const label = path.basename(swfPath);
    assertVerification(
        class112Source,
        [
            { label: 'class_112 method_2048', needle: 'private function method_2048(param1:Level) : uint' },
            { label: 'class_112 follower 99 clamp', needle: 'return param1.var_690 >= 100 ? 99 : param1.var_690;' },
            { label: 'class_112 render callsite', needle: 'this.var_327.SetText(this.method_2048(_loc1_) + "%");' }
        ],
        `${label} class_112`
    );
    assertVerification(
        linkUpdaterSource,
        [
            { label: 'LinkUpdater tutorial helper', needle: 'private function method_1912(param1:Entity) : void' },
            { label: 'LinkUpdater tutorial scope', needle: 'this.var_1.level.internalName != "TutorialDungeon"' },
            { label: 'LinkUpdater Goblin River scope', needle: 'this.var_1.level.internalName != "GoblinRiverDungeon"' },
            { label: 'LinkUpdater Goblin River hard scope', needle: 'this.var_1.level.internalName != "GoblinRiverDungeonHard"' },
            { label: 'LinkUpdater room bind', needle: 'param1.var_1609 = _loc2_;' },
            { label: 'LinkUpdater current room bind', needle: 'param1.currRoom = _loc2_;' },
            { label: 'LinkUpdater room vector insert', needle: '_loc2_.var_229.indexOf(param1) == -1' },
            { label: 'LinkUpdater hostile total refresh', needle: '_loc3_ = _loc2_.method_348();' },
            { label: 'LinkUpdater weighted hostile refresh', needle: '_loc3_ = _loc2_.method_1990();' }
        ],
        `${label} LinkUpdater`
    );
    assertVerification(
        roomSource,
        [
            { label: 'Room tutorial bootstrap scope', needle: 'this.var_1.level.internalName == "TutorialDungeon"' },
            { label: 'Room Goblin River bootstrap scope', needle: 'this.var_1.level.internalName == "GoblinRiverDungeon"' },
            { label: 'Room Goblin River hard bootstrap scope', needle: 'this.var_1.level.internalName == "GoblinRiverDungeonHard"' },
            { label: 'Room hostile bootstrap refresh', needle: 'if(_loc1_ > this.var_2261)' },
            { label: 'Room weighted bootstrap refresh', needle: 'if(_loc2_ > this.var_802)' }
        ],
        `${label} Room`
    );
}

function exportScripts(ffdecPath, workRoot, swfPath) {
    fs.rmSync(workRoot, { recursive: true, force: true });
    fs.mkdirSync(workRoot, { recursive: true });
    runFfdec(ffdecPath, ['-selectclass', 'LinkUpdater,Room,class_112', '-export', 'script', workRoot, swfPath]);

    const scriptsRoot = path.join(workRoot, 'scripts');
    const paths = {
        scriptsRoot,
        linkUpdater: path.join(scriptsRoot, 'LinkUpdater.as'),
        room: path.join(scriptsRoot, 'Room.as'),
        class112: path.join(scriptsRoot, 'class_112.as')
    };

    for (const filePath of Object.values(paths)) {
        if (!fs.existsSync(filePath)) {
            throw new Error(`FFDec export did not produce expected script: ${filePath}`);
        }
    }

    return paths;
}

function createWorkRoot(repoRoot, prefix, swfPath) {
    const buildRoot = path.join(repoRoot, 'build');
    fs.mkdirSync(buildRoot, { recursive: true });
    return fs.mkdtempSync(
        path.join(buildRoot, `${prefix}-${path.basename(swfPath, path.extname(swfPath))}-`)
    );
}

function resolveClass112TemplatePath(repoRoot, swfPath) {
    const swfName = path.basename(swfPath, path.extname(swfPath));
    const candidates = [
        path.join(repoRoot, 'src', 'client', 'ffdec-patches', swfName, 'scripts', 'class_112.as'),
        path.join(repoRoot, 'src', 'client', 'ffdec-patches', 'DungeonBlitz.localhost', 'scripts', 'class_112.as')
    ];

    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }

    throw new Error(`class_112 template not found for ${swfName}`);
}

function patchSwf(repoRoot, ffdecPath, swfPath) {
    const workRoot = createWorkRoot(repoRoot, 'ffdec-dungeonblitz-tutorial-party-progress', swfPath);

    try {
        const patchedSwfPath = path.join(workRoot, `${path.basename(swfPath, path.extname(swfPath))}.patched.swf`);
        const exported = exportScripts(ffdecPath, workRoot, swfPath);
        const class112Template = fs.readFileSync(resolveClass112TemplatePath(repoRoot, swfPath), 'utf8');

        const originalLinkUpdater = fs.readFileSync(exported.linkUpdater, 'utf8');
        const originalRoom = fs.readFileSync(exported.room, 'utf8');
        const originalClass112 = fs.readFileSync(exported.class112, 'utf8');

        try {
            verifyPatchedScripts(originalClass112, originalLinkUpdater, originalRoom, swfPath);
            console.log(`SWF already contains tutorial follower fix: ${swfPath}`);
            return;
        } catch (_error) {
        }

        const patchedLinkUpdater = patchLinkUpdater(originalLinkUpdater);
        const patchedRoom = patchRoom(originalRoom);
        const patchedClass112 = class112Template;

        fs.writeFileSync(exported.linkUpdater, patchedLinkUpdater, 'utf8');
        fs.writeFileSync(exported.room, patchedRoom, 'utf8');
        fs.writeFileSync(exported.class112, patchedClass112, 'utf8');

        runFfdec(ffdecPath, ['-importScript', swfPath, patchedSwfPath, exported.scriptsRoot]);
        fs.copyFileSync(patchedSwfPath, swfPath);
        console.log(`Patched tutorial follower fix into ${swfPath}`);
    } finally {
        fs.rmSync(workRoot, { recursive: true, force: true });
    }
}

function verifySwf(repoRoot, ffdecPath, swfPath) {
    const workRoot = createWorkRoot(repoRoot, 'ffdec-dungeonblitz-tutorial-party-progress-verify', swfPath);

    try {
        const exported = exportScripts(ffdecPath, workRoot, swfPath);
        verifyPatchedScripts(
            fs.readFileSync(exported.class112, 'utf8'),
            fs.readFileSync(exported.linkUpdater, 'utf8'),
            fs.readFileSync(exported.room, 'utf8'),
            swfPath
        );
        console.log(`Verified tutorial follower fix markers in ${swfPath}`);
    } finally {
        fs.rmSync(workRoot, { recursive: true, force: true });
    }
}

function main() {
    const repoRoot = resolveRepoRoot();
    const args = parseArgs(process.argv);
    const ffdecPath = detectFfdec(repoRoot, args.ffdec);

    if (!ffdecPath) {
        throw new Error('FFDec not found. Pass --ffdec or restore the repo-bundled FFDec app.');
    }

    const swfs = (args.swfs.length ? args.swfs : TARGET_SWFS).map((entry) => resolvePath(repoRoot, entry));
    for (const swfPath of swfs) {
        if (!fs.existsSync(swfPath)) {
            throw new Error(`SWF not found: ${swfPath}`);
        }
    }

    if (args.verify) {
        for (const swfPath of swfs) {
            verifySwf(repoRoot, ffdecPath, swfPath);
        }
        return;
    }

    for (const swfPath of swfs) {
        patchSwf(repoRoot, ffdecPath, swfPath);
    }
}

try {
    main();
} catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
}
