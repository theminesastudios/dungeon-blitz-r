#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/**
 * Sentinel Form is locked out for 30 seconds from the moment the Sentinel leaves it.
 *
 * The form already had a cooldown and it already started at the cast: CombatState.method_51
 * stamps `var_114[powerID] = now + coolDownTime` when the power goes off, method_414 refuses a
 * recast while that stamp is in the future, and nothing anywhere clears it -- cancelling is a
 * cast of EndSentinelForm, which is a different powerID with CoolDownTime 0, so it cannot wipe
 * the form's stamp either.
 *
 * What broke it is that the form has no Duration. Its buff authors Duration 0 because the form
 * is not on a timer at all -- CombatState drops it when the next swing costs more mana than the
 * Sentinel has left -- and the per-swing cost has since been cut twice, by
 * patch_gameswz_form_stance_balance and again by patch_gameswz_paladin_mastery_balance, down to
 * 3 mana at rank 10. A form that now runs for minutes outlives its own 30-second cooldown, so by
 * the time the Sentinel drops out of it the stamp has long expired and they can transform again
 * on the same frame. From the player's seat that reads as no cooldown at all.
 *
 * So the cast-time stamp is not enough on its own, and this re-stamps the form power when the
 * form ENDS. Both exits run through EndSentinelForm and both are here:
 *
 *   manual cancel    the hotbar slot holds EndSentinelForm while the buff is up (BuffType sets
 *                    var_611/var_1251), so pressing it casts through method_51.
 *   mana ran out     CombatState's per-tick check casts the same power through method_46, which
 *                    is also the path taken when the Sentinel dies in form.
 *
 * Every rank is stamped, not the one rank the Sentinel actually holds. var_114 is keyed per power
 * id and SentinelForm1..10 are ten separate powers, so the lockout has to name the right one --
 * and the first cut of this read the rank from combatState.var_498, which is where
 * Entity.method_247 parks it. That field is shared with the other stances, is zeroed when a form
 * ends, and method_247's control flow is obfuscated past the point where the rank write can be
 * proven to run for the local player. If it is ever 0 or stale here, the lockout lands on
 * SentinelForm1 while a rank 10 Sentinel re-transforms freely -- the exact bug this patch exists
 * to fix, silently reintroduced.
 *
 * A player only ever holds one rank, so stamping all ten costs nothing and depends on nothing.
 *
 * CombatState has to be decompiled and recompiled for this: it needs a new method plus two new
 * statements, which no in-place byte splice can express.
 */

const TARGET_SWF = path.join('src', 'client', 'content', 'localhost', 'p', 'cbp', 'DungeonBlitz.swf');
const LOCKOUT_MS = 30000;

// method_51: every player cast, including the hotbar press that cancels the form.
const CAST_ANCHOR = '         this.var_114[param1.powerID] = _loc5_ + param1.coolDownTime + _loc11_;\n';
// method_46: the engine-driven cast that ends the form when mana runs out or the Sentinel dies.
const AUTO_ANCHOR = '         this.var_114[param1.powerID] = this.var_1.mTimeThisTick + param1.coolDownTime + _loc6_;\n';
const HELPER_ANCHOR = '      public function method_749(param1:PowerType) : void\n';

/**
 * The buff going away is what "returning to normal form" actually means, so the lockout hangs off
 * that too, not only off the cancel cast.
 *
 * The two cast hooks below cover the ways out that go through EndSentinelForm, which is every way
 * a Sentinel normally leaves the form. This covers the rest by construction -- a dispel, a zone
 * change dropping buffs, anything that reaches RemoveBuff -- without needing each one enumerated
 * and proven. Stamping is idempotent (the helper never shortens an existing lockout), so the
 * overlap with the cast hooks costs nothing.
 *
 * "SigilSentinelArmor" is removed on the same power and deliberately does not match: the prefix
 * test is anchored at 0 and that name starts with "Sigil".
 */
const REMOVE_BUFF_ANCHOR = [
    '      public function RemoveBuff(param1:BuffType) : void',
    '      {',
    '         var _loc2_:Buff = this.method_135(param1);',
    '         if(_loc2_)',
    '         {',
    '            _loc2_.method_534();',
    '            _loc2_.method_258();',
    '            this.var_84.splice(this.var_84.indexOf(_loc2_),1);',
    '            this.var_555 = true;',
    ''
].join('\n');

