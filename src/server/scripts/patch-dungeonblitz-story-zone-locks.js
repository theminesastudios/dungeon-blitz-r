#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const TARGETS = [
    path.join('src', 'client', 'content', 'localhost', 'p', 'cbp', 'DungeonBlitz.swf')
];

const EARLY_ZONE_METHOD = 'method_6901';
const STORY_UNLOCK_METHOD = 'method_6902';
const ANNA_MARKER_METHOD = 'method_6903';

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
            '  node src/server/scripts/patch-dungeonblitz-story-zone-locks.js [--verify] [--swf <path>] [--ffdec <path>]',
            '',
            'Defaults:',
            '  patches the served DungeonBlitz SWF so the map only shows story-zone quest markers',
            '  after those zones are actually unlocked by the player story flow.'
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
        path.join(repoRoot, 'build', 'tools', 'ffdec_25.1.3', 'ffdec.sh'),
        path.join(repoRoot, 'build', 'tools', 'ffdec_25.1.3', 'ffdec.jar'),
        path.join(repoRoot, 'build', 'tools', 'ffdec_25.1.3', 'ffdec-cli.jar'),
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

function exportClass119(ffdecPath, workRoot, swfPath) {
    fs.rmSync(workRoot, { recursive: true, force: true });
    fs.mkdirSync(workRoot, { recursive: true });
    runFfdec(ffdecPath, ['-selectclass', 'class_119', '-export', 'script', workRoot, swfPath]);

    const classPath = path.join(workRoot, 'scripts', 'class_119.as');
    if (!fs.existsSync(classPath)) {
        throw new Error(`FFDec export did not produce ${classPath}`);
    }

    return classPath;
}

