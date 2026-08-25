#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/**
 * Sentinel Form's cooldown after leaving grows with the energy the form spent.
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
 * So the cast-time stamp is used only as the start marker, and the lockout itself is charged by
 * what the form actually cost: every swing in the form (SFMelee, SFMeleeCombo, SFRanged) spends
 * its authored ManaCost from the master-mana bar, method_51 accumulates that into
 * sentinelFormEnergyUsed as the swings are cast, and the exit helper converts the total at
 * ENERGY_TO_MS (a full 100-point bar drained is the 30-second cooldown). A form that burned 50
 * energy waits 15 seconds; a partial burn scales down from there but never below FLOOR_MS (10s),
 * so an instant attack-free exit cannot be spammed. Staying transformed long enough to spend the
 * whole bar produces the full 30-second cooldown; the cap is the energy budget, not the clock.
 * Both exits remove the SentinelForm buff, so the single RemoveBuff hook covers manual
 * cancellation, running out of mana, death and forced cleanup.
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
 * A player only ever holds one rank. Its still-future cast stamp reveals elapsed time; all ranks
 * are then stamped together so changing the reported rank cannot bypass the result.
 *
 * CombatState has to be decompiled and recompiled for this: it needs a helper plus a buff-removal
 * hook, which no small in-place byte splice can express safely. The same recompile also restores
 * method_51's Sentinel melee combo -- an earlier recompile flattened its counter to a bare
 * `currMeleeCombo = 0` and killed the second swing -- since that fix lives in a method this patch
 * already rewrites.
 */

const TARGET_SWF = path.join('src', 'client', 'content', 'localhost', 'p', 'cbp', 'DungeonBlitz.swf');
const LOCKOUT_MS = 30000;
// Cooldown milliseconds per point of master-mana spent in the form. The mana bar holds 100 points,
// so draining it dry -- the way the form normally ends -- costs the authored 30-second cooldown and
// a partial burn costs proportionally less. Must agree with SENTINEL_FORM_ENERGY_TO_MS in
// CastRateAuthority.ts (server); a mismatch makes the server and the honest client enforce
// different lockouts.
const ENERGY_TO_MS = 300;
// Minimum cooldown an early exit can be refunded down to. Without it, tapping the form and leaving
// on the same frame spends ~0 energy and the transform can be spammed with no cooldown at all.
const FLOOR_MS = 10000;

const HELPER_ANCHOR = '      public function method_749(param1:PowerType) : void\n';
const FIELD_ANCHOR = '      private var var_2361:uint;\n';
const ATTACK_FIELD = '      private var sentinelFormAttackUsed:Boolean = false;\n';
// An earlier cut made attacking in form forfeit the whole refund, tracked by this field and the
// method_51 block below. Dropping that penalty leaves both dead, so both are now STRIPPED from any
// SWF that still carries them; the energy accumulator below replaces the whole arrangement.
const ATTACK_FIELD_BLANK = '      \n' + ATTACK_FIELD;
// The energy the current form has spent, filled by ENERGY_TRACKER and read by
// sentinelFormExitCooldown(). Reset on every entry so a previous form cannot leak into the next.
const ENERGY_FIELD = '      private var sentinelFormEnergyUsed:uint = 0;\n';
const CAST_STAMP_ANCHOR = '         this.var_114[param1.powerID] = _loc5_ + param1.coolDownTime + _loc11_;\n';
// method_51 sees every player cast. The SentinelForm cast opens the form, so it resets the meter;
// each form swing spends its ManaCost and adds to it. This is also where the abandoned
// attack-penalty tracker lived, so an old SWF carries this block (in the old shape, writing
// sentinelFormAttackUsed) and is stripped before the new one is inserted.
const ENERGY_TRACKER = [
    '         if(param1.basePowerName == "SentinelForm")',
    '         {',
    '            this.sentinelFormEnergyUsed = 0;',
    '         }',
    '         else if(param1.basePowerName == "SFMelee" || param1.basePowerName == "SFMeleeCombo" || param1.basePowerName == "SFRanged")',
    '         {',
    '            this.sentinelFormEnergyUsed = this.sentinelFormEnergyUsed + param1.manaCost;',
    '         }',
    ''
].join('\n');
// The old attack-penalty tracker, kept only so an upgraded SWF can be recognized and stripped.
const OLD_CAST_TRACKER = [
    '         if(param1.basePowerName == "SentinelForm")',
    '         {',
    '            this.sentinelFormAttackUsed = false;',
    '         }',
    '         else if(param1.basePowerName == "SFMelee" || param1.basePowerName == "SFMeleeCombo" || param1.basePowerName == "SFRanged")',
    '         {',
    '            this.sentinelFormAttackUsed = true;',
    '         }',
    ''
].join('\n');

