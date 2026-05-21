const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SDK_BRANCH = process.env.DISCORD_SOCIAL_SDK_BRANCH || 'neodevils/discord-social-sdk-files';
const SDK_PATH = path.join('src', 'server', 'native_bridge', 'discord_social_sdk');
const TARGET_DIR = path.join(REPO_ROOT, SDK_PATH);

function hasArg(name) {
    return process.argv.includes(name);
}

function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
        cwd: options.cwd || REPO_ROOT,
        stdio: options.stdio || 'inherit',
        encoding: 'utf8'
    });

    if (result.error) {
        throw result.error;
    }

    if (result.status !== 0 && options.required !== false) {
        throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
    }

    return result;
}

function hasGitLfs() {
    const result = run('git', ['lfs', 'version'], { stdio: 'ignore', required: false });
    return result.status === 0;
}

function removeDirIfExists(target) {
    if (fs.existsSync(target)) {
        fs.rmSync(target, { recursive: true, force: true });
    }
}

function main() {
    const force = hasArg('--force');
    if (fs.existsSync(TARGET_DIR) && !force) {
        console.log(`Discord Social SDK already exists at ${SDK_PATH}.`);
        console.log('Use npm run install:discord-social-sdk -- --force to reinstall it.');
        return;
    }

    if (!hasGitLfs()) {
        console.warn('Git LFS is not installed. The SDK branch uses Git LFS for binary files.');
        console.warn('Install Git LFS first, then run this script again.');
        process.exitCode = 1;
        return;
    }

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'db-discord-social-sdk-'));
    const worktreeDir = path.join(tempRoot, 'worktree');

    try {
        console.log(`Fetching Discord Social SDK from origin/${SDK_BRANCH}...`);
        run('git', ['fetch', 'origin', SDK_BRANCH]);
        run('git', ['worktree', 'add', '--detach', worktreeDir, 'FETCH_HEAD']);
        run('git', ['lfs', 'pull'], { cwd: worktreeDir });

        const sourceDir = path.join(worktreeDir, SDK_PATH);
        if (!fs.existsSync(sourceDir)) {
            throw new Error(`SDK folder was not found in ${SDK_BRANCH}: ${SDK_PATH}`);
        }

        removeDirIfExists(TARGET_DIR);
        fs.mkdirSync(path.dirname(TARGET_DIR), { recursive: true });
        fs.cpSync(sourceDir, TARGET_DIR, { recursive: true, verbatimSymlinks: true });
        console.log(`Installed Discord Social SDK to ${SDK_PATH}.`);
    } finally {
        run('git', ['worktree', 'remove', '--force', worktreeDir], { required: false });
        removeDirIfExists(tempRoot);
    }
}

try {
    main();
} catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
}
