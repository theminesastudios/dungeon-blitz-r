#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const TARGETS = [
    {
        swf: path.join('src', 'client', 'content', 'localhost', 'p', 'cbp', 'DungeonBlitz.swf')
    }
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
            '  node src/server/scripts/patch-dungeonblitz-chat-commands.js [--verify] [--swf <path>] [--ffdec <path>]',
            '',
            'Defaults:',
            '  exports and patches class_127 in the served DungeonBlitz SWF',
            '  so /lang:tr, /lang: tr, /lang:en, and /lang: en pass through the client slash-command parser to the server.'
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

function exportClass127(ffdecPath, workRoot, swfPath) {
    fs.rmSync(workRoot, { recursive: true, force: true });
    fs.mkdirSync(workRoot, { recursive: true });
    runFfdec(ffdecPath, ['-selectclass', 'class_127', '-export', 'script', workRoot, swfPath]);

    const classPath = path.join(workRoot, 'scripts', 'class_127.as');
    if (!fs.existsSync(classPath)) {
        throw new Error(`FFDec export did not produce ${classPath}`);
    }

    return classPath;
}

function verifyPatchedClass127(source, swfPath) {
    if (!source.includes('private function method_1940(param1:String) : Boolean')) {
        throw new Error(`${path.basename(swfPath)} is missing the /lang passthrough helper.`);
    }
    if (!source.includes('_loc2_ = "/lang:" + _loc2_.substr(6).split(" ").join("");')) {
        throw new Error(`${path.basename(swfPath)} is missing whitespace-tolerant /lang normalization.`);
    }
    if (!source.includes('var_1.linkUpdater.WriteChatMessage(param1,param2);')) {
        throw new Error(`${path.basename(swfPath)} is missing the /lang passthrough send path.`);
    }
    if (!source.includes('if(this.method_1940(param2))')) {
        throw new Error(`${path.basename(swfPath)} is missing the /lang passthrough guard.`);
    }
}

function patchClass127Source(source, swfPath) {
    const oldReturn = 'return _loc2_ == "/lang:tr" || _loc2_ == "/lang:en" || _loc2_ == "\\\\lang:tr" || _loc2_ == "\\\\lang:en";';
    const newBlock = [
        'if(_loc2_.indexOf("/lang:") == 0)',
        '         {',
        '            _loc2_ = "/lang:" + _loc2_.substr(6).split(" ").join("");',
        '         }',
        '         else if(_loc2_.indexOf("\\\\lang:") == 0)',
        '         {',
        '            _loc2_ = "\\\\lang:" + _loc2_.substr(6).split(" ").join("");',
        '         }',
        '         return _loc2_ == "/lang:tr" || _loc2_ == "/lang:en" || _loc2_ == "\\\\lang:tr" || _loc2_ == "\\\\lang:en";'
    ].join('\n');

    const helper = [
        'private function method_1940(param1:String) : Boolean',
        '      {',
        '         var _loc2_:String = null;',
        '         if(!param1)',
        '         {',
        '            return false;',
        '         }',
        '         _loc2_ = param1.toLowerCase();',
        '         while(_loc2_.length && _loc2_.charAt(_loc2_.length - 1) == " ")',
        '         {',
        '            _loc2_ = _loc2_.substr(0,_loc2_.length - 1);',
        '         }',
        `         ${newBlock}`,
        '      }',
        '      ',
        '      '
    ].join('\n');

    if (source.includes(newBlock) && source.includes('if(this.method_1940(param2))')) {
        return source;
    }

    if (source.includes('private function method_1940(param1:String) : Boolean')) {
        if (!source.includes(oldReturn)) {
            throw new Error(`${path.basename(swfPath)} has an unexpected method_1940 return block.`);
        }
        return source.replace(oldReturn, newBlock);
    }

    const methodStartPattern = /public function method_537\(param1:uint, param2:String, param3:Boolean = false\) : void\r?\n      \{\r?\n         if\(param3 \|\| !this\.TryToProcessChatAsLocalCommand\(param2\)\)/;
    const patchedMethodStart = [
        `${helper}public function method_537(param1:uint, param2:String, param3:Boolean = false) : void`,
        '      {',
        '         if(this.method_1940(param2))',
        '         {',
        '            if(var_1.CanSendPacket())',
        '            {',
        '               var_1.linkUpdater.WriteChatMessage(param1,param2);',
        '            }',
        '            return;',
        '         }',
        '         if(param3 || !this.TryToProcessChatAsLocalCommand(param2))'
    ].join('\n');

    if (!methodStartPattern.test(source)) {
        throw new Error(`${path.basename(swfPath)} has an unexpected method_537 block.`);
    }

    return source.replace(methodStartPattern, patchedMethodStart);
}

function patchSwf(repoRoot, ffdecPath, swfPath) {
    const workRoot = path.join(
        repoRoot,
        'build',
        'ffdec-dungeonblitz-chat-commands',
        path.basename(swfPath, path.extname(swfPath))
    );
    const patchedSwfPath = path.join(workRoot, `${path.basename(swfPath, path.extname(swfPath))}.patched.swf`);
    fs.rmSync(workRoot, { recursive: true, force: true });
    fs.mkdirSync(workRoot, { recursive: true });

    const classPath = exportClass127(ffdecPath, workRoot, swfPath);
    const patchedSource = patchClass127Source(fs.readFileSync(classPath, 'utf8'), swfPath);
    fs.writeFileSync(classPath, patchedSource);

    const scriptsDir = path.join(workRoot, 'scripts');
    runFfdec(ffdecPath, ['-importScript', swfPath, patchedSwfPath, scriptsDir]);
    fs.copyFileSync(patchedSwfPath, swfPath);
    console.log(`Patched chat command passthrough in ${swfPath}`);
}

function verifySwf(repoRoot, ffdecPath, swfPath) {
    const workRoot = path.join(
        repoRoot,
        'build',
        'ffdec-dungeonblitz-chat-commands-verify',
        path.basename(swfPath, path.extname(swfPath))
    );
    const classPath = exportClass127(ffdecPath, workRoot, swfPath);
    verifyPatchedClass127(fs.readFileSync(classPath, 'utf8'), swfPath);
    console.log(`Verified chat command passthrough in ${swfPath}`);
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
        .map((target) => ({
            swfPath: resolvePath(repoRoot, target.swf)
        }))
        .filter((target) => requestedSwfs.has(target.swfPath));

    if (!selectedTargets.length) {
        throw new Error('No matching SWFs selected for patching.');
    }

    for (const target of selectedTargets) {
        if (!fs.existsSync(target.swfPath)) {
            throw new Error(`SWF not found: ${target.swfPath}`);
        }
    }

    if (args.verify) {
        for (const target of selectedTargets) {
            verifySwf(repoRoot, ffdecPath, target.swfPath);
        }
        return;
    }

    for (const target of selectedTargets) {
        patchSwf(repoRoot, ffdecPath, target.swfPath);
    }
}

try {
    main();
} catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
}
