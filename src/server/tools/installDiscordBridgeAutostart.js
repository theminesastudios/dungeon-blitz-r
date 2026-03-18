const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const SERVER_ROOT = path.resolve(__dirname, '..');
const BRIDGE_ENTRY = path.join(SERVER_ROOT, 'dist', 'tools', 'discordLocalBridge.js');
const LABEL = 'com.dungeonblitz.discordbridge';

function ensureBuilt() {
    if (!fs.existsSync(BRIDGE_ENTRY)) {
        console.error(`[DiscordBridge] Build output not found: ${BRIDGE_ENTRY}`);
        console.error('[DiscordBridge] Run `npm run build` first.');
        process.exit(1);
    }
}

function installMac() {
    const launchAgentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
    const plistPath = path.join(launchAgentsDir, `${LABEL}.plist`);
    const logsDir = path.join(SERVER_ROOT, 'logs');
    const stdoutPath = path.join(logsDir, 'discord-bridge.stdout.log');
    const stderrPath = path.join(logsDir, 'discord-bridge.stderr.log');

    fs.mkdirSync(launchAgentsDir, { recursive: true });
    fs.mkdirSync(logsDir, { recursive: true });

    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${process.execPath}</string>
        <string>${BRIDGE_ENTRY}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${SERVER_ROOT}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${stdoutPath}</string>
    <key>StandardErrorPath</key>
    <string>${stderrPath}</string>
</dict>
</plist>
`;

    fs.writeFileSync(plistPath, plist, 'utf8');
    console.log(`[DiscordBridge] LaunchAgent written: ${plistPath}`);
    console.log('[DiscordBridge] Load it once with:');
    console.log(`launchctl bootstrap gui/$(id -u) "${plistPath}"`);
    console.log('[DiscordBridge] Or log out/in and macOS will start it automatically.');
}

function installWindows() {
    const appData = process.env.APPDATA;
    if (!appData) {
        console.error('[DiscordBridge] APPDATA is not set; cannot locate Windows Startup folder.');
        process.exit(1);
    }

    const startupDir = path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
    const launcherPath = path.join(startupDir, 'DungeonBlitzDiscordBridge.bat');
    const logsDir = path.join(SERVER_ROOT, 'logs');
    const stdoutPath = path.join(logsDir, 'discord-bridge.stdout.log');
    const stderrPath = path.join(logsDir, 'discord-bridge.stderr.log');

    fs.mkdirSync(startupDir, { recursive: true });
    fs.mkdirSync(logsDir, { recursive: true });

    const script = [
        '@echo off',
        `cd /d "${SERVER_ROOT}"`,
        `start "" /min "${process.execPath}" "${BRIDGE_ENTRY}" 1>>"${stdoutPath}" 2>>"${stderrPath}"`
    ].join('\r\n') + '\r\n';

    fs.writeFileSync(launcherPath, script, 'utf8');
    console.log(`[DiscordBridge] Startup launcher written: ${launcherPath}`);
    console.log('[DiscordBridge] It will start automatically on next sign-in.');
}

function main() {
    ensureBuilt();

    switch (process.platform) {
        case 'darwin':
            installMac();
            break;
        case 'win32':
            installWindows();
            break;
        default:
            console.error(`[DiscordBridge] Unsupported platform for autostart: ${process.platform}`);
            process.exit(1);
    }
}

main();