function patchSource(source) {
    source = source.replace(/\r\n/g, '\n');

    if (
        source.includes(`private function ${STORY_UNLOCK_METHOD}(param1:class_13) : Boolean`) &&
        source.includes(`private function ${ANNA_MARKER_METHOD}(param1:class_13,param2:Mission) : Boolean`)
    ) {
        return source;
    }

    const loopNeedle = [
        '               if(_loc20_.var_431 != this.var_102)',
        '               {',
        '                  if(!_loc20_.var_186)',
        '                  {',
        '                     continue;',
        '                  }',
        '                  if(_loc20_.var_186 != this.var_102)',
        '                  {',
        '                     if(this.var_102 != "OldMineMountain" && this.var_102 != "OldMineMountainHard")',
        '                     {',
        '                        continue;',
        '                     }',
        '                     if(_loc20_.var_431 != "EmeraldGlades" && _loc20_.var_431 != "EmeraldGladesHard")',
        '                     {',
        '                        continue;',
        '                     }',
        '                     if(_loc20_.var_186 != "BridgeTown" && _loc20_.var_186 != "BridgeTownHard")',
        '                     {',
        '                        continue;',
        '                     }',
        '                  }',
        '               }',
        '               _loc19_ = var_1.mMissionInfoList[_loc20_.missionID];'
    ].join('\n');
    const loopReplacement = [
        '               if(_loc20_.var_431 != this.var_102)',
        '               {',
        '                  if(!_loc20_.var_186)',
        '                  {',
        '                     continue;',
        '                  }',
        '                  if(_loc20_.var_186 != this.var_102)',
        '                  {',
        '                     if(this.var_102 != "OldMineMountain" && this.var_102 != "OldMineMountainHard")',
        '                     {',
        '                        continue;',
        '                     }',
        '                     if(_loc20_.var_431 != "EmeraldGlades" && _loc20_.var_431 != "EmeraldGladesHard")',
        '                     {',
        '                        continue;',
        '                     }',
        '                     if(_loc20_.var_186 != "BridgeTown" && _loc20_.var_186 != "BridgeTownHard")',
        '                     {',
        '                        continue;',
        '                     }',
        '                  }',
        '               }',
        `               if(!this.${STORY_UNLOCK_METHOD}(_loc20_))`,
        '               {',
        '                  continue;',
        '               }',
        '               _loc19_ = var_1.mMissionInfoList[_loc20_.missionID];',
        `               if(!this.${ANNA_MARKER_METHOD}(_loc20_,_loc19_))`,
        '               {',
        '                  continue;',
        '               }'
    ].join('\n');
    const patchedLoopNeedle = [
        `               if(!this.${STORY_UNLOCK_METHOD}(_loc20_))`,
        '               {',
        '                  continue;',
        '               }',
        '               _loc19_ = var_1.mMissionInfoList[_loc20_.missionID];'
    ].join('\n');
    const patchedLoopReplacement = [
        `               if(!this.${STORY_UNLOCK_METHOD}(_loc20_))`,
        '               {',
        '                  continue;',
        '               }',
        '               _loc19_ = var_1.mMissionInfoList[_loc20_.missionID];',
        `               if(!this.${ANNA_MARKER_METHOD}(_loc20_,_loc19_))`,
        '               {',
        '                  continue;',
        '               }'
    ].join('\n');

    if (source.includes(loopNeedle)) {
        source = source.replace(loopNeedle, loopReplacement);
    } else if (source.includes(patchedLoopNeedle) && !source.includes(ANNA_MARKER_METHOD)) {
        source = source.replace(patchedLoopNeedle, patchedLoopReplacement);
    } else if (!source.includes(`${ANNA_MARKER_METHOD}(_loc20_,_loc19_)`)) {
        throw new Error('Failed to find the map marker mission loop in class_119.as.');
    }

    const helperAnchor = [
        '      public function method_517(param1:MovieClip) : void',
        '      {'
    ].join('\n');
    const helperBlock = [
        `      private function ${STORY_UNLOCK_METHOD}(param1:class_13) : Boolean`,
        '      {',
        '         var _loc2_:Mission = null;',
        '         var _loc3_:class_13 = null;',
        '         if(!param1)',
        '         {',
        '            return false;',
        '         }',
        `         if(this.${EARLY_ZONE_METHOD}(param1.var_431) || this.${EARLY_ZONE_METHOD}(param1.var_186))`,
        '         {',
        '            return true;',
        '         }',
        '         _loc3_ = class_14.var_42["DeliverToSwamp"];',
        '         if(!_loc3_)',
        '         {',
        '            return false;',
        '         }',
        '         _loc2_ = var_1.mMissionInfoList[_loc3_.missionID];',
        '         return Boolean(_loc2_) && _loc2_.var_145 == Mission.const_72;',
        '      }',
        '      ',
        `      private function ${ANNA_MARKER_METHOD}(param1:class_13,param2:Mission) : Boolean`,
        '      {',
        '         var _loc3_:class_13 = class_14.var_42["FindAnnasFather"];',
        '         if(!_loc3_ || !param1 || param1.missionID != _loc3_.missionID)',
        '         {',
        '            return true;',
        '         }',
        '         return Boolean(param2);',
        '      }',
        '      ',
        `      private function ${EARLY_ZONE_METHOD}(param1:String) : Boolean`,
        '      {',
        '         if(!param1)',
        '         {',
        '            return false;',
        '         }',
        '         return param1.indexOf("NewbieRoad") == 0 || param1.indexOf("Tutorial") == 0 || param1.indexOf("CraftTownTutorial") == 0;',
        '      }',
        '      ',
        '      public function method_517(param1:MovieClip) : void',
        '      {'
    ].join('\n');

    if (source.includes(helperAnchor) && !source.includes(`private function ${ANNA_MARKER_METHOD}(param1:class_13,param2:Mission) : Boolean`)) {
        source = source.replace(helperAnchor, helperBlock);
    } else if (!source.includes(`private function ${STORY_UNLOCK_METHOD}(param1:class_13) : Boolean`)) {
        throw new Error('Failed to find helper insertion point in class_119.as.');
    }

    return source;
}