/**
 * The reason the form never had a working cooldown, and why hooks alone could not give it one.
 *
 * Entity.method_247's form-off branch already stamps the lockout the way this whole change wants:
 *
 *     var_114[SentinelForm<rank>.powerID] = mTimeThisTick + coolDownTime;
 *     method_390(SentinelForm<rank>, 0.75 * (var_31 / const_156));   // 0.75 x mana fraction
 *
 * and then method_390 throws it away. It writes `0 + (1 - param2) * coolDownTime` -- an absolute
 * timestamp, where every other write to var_114 in the codebase is `mTimeThisTick + ...`. Against
 * getTimer(), which is hundreds of thousands of milliseconds into a session, a value that can never
 * exceed coolDownTime is always in the past, so method_414's `now < var_114[id]` test never holds
 * and the form is instantly recastable. That is an authored bug, not something the rebalance
 * introduced, and it fires at any mana level -- the mana fraction only decides how far into the
 * past the stamp lands.
 *
 * It also runs after every hook this patch installs: method_247 resolves when the EndSentinelForm
 * ActivePower completes, which is after the cast started, after the auto-end cast, and after
 * RemoveBuff. So the three stamps below were all being overwritten a few hundred ms later.
 *
 * Excluding the form from method_390 leaves method_247's own `mTimeThisTick + coolDownTime` stamp
 * standing, which is exactly the requested rule: 30 seconds from returning to normal form.
 *
 * Scoped to Sentinel Form rather than fixing the `0 +`. The only other caller is the Blademaster
 * path (var_1586, hudPowers 4-6), where the same bug currently turns "reduce this cooldown" into
 * "clear it outright". Repairing that is a real balance change to another class and belongs in its
 * own decision, not smuggled in here.
 */
const REDUCE_ANCHOR = [
    '      public function method_390(param1:PowerType, param2:Number) : void',
    '      {',
    '         var _loc3_:uint = 0;',
    ''
].join('\n');

const REDUCE_GUARD = [
    '         if(param1.basePowerName == "SentinelForm")',
    '         {',
    '            return;',
    '         }',
    ''
].join('\n');

const REMOVE_BUFF_GUARD = [
    '            if(param1.buffName.indexOf("SentinelForm") == 0)',
    '            {',
    '               this.sentinelFormExitCooldown();',
    '            }',
    ''
].join('\n');

const GUARD = [
    '         if(param1.basePowerName == "EndSentinelForm")',
    '         {',
    '            this.sentinelFormExitCooldown();',
    '         }',
    ''
].join('\n');

// The first cut of this helper, kept so an already-patched SWF upgrades in place instead of
// being skipped as "already done". Drop it once no working copy carries it.
const LEGACY_HELPER = [
    '      public function sentinelFormExitCooldown() : void',
    '      {',
    '         var _sfRank:int = this.var_498 > 0 ? this.var_498 : 1;',
    '         var _sfPower:PowerType = class_14.powerTypesDict["SentinelForm" + _sfRank];',
    '         if(Boolean(_sfPower))',
    '         {',
    '            this.var_114[_sfPower.powerID] = this.var_1.mTimeThisTick + ' + LOCKOUT_MS + ';',
    '         }',
    '      }'
].join('\n');

/**
 * uint() around the read, not a bare `<`: var_114 holds nothing at all for a rank that has never
 * been cast, and in AS3 `undefined < 30000` is false, so a bare comparison would skip exactly the
 * ranks that most need stamping. method_390 already reads the dictionary through uint() for the
 * same reason.
 *
 * Never shortens an existing stamp -- a form cancelled two seconds in is still inside the
 * cast-time cooldown, and that one runs longer.
 */
const HELPER_BODY = [
    '      public function sentinelFormExitCooldown() : void',
    '      {',
    '         var _sfRank:int = 0;',
    '         var _sfPower:PowerType = null;',
    '         var _sfReadyAt:uint = this.var_1.mTimeThisTick + ' + LOCKOUT_MS + ';',
    '         for(_sfRank = 0; _sfRank <= 10; _sfRank++)',
    '         {',
    '            _sfPower = class_14.powerTypesDict[_sfRank > 0 ? "SentinelForm" + _sfRank : "SentinelForm"];',
    '            if(Boolean(_sfPower) && uint(this.var_114[_sfPower.powerID]) < _sfReadyAt)',
    '            {',
    '               this.var_114[_sfPower.powerID] = _sfReadyAt;',
    '            }',
    '         }',
    '      }'
].join('\n');

