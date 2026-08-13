#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/**
 * Nothing the player presses fires while a cutscene is running -- only movement.
 *
 * Skills, the pet key and the mount key are all the same thing underneath: every one of them is a
 * PowerType parked in hudPowers (mount is PowerType.var_440, pet is SummonPet or VanityPet), and
 * pressing any of them casts through CombatState.method_51. One refusal there covers all three,
 * which is why this is a single guard rather than three.
 *
 * Movement is untouched because movement is not a cast -- it never reaches this method. Emotes are
 * not casts either, so cheer and wave keep working, which is what was asked for.
 *
 * Gated on the local player. method_51 runs for every entity, and a cutscene is exactly when the
 * NPCs in it are performing -- an ungated refusal would freeze the actors and the skit with them.
 * `this.var_1.clientEntID == this.var_3.id` is the same local-player test the Sentinel fury block
 * uses a few hundred lines down.
 *
 * `InActiveCutScene()` is the game's own answer to "is a cutscene running", not a reconstruction of
 * one: Entity defines it from the room's own state and Brain, Buff, class_60, class_174 and
 * CombatState itself already branch on it. Using it means this agrees with the engine by
 * construction, including on whatever edge cases the room state already handles.
 *
 * Returning false rather than swallowing the cast later is the whole point of doing this
 * client-side. The server can only drop the packet after the client has already spent the mana and
 * started the cooldown, which is what "the skill did nothing" looked like in issue #668. Refusing
 * at method_51 means the press costs nothing at all.
 *
 * Engine-driven casts on the local player are refused too for the duration -- an auto-exit from
 * Sentinel Form, say. That is a deliberate consequence: during a cutscene nothing of the player's
 * should be going off, and the alternative is a flag that distinguishes input from engine, which
 * this class does not carry.
 */

const TARGET_SWF = path.join('src', 'client', 'content', 'localhost', 'p', 'cbp', 'DungeonBlitz.swf');

const ANCHOR = [
    '         var _loc20_:uint = 0;',
    '         if(this.var_3.entState == Entity.const_6 || this.var_683 || this.var_445)',
    '         {',
    '            return false;',
    '         }',
    ''
].join('\n');

const PATCHED = [
    '         var _loc20_:uint = 0;',
    '         if(Boolean(this.var_1) && Boolean(this.var_3) && this.var_1.clientEntID == this.var_3.id && this.var_3.InActiveCutScene())',
    '         {',
    '            return false;',
    '         }',
    '         if(this.var_3.entState == Entity.const_6 || this.var_683 || this.var_445)',
    '         {',
    '            return false;',
    '         }',
    ''
].join('\n');

function parseArgs(argv) {
    const args = { ffdec: '', swf: '', verify: false };
    for (let i = 2; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--ffdec' || arg === '-f') { args.ffdec = argv[++i] || ''; continue; }
        if (arg === '--swf' || arg === '-s') { args.swf = argv[++i] || ''; continue; }
        if (arg === '--verify') { args.verify = true; continue; }
        throw new Error(`Unknown argument: ${arg}`);
    }
    return args;
}

function repoRoot() {
    return path.resolve(__dirname, '..', '..', '..');
}

function detectFfdec(root, override) {
    return [
        override,
        process.env.FFDEC_PATH,
        path.join(root, 'build', 'ffdec', 'ffdec.sh'),
        path.join(root, 'build', 'ffdec', 'ffdec.jar'),
        path.join(root, 'build', 'ffdec', 'ffdec-cli.jar'),
        '/Applications/FFDec.app/Contents/Resources/ffdec.sh',
        '/Applications/FFDec.app/Contents/Resources/ffdec.jar'
    ].find((c) => c && fs.existsSync(c)) || '';
}

function runFfdec(ffdecPath, args) {
    const resolved = path.resolve(ffdecPath);
    if (path.basename(resolved).toLowerCase().endsWith('.jar')) {
        execFileSync('java', ['-jar', resolved, '-cli', ...args], { stdio: 'inherit' });
        return;
    }
    execFileSync(resolved, ['-cli', ...args], { stdio: 'inherit' });
}

function exportCombatState(ffdecPath, workRoot, swfPath) {
    fs.rmSync(workRoot, { recursive: true, force: true });
    fs.mkdirSync(workRoot, { recursive: true });
    runFfdec(ffdecPath, ['-selectclass', 'CombatState', '-export', 'script', workRoot, swfPath]);
    const classPath = path.join(workRoot, 'scripts', 'CombatState.as');
    if (!fs.existsSync(classPath)) throw new Error(`FFDec export did not produce ${classPath}`);
    return classPath;
}

function patchSource(source, swfPath) {
    const next = source.replace(/\r\n/g, '\n');
    const name = path.basename(swfPath);

    if (next.includes('§§goto')) {
        throw new Error(`${name}: CombatState is uncompilable (§§goto). Repair that before patching.`);
    }
    if (next.includes('this.var_3.InActiveCutScene())\n         {\n            return false;')) {
        return next;
    }
    if (!next.includes(ANCHOR)) {
        throw new Error(`${name}: CombatState.method_51 does not open the way this patch expects.`);
    }
    return next.replace(ANCHOR, PATCHED);
}

function verifySource(source, swfPath) {
    const next = source.replace(/\r\n/g, '\n');
    const name = path.basename(swfPath);
    if (!next.includes('this.var_1.clientEntID == this.var_3.id && this.var_3.InActiveCutScene()')) {
        throw new Error(`${name} is missing the cutscene input lock.`);
    }
    if (next.includes('§§goto')) {
        throw new Error(`${name}: CombatState is uncompilable again -- a §§goto is back.`);
    }
    console.log(`Verified cutscene input lock in ${swfPath}`);
}

function main() {
    const root = repoRoot();
    const args = parseArgs(process.argv);
    const swfPath = path.resolve(root, args.swf || TARGET_SWF);
    const ffdecPath = detectFfdec(root, args.ffdec);

    if (!ffdecPath) throw new Error('FFDec not found. Pass --ffdec or install JPEXS FFDec.');
    if (!fs.existsSync(swfPath)) throw new Error(`SWF not found: ${swfPath}`);

    const workRoot = path.join(root, 'build', args.verify ? 'ffdec-cutscene-lock-verify' : 'ffdec-cutscene-lock');
    const classPath = exportCombatState(ffdecPath, workRoot, swfPath);

    if (args.verify) {
        verifySource(fs.readFileSync(classPath, 'utf8'), swfPath);
        return;
    }

    fs.writeFileSync(classPath, patchSource(fs.readFileSync(classPath, 'utf8'), swfPath));

    const patchedSwfPath = path.join(workRoot, `${path.basename(swfPath, path.extname(swfPath))}.patched.swf`);
    runFfdec(ffdecPath, ['-importScript', swfPath, patchedSwfPath, path.dirname(classPath)]);
    if (!fs.existsSync(`${swfPath}.bak`)) fs.copyFileSync(swfPath, `${swfPath}.bak`);
    fs.copyFileSync(patchedSwfPath, swfPath);
    console.log(`Patched cutscene input lock in ${swfPath}`);
    console.log(
        'NOTE: recompiling CombatState rebuilds the ABC constant pool. Re-run\n' +
        '      patch-dungeonblitz-forge-charm-durations.ts and the CombatState byte patches afterwards.'
    );
}

main();