// Bug: an earlier recompile decompiled method_51's Sentinel melee combo counter as a bare
// `currMeleeCombo = 0`, so the `== 1` test that swaps SFMelee for SFMeleeCombo was permanently
// false and the second swing never fired. Restore the original window/increment, byte-for-byte as
// it decompiled cleanly before, so the re-import round-trips. Keyed on the currMeleeCombo field
// name (stable across recompiles; locals get renumbered) and idempotent -- once the if/else is
// back, COMBO_BROKEN no longer appears. The preceding `_loc13_` window flag is left untouched.
const COMBO_BROKEN = [
    '                  this.currMeleeCombo = 0;',
    '                  if(this.currMeleeCombo == 1)'
].join('\n');
const COMBO_FIXED = [
    '                  if(!_loc13_ || this.currMeleeCombo >= param1.var_1075)',
    '                  {',
    '                     this.currMeleeCombo = 0;',
    '                  }',
    '                  else',
    '                  {',
    '                     ++this.currMeleeCombo;',
    '                  }',
    '                  if(this.currMeleeCombo == 1)'
].join('\n');

/**
 * The buff going away is what "returning to normal form" actually means. One hook here covers a
 * manual cancel, mana exhaustion, death, a dispel and zone cleanup without double-applying the
 * proportional calculation.
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

const REDUCE_ANCHOR = [
    '      public function method_390(param1:PowerType, param2:Number) : void',
    '      {',
    '         var _loc3_:uint = 0;',
    ''
].join('\n');

// The form-off flow calls method_390 after RemoveBuff. Re-entering the helper here preserves the
// proportional absolute timestamp instead of letting the authored broken reduction clear it.
const REDUCE_GUARD = [
    '         if(param1.basePowerName == "SentinelForm")',
    '         {',
    '            this.sentinelFormExitCooldown();',
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

/**
 * The exit lockout is the energy the form spent, not the wall-clock time it was up: the form only
 * drains the mana bar when a swing lands, so time would over-charge a Sentinel who spends most of
 * the form idle. The fresh (_sfFutureCount == 1) branch converts sentinelFormEnergyUsed at
 * ENERGY_TO_MS, floored at FLOOR_MS so an instant exit still costs something, capped at LOCKOUT_MS
 * so a long, regen-fueled form cannot overshoot the authored budget. The active rank's cast stamp
 * (`enteredAt + 30000`) is still required to be future here -- it is what makes the exit "fresh"
 * rather than a re-entry -- and once it has expired the form has been up at least 30 seconds, which
 * also means well past a full bar of energy, so the full lockout branch is the same answer. The
 * floor and cap live only in the fresh branch; the idempotent re-entry branch preserves the
 * already-computed earliest stamp, so a second call in the same exit cannot drift it.
 */
