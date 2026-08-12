#!/usr/bin/env node

/**
 * Chat history recall.
 *
 * class_127 already keeps every message the player sent in var_1055 and tracks a cursor in
 * var_883, but the COMMAND2_SCROLLUP / COMMAND2_SCROLLDOWN handlers were shipped with their
 * arguments nulled out (`method_566(null)` / `BeginChat(null)`), so recall never put anything
 * back into the chat entry. This patch:
 *
 *   1. restores those two handlers so they refill the chat entry from the sent-message history,
 *   2. adds a stage-level KEY_DOWN hook so the numpad keys walk that history from anywhere,
 *      opening the chat entry if it is closed: NUMPAD_8 (up, keyCode 104) steps toward the older
 *      end, NUMPAD_2 (down, keyCode 98) toward the newer one.
 *
 * var_883 rests one past the end after a send, and method_9113 clamps into [0, length-1], so the
 * first press of either key lands on the most recently sent message. From there up keeps walking
 * back through older messages and down returns toward the newest -- the shell convention, and
 * what issue #668's sibling report #667 asks for. This shipped inverted: up ran toward the newest
 * message, which meant the very first press already sat at the clamp and up did nothing at all.
 *
 * The recall is applied one frame later rather than inside the key handler, because Flash still
 * inserts the "8" character into the focused TextField after KEY_DOWN; overwriting the whole entry
 * on the following frame is what keeps the recalled text clean. That deferral rides an
 * ENTER_FRAME listener registered only while a recall is pending, not the chat screen's own tick,
 * so it still fires while a full-screen UI such as the inventory is up -- which is exactly when a
 * message built from a shared item link gets recalled.
 *
 * Shared item links survive the round trip because history stores the raw form: method_731 runs
 * method_1478 first, turning the entry's "[Sword]" display text back into its "{gear:...}" token
 * before pushing to var_1055. Recall runs method_566 over that token, which re-resolves the
 * display text and re-registers the pair through AddItemInfoToChatEntry, so pressing enter on a
 * recalled message links the item again rather than sending literal text.
 *
 * method_566 is lossy, though, and that is what made recall look dead for messages that start
 * with "{": it drops any {...} it cannot resolve, because the resolve branch has no else. A
 * token the client cannot parse -- a malformed one such as the doubled-brace
 * "{{IqzYlypNBN:MaceImp29L:...}" the chat renders raw, or a gear type that is gone -- therefore
 * expands to the empty string, and BeginChat("") is a no-op, so nothing comes back. When nothing
 * resolved, this falls back to the raw history entry so the message is always recoverable and
 * the player can edit or resend it.
 */

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
            '  node src/server/scripts/patch-dungeonblitz-chat-history-recall.js [--verify] [--swf <path>] [--ffdec <path>]',
            '',
            'Defaults:',
            '  patches class_127 in the served DungeonBlitz SWF so the numpad up key (NUMPAD_8)',
            '  steps to the previous sent chat message and the numpad down key (NUMPAD_2) to the',
            '  next one, and so the existing chat scroll-up / scroll-down commands actually',
            '  refill the chat entry.'
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
        'C:\\Program Files (x86)\\FFDec\\ffdec-cli.exe',
        'C:\\Program Files\\FFDec\\ffdec-cli.exe',
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

    if (basename.endsWith('.exe')) {
        execFileSync(resolved, args, {
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

const RECALL_HELPERS = [
    '      private function method_9110() : void',
    '      {',
    '         var _loc1_:Stage = null;',
    '         if(this.var_9101)',
    '         {',
    '            return;',
    '         }',
    '         if(!var_2)',
    '         {',
    '            return;',
    '         }',
    '         _loc1_ = var_2.stage;',
    '         if(!_loc1_)',
    '         {',
    '            return;',
    '         }',
    '         _loc1_.addEventListener(KeyboardEvent.KEY_DOWN,this.method_9112,false,0,false);',
    '         this.var_9101 = _loc1_;',
    '      }',
    '      ',
    '      private function method_9111() : void',
    '      {',
    '         if(!this.var_9101)',
    '         {',
    '            return;',
    '         }',
    '         this.var_9101.removeEventListener(KeyboardEvent.KEY_DOWN,this.method_9112,false);',
    '         if(this.var_9103)',
    '         {',
    '            this.var_9101.removeEventListener(Event.ENTER_FRAME,this.method_9114,false);',
    '            this.var_9103 = false;',
    '         }',
    '         this.var_9101 = null;',
    '      }',
    '      ',
    '      private function method_9112(param1:KeyboardEvent) : void',
    '      {',
    '         var _loc2_:int = 0;',
    '         if(!param1)',
    '         {',
    '            return;',
    '         }',
    '         if(param1.keyCode == Keyboard.NUMPAD_8)',
    '         {',
    '            _loc2_ = -1;',
    '         }',
    '         else if(param1.keyCode == Keyboard.NUMPAD_2)',
    '         {',
    '            _loc2_ = 1;',
    '         }',
    '         else',
    '         {',
    '            return;',
    '         }',
    '         if(Boolean(var_1) && Boolean(var_1.screenKeybind) && var_1.screenKeybind.mbVisible)',
    '         {',
    '            return;',
    '         }',
    '         this.var_9102 = this.var_9102 + _loc2_;',
    '         if(Boolean(this.var_9101) && !this.var_9103)',
    '         {',
    '            this.var_9101.addEventListener(Event.ENTER_FRAME,this.method_9114,false,0,false);',
    '            this.var_9103 = true;',
    '         }',
    '      }',
    '      ',
    '      private function method_9114(param1:Event) : void',
    '      {',
    '         var _loc2_:int = 0;',
    '         if(this.var_9103 && Boolean(this.var_9101))',
    '         {',
    '            this.var_9101.removeEventListener(Event.ENTER_FRAME,this.method_9114,false);',
    '         }',
    '         this.var_9103 = false;',
    '         if(this.var_9102 == 0)',
    '         {',
    '            return;',
    '         }',
    '         _loc2_ = this.var_9102;',
    '         this.var_9102 = 0;',
    '         this.method_9113(_loc2_);',
    '      }',
    '      ',
    '      private function method_9113(param1:int) : void',
    '      {',
    '         var _loc2_:int = 0;',
    '         var _loc3_:String = null;',
    '         var _loc4_:String = null;',
    '         if(param1 == 0 || !var_2 || !this.var_1055 || !this.var_1055.length)',
    '         {',
    '            return;',
    '         }',
    '         _loc2_ = int(this.var_883) + param1;',
    '         if(_loc2_ < 0)',
    '         {',
    '            _loc2_ = 0;',
    '         }',
    '         if(_loc2_ > int(this.var_1055.length) - 1)',
    '         {',
    '            _loc2_ = int(this.var_1055.length) - 1;',
    '         }',
    '         _loc3_ = this.var_1055[_loc2_];',
    '         if(!_loc3_)',
    '         {',
    '            return;',
    '         }',
    '         this.var_883 = uint(_loc2_);',
    '         var_2.am_ChatEntry.removeEventListener(TextEvent.TEXT_INPUT,this.method_381);',
    '         this.var_232 = new Array();',
    '         this.var_506 = new Array();',
    '         var_2.am_ChatEntry.text = "";',
    '         _loc4_ = this.method_566(_loc3_);',
    '         if(!this.var_506.length && _loc3_.indexOf("{") > -1)',
    '         {',
    '            var_2.am_ChatEntry.removeEventListener(TextEvent.TEXT_INPUT,this.method_381);',
    '            this.var_232 = new Array();',
    '            this.var_506 = new Array();',
    '            _loc4_ = _loc3_;',
    '         }',
    '         if(!_loc4_)',
    '         {',
    '            _loc4_ = _loc3_;',
    '         }',
    '         this.BeginChat(_loc4_);',
    '      }',
    '      ',
    '      '
].join('\n');

// Same mapping as the numpad: up walks toward the older end of the history, down toward the
// newer end.
const PATCHED_SCROLL_CASES = [
    '               case Game.COMMAND2_SCROLLUP:',
    '                  this.method_9113(-1);',
    '                  return true;',
    '               case Game.COMMAND2_SCROLLDOWN:',
    '                  this.method_9113(1);',
    '                  return true;'
].join('\n');

const PATCHED_TICK = [
    'override public function OnTickScreen() : void',
    '      {',
    '         this.method_9110();',
    '         this.method_844();',
    '      }'
].join('\n');

function patchImports(source, swfPath) {
    if (!source.includes('import flash.display.Stage;')) {
        if (!source.includes('   import flash.display.MovieClip;')) {
            throw new Error(`${path.basename(swfPath)} has an unexpected class_127 import block.`);
        }
        source = source.replace(
            '   import flash.display.MovieClip;',
            '   import flash.display.MovieClip;\n   import flash.display.Stage;'
        );
    }

    if (!source.includes('import flash.events.KeyboardEvent;')) {
        if (!source.includes('   import flash.events.FocusEvent;')) {
            throw new Error(`${path.basename(swfPath)} is missing the FocusEvent import anchor.`);
        }
        source = source.replace(
            '   import flash.events.FocusEvent;',
            '   import flash.events.FocusEvent;\n   import flash.events.KeyboardEvent;'
        );
    }

    if (!source.includes('import flash.ui.Keyboard;')) {
        if (!source.includes('   import flash.utils.Dictionary;')) {
            throw new Error(`${path.basename(swfPath)} is missing the Dictionary import anchor.`);
        }
        source = source.replace(
            '   import flash.utils.Dictionary;',
            '   import flash.ui.Keyboard;\n   import flash.utils.Dictionary;'
        );
    }

    return source;
}

function patchFields(source, swfPath) {
    if (source.includes('internal var var_9101:Stage')) {
        return source;
    }

    const anchor = '      internal var var_883:uint = 0;';
    if (!source.includes(anchor)) {
        throw new Error(`${path.basename(swfPath)} has an unexpected chat history cursor field.`);
    }

    return source.replace(
        anchor,
        [
            anchor,
            '      ',
            '      internal var var_9101:Stage = null;',
            '      ',
            '      internal var var_9102:int = 0;',
            '      ',
            '      internal var var_9103:Boolean = false;'
        ].join('\n')
    );
}

function patchFieldsUpgrade(source) {
    if (source.includes('internal var var_9103:Boolean')) {
        return source;
    }

    const anchor = '      internal var var_9102:int = 0;';
    if (!source.includes(anchor)) {
        return source;
    }

    return source.replace(anchor, `${anchor}\n      \n      internal var var_9103:Boolean = false;`);
}

/**
 * The helper block is always re-injected from scratch, so an SWF carrying an older revision of
 * this patch upgrades cleanly. Everything between method_9110 and the method_731 anchor is ours
 * by construction, which makes the region safe to cut.
 */
function stripPreviousHelpers(source, swfPath) {
    const start = source.indexOf('      private function method_9110() : void');
    if (start === -1) {
        return source;
    }

    const anchor = source.indexOf('      public function method_731() : void', start);
    if (anchor === -1) {
        throw new Error(`${path.basename(swfPath)} has a recall helper block with no method_731 anchor after it.`);
    }

    return source.slice(0, start) + source.slice(anchor);
}

function patchHelpers(source, swfPath) {
    source = stripPreviousHelpers(source, swfPath);

    const anchor = '      public function method_731() : void';
    if (!source.includes(anchor)) {
        throw new Error(`${path.basename(swfPath)} has an unexpected chat send method.`);
    }

    return source.replace(anchor, `${RECALL_HELPERS}${anchor}`);
}

function patchScrollCases(source, swfPath) {
    if (source.includes(PATCHED_SCROLL_CASES)) {
        return source;
    }

    // Matches both the shipped block and an earlier revision of this patch that still wired
    // scroll-down to a recall.
    const pattern = /               case Game\.COMMAND2_SCROLLUP:\r?\n(?:.*\r?\n)*?                  return true;\r?\n               case Game\.COMMAND2_SCROLLDOWN:\r?\n(?:.*\r?\n)*?                  return true;/;
    if (!pattern.test(source)) {
        throw new Error(`${path.basename(swfPath)} has an unexpected chat scroll command block.`);
    }

    return source.replace(pattern, PATCHED_SCROLL_CASES);
}

function patchTick(source, swfPath) {
    // Drop any calls a previous revision injected so the original block matches again.
    source = source.replace(/^ *this\.method_9114\(\);\r?\n/m, '');
    source = source.replace(/^ *this\.method_9110\(\);\r?\n/m, '');

    const pattern = /override public function OnTickScreen\(\) : void\r?\n      \{\r?\n         this\.method_844\(\);\r?\n      \}/;
    if (!pattern.test(source)) {
        throw new Error(`${path.basename(swfPath)} has an unexpected OnTickScreen block.`);
    }

    return source.replace(pattern, PATCHED_TICK);
}

function patchDestroy(source, swfPath) {
    if (source.includes('this.method_9111();')) {
        return source;
    }

    const anchor = 'override public function OnDestroyScreen() : void\n      {\n';
    const crlfAnchor = 'override public function OnDestroyScreen() : void\r\n      {\r\n';
    if (source.includes(crlfAnchor)) {
        return source.replace(crlfAnchor, `${crlfAnchor}         this.method_9111();\r\n`);
    }
    if (source.includes(anchor)) {
        return source.replace(anchor, `${anchor}         this.method_9111();\n`);
    }

    throw new Error(`${path.basename(swfPath)} has an unexpected OnDestroyScreen block.`);
}

function patchClass127Source(source, swfPath) {
    source = patchImports(source, swfPath);
    source = patchFields(source, swfPath);
    source = patchFieldsUpgrade(source);
    source = patchHelpers(source, swfPath);
    source = patchScrollCases(source, swfPath);
    source = patchTick(source, swfPath);
    source = patchDestroy(source, swfPath);
    return source;
}

function verifyPatchedClass127(source, swfPath) {
    const required = [
        ['import flash.ui.Keyboard;', 'the Keyboard import'],
        ['import flash.events.KeyboardEvent;', 'the KeyboardEvent import'],
        ['import flash.display.Stage;', 'the Stage import'],
        ['internal var var_9101:Stage = null;', 'the recall listener field'],
        ['internal var var_9102:int = 0;', 'the pending recall counter'],
        ['internal var var_9103:Boolean = false;', 'the pending-frame flag'],
        ['private function method_9114(param1:Event) : void', 'the frame-deferred recall apply'],
        ['this.var_9101.addEventListener(Event.ENTER_FRAME,this.method_9114,false,0,false);', 'the deferred apply scheduling'],
        // The decompiler is free to flip an else-if into a negated early return, so these only
        // assert that both keys are read and that each direction is still assigned.
        ['Keyboard.NUMPAD_8', 'the numpad up key check'],
        ['Keyboard.NUMPAD_2', 'the numpad down key check'],
        ['_loc2_ = 1;', 'the newer-direction step'],
        ['_loc2_ = -1;', 'the older-direction step'],
        ['_loc1_.addEventListener(KeyboardEvent.KEY_DOWN,this.method_9112,false,0,false);', 'the stage key listener'],
        ['this.var_9101.removeEventListener(KeyboardEvent.KEY_DOWN,this.method_9112,false);', 'the stage key listener teardown'],
        ['private function method_9113(param1:int) : void', 'the chat history recall helper'],
        ['_loc4_ = this.method_566(_loc3_);', 'the recalled-message item-link expansion'],
        ['if(!this.var_506.length && _loc3_.indexOf("{") > -1)', 'the unresolved-token fallback guard'],
        ['this.BeginChat(_loc4_);', 'the recalled-message chat entry refill'],
        ['this.method_9113(-1);', 'the scroll-up recall wiring'],
        ['this.method_9113(1);', 'the scroll-down recall wiring'],
        ['this.method_9110();', 'the tick-time listener attach'],
        ['this.method_9111();', 'the destroy-time listener detach']
    ];

    for (const [needle, description] of required) {
        if (!source.includes(needle)) {
            throw new Error(`${path.basename(swfPath)} is missing ${description}.`);
        }
    }

    if (/case Game\.COMMAND2_SCROLLUP:\r?\n\s*if\(this\.var_883 > 0\)/.test(source)) {
        throw new Error(`${path.basename(swfPath)} still has the dead chat scroll-up handler.`);
    }

    if (!PATCHED_SCROLL_CASES.split('\n').every((line) => source.includes(line.trim()))) {
        throw new Error(`${path.basename(swfPath)} has an unexpected chat scroll command block.`);
    }

    if (!/case Game\.COMMAND2_SCROLLUP:\r?\n\s*this\.method_9113\(-1\);/.test(source)) {
        throw new Error(`${path.basename(swfPath)} does not walk to the previous message on the up key.`);
    }
}

function patchSwf(repoRoot, ffdecPath, swfPath) {
    const workRoot = path.join(
        repoRoot,
        'build',
        'ffdec-dungeonblitz-chat-history-recall',
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
    console.log(`Patched chat history recall in ${swfPath}`);
}

function verifySwf(repoRoot, ffdecPath, swfPath) {
    const workRoot = path.join(
        repoRoot,
        'build',
        'ffdec-dungeonblitz-chat-history-recall-verify',
        path.basename(swfPath, path.extname(swfPath))
    );
    const classPath = exportClass127(ffdecPath, workRoot, swfPath);
    verifyPatchedClass127(fs.readFileSync(classPath, 'utf8'), swfPath);
    console.log(`Verified chat history recall in ${swfPath}`);
}

function main() {
    const repoRoot = resolveRepoRoot();
    const args = parseArgs(process.argv);
    const ffdecPath = detectFfdec(repoRoot, args.ffdec);

    if (!ffdecPath) {
        throw new Error('FFDec not found. Pass --ffdec or install JPEXS FFDec.');
    }

    const requestedSwfs = (args.swfs.length ? args.swfs : TARGETS.map((target) => target.swf)).map((entry) => resolvePath(repoRoot, entry));
    const selectedTargets = [...new Set(requestedSwfs)].map((swfPath) => ({ swfPath }));

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
