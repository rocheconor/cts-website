// Admin routes. Cookie-gated; single shared password.

import crypto from 'node:crypto';
import express from 'express';
import {
    checkPassword,
    issueAdminCookie,
    clearAdminCookie,
    requireAdmin,
    isAuthenticated,
} from '../lib/auth.js';
import { orchestrator } from '../orchestrator/index.js';
import { paths, FieldValue } from '../lib/firestore.js';
import { logInfo, logWarn, logError } from '../lib/log.js';
import {
    createPodcast,
    getOperation,
    downloadAudio,
    buildTextContexts,
    resolveProjectId,
} from '../podcast/client.js';

export const adminRouter = express.Router();

adminRouter.get('/status', (req, res) => {
    res.json({ authenticated: isAuthenticated(req) });
});

adminRouter.post('/login', (req, res) => {
    const password = req.body?.password;
    if (!checkPassword(password)) {
        logWarn('admin', 'login_failed');
        return res.status(401).json({ error: 'invalid_password' });
    }
    issueAdminCookie(res);
    logInfo('admin', 'login_ok');
    res.json({ ok: true });
});

adminRouter.post('/logout', (_req, res) => {
    clearAdminCookie(res);
    res.json({ ok: true });
});

// Everything below requires the admin cookie.
adminRouter.use(requireAdmin);

// ---------- Session lifecycle ----------