const HELPER = HELPER_BODY + '\n      \n';

function parseArgs(argv) {
    const args = { ffdec: '', swf: TARGET_SWF, verify: false, syncRevOnly: false };
    for (let index = 2; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--ffdec' || arg === '-f') { args.ffdec = argv[++index] || ''; continue; }
        if (arg === '--swf' || arg === '-s') { args.swf = argv[++index] || ''; continue; }
        if (arg === '--verify' || arg === '--dry-run') { args.verify = true; continue; }
        if (arg === '--sync-rev') { args.syncRevOnly = true; continue; }
        if (arg === '--help' || arg === '-h') {
            console.log([
                'Usage:',
                '  node src/server/scripts/patch-dungeonblitz-sentinel-form-exit-cooldown.js [--verify] [--sync-rev] [--swf <path>] [--ffdec <path>]',
                '',
                '  --sync-rev  only repoint index.html at the SWF currently on disk. Run this last,',
                '              after every script that writes DungeonBlitz.swf, or players keep',
                '              loading the cached copy.',
                '',
                `Locks Sentinel Form for ${LOCKOUT_MS / 1000}s from the moment the form ends, however it ends.`
            ].join('\n'));
            process.exit(0);
        }
        throw new Error(`Unknown argument: ${arg}`);
    }
    return args;
}

function repoRoot() { return path.resolve(__dirname, '..', '..', '..'); }

const DEFAULT_SWF_ABS = path.resolve(__dirname, '..', '..', 'client', 'content', 'localhost', 'p', 'cbp', 'DungeonBlitz.swf');
const INDEX_HTML = path.resolve(__dirname, '..', '..', 'client', 'content', 'localhost', 'index.html');

/**
 * index.html requests the SWF at a fixed `clientrev=` token, so patching the file on disk changes
 * nothing a player ever loads: same URL, so the browser and the Flash plugin keep serving the copy
 * they already cached. Every fix in this SWF is invisible until the token moves.
 *
 * That is not hypothetical -- it is how three rounds of "the cooldown still does not apply" went by
 * with a correctly patched SWF sitting on disk. Pin the token to the SWF's content hash, which is
 * also what StaticServer.clientRevision derives independently, so the page and the server agree
 * with no manual step.
 *
 * The same routine lives in patch-dungeonblitz-pet-fetches-loot.ts. Any script that writes this
 * SWF needs it; if a third one appears, lift this into a shared helper.
 */
