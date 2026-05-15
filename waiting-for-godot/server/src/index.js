// Entrypoint. Boots Express + raw HTTP server + ws upgrade handler.
// In dev, serves static files from ../web for one-process workflow.
// In prod (Cloud Run), Firebase Hosting serves /web and rewrites /wfg-api/**
// to this service.

import http from 'node:http';
import path from 'node:path';
import url from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { config, isProd } from './config.js';
import { orchestrator } from './orchestrator/index.js';
import { adminRouter } from './routes/admin.js';
import { feedRouter } from './routes/feed.js';
import { audienceRouter } from './routes/audience.js';
import { AudioPipeline } from './audio/pipeline.js';
import { isAuthenticated } from './lib/auth.js';
import { logCritical, logInfo } from './lib/log.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');
const webRoot = path.join(repoRoot, 'web');
const devAudioDir = path.join(repoRoot, 'dev-audio');

const app = express();
// Trust proxy so req.ip reflects the real visitor IP behind Cloud Run /
// Hosting / a local reverse proxy. In dev it just resolves to ::1/127.0.0.1.
app.set('trust proxy', true);
app.use(express.json({ limit: '256kb' }));

// CORS for the SSE feed stream. Firebase Hosting buffers/blocks
// `text/event-stream` responses, so the visitor + admin connect their
// EventSource directly to the Cloud Run URL. Other API calls still go
// through Hosting (same-origin, no CORS needed).
const ALLOWED_ORIGINS = new Set([
    'https://creativethinkingsystems.com',
    'https://www.creativethinkingsystems.com',
    'http://localhost:8787',
    'http://127.0.0.1:8787',
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

// Audio pipeline as an app-local singleton so routes can reach it.
const audio = new AudioPipeline({ orchestrator, devAudioDir });
app.locals.audio = audio;

app.get('/wfg-api/health', (_req, res) => {
    res.json({
        ok: true,
        activeSessionId: orchestrator.currentSessionId,
        state: orchestrator.state,
    });
});

app.use('/wfg-api/feed', feedRouter);
app.use('/wfg-api/admin', adminRouter);
app.use('/wfg-api/audience', audienceRouter);

// Static web — served by Cloud Run when no upstream (Firebase Hosting)
// is in front. Redundant but harmless once Hosting is rewriting.
// Redirects must come before static middleware so they win over
// directory-trailing-slash 301s.
app.get(['/wfg', '/wfg/'], (_req, res) => res.redirect(301, '/waitingforgodot/'));
app.get('/', (_req, res) => res.redirect(302, '/waitingforgodot/'));
// Per-session archive URLs: serve the visitor template; the JS reads
// the sessionId from window.location.pathname.
app.get(/^\/wfg\/sessions\/[^/]+\/?$/, (_req, res) =>
    res.sendFile(path.join(webRoot, 'waitingforgodot', 'index.html')),
);
app.use(express.static(webRoot, { extensions: ['html'] }));

const server = http.createServer(app);

// Operator audio WebSocket — admin-only. Auth via cookie at upgrade time.
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/wfg-api/ws/audio') {
        socket.destroy();
        return;
    }
    if (!isAuthenticated({ headers: req.headers })) {
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
    // Listen first so the server is responsive even if Firestore is degraded.
    await new Promise((resolve) => server.listen(config.port, resolve));
    logInfo('server', 'listening', { port: config.port });
    console.log(`\n  WFG ready.\n  Visitor: ${config.publicBaseUrl}/waitingforgodot/\n  Admin:   ${config.publicBaseUrl}/wfg/admin/\n`);
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
