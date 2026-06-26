const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const SERVER_ROOT = path.resolve(__dirname, '..');
const BRIDGE_CONFIG_PATH = path.join(SERVER_ROOT, 'discord-bridge.config.json');
const LAUNCHER_CONFIG_PATH = path.join(SERVER_ROOT, 'launcher.config.json');
const BRIDGE_ENTRY = path.join(SERVER_ROOT, 'dist', 'tools', 'discordLocalBridge.js');

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function normalizeHttpUrl(value, { loopbackOnly = false } = {}) {
    const raw = String(value || '').trim();
    if (!raw) {
        return '';
    }

    try {
        const parsed = new URL(raw);
        const protocolAllowed = parsed.protocol === 'http:' || parsed.protocol === 'https:';
        const hasCredentials = Boolean(parsed.username || parsed.password);
        const hostname = parsed.hostname.toLowerCase();
        const isLoopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';

        if (!protocolAllowed || hasCredentials || (loopbackOnly && !isLoopback)) {
            return '';
        }

        return parsed.toString();
    } catch {
        return '';
    }
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
    const presenceUrl = normalizeHttpUrl(launcherConfig.presenceUrl || bridgeConfig.presenceUrl, { loopbackOnly: true });
    const joinUrl = normalizeHttpUrl(launcherConfig.joinUrl || bridgeConfig.joinUrl, { loopbackOnly: true });
    const playGameUrl = normalizeHttpUrl(launcherConfig.playGameUrl || bridgeConfig.playGameUrl);

    if (presenceUrl) {
        bridgeConfig.presenceUrl = presenceUrl;
    }
    if (joinUrl) {
        bridgeConfig.joinUrl = joinUrl;
    }
    if (playGameUrl) {
        bridgeConfig.playGameUrl = playGameUrl;
    }
    bridgeConfig.characterName = String(launcherConfig.characterName || bridgeConfig.characterName || '').trim();
    writeJson(BRIDGE_CONFIG_PATH, bridgeConfig);
}

function startBridge() {
    const child = spawn(process.execPath, [BRIDGE_ENTRY], {
        cwd: SERVER_ROOT,
        detached: true,
        stdio: 'ignore',
        shell: false
    });
    child.unref();
}

function openUrl(url) {
    const safeUrl = normalizeHttpUrl(url);
    if (!safeUrl) {
        console.error('[Launcher] Refusing to launch an invalid or unsafe clientUrl.');
        process.exit(1);
    }

    if (process.platform === 'darwin') {
        spawn('open', [safeUrl], { detached: true, stdio: 'ignore', shell: false }).unref();
        return;
    }

    if (process.platform === 'win32') {
        spawn('rundll32.exe', ['url.dll,FileProtocolHandler', safeUrl], {
            detached: true,
            stdio: 'ignore',
            shell: false
        }).unref();
        return;
    }

    console.error(`[Launcher] Unsupported platform for URL launch: ${process.platform}`);
    process.exit(1);
}

function startClient(config) {
    const url = normalizeHttpUrl(config.clientUrl);
    if (!url) {
        console.error('[Launcher] No safe clientUrl configured.');
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
