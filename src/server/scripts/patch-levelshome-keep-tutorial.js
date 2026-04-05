#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const TARGETS = [
    {
        swf: path.join('src', 'client', 'content', 'localhost', 'p', 'cbp', 'LevelsHome.swf')
    }
];
const RUINED_KEEP_CHARACTER_ID = 2159;
const UPGRADED_KEEP_CHARACTER_ID = 2686;

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
            '  node src/server/scripts/patch-levelshome-keep-tutorial.js [--verify] [--swf <path>] [--ffdec <path>]',
            '',
            'Patches a_Room_MainTutorial inside LevelsHome.swf so:',
            '  - Ranik intro uses Run Loop instead of sliding',
            '  - the first reinforcement wave spawns 3 goblins at once',
            '  - later reinforcement respawns come back in 2-3 goblin waves instead of one-by-one',
            '  - the keep visual stays on the ruined a_Upgrade_Keep_0 sprite inside tutorial'
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
        path.join(repoRoot, 'build', 'ffdec', 'ffdec.sh'),
        path.join(repoRoot, 'build', 'ffdec', 'ffdec.jar'),
        path.join(repoRoot, 'build', 'ffdec', 'ffdec-cli.jar'),
        '/Applications/FFDec.app/Contents/Resources/ffdec.sh',
        '/Applications/FFDec.app/Contents/Resources/ffdec.jar',
        '/Applications/FFDec.app/Contents/Resources/ffdec-cli.jar'
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

    execFileSync(resolved, ['-cli', ...args], {
        stdio: 'inherit'
    });
}

function runFfdecCapture(ffdecPath, args) {
    const resolved = path.resolve(ffdecPath);
    const basename = path.basename(resolved).toLowerCase();

    if (basename.endsWith('.jar')) {
        return execFileSync('java', ['-jar', resolved, '-cli', ...args], {
            encoding: 'utf8',
            maxBuffer: 32 * 1024 * 1024
        });
    }

    return execFileSync(resolved, ['-cli', ...args], {
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024
    });
}

function replaceExact(source, needle, replacement, label) {
    if (!source.includes(needle)) {
        throw new Error(`Could not find ${label} in a_Room_MainTutorial.as`);
    }
    return source.replace(needle, replacement);
}

