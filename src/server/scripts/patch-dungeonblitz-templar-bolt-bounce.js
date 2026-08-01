#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/**
 * The Templar's ranged attack bounces between enemies.
 *
 * The reason this needed code, and why the earlier data attempt could never have worked:
 * a Paladin's basic ranged attack is whatever the equipped weapon names as its RangedPower,
 * and every Paladin weapon names Lightningball or Energyball. DivineBolt -- the Templar's
 * HotbarLocation 0 signature power, where the splash passive was parked -- is a separate
 * power the Templar casts deliberately. It is not the bolt that comes out when you attack,
 * so nothing put on it could ever change the attack.
 *
 * Putting the bounce on Lightningball in data has the opposite problem: weapons carry
 * <UsedBy>Paladin</UsedBy>, a class and never a mastery, so a Justicar and a Sentinel would
 * bounce too. The scoping has to happen where the caster is known, and class_130 knows it --
 * the missile holds its owner in var_19, and Entity.mMasterClass is the lowercase discipline
 * name ("templar", "justicar", "sentinel"). That is the check.
 *
 * How the bounce works. class_130's collision loop already has two shapes: the normal one
 * stops the missile on the first entity it crosses, and the FireBrand one damages everything
 * it passes through without ever stopping. A bounce is a third: damage the target, then aim
 * at the nearest enemy not yet hit and keep flying.
 *
 *   - templarBounceTargets remembers who has already been hit, so a bounce cannot land back
 *     on the enemy it just came from, and the missile cannot sit inside one target chewing
 *     it every tick.
 *   - The range budget is restarted at each bounce. var_1858 is the distance the missile was
 *     launched with and var_502 is where it started; without resetting both, a bolt that
 *     bounced sideways would hit its original range limit and vanish mid-flight.
 *   - Three bounces, so four enemies at most. With nothing else in range the bolt just
 *     hits its one target and stops, which is the authored behaviour untouched.
 *
 * When the bounces run out, or nothing is left to bounce to, the missile falls through to
 * the authored stop-and-explode path unchanged.
 *
 * class_130 is decompiled and recompiled rather than byte-patched because this adds state
 * and a search loop, which is far past what an in-place ABC splice can express. That is the
 * same route patch-dungeonblitz-firebrand-pierce-missile.js already takes through this exact
 * class, which is the evidence it survives a round-trip -- most classes in this SWF do not.
 * Only class_130 is recompiled; every other class, including the two carrying raw ABC edits
 * (CombatState, for the Viperblade scaling and the Clutch Heal threshold), passes through
 * untouched.
 */

const TARGET_SWF = path.join('src', 'client', 'content', 'localhost', 'p', 'cbp', 'DungeonBlitz.swf');
const BOUNCE_POWERS = ['Lightningball', 'Energyball'];
const MASTER_CLASS = 'templar';
const MAX_BOUNCES = 3;

const FIELD_ANCHOR = '      internal var fireBrandPiercedTargets:Object = null;\n';
const FIELD_PATCH =
    FIELD_ANCHOR +
    '      \n' +
    '      internal var templarBounceTargets:Object = null;\n' +
    '      \n' +
    '      internal var templarBouncesLeft:int = 0;\n';

const CTOR_ANCHOR =
    '         this.fireBrandPiercedTargets = param6.powerName == "FlameAxeFireBrandShot8" ? new Object() : null;\n';
const CTOR_PATCH =
    CTOR_ANCHOR +
    // The parentheses around the power test are load-bearing: && binds tighter than ||, so
    // without them this reads as (templar && Lightningball) || Energyball and every class in
    // the game bounces its Energyball. Verified against the round-tripped source, not assumed.
    `         this.templarBounceTargets = Boolean(param5) && param5.mMasterClass == "${MASTER_CLASS}" && (` +
    BOUNCE_POWERS.map((name) => `param6.powerName == "${name}"`).join(' || ') +
    ') ? new Object() : null;\n' +
    `         this.templarBouncesLeft = Boolean(this.templarBounceTargets) ? ${MAX_BOUNCES} : 0;\n`;

const COLLISION_ANCHOR =
    '                        if(CombatState.method_255(this.var_11,_loc4_,_loc13_))\n' +
    '                        {\n' +
    '                           if(this.power.powerName != "FlameAxeFireBrandShot8")\n';

