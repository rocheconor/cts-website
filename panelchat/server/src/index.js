// Entrypoint. Boots Express + raw HTTP server + ws upgrade handler.
// In dev, serves static files from ../web for one-process workflow.
// In prod (Cloud Run), Firebase Hosting serves /web and rewrites
// /panelchat-api/** to this service.

import http from 'node:http';
import path from 'node:path';
import url from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { config } from './config.js';
import { orchestrator } from './orchestrator/index.js';
import { adminRouter } from './routes/admin.js';
import { feedRouter } from './routes/feed.js';
import { audienceRouter } from './routes/audience.js';
import { AudioPipeline } from './audio/pipeline.js';
import { isAuthenticated, verifyWsTicket } from './lib/auth.js';
import { logCritical, logInfo, logWarn } from './lib/log.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');
const webRoot = path.join(repoRoot, 'web');
const devAudioDir = path.join(repoRoot, 'dev-audio');

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '256kb' }));

// CORS for the SSE feed stream. Firebase Hosting buffers/blocks
// `text/event-stream` responses, so the visitor + admin connect their
// EventSource directly to the Cloud Run URL. Other API calls still go
// through Hosting (same-origin, no CORS needed). The whitelist below
// covers the production domain plus local dev origins.
const ALLOWED_ORIGINS = new Set([
    'https://creativethinkingsystems.com',
    'https://www.creativethinkingsystems.com',
    'http://localhost:8788',
    'http://127.0.0.1:8788',
]);
app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && ALLOWED_ORIGINS.has(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        res.setHeader('Access-Control-Max-Age', '600');
        return res.sendStatus(204);
    }
    next();
});

const audio = new AudioPipeline({ orchestrator, devAudioDir });
app.locals.audio = audio;

app.get('/panelchat-api/health', (_req, res) => {
    res.json({
        ok: true,
        activeSessionId: orchestrator.currentSessionId,
        state: orchestrator.state,
    });
});

app.use('/panelchat-api/feed', feedRouter);
app.use('/panelchat-api/admin', adminRouter);
app.use('/panelchat-api/audience', audienceRouter);

// Root → visitor surface.
app.get('/', (_req, res) => res.redirect(302, '/panelchat/'));
// Bare /panelchat → /panelchat/ (no-slash form only; loose-routing-safe).
app.get(/^\/panelchat$/, (_req, res) => res.redirect(301, '/panelchat/'));

// Per-session archive URL: serve the visitor template; the JS reads the
// sessionId from window.location.pathname.
app.get(/^\/panelchat\/sessions\/[^/]+\/?$/, (_req, res) =>
    res.sendFile(path.join(webRoot, 'visitor', 'index.html')),
);

// Static web. Two roots:
//   /panelchat/admin/* — admin console
//   /panelchat/*       — visitor feed
app.use('/panelchat/admin', express.static(path.join(webRoot, 'admin'), { extensions: ['html'] }));
app.use('/panelchat', express.static(path.join(webRoot, 'visitor'), { extensions: ['html'] }));

const server = http.createServer(app);

// Operator audio WebSocket — admin-only. Auth via cookie at upgrade time.
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
    // The upgrade URL carries the path *and* any query string (ws/audio?ticket=...).
    const parsed = url.parse(req.url || '', true);
    if (parsed.pathname !== '/panelchat-api/ws/audio') {
        socket.destroy();
        return;
    }

    // Origin allowlist — same set as the HTTP CORS allowlist. Defends
    // against cross-site WebSocket hijacking when auth rides a cookie.
    const origin = req.headers.origin;
    if (origin && !ALLOWED_ORIGINS.has(origin)) {
        logWarn('ws', 'origin_rejected', { origin });
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
    }

    // Accept either the __session cookie (works same-origin in dev, or
    // when a future Hosting hop supports WS) or a short-lived signed
    // ticket on the query string (required in prod, where the WS goes
    // direct to *.run.app and the cookie can't ride along).
    const ticket = typeof parsed.query.ticket === 'string' ? parsed.query.ticket : null;
    const authed = isAuthenticated({ headers: req.headers }) || (ticket && verifyWsTicket(ticket));
    if (!authed) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
    });
});

wss.on('connection', async (ws) => {
    logInfo('ws', 'operator_connected');
    try {
        await audio.startLive();
    } catch (err) {
        logCritical('ws', 'live_start_failed', { message: err.message });
        ws.send(JSON.stringify({ type: 'error', message: err.message }));
        ws.close();
        return;
    }
    audio.attachOperatorSocket(ws);
    ws.send(JSON.stringify({ type: 'ready' }));
});

const boot = async () => {
    await new Promise((resolve) => server.listen(config.port, resolve));
    logInfo('server', 'listening', { port: config.port });
    console.log(`\n  Panelchat ready.\n  Visitor: ${config.publicBaseUrl}/panelchat/\n  Admin:   ${config.publicBaseUrl}/panelchat/admin/\n`);
    orchestrator.bootstrap().catch((err) => {
        logCritical('server', 'bootstrap_failed', { message: err.message });
    });
};

boot().catch((err) => {
    console.error('boot failed', err);
    process.exit(1);
});

const shutdown = async (sig) => {
    logInfo('server', 'shutdown', { sig });
    try {
        await audio.stop();
        server.close();
    } finally {
        process.exit(0);
    }
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