adminRouter.get('/sessions', async (_req, res) => {
    try {
        const sessions = await orchestrator.listSessions();
        res.json({ sessions, activeId: orchestrator.currentSessionId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

adminRouter.post('/sessions', async (req, res) => {
    const label = (req.body?.label || '').trim() || 'Untitled';
    const kind = req.body?.kind === 'live' ? 'live' : 'rehearsal';
    try {
        const id = await orchestrator.newSession({ label, kind });
        res.json({ ok: true, id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

adminRouter.post('/sessions/:id/activate', async (req, res) => {
    try {
        await orchestrator.activateSession(req.params.id);
        res.json({ ok: true, activeId: orchestrator.currentSessionId });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

adminRouter.post('/sessions/:id/end', async (req, res) => {
    try {
        await orchestrator.endSession(req.params.id);
        res.json({ ok: true });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

adminRouter.post('/sessions/:id/delete', async (req, res) => {
    try {
        await orchestrator.deleteSession(req.params.id);
        res.json({ ok: true });
    } catch (err) {
        const status = err.status && err.status < 600 ? err.status : 500;
        res.status(status).json({ error: err.message });
    }
});

// ---------- Active session controls ----------

adminRouter.post('/start', async (_req, res) => {
    try {
        await orchestrator.start();
        res.json({ ok: true, state: orchestrator.state });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

adminRouter.post('/end', async (_req, res) => {
    await orchestrator.endCurrentSession();
    res.json({ ok: true, state: orchestrator.state });
});

adminRouter.post('/restart', async (_req, res) => {
    try {
        await orchestrator.restartCurrentSession();
        res.json({ ok: true, state: orchestrator.state });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

adminRouter.post('/pause', async (_req, res) => {
    await orchestrator.pause();
    res.json({ ok: true, state: orchestrator.state });
});

adminRouter.post('/resume', async (_req, res) => {
    await orchestrator.resume();
    res.json({ ok: true, state: orchestrator.state });
});

adminRouter.post('/godot', async (req, res) => {
    const question = req.body?.question;
    try {
        await orchestrator.godotAsk(question);
        res.json({ ok: true });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

adminRouter.post('/settings', async (req, res) => {
    const numbers = [
        'globalCooldownMs',
        'perCharacterCooldownMs',
        'targetPostsPerMinute',
        'godotDeliberationCap',
        'audienceRateLimitMs',
        'audienceMaxChars',
        'audienceQueueCap',
        'idleQuietMs',
    ];
    const booleans = ['audienceGodotEnabled'];
    const patch = {};
    for (const k of numbers) {
        if (req.body?.[k] !== undefined) patch[k] = Number(req.body[k]);
    }
    for (const k of booleans) {
        if (req.body?.[k] !== undefined) patch[k] = !!req.body[k];
    }
    await orchestrator.updateSettings(patch);
    res.json({ ok: true, settings: orchestrator.settings });
});

adminRouter.post('/profiles/:id', async (req, res) => {
    const allowed = [
        'displayName', 'nickname', 'avatarUrl', 'modelBadgeUrl', 'modelLabel',
        'maxPostChars', 'responseDelayMs', 'systemPrompt', 'triggers',
    ];
    const patch = {};
    for (const k of allowed) {
        if (req.body?.[k] !== undefined) patch[k] = req.body[k];
    }
    try {
        await orchestrator.updateProfile(req.params.id, patch);
        res.json({
            ok: true,
            profile: orchestrator.profileList().find((p) => p.id === req.params.id),
        });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

adminRouter.get('/profiles', (_req, res) => {
    res.json({ profiles: orchestrator.profileList() });
});

// ---------- Rehearsal tooling ----------

adminRouter.post('/probe', async (req, res) => {
    const characterId = req.body?.characterId;
    const message = req.body?.message;
    const includeContext = !!req.body?.includeContext;
    if (!characterId || !message) return res.status(400).json({ error: 'characterId and message required' });
    try {
        const result = await orchestrator.probeCharacter(characterId, message, { includeContext });
        res.json({ ok: true, ...result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

adminRouter.get('/audience-queue', (_req, res) => {
    res.json({
        enabled: !!orchestrator.settings.audienceGodotEnabled,
        items: orchestrator.audienceQueueSnapshot(),
    });
});

adminRouter.post('/audience-queue/clear', (_req, res) => {
    const dropped = orchestrator.clearAudienceQueue();
    res.json({ ok: true, dropped });
});

adminRouter.post('/audience-queue/dismiss/:id', (req, res) => {
    const removed = orchestrator.dismissAudienceQueueItem(req.params.id);
    res.json({ ok: true, removed });
});

adminRouter.post('/transcript-inject', async (req, res) => {
    const text = req.body?.text;
    if (!text) return res.status(400).json({ error: 'text required' });
    orchestrator.injectTranscript(text);
    res.json({ ok: true });
});

// ---------- Transcript download ----------

// GET /wfg-api/admin/transcript[?sessionId=X]
// Plain text, one line per completed segment, in chronological order.
// Works at any time — the session doesn't need to have ended.
adminRouter.get('/transcript', async (req, res) => {
    const sid = req.query.sessionId || orchestrator.currentSessionId;
    if (!sid) return res.status(400).json({ error: 'no_session' });
    try {
        const sessionSnap = await paths.session(sid).get();
        if (!sessionSnap.exists) return res.status(404).json({ error: 'session_not_found' });
        const label = (sessionSnap.data()?.label || sid).trim() || sid;
        const safeLabel = label
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 60) || sid;

        const snap = await paths.transcript(sid).orderBy('createdAtMs', 'asc').get();
        const lines = snap.docs.map((d) => (d.data().text || '').trim()).filter(Boolean);
        const body = lines.join('\n') + (lines.length ? '\n' : '');

        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader(
            'Content-Disposition',
            `attachment; filename="${safeLabel}-transcript.txt"`,
        );
        res.setHeader('Cache-Control', 'no-store');
        res.send(body);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ---------- Podcast (NotebookLM Enterprise Podcast API) ----------
//
// Long-running. POST /podcasts kicks off generation; UI polls
// /podcasts/:id/refresh; when ready, /podcasts/:id/audio proxies the MP3
// to the operator's browser (we have to proxy — the download URL needs
// our OAuth token).

const PODCAST_STATUSES = ['queued', 'generating', 'ready', 'failed'];

const readSessionTranscript = async (sessionId) => {
    const snap = await paths.transcript(sessionId).orderBy('createdAtMs', 'asc').get();
    return snap.docs
        .map((d) => (d.data().text || '').trim())
        .filter(Boolean)
        .join('\n');
};

const readSessionChat = async (sessionId) => {
    const snap = await paths
        .posts(sessionId)
        .orderBy('createdAtMs', 'asc')
        .limit(2000)
        .get();
    return snap.docs
        .map((d) => {
            const p = d.data();
            if (p.kind === 'godot_question') {
                return `Audience question: ${(p.body || '').trim()}`;
            }
            const name = p.displayName || p.characterId || 'bot';
            const body = (p.body || '').trim();
            if (!body) return '';
            return `${name}: ${body}`;
        })
        .filter(Boolean)
        .join('\n');
};

const newPodcastId = () => crypto.randomBytes(8).toString('hex');

adminRouter.post('/podcasts', async (req, res) => {
    const sessionId = (req.body?.sessionId || orchestrator.currentSessionId || '').trim();
    if (!sessionId) return res.status(400).json({ error: 'no_session' });
    const title = (req.body?.title || '').trim().slice(0, 200);
    const description = (req.body?.description || '').trim().slice(0, 1000);
    const focus = (req.body?.focus || '').trim().slice(0, 1000);
    const length = req.body?.length === 'STANDARD' ? 'STANDARD' : 'SHORT';
    const includeBotPosts = !!req.body?.includeBotPosts;

    try {
        const sessionSnap = await paths.session(sessionId).get();
        if (!sessionSnap.exists) return res.status(404).json({ error: 'session_not_found' });

        const transcript = await readSessionTranscript(sessionId);
        if (!transcript) return res.status(400).json({ error: 'empty_transcript' });
        const chat = includeBotPosts ? await readSessionChat(sessionId) : '';
        const contexts = buildTextContexts({ transcript, chat });

        const op = await createPodcast({
            projectId: resolveProjectId(),
            focus,
            length,
            title,
            description,
            contexts,
        });

        const id = newPodcastId();
        const now = Date.now();
        const doc = {
            id,
            sessionId,
            title: title || (sessionSnap.data()?.label || sessionId),
            description,
            focus,
            length,
            includeBotPosts,
            operationName: op.name,
            status: op.done ? 'ready' : 'generating',
            errorMessage: null,
            createdAtMs: now,
            createdAt: FieldValue.serverTimestamp(),
            completedAtMs: op.done ? now : null,
        };
        await paths.podcast(sessionId, id).set(doc);
        logInfo('podcast', 'created', { id, sessionId, length, includeBotPosts, op: op.name });
        res.json({ ok: true, podcast: doc });
    } catch (err) {
        logError('podcast', 'create_failed', {
            sessionId,
            status: err.status,
            message: err.message,
            detail: err.detail,
        });
        res.status(err.status && err.status < 600 ? err.status : 500).json({
            error: err.message,
            detail: err.detail,
        });
    }
});

adminRouter.get('/podcasts', async (req, res) => {
    const sessionId = (req.query.sessionId || orchestrator.currentSessionId || '').trim();
    if (!sessionId) return res.json({ podcasts: [] });
    try {
        const snap = await paths
            .podcasts(sessionId)
            .orderBy('createdAtMs', 'desc')
            .limit(50)
            .get();
        const podcasts = snap.docs.map((d) => {
            const data = d.data();
            const { createdAt, ...rest } = data;
            return rest;
        });
        res.json({ sessionId, podcasts });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const findPodcast = async (id) => {
    // Podcasts are stored under each session; we have to scan sessions if
    // the caller didn't tell us which. In practice the UI passes sessionId
    // alongside the id, so this is rarely hit.
    const sessionsSnap = await paths.sessions().get();
    for (const s of sessionsSnap.docs) {
        const docSnap = await paths.podcast(s.id, id).get();
        if (docSnap.exists) return { sessionId: s.id, podcast: docSnap.data() };
    }
    return null;
};

const loadPodcast = async (req) => {
    const id = req.params.id;
    const hintedSession = (req.query.sessionId || req.body?.sessionId || '').trim();
    if (hintedSession) {
        const snap = await paths.podcast(hintedSession, id).get();
        if (snap.exists) return { sessionId: hintedSession, podcast: snap.data() };
    }
    return findPodcast(id);
};

adminRouter.post('/podcasts/:id/refresh', async (req, res) => {
    try {
        const found = await loadPodcast(req);
        if (!found) return res.status(404).json({ error: 'podcast_not_found' });
        const { sessionId, podcast } = found;

        // Terminal states — no need to poll.
        if (podcast.status === 'ready' || podcast.status === 'failed') {
            return res.json({ ok: true, podcast });
        }

        const op = await getOperation(podcast.operationName);
        const patch = {};
        if (op.done) {
            if (op.error) {
                patch.status = 'failed';
                patch.errorMessage = (op.error.message || JSON.stringify(op.error)).slice(0, 2000);
            } else {
                patch.status = 'ready';
                patch.completedAtMs = Date.now();
            }
        } else {
            patch.status = 'generating';
        }
        await paths.podcast(sessionId, podcast.id).set(patch, { merge: true });
        res.json({ ok: true, podcast: { ...podcast, ...patch } });
    } catch (err) {
        logError('podcast', 'refresh_failed', {
            id: req.params.id,
            status: err.status,
            message: err.message,
        });
        res.status(err.status && err.status < 600 ? err.status : 500).json({
            error: err.message,
            detail: err.detail,
        });
    }
});

adminRouter.get('/podcasts/:id/audio', async (req, res) => {
    try {
        const found = await loadPodcast(req);
        if (!found) return res.status(404).json({ error: 'podcast_not_found' });
        const { podcast } = found;
        if (podcast.status !== 'ready') {
            return res.status(409).json({ error: `not_ready_${podcast.status}` });
        }
        const upstream = await downloadAudio(podcast.operationName);

        const safeLabel = (podcast.title || podcast.id)
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 60) || podcast.id;

        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader(
            'Content-Disposition',
            `attachment; filename="${safeLabel}.mp3"`,
        );
        res.setHeader('Cache-Control', 'no-store');
        const len = upstream.headers.get('content-length');
        if (len) res.setHeader('Content-Length', len);

        // Pipe the upstream Response body straight to the operator.
        const reader = upstream.body.getReader();
        const pump = async () => {
            try {
                while (true) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    if (!res.write(Buffer.from(value))) {
                        await new Promise((resolve) => res.once('drain', resolve));
                    }
                }
                res.end();
            } catch (err) {
                logError('podcast', 'stream_failed', { id: req.params.id, message: err.message });
                if (!res.headersSent) res.status(500).end();
                else res.end();
            }
        };
        pump();
    } catch (err) {
        logError('podcast', 'audio_failed', {
            id: req.params.id,
            status: err.status,
            message: err.message,
        });
        res.status(err.status && err.status < 600 ? err.status : 500).json({
            error: err.message,
            detail: err.detail,
        });
    }
});

// ---------- Log ----------

adminRouter.get('/log', async (req, res) => {
    const limit = Math.min(500, Math.max(10, Number(req.query.limit) || 200));
    const sid = req.query.sessionId || orchestrator.currentSessionId;
    if (!sid) return res.json({ entries: [] });
    const snap = await paths.log(sid).orderBy('createdAtMs', 'desc').limit(limit).get();
    res.json({
        sessionId: sid,
        entries: snap.docs.map((d) => {
            const data = d.data();
            return {
                id: d.id,
                ...data,
                createdAt: undefined,
            };
        }),
    });
});

// ---------- Audio source ----------

adminRouter.get('/audio', (req, res) => {
    res.json({
        status: req.app.locals.audio.status(),
        devFiles: req.app.locals.audio.listDevAudio(),
    });
});

adminRouter.post('/audio/live', async (req, res) => {
    try {
        await req.app.locals.audio.startLive();
        res.json({ ok: true, status: req.app.locals.audio.status() });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

adminRouter.post('/audio/file', async (req, res) => {
    const filename = req.body?.filename;
    try {
        await req.app.locals.audio.startFile(filename);
        res.json({ ok: true, status: req.app.locals.audio.status() });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

adminRouter.post('/audio/stop', async (req, res) => {
    await req.app.locals.audio.stop();
    res.json({ ok: true, status: req.app.locals.audio.status() });
});