function replaceOneOf(source, replacements, label) {
    for (const [needle, replacement] of replacements) {
        if (source.includes(needle)) {
            return source.replace(needle, replacement);
        }
    }
    throw new Error(`Could not find ${label} in a_Room_MainTutorial.as`);
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countOccurrences(source, needle) {
    if (!needle) {
        return 0;
    }
    const matches = source.match(new RegExp(escapeRegExp(needle), 'g'));
    return matches ? matches.length : 0;
}

function ensureSingleOccurrence(source, needle, replacement = needle) {
    const count = countOccurrences(source, needle);
    if (count === 0) {
        return source;
    }
    if (count === 1 && needle === replacement) {
        return source;
    }
    return source.replace(new RegExp(`(?:${escapeRegExp(needle)}\\n?)+`, 'g'), `${replacement}`);
}

function exportScripts(ffdecPath, workRoot, swfPath) {
    fs.rmSync(workRoot, { recursive: true, force: true });
    fs.mkdirSync(workRoot, { recursive: true });
    runFfdec(ffdecPath, ['-selectclass', 'a_Room_MainTutorial', '-export', 'script', workRoot, swfPath]);

    const roomPath = path.join(workRoot, 'scripts', 'a_Room_MainTutorial.as');
    if (!fs.existsSync(roomPath)) {
        throw new Error(`FFDec export did not produce ${roomPath}`);
    }

    return {
        roomPath
    };
}

function patchRoomSource(source) {
    let patched = source.replace(/\r\n/g, '\n');
    const waveFieldsBlock = `      public var bInitialWave:Boolean = false;\n      \n      public var bUseSmallWave:Boolean = false;\n`;
    const waveResetBlock = `         this.bInitialWave = false;\n         this.bUseSmallWave = false;\n`;

    patched = ensureSingleOccurrence(patched, waveFieldsBlock);
    patched = ensureSingleOccurrence(patched, waveResetBlock);

    if (
        patched.includes('this.am_Boss.Skit(msg);') &&
        patched.includes('&& !_loc1_.bHoldSpawn && Boolean(_loc1_.Health()) && !_loc1_.Defeated()') &&
        patched.includes('&& (_loc2_.bHoldSpawn || !_loc2_.Health() || _loc2_.Defeated())') &&
        countOccurrences(patched, 'public var bInitialWave:Boolean = false;') === 1 &&
        countOccurrences(patched, 'public var bUseSmallWave:Boolean = false;') === 1 &&
        countOccurrences(patched, '         this.bInitialWave = false;') === 1 &&
        countOccurrences(patched, '         this.bUseSmallWave = false;') === 1
    ) {
        return patched.endsWith('\n') ? patched : `${patched}\n`;
    }

    if (!patched.includes('public var bInitialWave:Boolean = false;') || !patched.includes('public var bUseSmallWave:Boolean = false;')) {
        patched = replaceExact(
            patched,
            `      public var bWounded2:Boolean = false;\n`,
            `      public var bWounded2:Boolean = false;\n      \n      public var bInitialWave:Boolean = false;\n      \n      public var bUseSmallWave:Boolean = false;\n`,
            'wave state fields'
        );
    }

    if (!patched.includes('         this.bInitialWave = false;') || !patched.includes('         this.bUseSmallWave = false;')) {
        patched = replaceExact(
            patched,
            `         this.bWounded = false;\n         this.bWounded2 = false;\n`,
            `         this.bWounded = false;\n         this.bWounded2 = false;\n         this.bInitialWave = false;\n         this.bUseSmallWave = false;\n`,
            'wave reset block'
        );
    }

    if (patched.includes(`         param1.cutSceneStartBoss = ["0 Camera 1","5 OldManTutorial Thank the stars you\\'re here!","14 OldManTutorial The goblins have ruined the keep.","14 OldManTutorial I was the caretaker here...","6 Parrot <Goto Red 1> Look out!","2 SpawnCue Boss","2 Boss <Goto Red 2> Stop the human!","10 Boss Don\\'t let him|her take our home!","6 Camera Free"];\n`)) {
        patched = replaceExact(
            patched,
            `         param1.cutSceneStartBoss = ["0 Camera 1","5 OldManTutorial Thank the stars you\\'re here!","14 OldManTutorial The goblins have ruined the keep.","14 OldManTutorial I was the caretaker here...","6 Parrot <Goto Red 1> Look out!","2 SpawnCue Boss","2 Boss <Goto Red 2> Stop the human!","10 Boss Don\\'t let him|her take our home!","6 Camera Free"];\n`,
            `         param1.cutSceneStartBoss = ["0 Camera 1","5 OldManTutorial Thank the stars you\\'re here!","14 OldManTutorial The goblins have ruined the keep.","14 OldManTutorial I was the caretaker here...","6 Parrot <Goto Red 1> Look out!","2 SpawnCue Boss","2 Boss <Run Loop><Goto Red 2> Stop the human!","10 Boss <End> Don\\'t let him|her take our home!","6 Camera Free"];\n`,
            'boss intro cutscene'
        );
    }

    if (
        patched.includes('if(Boolean(_loc1_) && Boolean(_loc1_.Health()))') ||
        patched.includes('if(Boolean(_loc2_) && !_loc2_.Health())')
    ) {
        patched = replaceOneOf(
            patched,
            [
                [
                    `      public function UpdateBossFight(param1:a_GameHook) : void\n      {\n         if(!param1.OnScriptFinish(param1.cutSceneStartBoss))\n         {\n            return;\n         }\n         this.am_Boss.visible = true;\n         this.am_Boss.RemoveBuff("Untouchable");\n         if(this.am_Boss.Defeated())\n         {\n            param1.Group(this.am_MonsterGroup).Kill();\n            this.monsterList = null;\n            param1.SetPhase(null);\n            return;\n         }\n         if(!this.bInitialWave)\n         {\n            this.bInitialWave = true;\n            this.SpawnMonsterWave(3);\n         }\n         if(!this.bWounded && this.am_Boss.Health() < 0.6)\n         {\n            this.bWounded = true;\n            this.SummonReinforcements(param1,"To me! Protect your home!");\n         }\n         if(!this.bWounded2 && this.am_Boss.Health() < 0.3)\n         {\n            this.bWounded2 = true;\n            this.SummonReinforcements(param1,"I will not fall! To me, brothers!");\n         }\n         if(param1.AtTimeRepeat(2000,0) && this.CountLivingReinforcements() == 0)\n         {\n            this.SpawnMonsterWave(this.bUseSmallWave ? 2 : 3);\n            this.bUseSmallWave = !this.bUseSmallWave;\n         }\n      }\n      \n      public function CountLivingReinforcements() : uint\n      {\n         var _loc1_:a_Cue = null;\n         var _loc2_:uint = 0;\n         var _loc3_:uint = 0;\n         while(_loc3_ < this.numMonsters)\n         {\n            _loc1_ = this.monsterList[_loc3_];\n            if(Boolean(_loc1_) && Boolean(_loc1_.Health()))\n            {\n               _loc2_++;\n            }\n            _loc3_++;\n         }\n         return _loc2_;\n      }\n      \n      public function SpawnMonsterWave(param1:uint) : void\n      {\n         var _loc2_:a_Cue = null;\n         var _loc3_:uint = this.spawnIndex;\n         var _loc4_:uint = 0;\n         var _loc5_:uint = 0;\n         while(_loc4_ < this.numMonsters && _loc5_ < param1)\n         {\n            _loc2_ = this.monsterList[_loc3_];\n            if(Boolean(_loc2_) && !_loc2_.Health())\n            {\n               _loc2_.Remove();\n               _loc2_.Spawn();\n               _loc2_.Aggro();\n               _loc5_++;\n            }\n            _loc3_ = _loc3_ < this.numMonsters - 1 ? uint(_loc3_ + 1) : 0;\n            _loc4_++;\n         }\n         this.spawnIndex = _loc3_;\n      }\n      \n      public function SummonReinforcements(param1:a_GameHook, msg:String) : void\n      {\n         this.SpawnMonsterWave(3);\n      }\n`,
                    `      public function UpdateBossFight(param1:a_GameHook) : void\n      {\n         if(!param1.OnScriptFinish(param1.cutSceneStartBoss))\n         {\n            return;\n         }\n         this.am_Boss.visible = true;\n         this.am_Boss.RemoveBuff("Untouchable");\n         if(this.am_Boss.Defeated())\n         {\n            param1.Group(this.am_MonsterGroup).Kill();\n            this.monsterList = null;\n            param1.SetPhase(null);\n            return;\n         }\n         if(!this.bInitialWave)\n         {\n            this.bInitialWave = true;\n            this.SpawnMonsterWave(3);\n         }\n         if(!this.bWounded && this.am_Boss.Health() < 0.6)\n         {\n            this.bWounded = true;\n            this.SummonReinforcements(param1,"To me! Protect your home!");\n         }\n         if(!this.bWounded2 && this.am_Boss.Health() < 0.3)\n         {\n            this.bWounded2 = true;\n            this.SummonReinforcements(param1,"I will not fall! To me, brothers!");\n         }\n         if(param1.AtTimeRepeat(2000,0) && this.CountLivingReinforcements() == 0)\n         {\n            this.SpawnMonsterWave(this.bUseSmallWave ? 2 : 3);\n            this.bUseSmallWave = !this.bUseSmallWave;\n         }\n      }\n      \n      public function CountLivingReinforcements() : uint\n      {\n         var _loc1_:a_Cue = null;\n         var _loc2_:uint = 0;\n         var _loc3_:uint = 0;\n         while(_loc3_ < this.numMonsters)\n         {\n            _loc1_ = this.monsterList[_loc3_];\n            if(Boolean(_loc1_) && !_loc1_.bHoldSpawn && Boolean(_loc1_.Health()) && !_loc1_.Defeated())\n            {\n               _loc2_++;\n            }\n            _loc3_++;\n         }\n         return _loc2_;\n      }\n      \n      public function SpawnMonsterWave(param1:uint) : void\n      {\n         var _loc2_:a_Cue = null;\n         var _loc3_:uint = this.spawnIndex;\n         var _loc4_:uint = 0;\n         var _loc5_:uint = 0;\n         while(_loc4_ < this.numMonsters && _loc5_ < param1)\n         {\n            _loc2_ = this.monsterList[_loc3_];\n            if(Boolean(_loc2_) && (_loc2_.bHoldSpawn || !_loc2_.Health() || _loc2_.Defeated()))\n            {\n               _loc2_.Remove();\n               _loc2_.Spawn();\n               _loc2_.Aggro();\n               _loc5_++;\n            }\n            _loc3_ = _loc3_ < this.numMonsters - 1 ? uint(_loc3_ + 1) : 0;\n            _loc4_++;\n         }\n         this.spawnIndex = _loc3_;\n      }\n      \n      public function SummonReinforcements(param1:a_GameHook, msg:String) : void\n      {\n         this.am_Boss.Skit(msg);\n         this.SpawnMonsterWave(3);\n      }\n`
                ]
            ],
            'boss fight reinforcement methods'
        );
    }

    if (!patched.includes('this.am_Boss.Skit(msg);')) {
        patched = replaceExact(
            patched,
            `      public function SummonReinforcements(param1:a_GameHook, msg:String) : void\n      {\n         this.SpawnMonsterWave(3);\n      }\n`,
            `      public function SummonReinforcements(param1:a_GameHook, msg:String) : void\n      {\n         this.am_Boss.Skit(msg);\n         this.SpawnMonsterWave(3);\n      }\n`,
            'reinforcement skit'
        );
    }

    return patched.endsWith('\n') ? patched : `${patched}\n`;
}

function verifyRoomSource(source, swfPath) {
    const normalized = source.replace(/\r\n/g, '\n');
    const checks = [
        'public var bInitialWave:Boolean = false;',
        'public var bUseSmallWave:Boolean = false;',
        'Boss <Run Loop><Goto Red 2> Stop the human!',
        'Boss <End> Don\\\'t let him|her take our home!',
        'this.am_Boss.Skit(msg);',
        'this.SpawnMonsterWave(3);',
        'this.CountLivingReinforcements() == 0',
        'this.SpawnMonsterWave(this.bUseSmallWave ? 2 : 3);',
        '&& !_loc1_.bHoldSpawn && Boolean(_loc1_.Health()) && !_loc1_.Defeated()',
        '&& (_loc2_.bHoldSpawn || !_loc2_.Health() || _loc2_.Defeated())'
    ];

    for (const check of checks) {
        if (!normalized.includes(check)) {
            throw new Error(`${path.basename(swfPath)} is missing expected patch content: ${check}`);
        }
    }

    const singleUseChecks = [
        'public var bInitialWave:Boolean = false;',
        'public var bUseSmallWave:Boolean = false;',
        '         this.bInitialWave = false;',
        '         this.bUseSmallWave = false;'
    ];

    for (const check of singleUseChecks) {
        if (countOccurrences(normalized, check) !== 1) {
            throw new Error(`${path.basename(swfPath)} should contain exactly one occurrence of: ${check}`);
        }
    }
}

function replaceKeepCharacter(ffdecPath, inputSwfPath, outputSwfPath) {
    runFfdec(ffdecPath, [
        '-replaceCharacter',
        inputSwfPath,
        outputSwfPath,
        String(UPGRADED_KEEP_CHARACTER_ID),
        String(RUINED_KEEP_CHARACTER_ID)
    ]);
}

function verifyKeepCharacterReplacement(ffdecPath, swfPath) {
    const dumpOutput = runFfdecCapture(ffdecPath, ['-dumpSWF', swfPath]);
    if (dumpOutput.includes('already contains characterId=')) {
        throw new Error(`${path.basename(swfPath)} contains duplicate character id warnings after keep replacement`);
    }
}

function patchSwf(repoRoot, ffdecPath, swfPath) {
    const workRoot = path.join(repoRoot, 'build', 'ffdec-levelshome-keep-tutorial', path.basename(swfPath, path.extname(swfPath)));
    const { roomPath } = exportScripts(ffdecPath, workRoot, swfPath);
    const scriptsRoot = path.dirname(roomPath);
    const patchedSwfPath = path.join(workRoot, `${path.basename(swfPath, path.extname(swfPath))}.patched.swf`);
    const replacedSwfPath = path.join(workRoot, `${path.basename(swfPath, path.extname(swfPath))}.keep-replaced.swf`);

    const patchedRoomSource = patchRoomSource(fs.readFileSync(roomPath, 'utf8'));
    verifyRoomSource(patchedRoomSource, swfPath);
    fs.writeFileSync(roomPath, patchedRoomSource, 'utf8');

    runFfdec(ffdecPath, ['-importScript', swfPath, patchedSwfPath, scriptsRoot]);
    replaceKeepCharacter(ffdecPath, patchedSwfPath, replacedSwfPath);
    fs.copyFileSync(replacedSwfPath, swfPath);
    console.log(`Patched keep tutorial room logic in ${swfPath}`);
}

function verifySwf(repoRoot, ffdecPath, swfPath) {
    const workRoot = path.join(repoRoot, 'build', 'ffdec-levelshome-keep-tutorial-verify', path.basename(swfPath, path.extname(swfPath)));
    const { roomPath } = exportScripts(ffdecPath, workRoot, swfPath);
    verifyRoomSource(fs.readFileSync(roomPath, 'utf8'), swfPath);
    verifyKeepCharacterReplacement(ffdecPath, swfPath);
    console.log(`Verified keep tutorial room logic in ${swfPath}`);
}

function main() {
    const repoRoot = resolveRepoRoot();
    const args = parseArgs(process.argv);
    const ffdecPath = detectFfdec(repoRoot, args.ffdec);

    if (!ffdecPath) {
        throw new Error('FFDec not found. Pass --ffdec or install JPEXS FFDec.');
    }

    const requestedSwfs = new Set((args.swfs.length ? args.swfs : TARGETS.map((target) => target.swf)).map((entry) => resolvePath(repoRoot, entry)));
    const selectedTargets = TARGETS
        .map((target) => resolvePath(repoRoot, target.swf))
        .filter((swfPath) => requestedSwfs.has(swfPath));

    if (!selectedTargets.length) {
        throw new Error('No matching SWFs selected for patching.');
    }

    for (const swfPath of selectedTargets) {
        if (!fs.existsSync(swfPath)) {
            throw new Error(`SWF not found: ${swfPath}`);
        }
    }

    if (args.verify) {
        for (const swfPath of selectedTargets) {
            verifySwf(repoRoot, ffdecPath, swfPath);
        }
        return;
    }

    for (const swfPath of selectedTargets) {
        patchSwf(repoRoot, ffdecPath, swfPath);
    }
}

try {
    main();
} catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
}
