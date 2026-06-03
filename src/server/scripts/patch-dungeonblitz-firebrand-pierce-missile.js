#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const TARGET_SWF = path.join('src', 'client', 'content', 'localhost', 'p', 'cbp', 'DungeonBlitz.swf');
const TARGET_POWER = 'FlameAxeFireBrandShot8';

function parseArgs(argv) {
    const args = {
        ffdec: '',
        swf: TARGET_SWF,
        verify: false
    };

    for (let index = 2; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--ffdec' || arg === '-f') {
            args.ffdec = argv[++index] || '';
            continue;
        }
        if (arg === '--swf' || arg === '-s') {
            args.swf = argv[++index] || '';
            continue;
        }
        if (arg === '--verify') {
            args.verify = true;
            continue;
        }
        if (arg === '--help' || arg === '-h') {
            console.log([
                'Usage:',
                '  node src/server/scripts/patch-dungeonblitz-firebrand-pierce-missile.js [--verify] [--swf <path>] [--ffdec <path>]',
                '',
                `Patches class_130 so ${TARGET_POWER} missiles damage pierced entities without stopping on them.`
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
    if (!value) {
        return '';
    }
    return path.isAbsolute(value) ? value : path.join(root, value);
}

function detectFfdec(root, preferred) {
    const candidates = [];
    if (preferred) {
        candidates.push(resolvePath(root, preferred));
    }
    candidates.push(
        path.join(root, 'build', 'ffdec', 'ffdec.sh'),
        path.join(root, 'build', 'ffdec', 'ffdec.jar'),
        path.join(root, 'build', 'ffdec', 'ffdec-cli.jar'),
        '/Applications/FFDec.app/Contents/Resources/ffdec.sh',
        '/Applications/FFDec.app/Contents/Resources/ffdec.jar',
        '/Applications/FFDec.app/Contents/Resources/ffdec-cli.jar'
    );
    return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || '';
}

function runFfdec(ffdecPath, args) {
    const resolved = path.resolve(ffdecPath);
    const basename = path.basename(resolved).toLowerCase();
    if (basename.endsWith('.jar')) {
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
    if (!fs.existsSync(classPath)) {
        throw new Error(`FFDec export did not produce ${classPath}`);
    }
    return classPath;
}

function patchSource(source, swfPath) {
    let next = source.replace(/\r\n/g, '\n');

    const varDecl = '      internal var var_2413:uint = 0;\n      \n';
    const patchedVarDecl = '      internal var var_2413:uint = 0;\n      \n      internal var fireBrandPiercedTargets:Object = null;\n      \n';
    if (!next.includes('internal var fireBrandPiercedTargets:Object = null;')) {
        if (!next.includes(varDecl)) {
            throw new Error(`${path.basename(swfPath)} has an unexpected class_130 field block.`);
        }
        next = next.replace(varDecl, patchedVarDecl);
    }

    const constructorAnchor = '         this.var_743 = param10;\n';
    const constructorPatch = `         this.var_743 = param10;\n         this.fireBrandPiercedTargets = param6.powerName == "${TARGET_POWER}" ? new Object() : null;\n`;
    if (!next.includes(`this.fireBrandPiercedTargets = param6.powerName == "${TARGET_POWER}" ? new Object() : null;`)) {
        if (!next.includes(constructorAnchor)) {
            throw new Error(`${path.basename(swfPath)} has an unexpected class_130 constructor block.`);
        }
        next = next.replace(constructorAnchor, constructorPatch);
    }

    const originalGather = '_loc11_ = this.var_1.GatherEntities(this.var_19,this.var_11.x,this.var_11.y,_loc10_,_loc10_,this.power.damageMultFull < 0 ? Game.FRIEND : Game.ENEMY);';
    const bypassGather = `_loc11_ = this.power.powerName == "${TARGET_POWER}" ? new Array() : this.var_1.GatherEntities(this.var_19,this.var_11.x,this.var_11.y,_loc10_,_loc10_,this.power.damageMultFull < 0 ? Game.FRIEND : Game.ENEMY);`;
    if (next.includes(bypassGather)) {
        next = next.replace(bypassGather, originalGather);
    }
    if (!next.includes(originalGather)) {
        throw new Error(`${path.basename(swfPath)} has an unexpected class_130 entity gather block.`);
    }

    const oldExperimentalCollision = [
        '                        if(CombatState.method_255(this.var_11,_loc4_,_loc13_))',
        '                        {',
        `                           if(this.power.powerName != "${TARGET_POWER}")`,
        '                           {',
        '                              _loc9_ = _loc13_;',
        '                              _loc1_ = true;',
        '                              _loc5_.x = this.var_11.x * 0.3 + _loc13_.appearPosX * 0.7;',
        '                              _loc5_.y = this.var_11.y;',
        '                              break;',
        '                           }',
        '                           if(!this.fireBrandPiercedTargets[_loc13_.id])',
        '                           {',
        '                              this.fireBrandPiercedTargets[_loc13_.id] = true;',
        '                              this.var_19.combatState.FireThisPower(this.power,this.var_11,new Array(_loc13_),this.var_743,0,this.var_1448,0,null,0,this.var_249);',
        '                           }',
        '                        }'
    ].join('\n');
    const originalCollision = [
        '                        if(CombatState.method_255(this.var_11,_loc4_,_loc13_))',
        '                        {',
        '                           _loc9_ = _loc13_;',
        '                           _loc1_ = true;',
        '                           _loc5_.x = this.var_11.x * 0.3 + _loc13_.appearPosX * 0.7;',
        '                           _loc5_.y = this.var_11.y;',
        '                           break;',
        '                        }'
    ].join('\n');
    const patchedCollision = [
        '                        if(CombatState.method_255(this.var_11,_loc4_,_loc13_))',
        '                        {',
        `                           if(this.power.powerName == "${TARGET_POWER}")`,
        '                           {',
        '                              if(!this.fireBrandPiercedTargets[_loc13_.id])',
        '                              {',
        '                                 this.fireBrandPiercedTargets[_loc13_.id] = true;',
        '                                 this.var_19.combatState.FireThisPower(this.power,this.var_11,new Array(_loc13_),this.var_743,0,this.var_1448,0,null,0,this.var_249);',
        '                              }',
        '                           }',
        '                           else',
        '                           {',
        '                              _loc9_ = _loc13_;',
        '                              _loc1_ = true;',
        '                              _loc5_.x = this.var_11.x * 0.3 + _loc13_.appearPosX * 0.7;',
        '                              _loc5_.y = this.var_11.y;',
        '                              break;',
        '                           }',
        '                        }'
    ].join('\n');
    if (!next.includes(patchedCollision)) {
        if (next.includes(oldExperimentalCollision)) {
            next = next.replace(oldExperimentalCollision, patchedCollision);
        } else if (next.includes(originalCollision)) {
            next = next.replace(originalCollision, patchedCollision);
        } else {
            throw new Error(`${path.basename(swfPath)} has an unexpected class_130 collision block.`);
        }
    }

    return next;
}

function verifySource(source, swfPath) {
    source = source.replace(/\r\n/g, '\n');
    const required = [
        'internal var fireBrandPiercedTargets:Object = null;',
        `this.fireBrandPiercedTargets = param6.powerName == "${TARGET_POWER}" ? new Object() : null;`,
        'this.var_1.GatherEntities(this.var_19,this.var_11.x,this.var_11.y,_loc10_,_loc10_,this.power.damageMultFull < 0 ? Game.FRIEND : Game.ENEMY);',
        `if(this.power.powerName != "${TARGET_POWER}")`,
        'if(!this.fireBrandPiercedTargets[_loc13_.id])',
        'this.fireBrandPiercedTargets[_loc13_.id] = true;',
        'this.var_19.combatState.FireThisPower(this.power,this.var_11,new Array(_loc13_),this.var_743,0,this.var_1448,0,null,0,this.var_249);'
    ];
    for (const snippet of required) {
        if (!source.includes(snippet)) {
            throw new Error(`${path.basename(swfPath)} is missing the ${TARGET_POWER} piercing hit patch: ${snippet}`);
        }
    }
    if (source.includes(`this.power.powerName == "${TARGET_POWER}" ? new Array() : this.var_1.GatherEntities`)) {
        throw new Error(`${path.basename(swfPath)} still disables ${TARGET_POWER} entity collision gathering.`);
    }
    console.log(`Verified ${TARGET_POWER} piercing hit patch in ${swfPath}`);
}

function main() {
    const root = repoRoot();
    const args = parseArgs(process.argv);
    const swfPath = resolvePath(root, args.swf);
    const ffdecPath = detectFfdec(root, args.ffdec);

    if (!ffdecPath) {
        throw new Error('FFDec not found. Pass --ffdec or install JPEXS FFDec.');
    }
    if (!fs.existsSync(swfPath)) {
        throw new Error(`SWF not found: ${swfPath}`);
    }

    const workRoot = path.join(root, 'build', args.verify ? 'ffdec-firebrand-pierce-missile-verify' : 'ffdec-firebrand-pierce-missile');
    const classPath = exportClass130(ffdecPath, workRoot, swfPath);

    if (args.verify) {
        verifySource(fs.readFileSync(classPath, 'utf8'), swfPath);
        return;
    }

    const patchedSource = patchSource(fs.readFileSync(classPath, 'utf8'), swfPath);
    fs.writeFileSync(classPath, patchedSource);

    const patchedSwfPath = path.join(workRoot, `${path.basename(swfPath, path.extname(swfPath))}.patched.swf`);
    runFfdec(ffdecPath, ['-importScript', swfPath, patchedSwfPath, path.dirname(classPath)]);
    if (!fs.existsSync(`${swfPath}.bak`)) {
        fs.copyFileSync(swfPath, `${swfPath}.bak`);
    }
    fs.copyFileSync(patchedSwfPath, swfPath);
    console.log(`Patched ${TARGET_POWER} piercing hit behavior in ${swfPath}`);
}

main();
