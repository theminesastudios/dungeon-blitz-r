const { execFileSync } = require('child_process');
const path = require('path');

const serverRoot = normalize(path.resolve(__dirname, '..'));
const ports = [8000, 8080];

function normalize(value) {
    return value.replace(/["']/g, '').replace(/\\/g, '/').toLowerCase();
}

function run(command, args) {
    try {
        return execFileSync(command, args, {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore']
        }).trim();
    } catch {
        return '';
    }
}

function getListeningPids(port) {
    if (process.platform === 'win32') {
        const output = run('powershell', [
            '-NoProfile',
            '-Command',
            `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess | Sort-Object -Unique`
        ]);
        return output
            .split(/\r?\n/)
            .map((value) => Number.parseInt(value.trim(), 10))
            .filter(Number.isInteger);
    }

    const output = run('lsof', ['-tiTCP:' + port, '-sTCP:LISTEN']);
    return output
        .split(/\r?\n/)
        .map((value) => Number.parseInt(value.trim(), 10))
        .filter(Number.isInteger);
}

function getCommandLine(pid) {
    if (process.platform === 'win32') {
        return run('powershell', [
            '-NoProfile',
            '-Command',
            `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" | Select-Object -ExpandProperty CommandLine)`
        ]);
    }

    return run('ps', ['-p', String(pid), '-o', 'command=']);
}

function isStaleDungeonBlitzDevServer(commandLine) {
    const normalizedCommand = normalize(commandLine);
    return normalizedCommand.includes(serverRoot) && normalizedCommand.includes('main.ts');
}

function stopProcess(pid) {
    if (process.platform === 'win32') {
        run('taskkill', ['/PID', String(pid), '/T', '/F']);
        return;
    }

    try {
        process.kill(pid, 'SIGTERM');
    } catch {
        // Ignore processes that disappeared between detection and cleanup.
    }
}

const stalePids = new Set();

for (const port of ports) {
    for (const pid of getListeningPids(port)) {
        if (pid !== process.pid) {
            stalePids.add(pid);
        }
    }
}

for (const pid of stalePids) {
    const commandLine = getCommandLine(pid);
    if (!isStaleDungeonBlitzDevServer(commandLine)) {
        continue;
    }

    console.log(`[dev] Stopping stale Dungeon Blitz server process ${pid}.`);
    stopProcess(pid);
}