const BOUNCE_BLOCK = [
    // An enemy this bolt has already bounced off is invisible to it from then on. Without
    // this the missile would still be overlapping the target it just left, fail the "not yet
    // hit" test, and fall straight into the authored stop-and-explode branch -- so the bolt
    // would die on the enemy it had just bounced away from and never reach the second one.
    '                           if(Boolean(this.templarBounceTargets) && Boolean(this.templarBounceTargets[_loc13_.id]))',
    '                           {',
    '                              continue;',
    '                           }',
    '                           if(Boolean(this.templarBounceTargets))',
    '                           {',
    '                              this.templarBounceTargets[_loc13_.id] = true;',
    '                              this.var_19.combatState.FireThisPower(this.power,this.var_11,new Array(_loc13_),this.var_743,0,this.var_1448,0,null,0,this.var_249);',
    '                              var _templarNext:Entity = null;',
    '                              var _templarBest:Number = 0;',
    '                              var _templarDist:Number = 0;',
    '                              var _templarCand:Entity = null;',
    '                              var _templarBurst:GfxType = null;',
    '                              var _templarAnim:SuperAnimInstance = null;',
    '                              if(this.templarBouncesLeft > 0)',
    '                              {',
    '                                 for each(_templarCand in _loc11_)',
    '                                 {',
    '                                    if(_templarCand != this.var_19 && !this.templarBounceTargets[_templarCand.id] && _templarCand.method_156())',
    '                                    {',
    '                                       _templarDist = Point.distance(this.var_11,new Point(_templarCand.appearPosX,_templarCand.appearPosY));',
    '                                       if(_templarNext == null || _templarDist < _templarBest)',
    '                                       {',
    '                                          _templarNext = _templarCand;',
    '                                          _templarBest = _templarDist;',
    '                                       }',
    '                                    }',
    '                                 }',
    '                              }',
    '                              if(_templarNext != null)',
    '                              {',
    '                                 this.templarBouncesLeft = this.templarBouncesLeft - 1;',
    '                                 this.velocity.x = _templarNext.appearPosX - this.var_11.x;',
    '                                 this.velocity.y = _templarNext.appearPosY - this.var_11.y;',
    '                                 this.var_502.x = this.var_11.x;',
    '                                 this.var_502.y = this.var_11.y;',
    '                                 this.var_1858 = this.velocity.length + const_883;',
    // The impact burst is drawn inline rather than by calling method_106. That method is the
    // missile's death: it destroys the gfx and stamps var_1718, which makes the next
    // TickMissile bail out -- calling it here would kill the bolt at its first bounce.
    '                                 if(this.power.var_352)',
    '                                 {',
    '                                    _templarBurst = this.power.var_352[uint(Math.random() * this.power.var_352.length)];',
    '                                    _templarAnim = new SuperAnimInstance(this.var_1,_templarBurst,this.var_19.var_24 != null);',
    '                                    _templarAnim.m_TheDO.x = this.var_11.x;',
    '                                    _templarAnim.m_TheDO.y = this.var_11.y;',
    '                                    _templarAnim.m_TheDO.rotation = MathUtil.method_222(this.var_559,_loc4_,360);',
    '                                    this.var_1.playerEntLayer.addChild(_templarAnim.m_TheDO);',
    '                                 }',
    // Re-aim this tick's step at the new heading. Rotation and the floor check downstream are
    // both derived from _loc4_/_loc5_, which were computed from the pre-bounce velocity -- so
    // without this the bolt turns invisibly and keeps drifting the old way for a frame.
    '                                 _loc4_.x = this.velocity.x;',
    '                                 _loc4_.y = this.velocity.y;',
    '                                 _loc4_.normalize(this.var_1.TIMESTEP * this.var_2712);',
    '                                 _loc5_.x = this.var_11.x + _loc4_.x;',
    '                                 _loc5_.y = this.var_11.y + _loc4_.y;',
    '                                 break;',
    '                              }',
    '                           }',
    '',
].join('\n');

const COLLISION_PATCH =
    '                        if(CombatState.method_255(this.var_11,_loc4_,_loc13_))\n' +
    '                        {\n' +
    BOUNCE_BLOCK +
    '                           if(this.power.powerName != "FlameAxeFireBrandShot8")\n';

function parseArgs(argv) {
    const args = { ffdec: '', swf: TARGET_SWF, verify: false };
    for (let index = 2; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--ffdec' || arg === '-f') { args.ffdec = argv[++index] || ''; continue; }
        if (arg === '--swf' || arg === '-s') { args.swf = argv[++index] || ''; continue; }
        if (arg === '--verify' || arg === '--dry-run') { args.verify = true; continue; }
        if (arg === '--help' || arg === '-h') {
            console.log([
                'Usage:',
                '  node src/server/scripts/patch-dungeonblitz-templar-bolt-bounce.js [--verify] [--swf <path>] [--ffdec <path>]',
                '',
                `Makes ${BOUNCE_POWERS.join('/')} missiles bounce to ${MAX_BOUNCES} further enemies, for Templars only.`
            ].join('\n'));
            process.exit(0);
        }
        throw new Error(`Unknown argument: ${arg}`);
    }
    return args;
}

function repoRoot() {
    return path.resolve(__dirname, '..', '..', '..');
}

function resolvePath(root, value) {
    if (!value) return '';
    return path.isAbsolute(value) ? value : path.join(root, value);
}

function detectFfdec(root, preferred) {
    const candidates = [];
    if (preferred) candidates.push(resolvePath(root, preferred));
    candidates.push(
        path.join(root, 'build', 'ffdec', 'ffdec.sh'),
        path.join(root, 'build', 'ffdec', 'ffdec.jar'),
        '/Applications/FFDec.app/Contents/Resources/ffdec.sh',
        '/Applications/FFDec.app/Contents/Resources/ffdec.jar'
    );
    return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || '';
}

