const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function readArg(name, fallback) {
    const index = process.argv.indexOf(name);
    return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const panelHost = '127.0.0.1';
const panelPort = Math.max(1, Number(readArg('--port', process.env.ADMIN_PANEL_PORT || 8787)) || 8787);
const targetBase = new URL(readArg('--server', process.env.ADMIN_SERVER_URL || process.env.PUBLIC_BASE_URL || 'http://localhost:8000'));
const secret = String(readArg('--secret', process.env.ADMIN_API_SECRET || process.env.DISCORD_MAINTENANCE_API_SECRET || '')).trim();
const webDir = path.resolve(__dirname, 'admin-panel');

if (!secret) {
    console.error('[AdminPanel] ADMIN_API_SECRET or DISCORD_MAINTENANCE_API_SECRET is required.');
    process.exit(1);
}

const contentTypes = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.svg': 'image/svg+xml'
};

function sanitizeApiSuffix(pathname) {
    const rawSuffix = pathname.slice(5);
    let decodedSuffix;
    try {
        decodedSuffix = decodeURIComponent(rawSuffix);
    } catch (_error) {
        return null;
    }

    if (!decodedSuffix || /(^|\/)\.\.?(\/|$)/.test(decodedSuffix) || decodedSuffix.includes('\\') || /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(decodedSuffix) || decodedSuffix.startsWith('/') || /[\r\n\0]/.test(decodedSuffix)) {
        return null;
    }

    return decodedSuffix
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/');
}

function targetRequest(req, res, targetPath, stream = false) {
    const transport = targetBase.protocol === 'https:' ? https : http;
    const headers = {
        authorization: `Bearer ${secret}`,
        accept: stream ? 'text/event-stream' : 'application/json'
    };
    if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
    const upstream = transport.request(new URL(targetPath, targetBase), {
        method: req.method,
        headers
    }, (upstreamResponse) => {
        res.writeHead(upstreamResponse.statusCode || 502, {
            'content-type': upstreamResponse.headers['content-type'] || 'application/json',
            'cache-control': 'no-store',
            connection: stream ? 'keep-alive' : 'close'
        });
        upstreamResponse.pipe(res);
    });
    upstream.on('error', (error) => {
        if (!res.headersSent) {
            res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
        }
        res.end(JSON.stringify({ error: `Active server is unreachable: ${error.message}` }));
    });
    if (stream) {
        res.on('close', () => upstream.destroy());
    }
    if (req.method === 'GET' || req.method === 'HEAD') upstream.end();
    else req.pipe(upstream);
}

const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://${panelHost}:${panelPort}`);
    if (url.pathname === '/events') {
        targetRequest(req, res, '/api/admin/control/events', true);
        return;
    }
    if (url.pathname.startsWith('/api/')) {
        const sanitizedSuffix = sanitizeApiSuffix(url.pathname);
        if (!sanitizedSuffix) {
            res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'Invalid API path.' }));
            return;
        }
        targetRequest(req, res, `/api/admin/control/${sanitizedSuffix}${url.search}`);
        return;
    }

    const requested = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const filePath = path.resolve(webDir, requested);
    if (!filePath.startsWith(`${webDir}${path.sep}`) && filePath !== path.join(webDir, 'index.html')) {
        res.writeHead(403).end('Forbidden');
        return;
    }
    fs.readFile(filePath, (error, contents) => {
        if (error) {
            res.writeHead(404).end('Not found');
            return;
        }
        res.writeHead(200, {
            'content-type': contentTypes[path.extname(filePath)] || 'application/octet-stream',
            'cache-control': 'no-store'
        });
        res.end(contents);
    });
});

server.listen(panelPort, panelHost, () => {
    const panelUrl = `http://${panelHost}:${panelPort}`;
    console.log(`[AdminPanel] ${panelUrl}`);
    console.log(`[AdminPanel] Active server: ${targetBase.origin}`);
    if (!process.argv.includes('--no-open')) {
        const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
        const args = process.platform === 'win32' ? ['/c', 'start', '', panelUrl] : [panelUrl];
        spawn(command, args, { detached: true, stdio: 'ignore' }).unref();
    }
});

function shutdown() {
    server.close(() => process.exit(0));
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
