const fs = require('fs');
const os = require('os');
const path = require('path');

const LABEL = 'com.dungeonblitz.discordbridge';

function removeMac() {
    const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
    if (fs.existsSync(plistPath)) {
        fs.unlinkSync(plistPath);
        console.log(`[DiscordBridge] Removed LaunchAgent: ${plistPath}`);
    } else {
        console.log(`[DiscordBridge] LaunchAgent not found: ${plistPath}`);
    }

    console.log('[DiscordBridge] If it is currently loaded, unload it with:');
    console.log(`launchctl bootout gui/$(id -u) "${plistPath}"`);
}

function removeWindows() {
    const appData = process.env.APPDATA;
    if (!appData) {
        console.error('[DiscordBridge] APPDATA is not set; cannot locate Windows Startup folder.');
        process.exit(1);
    }

    const launcherPath = path.join(
        appData,
        'Microsoft',
        'Windows',
        'Start Menu',
        'Programs',
        'Startup',
        'DungeonBlitzDiscordBridge.bat'
    );

    if (fs.existsSync(launcherPath)) {
        fs.unlinkSync(launcherPath);
        console.log(`[DiscordBridge] Removed Startup launcher: ${launcherPath}`);
    } else {
        console.log(`[DiscordBridge] Startup launcher not found: ${launcherPath}`);
    }
}

function main() {
    switch (process.platform) {
        case 'darwin':
            removeMac();
            break;
        case 'win32':
            removeWindows();
            break;
        default:
            console.error(`[DiscordBridge] Unsupported platform for autostart removal: ${process.platform}`);
            process.exit(1);
    }
}

main();