function runFfdec(ffdecPath, args) {
    const resolved = path.resolve(ffdecPath);
    if (path.basename(resolved).toLowerCase().endsWith('.jar')) {
        execFileSync('java', ['-jar', resolved, '-cli', ...args], { stdio: 'inherit' });
        return;
    }
    execFileSync(resolved, ['-cli', ...args], { stdio: 'inherit' });
}

function exportClass130(ffdecPath, workRoot, swfPath) {
    fs.rmSync(workRoot, { recursive: true, force: true });
    fs.mkdirSync(workRoot, { recursive: true });
    runFfdec(ffdecPath, ['-selectclass', 'class_130', '-export', 'script', workRoot, swfPath]);
    const classPath = path.join(workRoot, 'scripts', 'class_130.as');
    if (!fs.existsSync(classPath)) throw new Error(`FFDec export did not produce ${classPath}`);
    return classPath;
}

function patchSource(source, swfPath) {
    let next = source.replace(/\r\n/g, '\n');
    const name = path.basename(swfPath);

    if (!next.includes('internal var templarBounceTargets:Object = null;')) {
        if (!next.includes(FIELD_ANCHOR)) {
            throw new Error(`${name}: class_130 field block is not the shape this patch expects (is the FireBrand pierce patch applied?).`);
        }
        next = next.replace(FIELD_ANCHOR, FIELD_PATCH);
    }

    if (!next.includes('this.templarBounceTargets = ')) {
        if (!next.includes(CTOR_ANCHOR)) {
            throw new Error(`${name}: class_130 constructor block is not the shape this patch expects.`);
        }
        next = next.replace(CTOR_ANCHOR, CTOR_PATCH);
    }

    if (!next.includes('this.templarBounceTargets[_loc13_.id] = true;')) {
        if (!next.includes(COLLISION_ANCHOR)) {
            throw new Error(`${name}: class_130 collision block is not the shape this patch expects.`);
        }
        next = next.replace(COLLISION_ANCHOR, COLLISION_PATCH);
    }

    return next;
}

function verifySource(source, swfPath) {
    source = source.replace(/\r\n/g, '\n');
    const required = [
        'internal var templarBounceTargets:Object = null;',
        'internal var templarBouncesLeft:int = 0;',
        `param5.mMasterClass == "${MASTER_CLASS}" && (param6.powerName == "Lightningball" || param6.powerName == "Energyball")`,
        'this.templarBounceTargets[_loc13_.id] = true;',
        'this.templarBouncesLeft -= 1;',
        'this.var_1858 = this.velocity.length + const_883;',
        'this.var_1.playerEntLayer.addChild(_templarAnim.m_TheDO);',
        '_loc5_.y = this.var_11.y + _loc4_.y;'
    ];
    for (const snippet of required) {
        if (!source.includes(snippet)) {
            throw new Error(`${path.basename(swfPath)} is missing the Templar bolt bounce patch: ${snippet}`);
        }
    }
    // The bounce must not have eaten the FireBrand pierce that shares this loop.
    if (!source.includes('this.fireBrandPiercedTargets[_loc13_.id] = true;')) {
        throw new Error(`${path.basename(swfPath)} lost the FireBrand pierce patch.`);
    }
    console.log(`Verified Templar bolt bounce patch in ${swfPath}`);
}

function main() {
    const root = repoRoot();
    const args = parseArgs(process.argv);
    const swfPath = resolvePath(root, args.swf);
    const ffdecPath = detectFfdec(root, args.ffdec);

    if (!ffdecPath) throw new Error('FFDec not found. Pass --ffdec or install JPEXS FFDec.');
    if (!fs.existsSync(swfPath)) throw new Error(`SWF not found: ${swfPath}`);

    const workRoot = path.join(root, 'build', args.verify ? 'ffdec-templar-bolt-bounce-verify' : 'ffdec-templar-bolt-bounce');
    const classPath = exportClass130(ffdecPath, workRoot, swfPath);

    if (args.verify) {
        verifySource(fs.readFileSync(classPath, 'utf8'), swfPath);
        return;
    }

    const patchedSource = patchSource(fs.readFileSync(classPath, 'utf8'), swfPath);
    fs.writeFileSync(classPath, patchedSource);

    const patchedSwfPath = path.join(workRoot, `${path.basename(swfPath, path.extname(swfPath))}.patched.swf`);
    runFfdec(ffdecPath, ['-importScript', swfPath, patchedSwfPath, path.dirname(classPath)]);
    if (!fs.existsSync(`${swfPath}.bak`)) fs.copyFileSync(swfPath, `${swfPath}.bak`);
    fs.copyFileSync(patchedSwfPath, swfPath);
    console.log(`Patched Templar bolt bounce in ${swfPath}`);
}

main();
