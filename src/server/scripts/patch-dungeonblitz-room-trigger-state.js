#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function resolveRepoRoot() {
    return path.resolve(__dirname, '..', '..', '..');
}

function resolvePath(repoRoot, value) {
    if (!value) {
        return '';
    }
    return path.isAbsolute(value) ? value : path.join(repoRoot, value);
}

function parseArgs(argv) {
    const args = { swf: '', output: '', ffdec: '' };
    for (let index = 2; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === '--swf' || arg === '-s') {
            args.swf = argv[++index] || '';
        } else if (arg === '--output' || arg === '-o') {
            args.output = argv[++index] || '';
        } else if (arg === '--ffdec' || arg === '-f') {
            args.ffdec = argv[++index] || '';
        } else {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }
    return args;
}

function detectFfdec(repoRoot, preferred) {
    const candidates = [
        preferred ? resolvePath(repoRoot, preferred) : '',
        path.join(repoRoot, 'build', 'ffdec', 'ffdec.jar'),
        path.join(repoRoot, 'temp', 'jpexs_25_1_3', 'FFDec.app', 'Contents', 'Resources', 'ffdec.jar'),
        path.join(repoRoot, 'temp', 'jpexs_25_1_3', 'FFDec.app', 'Contents', 'Resources', 'ffdec-cli.jar')
    ];
    return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || '';
}

function runFfdec(ffdecPath, args) {
    execFileSync('java', ['-jar', ffdecPath, '-cli', ...args], { stdio: 'inherit' });
}

function patchRoom(source) {
    const eol = source.includes('\r\n') ? '\r\n' : '\n';
    source = source
        .replace('null.bDisabled = param3 != "On";', '_loc4_.bDisabled = param3 != "On";')
        .replace('if((Boolean(_loc5_)) && null.entState != Entity.const_6)', 'if(Boolean(_loc5_) && _loc5_.entState != Entity.const_6)')
        .replace('null.gfx.m_Seq.method_34(Seq.C_USEPOWER,param3,true);', '_loc5_.gfx.m_Seq.method_34(Seq.C_USEPOWER,param3,true);')
        .replace('var _loc34_:SuperAnimInstance = this.method_67(null);', 'var _loc34_:SuperAnimInstance = this.method_67(_loc33_);')
        .replace('_loc17_.x = null.m_TheDO.x + 200 + Math.random() * 200;', '_loc17_.x = _loc34_.m_TheDO.x + 200 + Math.random() * 200;');

    if (source.includes('param1 == "GoblinKidnappersAuthority"')) {
        return source;
    }

    const authorityBranch = [
        '         else if(param1 == "GoblinKidnappersAuthority")',
        '         {',
        '            if(Boolean(this.var_150) && this.var_150.hasOwnProperty("ApplyServerAuthoritySnapshot"))',
        '            {',
        '               this.var_150["ApplyServerAuthoritySnapshot"](this.var_122,param3);',
        '            }',
        '         }'
    ].join(eol);

    const triggerBranch = [
        '         else if(param1 == "Trigger")',
        '         {',
        '            this.method_79(param2);',
        '         }'
    ].join(eol);
    if (source.includes('param1 == "Trigger"')) {
        if (!source.includes(triggerBranch)) {
            throw new Error('Could not find existing Room Trigger branch');
        }
        return source.replace(triggerBranch, `${triggerBranch}${eol}${authorityBranch}`);
    }

    const needle = [
        '         else if(param1 == "SetEntityAnimation")',
        '         {',
        '            var _loc5_:Entity = this.var_1.GetEntFromID(int(param2));',
        '            if(Boolean(_loc5_) && _loc5_.entState != Entity.const_6)',
        '            {',
        '               _loc5_.gfx.m_Seq.method_34(Seq.C_USEPOWER,param3,true);',
        '            }',
        '         }'
    ].join(eol);
    const replacement = [
        '         else if(param1 == "SetEntityAnimation")',
        '         {',
        '            var _loc5_:Entity = this.var_1.GetEntFromID(int(param2));',
        '            if(Boolean(_loc5_) && _loc5_.entState != Entity.const_6)',
        '            {',
        '               _loc5_.gfx.m_Seq.method_34(Seq.C_USEPOWER,param3,true);',
        '            }',
        '         }',
        triggerBranch,
        authorityBranch
    ].join(eol);

    if (!source.includes(needle)) {
        const fallbackNeedle = [
            '         else if(param1 == "SetEntityAnimation")',
            '         {',
            '            var _loc5_:Entity = this.var_1.GetEntFromID(int(param2));',
            '            if((Boolean(_loc5_)) && _loc5_.entState != Entity.const_6)',
            '            {',
            '               _loc5_.gfx.m_Seq.method_34(Seq.C_USEPOWER,param3,true);',
            '            }',
            '         }'
        ].join(eol);
        if (!source.includes(fallbackNeedle)) {
            throw new Error('Could not find Room.method_1147 insertion point');
        }
        return source.replace(fallbackNeedle, replacement);
    }

    return source.replace(needle, replacement);
}

function main() {
    const repoRoot = resolveRepoRoot();
    const args = parseArgs(process.argv);
    const swfPath = resolvePath(
        repoRoot,
        args.swf || path.join('src', 'client', 'content', 'localhost', 'p', 'cbp', 'DungeonBlitz.swf')
    );
    const outputPath = resolvePath(repoRoot, args.output || swfPath);
    const ffdecPath = detectFfdec(repoRoot, args.ffdec);
    if (!fs.existsSync(swfPath)) {
        throw new Error(`SWF not found: ${swfPath}`);
    }
    if (!ffdecPath) {
        throw new Error('FFDec not found');
    }

    const workRoot = path.join(repoRoot, 'build', 'ffdec-dungeonblitz-room-trigger-state');
    const scriptsRoot = path.join(workRoot, 'scripts');
    const roomPath = path.join(scriptsRoot, 'Room.as');
    const patchedSwfPath = path.join(workRoot, 'DungeonBlitz.room-trigger-state.swf');

    fs.rmSync(workRoot, { recursive: true, force: true });
    fs.mkdirSync(workRoot, { recursive: true });
    runFfdec(ffdecPath, ['-selectclass', 'Room', '-export', 'script', workRoot, swfPath]);

    if (!fs.existsSync(roomPath)) {
        throw new Error(`FFDec export did not produce ${roomPath}`);
    }

    const original = fs.readFileSync(roomPath, 'utf8');
    const patched = patchRoom(original);
    if (patched === original) {
        console.log(`SWF already contains room trigger state patch: ${swfPath}`);
        if (path.resolve(outputPath) !== path.resolve(swfPath)) {
            fs.copyFileSync(swfPath, outputPath);
        }
        return;
    }

    fs.writeFileSync(roomPath, patched, 'utf8');
    runFfdec(ffdecPath, ['-importScript', swfPath, patchedSwfPath, scriptsRoot]);
    fs.copyFileSync(patchedSwfPath, outputPath);
    console.log(`Patched SWF written to ${outputPath}`);
}

try {
    main();
} catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
}