function verifySource(source, swfPath) {
    source = source.replace(/\r\n/g, '\n');

    if (!source.includes(`private function ${STORY_UNLOCK_METHOD}(param1:class_13) : Boolean`)) {
        throw new Error(`${path.basename(swfPath)} is missing the story zone unlock helper.`);
    }
    if (!source.includes(`private function ${ANNA_MARKER_METHOD}(param1:class_13,param2:Mission) : Boolean`)) {
        throw new Error(`${path.basename(swfPath)} is missing the Anna marker gate.`);
    }
    if (!source.includes(`private function ${EARLY_ZONE_METHOD}(param1:String) : Boolean`)) {
        throw new Error(`${path.basename(swfPath)} is missing the early-zone helper.`);
    }
    if (!new RegExp(`if\\s*\\(!?this\\.${STORY_UNLOCK_METHOD}\\(`).test(source)) {
        throw new Error(`${path.basename(swfPath)} is missing the map marker story gate.`);
    }
    if (!new RegExp(`if\\s*\\(!?this\\.${ANNA_MARKER_METHOD}\\(`).test(source)) {
        throw new Error(`${path.basename(swfPath)} is missing the Anna follow-up marker gate.`);
    }
    if (!source.includes('_loc3_ = class_14.var_42["DeliverToSwamp"];')) {
        throw new Error(`${path.basename(swfPath)} is missing the DeliverToSwamp unlock dependency.`);
    }
    if (!source.includes('class_14.var_42["FindAnnasFather"]')) {
        throw new Error(`${path.basename(swfPath)} is missing the FindAnnasFather marker dependency.`);
    }
}

function patchSwf(repoRoot, ffdecPath, swfPath) {
    const workRoot = path.join(
        repoRoot,
        'build',
        'ffdec-dungeonblitz-story-zone-locks',
        path.basename(swfPath, path.extname(swfPath))
    );
    const patchedSwfPath = path.join(workRoot, `${path.basename(swfPath, path.extname(swfPath))}.patched.swf`);
    const classPath = exportClass119(ffdecPath, workRoot, swfPath);
    const patchedSource = patchSource(fs.readFileSync(classPath, 'utf8'));
    fs.writeFileSync(classPath, patchedSource, 'utf8');
    verifySource(patchedSource, swfPath);

    runFfdec(ffdecPath, ['-importScript', swfPath, patchedSwfPath, path.dirname(classPath)]);
    fs.copyFileSync(patchedSwfPath, swfPath);
    console.log(`Patched story zone locks in ${swfPath}`);
}

function verifySwf(repoRoot, ffdecPath, swfPath) {
    const workRoot = path.join(
        repoRoot,
        'build',
        'ffdec-dungeonblitz-story-zone-locks-verify',
        path.basename(swfPath, path.extname(swfPath))
    );
    const classPath = exportClass119(ffdecPath, workRoot, swfPath);
    verifySource(fs.readFileSync(classPath, 'utf8').replace(/\r\n/g, '\n'), swfPath);
    console.log(`Verified story zone locks in ${swfPath}`);
}

function main() {
    const repoRoot = resolveRepoRoot();
    const args = parseArgs(process.argv);
    const ffdecPath = detectFfdec(repoRoot, args.ffdec);

    if (!ffdecPath) {
        throw new Error('FFDec not found. Pass --ffdec or install JPEXS FFDec.');
    }

    const requestedSwfs = new Set((args.swfs.length ? args.swfs : TARGETS).map((entry) => resolvePath(repoRoot, entry)));
    const selectedSwfs = TARGETS
        .map((entry) => resolvePath(repoRoot, entry))
        .filter((swfPath) => requestedSwfs.has(swfPath));

    if (!selectedSwfs.length) {
        throw new Error('No matching SWFs selected for patching.');
    }

    for (const swfPath of selectedSwfs) {
        if (!fs.existsSync(swfPath)) {
            throw new Error(`SWF not found: ${swfPath}`);
        }
    }

    if (args.verify) {
        for (const swfPath of selectedSwfs) {
            verifySwf(repoRoot, ffdecPath, swfPath);
        }
        return;
    }

    for (const swfPath of selectedSwfs) {
        patchSwf(repoRoot, ffdecPath, swfPath);
    }
}

try {
    main();
} catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
}