const HELPER_BODY = [
    '      public function sentinelFormExitCooldown() : void',
    '      {',
    '         var _sfRank:int = 0;',
    '         var _sfPower:PowerType = null;',
    '         var _sfNow:uint = this.var_1.mTimeThisTick;',
    '         var _sfUsedMs:uint = ' + LOCKOUT_MS + ';',
    '         var _sfCurrentReadyAt:uint = 0;',
    '         var _sfReadyAt:uint = 0;',
    '         var _sfEarliestReadyAt:uint = 0;',
    '         var _sfFutureCount:uint = 0;',
    '         for(_sfRank = 0; _sfRank <= 10; _sfRank++)',
    '         {',
    '            _sfPower = class_14.powerTypesDict[_sfRank > 0 ? "SentinelForm" + _sfRank : "SentinelForm"];',
    '            if(Boolean(_sfPower))',
    '            {',
    '               _sfCurrentReadyAt = uint(this.var_114[_sfPower.powerID]);',
    '               if(_sfCurrentReadyAt > _sfNow && _sfCurrentReadyAt - _sfNow <= ' + LOCKOUT_MS + ')',
    '               {',
    '                  _sfFutureCount++;',
    '                  if(_sfEarliestReadyAt == 0 || _sfCurrentReadyAt < _sfEarliestReadyAt)',
    '                  {',
    '                     _sfEarliestReadyAt = _sfCurrentReadyAt;',
    '                  }',
    '               }',
    '            }',
    '         }',
    '         if(_sfFutureCount == 1)',
    '         {',
    '            _sfUsedMs = this.sentinelFormEnergyUsed * ' + ENERGY_TO_MS + ';',
    '            if(_sfUsedMs > ' + LOCKOUT_MS + ')',
    '            {',
    '               _sfUsedMs = ' + LOCKOUT_MS + ';',
    '            }',
    '            if(_sfUsedMs < ' + FLOOR_MS + ')',
    '            {',
    '               _sfUsedMs = ' + FLOOR_MS + ';',
    '            }',
    '            _sfReadyAt = _sfNow + _sfUsedMs;',
    '         }',
    '         else if(_sfFutureCount > 1)',
    '         {',
    '            _sfReadyAt = _sfEarliestReadyAt;',
    '         }',
    '         else',
    '         {',
    '            _sfReadyAt = _sfNow + ' + LOCKOUT_MS + ';',
    '         }',
    '         for(_sfRank = 0; _sfRank <= 10; _sfRank++)',
    '         {',
    '            _sfPower = class_14.powerTypesDict[_sfRank > 0 ? "SentinelForm" + _sfRank : "SentinelForm"];',
    '            if(Boolean(_sfPower))',
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
                `Scales Sentinel Form's post-exit cooldown to the energy the form spent.`
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

    // Drop the abandoned attack penalty: strip the field and its method_51 tracker from any SWF
    // that still carries them. Fresh source has neither, so these are no-ops there.
    next = next.split(ATTACK_FIELD_BLANK).join('');
    next = next.split(ATTACK_FIELD).join('');
    next = next.split(OLD_CAST_TRACKER).join('');

    // The energy meter: the field next to the other CombatState flags, and the method_51 tracker
    // right after the cast stamp. Both are idempotent -- an SWF already carrying them (or an old
    // stripped one being re-run) is left alone.
    if (!next.includes(ENERGY_FIELD.trim())) {
        if (!next.includes(FIELD_ANCHOR)) {
            throw new Error(`${name}: CombatState fields do not open the way this patch expects.`);
        }
        next = next.replace(FIELD_ANCHOR, FIELD_ANCHOR + '      \n' + ENERGY_FIELD);
    }
    if (!next.includes(ENERGY_TRACKER.trimEnd())) {
        if (!next.includes(CAST_STAMP_ANCHOR)) {
            throw new Error(`${name}: CombatState.method_51 cooldown stamp was not found.`);
        }
        next = next.replace(CAST_STAMP_ANCHOR, CAST_STAMP_ANCHOR + ENERGY_TRACKER);
    }

    // Restore the Sentinel melee second swing (see COMBO_FIXED). Fresh source already has the
    // if/else, so COMBO_BROKEN is absent and this is a no-op there.
    if (next.includes(COMBO_BROKEN)) {
        next = next.replace(COMBO_BROKEN, COMBO_FIXED);
    }

    // Upgrade an SWF that carries an earlier cut of this patch.
    if (next.includes('sentinelFormExitCooldown')) {
        // Isolate the helper by its own signature and 6-space method brace, NOT by the method that
        // follows it: FFDec reorders methods on import, so an earlier `(?=method_749)` lookahead
        // grew to swallow whatever method it shuffled in between and delete it on replace. The body
        // has no 6-space closing brace of its own, so the first one ends the method.
        const helperPattern = /      public function sentinelFormExitCooldown\(\) : void\n      \{\n[\s\S]*?\n      \}\n      \n/;
        if (!helperPattern.test(next)) {
            throw new Error(`${name}: could not isolate the existing sentinelFormExitCooldown helper.`);
        }
        next = next.replace(helperPattern, HELPER);
        next = next.split(GUARD).join('');
        const obsoleteReduceGuard = REDUCE_GUARD.replace('            this.sentinelFormExitCooldown();\n', '');
        next = next.split(obsoleteReduceGuard).join('');
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
    for (const [anchor, where] of [[HELPER_ANCHOR, 'method_749']]) {
        if (!next.includes(anchor)) {
            throw new Error(`${name}: CombatState.${where} does not open the way this patch expects.`);
        }
    }

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
        'private var sentinelFormEnergyUsed:uint = 0;',
        `_sfUsedMs = this.sentinelFormEnergyUsed * ${ENERGY_TO_MS};`,
        `if(_sfUsedMs > ${LOCKOUT_MS})`,
        `_sfUsedMs = ${LOCKOUT_MS};`,
        `if(_sfUsedMs < ${FLOOR_MS})`,
        `_sfUsedMs = ${FLOOR_MS};`,
        '_sfReadyAt = _sfEarliestReadyAt;',
        // Matches both the source form and the `while` FFDec turns it back into on re-export.
        '_sfRank <= 10',
        'this.var_114[_sfPower.powerID] = _sfReadyAt;'
    ];
    // FFDec recompiles `x = x + y` as `x += y` on import, so accept both spellings of the
    // accumulator. The important part is that each form swing adds param1.manaCost to the meter.
    if (!source.includes('this.sentinelFormEnergyUsed = this.sentinelFormEnergyUsed + param1.manaCost;')
        && !source.includes('this.sentinelFormEnergyUsed += param1.manaCost;')) {
        throw new Error(`${path.basename(swfPath)} is missing the Sentinel Form energy accumulator.`);
    }
    // The rank-reading first cut must not survive: it stamps SentinelForm1 whenever var_498 is
    // stale, which leaves every other rank with no lockout at all.
    if (source.includes('this.var_498 > 0 ? this.var_498 : 1')) {
        throw new Error(`${path.basename(swfPath)} still carries the rank-reading Sentinel Form lockout.`);
    }
    // The dropped attack penalty must be fully gone -- field, tracker and helper override -- or the
    // server (which charges cooldown by energy, not by attacking) and the client would enforce
    // different rules.
    if (source.includes('sentinelFormAttackUsed')) {
        throw new Error(`${path.basename(swfPath)} still carries the removed Sentinel Form attack penalty.`);
    }
    // The energy meter must reset on entry as well as accumulate on swings; a form that never
    // spends energy must not inherit the previous form's lockout.
    if (!source.includes('this.sentinelFormEnergyUsed = 0;')) {
        throw new Error(`${path.basename(swfPath)} is missing the Sentinel Form energy meter reset.`);
    }
    // The melee combo must swing twice: a bare `currMeleeCombo = 0` right before the `== 1` swap is
    // the corruption that left the substitution dead and killed the second swing.
    if (source.includes(COMBO_BROKEN)) {
        throw new Error(`${path.basename(swfPath)} still has the broken Sentinel Form melee combo (no second swing).`);
    }
    for (const snippet of required) {
        if (!source.includes(snippet)) {
            throw new Error(`${path.basename(swfPath)} is missing the Sentinel Form exit cooldown: ${snippet}`);
        }
    }
    // RemoveBuff is the one authoritative exit. Multiple cast hooks would run the proportional
    // calculation repeatedly and turn a six-second use into a 24-second cooldown.
    const guards = source.split('this.sentinelFormExitCooldown();').length - 1;
    if (guards !== 2) {
        throw new Error(
            `${path.basename(swfPath)} has ${guards} Sentinel Form exit hooks, expected RemoveBuff and method_390.`
        );
    }
    if (!source.includes('if(param1.buffName.indexOf("SentinelForm") == 0)')) {
        throw new Error(`${path.basename(swfPath)} is missing the buff-removal Sentinel Form hook.`);
    }
    if (!source.includes(REDUCE_GUARD.trimEnd())) {
        throw new Error(
            `${path.basename(swfPath)} is missing the idempotent method_390 Sentinel Form finalizer.`
        );
    }
    // The other patches that share CombatState must have survived the recompile.
    if (!source.includes('_shroudPower')) {
        throw new Error(`${path.basename(swfPath)} lost the Midnight Shroud passive patch.`);
    }
    if (source.includes('param3 = uint(param2.meleeDamage);')) {
        throw new Error(`${path.basename(swfPath)} restored the retired Viperblade Attack-scaling override.`);
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