function syncClientRev(swfPath) {
    if (path.resolve(swfPath) !== DEFAULT_SWF_ABS || !fs.existsSync(INDEX_HTML)) {
        return;
    }
    const digest = crypto.createHash('sha1').update(fs.readFileSync(swfPath)).digest('hex').slice(0, 12);
    const html = fs.readFileSync(INDEX_HTML, 'utf8');
    // Stop at $ as well as & and the quotes: the token is followed by ${languageParam} in a
    // template literal, and swallowing that would drop the locale.
    const updated = html.replace(/clientrev=[^&`"'$]+/, `clientrev=swf-${digest}`);
    if (updated !== html) {
        fs.writeFileSync(INDEX_HTML, updated);
        console.log(`  index.html clientrev -> swf-${digest} (cache buster)`);
    }
}

/** True when index.html would make a browser load the SWF that is actually on disk. */
function clientRevIsCurrent(swfPath) {
    if (path.resolve(swfPath) !== DEFAULT_SWF_ABS || !fs.existsSync(INDEX_HTML)) {
        return true;
    }
    const digest = crypto.createHash('sha1').update(fs.readFileSync(swfPath)).digest('hex').slice(0, 12);
    return fs.readFileSync(INDEX_HTML, 'utf8').includes(`clientrev=swf-${digest}`);
}
function resolvePath(root, value) { return !value ? '' : (path.isAbsolute(value) ? value : path.join(root, value)); }

function detectFfdec(root, preferred) {
    const candidates = [];
    if (preferred) candidates.push(resolvePath(root, preferred));
    candidates.push(
        path.join(root, 'build', 'ffdec', 'ffdec.sh'),
        path.join(root, 'build', 'ffdec', 'ffdec.jar'),
        'C:\\Program Files (x86)\\FFDec\\ffdec.jar',
        'C:\\Program Files\\FFDec\\ffdec.jar',
        '/Applications/FFDec.app/Contents/Resources/ffdec.sh',
        '/Applications/FFDec.app/Contents/Resources/ffdec.jar'
    );
    return candidates.find((c) => c && fs.existsSync(c)) || '';
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
    let next = source.replace(/\r\n/g, '\n');
    const name = path.basename(swfPath);

    // Upgrade an SWF that carries some earlier cut of this patch: add whichever pieces it lacks.
    if (next.includes('_sfReadyAt')) {
        if (!next.includes(REMOVE_BUFF_GUARD)) {
            if (!next.includes(REMOVE_BUFF_ANCHOR)) {
                throw new Error(`${name}: CombatState.RemoveBuff does not open the way this patch expects.`);
            }
            next = next.replace(REMOVE_BUFF_ANCHOR, REMOVE_BUFF_ANCHOR + REMOVE_BUFF_GUARD);
        }
        if (!next.includes(REDUCE_GUARD)) {
            if (!next.includes(REDUCE_ANCHOR)) {
                throw new Error(`${name}: CombatState.method_390 does not open the way this patch expects.`);
            }
            next = next.replace(REDUCE_ANCHOR, REDUCE_ANCHOR + REDUCE_GUARD);
        }
        return next;
    }
    // An SWF carrying the rank-reading first cut keeps its two call sites; only the helper
    // they call is swapped.
    if (next.includes(LEGACY_HELPER)) {
        return next.replace(LEGACY_HELPER, HELPER_BODY);
    }
    if (next.includes('sentinelFormExitCooldown')) {
        throw new Error(`${name}: an unrecognised sentinelFormExitCooldown is already present; patch by hand.`);
    }
    for (const [anchor, where] of [[CAST_ANCHOR, 'method_51'], [AUTO_ANCHOR, 'method_46'], [HELPER_ANCHOR, 'method_749']]) {
        if (!next.includes(anchor)) {
            throw new Error(`${name}: CombatState.${where} does not open the way this patch expects.`);
        }
    }

    next = next.replace(CAST_ANCHOR, CAST_ANCHOR + GUARD);
    next = next.replace(AUTO_ANCHOR, AUTO_ANCHOR + GUARD);
    if (!next.includes(REMOVE_BUFF_ANCHOR)) {
        throw new Error(`${name}: CombatState.RemoveBuff does not open the way this patch expects.`);
    }
    next = next.replace(REMOVE_BUFF_ANCHOR, REMOVE_BUFF_ANCHOR + REMOVE_BUFF_GUARD);
    if (!next.includes(REDUCE_ANCHOR)) {
        throw new Error(`${name}: CombatState.method_390 does not open the way this patch expects.`);
    }
    next = next.replace(REDUCE_ANCHOR, REDUCE_ANCHOR + REDUCE_GUARD);
    return next.replace(HELPER_ANCHOR, HELPER + HELPER_ANCHOR);
}

function verifySource(source, swfPath) {
    source = source.replace(/\r\n/g, '\n');
    const required = [
        'public function sentinelFormExitCooldown() : void',
        `var _sfReadyAt:uint = this.var_1.mTimeThisTick + ${LOCKOUT_MS};`,
        // Matches both the source form and the `while` FFDec turns it back into on re-export.
        '_sfRank <= 10',
        'uint(this.var_114[_sfPower.powerID]) < _sfReadyAt',
        'this.var_114[_sfPower.powerID] = _sfReadyAt;'
    ];
    // The rank-reading first cut must not survive: it stamps SentinelForm1 whenever var_498 is
    // stale, which leaves every other rank with no lockout at all.
    if (source.includes('this.var_498 > 0 ? this.var_498 : 1')) {
        throw new Error(`${path.basename(swfPath)} still carries the rank-reading Sentinel Form lockout.`);
    }
    for (const snippet of required) {
        if (!source.includes(snippet)) {
            throw new Error(`${path.basename(swfPath)} is missing the Sentinel Form exit cooldown: ${snippet}`);
        }
    }
    // One guard is the manual cancel, the other is the mana-ran-out cast. Losing either one
    // leaves an exit that dodges the lockout, which is the whole bug this fixes.
    const guards = source.split('this.sentinelFormExitCooldown();').length - 1;
    if (guards !== 3) {
        throw new Error(
            `${path.basename(swfPath)} has ${guards} Sentinel Form exit hooks, expected 3 ` +
            '(method_51, method_46 and RemoveBuff).'
        );
    }
    if (!source.includes('if(param1.buffName.indexOf("SentinelForm") == 0)')) {
        throw new Error(`${path.basename(swfPath)} is missing the buff-removal Sentinel Form hook.`);
    }
    // Without this the lockout is wiped a few hundred ms after it is set, which is the state the
    // form shipped in. It is the one piece that actually makes the cooldown appear in game.
    if (!source.includes('if(param1.basePowerName == "SentinelForm")')) {
        throw new Error(
            `${path.basename(swfPath)} is missing the method_390 exclusion, so Entity.method_247 ` +
            'still wipes the Sentinel Form cooldown on exit.'
        );
    }
    // The other patches that share CombatState must have survived the recompile.
    if (!source.includes('_shroudPower')) {
        throw new Error(`${path.basename(swfPath)} lost the Midnight Shroud passive patch.`);
    }
    if (!source.includes('param3 = uint(param2.meleeDamage);')) {
        throw new Error(`${path.basename(swfPath)} lost the Viperblade passive scaling patch.`);
    }
    if (!source.includes('param2.maxHP * 0.3')) {
        throw new Error(`${path.basename(swfPath)} lost the Clutch Heal threshold patch.`);
    }
    console.log(`Verified Sentinel Form exit cooldown in ${swfPath}`);
}

function main() {
    const root = repoRoot();
    const args = parseArgs(process.argv);
    const swfPath = resolvePath(root, args.swf);
    const ffdecPath = detectFfdec(root, args.ffdec);

    if (!fs.existsSync(swfPath)) throw new Error(`SWF not found: ${swfPath}`);

    // Deliberately before the FFDec check: resyncing the token is pure file I/O and must stay
    // available on a box that has no FFDec installed.
    if (args.syncRevOnly) {
        syncClientRev(swfPath);
        console.log(clientRevIsCurrent(swfPath) ? 'index.html points at the SWF on disk.' : 'index.html could not be resynced.');
        return;
    }

    if (!ffdecPath) throw new Error('FFDec not found. Pass --ffdec or install JPEXS FFDec.');

    const workRoot = path.join(root, 'build', args.verify ? 'ffdec-sentinel-form-cooldown-verify' : 'ffdec-sentinel-form-cooldown');
    const classPath = exportCombatState(ffdecPath, workRoot, swfPath);

    if (args.verify) {
        verifySource(fs.readFileSync(classPath, 'utf8'), swfPath);
        if (!clientRevIsCurrent(swfPath)) {
            throw new Error(
                'index.html clientrev does not match the SWF on disk, so players load a cached ' +
                'copy and none of the SWF patches take effect. Re-run this script without ' +
                '--verify to resync it.'
            );
        }
        return;
    }

    fs.writeFileSync(classPath, patchSource(fs.readFileSync(classPath, 'utf8'), swfPath));

    const patchedSwfPath = path.join(workRoot, `${path.basename(swfPath, path.extname(swfPath))}.patched.swf`);
    runFfdec(ffdecPath, ['-importScript', swfPath, patchedSwfPath, path.dirname(classPath)]);
    if (!fs.existsSync(`${swfPath}.bak`)) fs.copyFileSync(swfPath, `${swfPath}.bak`);
    fs.copyFileSync(patchedSwfPath, swfPath);
    syncClientRev(swfPath);
    console.log(`Patched Sentinel Form exit cooldown into ${swfPath}`);
    console.log(
        'NOTE: recompiling CombatState rebuilds the ABC constant pool. Re-run\n' +
        '      patch-dungeonblitz-forge-charm-durations.ts afterwards -- it stores its values\n' +
        '      in the int pool and is reverted by every FFDec import.'
    );
}

main();
