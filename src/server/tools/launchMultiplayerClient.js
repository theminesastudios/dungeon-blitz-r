const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const SERVER_ROOT = path.resolve(__dirname, '..');
const PROJECT_ROOT = path.resolve(SERVER_ROOT, '..', '..');
const BRIDGE_CONFIG_PATH = path.join(SERVER_ROOT, 'discord-bridge.config.json');
const LAUNCHER_CONFIG_PATH = path.join(SERVER_ROOT, 'launcher.config.json');
const BRIDGE_ENTRY = path.join(SERVER_ROOT, 'dist', 'tools', 'discordLocalBridge.js');

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function ensureBuilt() {
    if (!fs.existsSync(BRIDGE_ENTRY)) {
        console.error(`[Launcher] Missing build output: ${BRIDGE_ENTRY}`);
        console.error('[Launcher] Run `npm run build` first.');
        process.exit(1);
    }
}

function ensureLauncherConfig() {
    if (!fs.existsSync(LAUNCHER_CONFIG_PATH)) {
        console.error(`[Launcher] Missing launcher config: ${LAUNCHER_CONFIG_PATH}`);
        process.exit(1);
    }
}

function updateBridgeConfig(launcherConfig) {
    const bridgeConfig = readJson(BRIDGE_CONFIG_PATH);
    bridgeConfig.presenceUrl = String(launcherConfig.presenceUrl || bridgeConfig.presenceUrl || '').trim();
    bridgeConfig.joinUrl = String(launcherConfig.joinUrl || bridgeConfig.joinUrl || '').trim();
    bridgeConfig.playGameUrl = String(launcherConfig.playGameUrl || bridgeConfig.playGameUrl || '').trim();
    bridgeConfig.characterName = String(launcherConfig.characterName || bridgeConfig.characterName || '').trim();
    writeJson(BRIDGE_CONFIG_PATH, bridgeConfig);
}

function startBridge() {
    const child = spawn(process.execPath, [BRIDGE_ENTRY], {
        cwd: SERVER_ROOT,
        detached: true,
        stdio: 'ignore'
    });
    child.unref();
}

function getClientCommand(config) {
    if (process.platform === 'darwin') {
        return {
            command: Array.isArray(config.clientCommandMac) ? config.clientCommandMac : [],
            cwd: String(config.clientWorkingDirectoryMac || '').trim()
        };
    }

    if (process.platform === 'win32') {
        return {
            command: Array.isArray(config.clientCommandWindows) ? config.clientCommandWindows : [],
            cwd: String(config.clientWorkingDirectoryWindows || '').trim()
        };
    }

    return { command: [], cwd: '' };
}

function openUrl(url) {
    if (process.platform === 'darwin') {
        spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
        return;
    }

    if (process.platform === 'win32') {
        spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
        return;
    }

    console.error(`[Launcher] Unsupported platform for URL launch: ${process.platform}`);
    process.exit(1);
}

function startClient(config) {
    const client = getClientCommand(config);
    if (client.command.length > 0) {
        const [command, ...args] = client.command;
        spawn(command, args, {
            cwd: client.cwd || PROJECT_ROOT,
            detached: true,
            stdio: 'ignore'
        }).unref();
        return;
    }

    const url = String(config.clientUrl || '').trim();
    if (!url) {
        console.error('[Launcher] No client command or clientUrl configured.');
        process.exit(1);
    }

    openUrl(url);
}

function main() {
    ensureBuilt();
    ensureLauncherConfig();
    const launcherConfig = readJson(LAUNCHER_CONFIG_PATH);
    updateBridgeConfig(launcherConfig);
    startBridge();
    startClient(launcherConfig);
    console.log('[Launcher] Discord bridge started and multiplayer client launch requested.');
}

main();
