const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const CLASS_NAME = 'a_Room_BTZ_BridgeTownEast';
const INTERNAL_CHARACTER_NAME = 'Felguard';
const DISPLAY_NAME = 'Benjaea';

function parseArgs(argv) {
    const args = { verify: false, swf: '', output: '', ffdec: '' };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--verify') args.verify = true;
        else if (arg === '--swf') args.swf = argv[++i] || '';
        else if (arg === '--output') args.output = argv[++i] || '';
        else if (arg === '--ffdec') args.ffdec = argv[++i] || '';
        else if (arg === '--help' || arg === '-h') {
            console.log('Usage: node src/server/scripts/patch-levelsbt-benjaea-display-name.js [--verify] [--swf <path>] [--output <path>] [--ffdec <path>]');
            process.exit(0);
        } else {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }
    return args;
}

function detectFfdec(repoRoot, preferred) {
    const candidates = [
        preferred,
        path.join(repoRoot, 'build', 'ffdec', 'ffdec.jar'),
        path.join(repoRoot, 'build', 'tools', 'ffdec_25.1.3', 'ffdec.jar'),
        'C:\\Program Files (x86)\\FFDec\\ffdec.jar',
        'C:\\Program Files\\FFDec\\ffdec.jar'
    ].filter(Boolean);
    return candidates.find((candidate) => fs.existsSync(candidate)) || '';
}

function runFfdec(ffdecPath, homeDir, args) {
    fs.mkdirSync(homeDir, { recursive: true });
    execFileSync('java', [`-Duser.home=${homeDir}`, '-jar', ffdecPath, '-cli', ...args], {
        stdio: 'inherit',
        env: {
            ...process.env,
            APPDATA: homeDir,
            LOCALAPPDATA: path.join(homeDir, 'LocalAppData'),
            USERPROFILE: homeDir
        }
    });
}

function exportRoom(ffdecPath, homeDir, exportRoot, swfPath) {
    fs.rmSync(exportRoot, { recursive: true, force: true });
    runFfdec(ffdecPath, homeDir, ['-selectclass', CLASS_NAME, '-export', 'script', exportRoot, swfPath]);
    const classPath = path.join(exportRoot, 'scripts', `${CLASS_NAME}.as`);
    if (!fs.existsSync(classPath)) {
        throw new Error(`FFDec export did not produce ${classPath}`);
    }
    return classPath;
}

function assertPatchedSource(source, label) {
    const internalAssignment = `.characterName = "${INTERNAL_CHARACTER_NAME}";`;
    const displayAssignment = `.displayName = "${DISPLAY_NAME}";`;
    if (!source.includes(internalAssignment)) {
        throw new Error(`${label}: internal characterName was not preserved as ${INTERNAL_CHARACTER_NAME}`);
    }
    if (!source.includes(displayAssignment)) {
        throw new Error(`${label}: displayName is not ${DISPLAY_NAME}`);
    }
    if (source.includes(`.displayName = "${INTERNAL_CHARACTER_NAME}";`)) {
        throw new Error(`${label}: legacy visible displayName is still present`);
    }
}

function patchSource(source) {
    const legacy = `.displayName = "${INTERNAL_CHARACTER_NAME}";`;
    const replacement = `.displayName = "${DISPLAY_NAME}";`;
    const matches = source.split(legacy).length - 1;
    if (matches !== 1) {
        throw new Error(`Expected exactly one ${legacy} assignment, found ${matches}`);
    }
    const patched = source.replace(legacy, replacement);
    assertPatchedSource(patched, 'patched source');
    return patched;
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const repoRoot = path.resolve(__dirname, '..', '..', '..');
    const swfPath = path.resolve(args.swf || path.join(repoRoot, 'src', 'client', 'content', 'localhost', 'p', 'cam', 'LevelsBT.swf'));
    const outputPath = path.resolve(args.output || swfPath);
    const ffdecPath = detectFfdec(repoRoot, args.ffdec);
    if (!ffdecPath) throw new Error('FFDec not found. Pass --ffdec <path>.');
    if (!fs.existsSync(swfPath)) throw new Error(`LevelsBT SWF not found: ${swfPath}`);

    const workRoot = path.join(repoRoot, 'build', args.verify ? 'ffdec-levelsbt-benjaea-verify' : 'ffdec-levelsbt-benjaea');
    const homeDir = path.join(workRoot, 'ffdec-home');
    const exportRoot = path.join(workRoot, 'export');

    if (args.verify) {
        const classPath = exportRoom(ffdecPath, homeDir, exportRoot, swfPath);
        assertPatchedSource(fs.readFileSync(classPath, 'utf8'), swfPath);
        console.log(`[LevelsBT Benjaea] Verified: characterName=${INTERNAL_CHARACTER_NAME}, displayName=${DISPLAY_NAME}`);
        return;
    }

    const classPath = exportRoom(ffdecPath, homeDir, exportRoot, swfPath);
    const patchedSource = patchSource(fs.readFileSync(classPath, 'utf8'));
    fs.writeFileSync(classPath, patchedSource, 'utf8');

    const stagedOutput = path.join(workRoot, 'LevelsBT.patched.swf');
    fs.rmSync(stagedOutput, { force: true });
    runFfdec(ffdecPath, homeDir, ['-importScript', swfPath, stagedOutput, path.dirname(classPath)]);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.copyFileSync(stagedOutput, outputPath);

    const verifyRoot = path.join(workRoot, 'verify');
    const verifiedClass = exportRoom(ffdecPath, homeDir, verifyRoot, outputPath);
    assertPatchedSource(fs.readFileSync(verifiedClass, 'utf8'), outputPath);
    console.log(`[LevelsBT Benjaea] Rebuilt ${outputPath}`);
}

main();
