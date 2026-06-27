const { spawn } = require('child_process');
const http = require('http');

const ANSI_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

function isTruthyEnv(value) {
    return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function normalizeLine(line) {
    return String(line || '').replace(ANSI_PATTERN, '').trim();
}

const flashPlayerUrl = process.env.FLASH_PLAYER_URL || 'http://localhost:8000/p/cbp/DungeonBlitz.swf?fv=cbp&gv=cbp';
const flashBrowserUrl = process.env.FLASH_BROWSER_URL || 'http://localhost:8000/';
const requireNativeBridge = isTruthyEnv(process.env.DISCORD_SOCIAL_BRIDGE_ENABLED) &&
    isTruthyEnv(process.env.DISCORD_SOCIAL_NATIVE_BRIDGE_ENABLED);

const readiness = {
    gameServer: false,
    rpcBridge: false,
    nativeBridge: !requireNativeBridge,
    staticServer: false
};
let printedUrls = false;
let staticServerCheckStarted = false;

function checkStaticServerReady() {
    if (readiness.staticServer || staticServerCheckStarted) {
        return;
    }

    staticServerCheckStarted = true;

    const poll = () => {
        const request = http.get(`${flashBrowserUrl}healthz`, (response) => {
            response.resume();

            if (response.statusCode === 200) {
                readiness.staticServer = true;
                maybePrintUrls();
                return;
            }

            setTimeout(poll, 250);
        });

        request.on('error', () => {
            setTimeout(poll, 250);
        });

        request.setTimeout(2000, () => {
            request.destroy();
        });
    };

    poll();
}

function maybePrintUrls() {
    if (
        printedUrls ||
        !readiness.gameServer ||
        !readiness.rpcBridge ||
        !readiness.nativeBridge ||
        !readiness.staticServer
    ) {
        if (
            !printedUrls &&
            readiness.gameServer &&
            readiness.rpcBridge &&
            readiness.nativeBridge
        ) {
            checkStaticServerReady();
        }
        return;
    }

    printedUrls = true;
    process.stdout.write(`Flash Player URL:\n${flashPlayerUrl}\n\nFlash Browser URL:\n${flashBrowserUrl}\n`);
}

function handleLine(line) {
    const normalized = normalizeLine(line);

    if (normalized.includes('[GameServer] Listening on ')) {
        readiness.gameServer = true;
    }

    if (normalized.includes('[DiscordBridge] Listening on ')) {
        readiness.rpcBridge = true;
    }

    if (normalized.includes('[DiscordSocialBridge] Native Social SDK bridge is ready.')) {
        readiness.nativeBridge = true;
    }

    maybePrintUrls();
}

function watchStream(stream, output) {
    let buffered = '';

    stream.on('data', (chunk) => {
        output.write(chunk);

        buffered += chunk.toString('utf8');
        let newlineIndex = buffered.indexOf('\n');
        while (newlineIndex >= 0) {
            const line = buffered.slice(0, newlineIndex).replace(/\r$/, '');
            buffered = buffered.slice(newlineIndex + 1);
            handleLine(line);
            newlineIndex = buffered.indexOf('\n');
        }
    });

    stream.on('end', () => {
        if (buffered) {
            handleLine(buffered);
            buffered = '';
        }
    });
}

const command = process.platform === 'win32' ? 'call npm run dev:discord' : 'npm';
const args = process.platform === 'win32' ? [] : ['run', 'dev:discord'];
let child;

try {
    child = spawn(command, args, {
        cwd: process.cwd(),
        env: process.env,
        shell: process.platform === 'win32',
        stdio: ['inherit', 'pipe', 'pipe']
    });
} catch (error) {
    console.error('[dev-windows] Failed to start npm run dev:discord:', error);
    process.exit(1);
}

watchStream(child.stdout, process.stdout);
watchStream(child.stderr, process.stderr);

child.on('error', (error) => {
    console.error('[dev-windows] Failed to start npm run dev:discord:', error);
    process.exit(1);
});

child.on('exit', (code, signal) => {
    if (signal) {
        process.exit(1);
        return;
    }

    process.exit(code ?? 0);
});

const forwardedSignals = process.platform === 'win32' ? ['SIGINT', 'SIGTERM', 'SIGBREAK'] : ['SIGINT', 'SIGTERM'];
for (const signal of forwardedSignals) {
    process.on(signal, () => {
        if (!child.killed) {
            child.kill(signal);
        }
    });
}
