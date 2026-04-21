#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DEFAULT_INPUT = path.join('src', 'client', 'content', 'localhost', 'p', 'cbp', 'DungeonBlitz.multiplayer.swf');
const DEFAULT_INPUT_FALLBACK = path.join('src', 'client', 'content', 'localhost', 'p', 'cbp', 'DungeonBlitz.multiplayer.swf.bak');
const DEFAULT_OUTPUT = path.join('src', 'client', 'content', 'localhost', 'p', 'cbp', 'DungeonBlitz.swf');
const DEFAULT_EXISTING_OUTPUT = path.join('src', 'client', 'content', 'localhost', 'p', 'cbp', 'DungeonBlitz.swf');
const CLASS_NAMES = ['DungeonBlitz', 'class_67', 'Game'];
const MULTIPLAYER_BASE_IP = String(process.env.MULTIPLAYER_BASE_IP || '10.179.241.95').trim() || '10.179.241.95';

function parseArgs(argv) {
    const args = {
        ffdec: '',
        input: DEFAULT_INPUT,
        output: DEFAULT_OUTPUT,
        verify: false
    };

    for (let index = 2; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === '--ffdec' || arg === '-f') {
            args.ffdec = argv[++index] || '';
            continue;
        }
        if (arg === '--input' || arg === '-i') {
            args.input = argv[++index] || '';
            continue;
        }
        if (arg === '--output' || arg === '-o') {
            args.output = argv[++index] || '';
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
            '  node src/server/scripts/build-dungeonblitz-single-swf.js [--verify] [--input <path>] [--output <path>] [--ffdec <path>]',
            '',
            'Defaults:',
            `  input:  ${DEFAULT_INPUT}`,
            `  output: ${DEFAULT_OUTPUT}`,
            '  exports DungeonBlitz + class_67 from the multiplayer SWF, patches them for runtime local/multiplayer host selection,',
            '  and imports the result back into a single DungeonBlitz.swf.'
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

function resolveInputSwfPath(repoRoot, value) {
    const primary = resolvePath(repoRoot, value);
    if (fs.existsSync(primary)) {
        return primary;
    }

    if (value === DEFAULT_INPUT) {
        const fallbacks = [DEFAULT_INPUT_FALLBACK, DEFAULT_EXISTING_OUTPUT].map((entry) => resolvePath(repoRoot, entry));
        for (const fallback of fallbacks) {
            if (fs.existsSync(fallback)) {
                return fallback;
            }
        }
    }

    return primary;
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

function replaceExact(source, needle, replacement, label) {
    if (!source.includes(needle)) {
        throw new Error(`Could not find patch marker: ${label}`);
    }
    return source.replace(needle, replacement);
}

function replaceRegex(source, pattern, replacement, label) {
    if (!pattern.test(source)) {
        throw new Error(`Could not find patch marker: ${label}`);
    }
    return source.replace(pattern, replacement);
}

function patchDungeonBlitzSource(source) {
    const eol = source.includes('\r\n') ? '\r\n' : '\n';
    const join = (lines) => lines.join(eol);

    if (source.includes('_loc4_ = stage.loaderInfo.url.toLowerCase();')) {
        return source;
    }
    const patched = join([
        '      public function method_861(param1:Event = null) : void',
        '      {',
        '         var _loc2_:String = null;',
        '         var _loc3_:String = null;',
        '         var _loc4_:String = null;',
        `         var _loc5_:String = "${MULTIPLAYER_BASE_IP}";`,
        '         var _loc6_:String = "/p/";',
        '         DevSettings.method_275();',
        '         stage.scaleMode = StageScaleMode.NO_SCALE;',
        '         stage.align = StageAlign.TOP_LEFT;',
        '         this.var_2228 = new Sprite();',
        '         addChild(this.var_2228);',
        '         if(!(DevSettings.flags & DevSettings.DEVFLAG_MASTER_CLIENT))',
        '         {',
        '            _loc2_ = ResourceManager.method_1071(root);',
        '            _loc4_ = stage.loaderInfo.url.toLowerCase();',
        '            if(_loc4_.indexOf("localhost") >= 0)',
        '            {',
        '               _loc5_ = "localhost";',
        '               _loc6_ = ":8000/p/";',
        '            }',
        '            else if(_loc4_.indexOf("127.0.0.1") >= 0)',
        '            {',
        '               _loc5_ = "127.0.0.1";',
        '               _loc6_ = ":8000/p/";',
        '            }',
        '            _loc3_ = ResourceManager.method_1544(stage,_loc5_,_loc5_,_loc6_);',
        '         }'
    ]);

    return replaceRegex(
        source,
        /      public function method_861\(param1:Event = null\) : void\r?\n      \{\r?\n         var _loc2_:String = null;\r?\n         var _loc3_:String = null;\r?\n         DevSettings\.method_275\(\);\r?\n         stage\.scaleMode = StageScaleMode\.NO_SCALE;\r?\n         stage\.align = StageAlign\.TOP_LEFT;\r?\n         this\.var_2228 = new Sprite\(\);\r?\n         addChild\(this\.var_2228\);\r?\n         if\(!\(DevSettings\.flags & DevSettings\.DEVFLAG_MASTER_CLIENT\)\)\r?\n         \{\r?\n            _loc2_ = ResourceManager\.method_1071\(root\);\r?\n            _loc3_ = ResourceManager\.method_1544\(stage,"[^"]+","[^"]+","[^"]+"\);\r?\n         \}/,
        patched,
        'DungeonBlitz.method_861 host selection'
    );
}

function patchCrashWindowSource(source) {
    if (source.includes('var _loc2_:String = "/p/cbp/DungeonBlitz.swf?fv=cbq&gv=cbp";')) {
        return source;
    }

    return replaceRegex(
        source,
        /         var _loc2_:String = "http:\/\/[^"]+\/p\/cbp\/DungeonBlitz\.swf\?fv=cbq&gv=cbp";/,
        '         var _loc2_:String = "/p/cbp/DungeonBlitz.swf?fv=cbq&gv=cbp";',
        'class_67.method_1866 refresh URL'
    );
}

function patchGameSource(source) {
    const eol = source.includes('\r\n') ? '\r\n' : '\n';
    const join = (lines) => lines.join(eol);

    if (source.includes('_loc3_ = this.main.stage.loaderInfo.url.toLowerCase();')) {
        return source;
    }

    const original = join([
        '      public function method_429(param1:Boolean) : void',
        '      {',
        '         if(!param1)',
        '         {',
        '            this.serverConn = new Connection(this,this.method_1933);',
        '         }',
        '         else',
        '         {',
        '            this.var_94.method_71("Connecting...");',
        '            this.serverConn = new Connection(this,this.method_1968,this.method_1610);',
        '         }',
        '         var _loc2_:String = DevSettings.flags & DevSettings.DEVFLAG_SERVERLOCAL ? DevSettings.var_2032 : LinkUpdater.const_1264;',
        '         this.serverConn.method_403(_loc2_,Connection.LOGINSERVER_PORT);',
        '      }'
    ]);
    const patched = join([
        '      public function method_429(param1:Boolean) : void',
        '      {',
        '         var _loc2_:String = null;',
        '         var _loc3_:String = null;',
        '         if(!param1)',
        '         {',
        '            this.serverConn = new Connection(this,this.method_1933);',
        '         }',
        '         else',
        '         {',
        '            this.var_94.method_71("Connecting...");',
        '            this.serverConn = new Connection(this,this.method_1968,this.method_1610);',
        '         }',
        '         _loc2_ = DevSettings.flags & DevSettings.DEVFLAG_SERVERLOCAL ? DevSettings.var_2032 : LinkUpdater.const_1264;',
        '         _loc3_ = this.main.stage.loaderInfo.url.toLowerCase();',
        '         if(_loc3_.indexOf("localhost") >= 0)',
        '         {',
        '            _loc2_ = "localhost";',
        '         }',
        '         else if(_loc3_.indexOf("127.0.0.1") >= 0)',
        '         {',
        '            _loc2_ = "127.0.0.1";',
        '         }',
        '         this.serverConn.method_403(_loc2_,Connection.LOGINSERVER_PORT);',
        '      }'
    ]);

    source = replaceExact(source, original, patched, 'Game.method_429 host selection');
    source = source.replace('            null.var_514 = 0;', '            _loc7_.var_514 = 0;');
    source = source.replace('            this.var_532.push(null);', '            this.var_532.push(_loc7_);');
    source = source.replace('                  this.mOwnedCharms[param1.method_75()] = null;', '                  this.mOwnedCharms[param1.method_75()] = _loc4_;');
    source = source.replace('               ++null.var_181;', '               ++_loc4_.var_181;');
    return source;
}

function exportScripts(ffdecPath, workRoot, swfPath) {
    fs.rmSync(workRoot, { recursive: true, force: true });
    fs.mkdirSync(workRoot, { recursive: true });
    runFfdec(ffdecPath, ['-selectclass', CLASS_NAMES.join(','), '-export', 'script', workRoot, swfPath]);

    const scriptsDir = path.join(workRoot, 'scripts');
    const dungeonBlitzPath = path.join(scriptsDir, 'DungeonBlitz.as');
    const crashWindowPath = path.join(scriptsDir, 'class_67.as');
    const gamePath = path.join(scriptsDir, 'Game.as');
    if (!fs.existsSync(dungeonBlitzPath) || !fs.existsSync(crashWindowPath) || !fs.existsSync(gamePath)) {
        throw new Error('FFDec export did not produce the expected ActionScript files.');
    }

    return { scriptsDir, dungeonBlitzPath, crashWindowPath, gamePath };
}

function verifyPatchedSources(dungeonBlitzSource, crashWindowSource, gameSource, swfPath) {
    if (!dungeonBlitzSource.includes('_loc4_ = stage.loaderInfo.url.toLowerCase();')) {
        throw new Error(`${path.basename(swfPath)} is missing the runtime host selector in DungeonBlitz.method_861.`);
    }
    if (!dungeonBlitzSource.includes('_loc6_ = ":8000/p/";')) {
        throw new Error(`${path.basename(swfPath)} is missing the localhost asset path in DungeonBlitz.method_861.`);
    }
    if (!crashWindowSource.includes('var _loc2_:String = "/p/cbp/DungeonBlitz.swf?fv=cbq&gv=cbp";')) {
        throw new Error(`${path.basename(swfPath)} is missing the relative crash refresh URL.`);
    }
    if (!gameSource.includes('_loc3_ = this.main.stage.loaderInfo.url.toLowerCase();')) {
        throw new Error(`${path.basename(swfPath)} is missing the runtime login host selector in Game.method_429.`);
    }
    if (!gameSource.includes('_loc2_ = "localhost";')) {
        throw new Error(`${path.basename(swfPath)} is missing the localhost login override in Game.method_429.`);
    }
}

function buildSingleSwf(repoRoot, ffdecPath, inputSwfPath, outputSwfPath) {
    const workRoot = path.join(repoRoot, 'build', 'ffdec-dungeonblitz-single-swf');
    const patchedSwfPath = path.join(workRoot, 'DungeonBlitz.single.swf');
    const { scriptsDir, dungeonBlitzPath, crashWindowPath, gamePath } = exportScripts(ffdecPath, workRoot, inputSwfPath);

    fs.writeFileSync(dungeonBlitzPath, patchDungeonBlitzSource(fs.readFileSync(dungeonBlitzPath, 'utf8')), 'utf8');
    fs.writeFileSync(crashWindowPath, patchCrashWindowSource(fs.readFileSync(crashWindowPath, 'utf8')), 'utf8');
    fs.writeFileSync(gamePath, patchGameSource(fs.readFileSync(gamePath, 'utf8')), 'utf8');
    verifyPatchedSources(
        fs.readFileSync(dungeonBlitzPath, 'utf8'),
        fs.readFileSync(crashWindowPath, 'utf8'),
        fs.readFileSync(gamePath, 'utf8'),
        inputSwfPath
    );

    runFfdec(ffdecPath, ['-importScript', inputSwfPath, patchedSwfPath, scriptsDir]);
    fs.copyFileSync(patchedSwfPath, outputSwfPath);
    console.log(`Built single SWF at ${outputSwfPath}`);
}

function verifySwf(repoRoot, ffdecPath, swfPath) {
    const workRoot = path.join(repoRoot, 'build', 'ffdec-dungeonblitz-single-swf-verify');
    const { dungeonBlitzPath, crashWindowPath, gamePath } = exportScripts(ffdecPath, workRoot, swfPath);
    verifyPatchedSources(
        fs.readFileSync(dungeonBlitzPath, 'utf8'),
        fs.readFileSync(crashWindowPath, 'utf8'),
        fs.readFileSync(gamePath, 'utf8'),
        swfPath
    );
    console.log(`Verified single SWF host switching in ${swfPath}`);
}

function main() {
    const repoRoot = resolveRepoRoot();
    const args = parseArgs(process.argv);
    const ffdecPath = detectFfdec(repoRoot, args.ffdec);
    const inputSwfPath = resolveInputSwfPath(repoRoot, args.input);
    const outputSwfPath = resolvePath(repoRoot, args.output);

    if (!ffdecPath) {
        throw new Error('FFDec not found. Pass --ffdec or install JPEXS FFDec.');
    }
    if (!fs.existsSync(inputSwfPath)) {
        throw new Error(`Input SWF not found: ${inputSwfPath}`);
    }

    if (args.verify) {
        if (!fs.existsSync(outputSwfPath)) {
            throw new Error(`Output SWF not found: ${outputSwfPath}`);
        }
        verifySwf(repoRoot, ffdecPath, outputSwfPath);
        return;
    }

    buildSingleSwf(repoRoot, ffdecPath, inputSwfPath, outputSwfPath);
}

try {
    main();
} catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
}
